import { jest } from '@jest/globals';
import type { MiioDevice } from 'node-miio';

import { getLoggerMock, type LoggerMock } from '../utils/logger.mock.js';

import { isDreame, wrapDreame } from './dreame_device.js';

interface MiotPropertyResult {
  did: string;
  code: number;
  value: unknown;
}

/**
 * Builds the `get_properties` response for the values a test cares about.
 *
 * @param {Record<string, unknown>} values The MIoT values the robot reports.
 * @returns {MiotPropertyResult[]} The response as node-miio would return it.
 */
const miotResults = (values: Record<string, unknown>): MiotPropertyResult[] => Object.entries(values).map(([did, value]) => ({ did, code: 0, value }));

describe('DreameDevice', () => {
  let log: LoggerMock;
  let raw: jest.Mocked<MiioDevice>;
  let device: MiioDevice;

  beforeEach(() => {
    log = getLoggerMock();
    raw = {
      miioModel: 'dreame.vacuum.p2008',
      call: jest.fn(),
      destroy: jest.fn(),
      handle: { api: { parent: { socket: {} } } },
    } as unknown as jest.Mocked<MiioDevice>;
    device = wrapDreame(raw, log);
  });

  describe('isDreame', () => {
    test.each([
      ['dreame.vacuum.p2008', true],
      ['dreame.vacuum.mc1808', true],
      ['roborock.vacuum.s5', false],
      ['viomi.vacuum.v7', false],
      [undefined, false],
    ])('%s', (model, expected) => {
      expect(isDreame(model)).toBe(expected);
    });
  });

  describe('poll/state', () => {
    const poll = async (values: Record<string, unknown>) => {
      raw.call.mockResolvedValueOnce(miotResults(values) as never);
      await device.poll();
    };

    test('asks for every mapped property over MIoT', async () => {
      await poll({});
      expect(raw.call).toHaveBeenCalledWith('get_properties', [
        { did: 'battery_level', siid: 3, piid: 1 },
        { did: 'charging_state', siid: 3, piid: 2 },
        { did: 'device_fault', siid: 2, piid: 2 },
        { did: 'device_status', siid: 2, piid: 1 },
        { did: 'operating_mode', siid: 4, piid: 1 },
        { did: 'cleaning_mode', siid: 4, piid: 4 },
        { did: 'water_flow', siid: 4, piid: 5 },
      ]);
    });

    test('ignores the properties the robot failed to report', async () => {
      raw.call.mockResolvedValueOnce([
        { did: 'battery_level', code: 0, value: 55 },
        { did: 'cleaning_mode', code: -4004, value: null },
      ] as never);
      await device.poll();
      expect(device.properties).toStrictEqual({ battery_level: 55 });
    });

    test('maps the MIoT values onto the state the accessory understands', async () => {
      await poll({ device_status: 1, charging_state: 2, battery_level: 42, cleaning_mode: 2, water_flow: 3, device_fault: 0 });

      await expect(device.state()).resolves.toStrictEqual({
        state: 'cleaning',
        batteryLevel: 42,
        charging: false,
        cleaning: true,
        in_returning: false,
        fanSpeed: 2,
        water_box_mode: 3,
        error: 0,
      });
    });

    test.each([
      [1, 'cleaning', true],
      [2, 'idle', false],
      [3, 'paused', false],
      [4, 'error', false],
      [5, 'returning', false],
      [6, 'charging', false],
      [7, 'mopping', true],
      [8, 'drying', false],
      [9, 'washing', false],
      [10, 'returning-washing', false],
      [11, 'building', true],
      [12, 'sweeping-and-mopping', true],
      [13, 'fully-charged', false],
      [14, 'updating', false],
      [99, 'idle', false],
    ])('device_status %s is reported as %s', async (deviceStatus, expectedState, cleaning) => {
      await poll({ device_status: deviceStatus });

      const state = await device.state();
      expect(state.state).toBe(expectedState);
      expect(state.cleaning).toBe(cleaning);
    });

    test.each([
      [5, true],
      [10, true],
      [1, false],
    ])('device_status %s reports in_returning as %s', async (deviceStatus, expected) => {
      await poll({ device_status: deviceStatus });
      await expect(device.state()).resolves.toEqual(expect.objectContaining({ in_returning: expected }));
    });

    test.each([
      [1, true],
      [2, false],
      [4, true],
      [5, false],
      [99, false],
    ])('charging_state %s is reported as %s', async (chargingState, expected) => {
      await poll({ charging_state: chargingState });
      await expect(device.state()).resolves.toEqual(expect.objectContaining({ charging: expected }));
    });

    test('reports a full battery on the charger as fully-charged', async () => {
      await poll({ device_status: 6, charging_state: 1, battery_level: 100 });
      await expect(device.state()).resolves.toEqual(expect.objectContaining({ state: 'fully-charged' }));
    });

    test('reports the fault, and reports it as cleared once it goes away', async () => {
      await poll({ device_status: 4, device_fault: 9 });
      await expect(device.state()).resolves.toEqual(expect.objectContaining({ error: 9 }));

      await poll({ device_status: 2, device_fault: 0 });
      await expect(device.state()).resolves.toEqual(expect.objectContaining({ error: 0 }));
    });

    test('exposes the aliases the accessory reads', async () => {
      await poll({ device_status: 7, battery_level: 42, cleaning_mode: 2, water_flow: 3 });

      expect(device.property('state')).toBe('mopping');
      expect(device.property('batteryLevel')).toBe(42);
      expect(device.property('fanSpeed')).toBe(2);
      expect(device.property('water_box_mode')).toBe(3);
      expect(device.property('operating_mode')).toBeUndefined();
    });
  });

  describe('commands', () => {
    test.each([
      ['activateCleaning', 'start_clean', { siid: 4, aiid: 1 }],
      ['deactivateCleaning', 'stop_clean', { siid: 4, aiid: 2 }],
      ['pause', 'stop_clean', { siid: 4, aiid: 2 }],
      ['find', 'locate', { siid: 7, aiid: 1 }],
    ] as const)('%s calls the %s action', async (method, action, spec) => {
      await device[method]();
      expect(raw.call).toHaveBeenCalledWith('action', { did: action, ...spec, in: [] });
    });

    describe('activateCharging', () => {
      /**
       * @returns {string[]} The calls the robot received, in order.
       */
      const calledActions = (): string[] => raw.call.mock.calls.map(([, args]) => (args as { did: string }).did);

      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      test('stops the cleaning and waits before sending the robot home', async () => {
        const charging = device.activateCharging();
        await jest.advanceTimersByTimeAsync(0);
        // The robot ignores `home` while it is still cleaning or paused.
        expect(calledActions()).toStrictEqual(['stop_clean']);

        await jest.advanceTimersByTimeAsync(1000);
        await charging;
        expect(calledActions()).toStrictEqual(['stop_clean', 'home']);
      });

      test('still goes home when the robot refuses to stop', async () => {
        raw.call.mockRejectedValueOnce(new Error('Could not complete call to device') as never);

        const charging = device.activateCharging();
        await jest.advanceTimersByTimeAsync(1000);
        await charging;

        expect(calledActions()).toStrictEqual(['stop_clean', 'home']);
        expect(log.debug).toHaveBeenCalledWith('dreame | stop_clean before home failed: Error: Could not complete call to device');
      });
    });

    test('changeFanSpeed sets cleaning_mode', async () => {
      await device.changeFanSpeed(2);
      expect(raw.call).toHaveBeenCalledWith('set_properties', [{ did: 'cleaning_mode', siid: 4, piid: 4, value: 2 }]);
    });

    test('changeFanSpeed ignores the "off" level, which the robot does not have', async () => {
      await device.changeFanSpeed(-1);
      expect(raw.call).not.toHaveBeenCalled();
    });

    test('setWaterBoxMode sets water_flow', async () => {
      await device.setWaterBoxMode(3);
      expect(raw.call).toHaveBeenCalledWith('set_properties', [{ did: 'water_flow', siid: 4, piid: 5, value: 3 }]);
    });

    test('setWaterBoxMode reports that the robot has no "water off" level instead of silently dropping it', async () => {
      await device.setWaterBoxMode(0);
      expect(raw.call).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith('dreame | dreame.vacuum.p2008 has no "water off" level, keeping the current one');
    });
  });

  describe('refused calls', () => {
    // MIoT answers a rejected command with a non-zero code instead of failing the request.
    test('an action the robot refused is reported as an error', async () => {
      raw.call.mockResolvedValueOnce({ did: 'start_clean', code: -5 } as never);
      await expect(device.activateCleaning()).rejects.toThrow('The robot refused "start_clean" (code -5)');
    });

    test('a property the robot refused is reported as an error', async () => {
      raw.call.mockResolvedValueOnce([{ did: 'water_flow', code: -4004 }] as never);
      await expect(device.setWaterBoxMode(3)).rejects.toThrow('The robot refused "water_flow" (code -4004)');
    });

    test('a successful call is not reported as an error', async () => {
      raw.call.mockResolvedValueOnce({ did: 'start_clean', code: 0 } as never);
      await expect(device.activateCleaning()).resolves.toStrictEqual({ did: 'start_clean', code: 0 });
    });
  });

  describe('device info', () => {
    test('strips the separators Matter rejects from the serial number', async () => {
      raw.call.mockResolvedValueOnce({ mac: 'AA:BB:CC:DD:EE:FF', fw_ver: '1.2.3' } as never);
      await expect(device.getSerialNumber()).resolves.toBe('AABBCCDDEEFF');
    });

    test('falls back to the device id when there is no mac', async () => {
      raw.call.mockResolvedValueOnce({ did: '123456789' } as never);
      await expect(device.getSerialNumber()).resolves.toBe('123456789');
    });

    test('reports the firmware version', async () => {
      raw.call.mockResolvedValueOnce({ fw_ver: '1.2.3' } as never);
      await expect(device.getDeviceInfo()).resolves.toStrictEqual({ fw_ver: '1.2.3' });
    });

    test('survives miIO.info failing', async () => {
      raw.call.mockRejectedValue(new Error('user ack timeout') as never);

      await expect(device.getSerialNumber()).resolves.toBe('Unknown');
      await expect(device.getDeviceInfo()).resolves.toStrictEqual({ fw_ver: 'Unknown' });
      expect(log.debug).toHaveBeenCalledWith('dreame | miIO.info failed: Error: user ack timeout');
    });
  });

  describe('plumbing', () => {
    test('reports itself as a vacuum and exposes the underlying handle', () => {
      expect(device.matches('type:vaccuum')).toBe(true);
      expect(device.miioModel).toBe('dreame.vacuum.p2008');
      expect(device.handle).toBe(raw.handle);
    });

    test('destroys the wrapped device', () => {
      device.destroy();
      expect(raw.destroy).toHaveBeenCalled();
    });
  });
});
