import { jest } from '@jest/globals';
import type { Logger } from 'matterbridge/logger';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { PowerSource, RvcCleanMode, RvcOperationalState, RvcRunMode, ServiceArea } from 'matterbridge/matter/clusters';
import { MatterbridgeServiceAreaServer, type CommandHandlerPayload } from 'matterbridge';

import { deviceManagerMock, findSpeedModesMock } from './vacuum_device_accessory.test.mock.js';
import type { VacuumDeviceAccessory } from './vacuum_device_accessory.js';
import { speedmodes } from './models/speedmodes.js';
import { watermodes } from './models/watermodes.js';

describe('VacuumDeviceAccessory', () => {
  let deviceAccessory: VacuumDeviceAccessory;
  let logger: Logger;

  beforeEach(async () => {
    logger = {
      debug: jest.fn(),
      notice: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      log: jest.fn(),
    };

    deviceManagerMock.device.getSerialNumber.mockResolvedValue('serial-number');
    deviceManagerMock.device.getDeviceInfo.mockResolvedValue({ fw_ver: '1.0.0' });

    const { VacuumDeviceAccessory } = await import('./vacuum_device_accessory.js');
    deviceAccessory = new VacuumDeviceAccessory({ name: 'Test Vacuum' }, logger);
  });

  afterEach(() => {
    deviceAccessory.stop();
    jest.clearAllMocks();
  });

  describe('initializeMatterbridgeEndpoint', () => {
    test('should return an endpoint of type RVC', async () => {
      const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();

      deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);

      await expect(endpointPromise).resolves.toBeInstanceOf(RoboticVacuumCleaner);
    });

    test('should fail to retrieve serial and fw', async () => {
      deviceManagerMock.device.getSerialNumber.mockRejectedValue(new Error('Failed to retrieve serial number'));
      deviceManagerMock.device.getDeviceInfo.mockRejectedValue(new Error('Failed to retrieve firmware version'));

      const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();

      deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);

      await expect(endpointPromise).resolves.toBeInstanceOf(RoboticVacuumCleaner);
    });

    test('should not expose any service area', async () => {
      const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();

      deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);

      const endpoint = await endpointPromise;
      expect(endpoint).toBeInstanceOf(RoboticVacuumCleaner);
      expect(endpoint.behaviors.optionsFor(MatterbridgeServiceAreaServer.with(ServiceArea.Feature.Maps))).toMatchInlineSnapshot(`
        {
          "currentArea": null,
          "estimatedEndTime": null,
          "selectedAreas": [],
          "supportedAreas": [],
          "supportedMaps": [],
        }
      `);
      expect(deviceManagerMock.device.getRoomMap).not.toHaveBeenCalled();
      expect(deviceManagerMock.device.getTimer).not.toHaveBeenCalled();
    });

    test('should stop the device manager when the destroying lifecycle triggers', async () => {
      const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();

      deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);

      const endpoint = await endpointPromise;
      expect(endpoint).toBeInstanceOf(RoboticVacuumCleaner);
      endpoint.lifecycle.destroying.emit();
      expect(deviceManagerMock.stop).toHaveBeenCalledTimes(1);
    });

    describe('command handlers', () => {
      let endpoint: RoboticVacuumCleaner;

      beforeEach(async () => {
        const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();
        deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);
        endpoint = (await endpointPromise) as RoboticVacuumCleaner;
      });

      describe('changeToMode', () => {
        test('should have a changeToMode handler', async () => {
          expect(endpoint.commandHandler.hasHandler('RvcCleanMode.changeToMode')).toBe(true);
          expect(endpoint.commandHandler.hasHandler('RvcRunMode.changeToMode')).toBe(true);
        });

        describe('RvcCleanMode.changeToMode', () => {
          test('sets the fan speed (but not the water level)', async () => {
            endpoint.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 1 } } as unknown as CommandHandlerPayload<'RvcCleanMode.changeToMode'>);
            expect(deviceManagerMock.device.changeFanSpeed).toHaveBeenCalledWith(105);
            expect(deviceManagerMock.device.setWaterBoxMode).not.toHaveBeenCalled();
          });

          test('sets the fan speed and the water level to off (for a supported model)', async () => {
            findSpeedModesMock.mockReturnValueOnce({
              speed: speedmodes.gen2,
              waterspeed: watermodes.gen1,
            });

            const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();
            deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);
            endpoint = (await endpointPromise) as RoboticVacuumCleaner;

            endpoint.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 1 } } as unknown as CommandHandlerPayload<'RvcCleanMode.changeToMode'>);
            await Promise.resolve(); // Just waiting for the pending promises to run
            expect(deviceManagerMock.device.changeFanSpeed).toHaveBeenCalledWith(105);
            expect(deviceManagerMock.device.setWaterBoxMode).toHaveBeenCalledWith(200);
          });
        });

        describe('RvcRunMode.changeToMode', () => {
          test('on Idle, it does nothing', async () => {
            endpoint.commandHandler.executeHandler('RvcRunMode.changeToMode', { request: { newMode: 1 } } as unknown as CommandHandlerPayload<'RvcRunMode.changeToMode'>);
            expect(logger.warn).not.toHaveBeenCalled();
          });

          test('on unknown mode, it logs a warning', async () => {
            endpoint.commandHandler.executeHandler('RvcRunMode.changeToMode', { request: { newMode: 3 } } as unknown as CommandHandlerPayload<'RvcRunMode.changeToMode'>);
            expect(logger.warn).toHaveBeenCalledWith('[Name=Test Vacuum][Model=unknown] Unknown mode 3');
          });

          test('on Cleaning, it starts a full cleaning', async () => {
            endpoint.commandHandler.executeHandler('RvcRunMode.changeToMode', { request: { newMode: 2 } } as unknown as CommandHandlerPayload<'RvcRunMode.changeToMode'>);
            expect(logger.info).toHaveBeenCalledWith('[Name=Test Vacuum][Model=unknown] Initiating full cleaning...');
            expect(deviceManagerMock.device.activateCleaning).toHaveBeenCalled();
            expect(deviceManagerMock.device.cleanRooms).not.toHaveBeenCalled();
          });
        });
      });

      describe('stop', () => {
        test('calls deactivate cleaning when triggered', async () => {
          endpoint.commandHandler.executeHandler('stop', { request: {} } as unknown as CommandHandlerPayload<'stop'>);
          expect(deviceManagerMock.device.deactivateCleaning).toHaveBeenCalled();
        });
      });

      describe('pause', () => {
        test('pauses the current cleaning', async () => {
          endpoint.commandHandler.executeHandler('pause', { request: {} } as unknown as CommandHandlerPayload<'pause'>);
          expect(deviceManagerMock.device.pause).toHaveBeenCalled();
        });
      });

      describe('resume', () => {
        test('resumes the current cleaning', async () => {
          endpoint.commandHandler.executeHandler('resume', { request: {} } as unknown as CommandHandlerPayload<'resume'>);
          expect(deviceManagerMock.device.activateCleaning).toHaveBeenCalled();
          expect(deviceManagerMock.device.resumeCleanRooms).not.toHaveBeenCalled();
        });
      });

      describe('goHome', () => {
        test('sends the RVC to the charger without writing to the cluster it is called from', async () => {
          const updateAttributeSpy = jest.spyOn(endpoint, 'updateAttribute').mockResolvedValue(true);

          endpoint.commandHandler.executeHandler('goHome', { request: {} } as unknown as CommandHandlerPayload<'goHome'>);
          await Promise.resolve(); // Just waiting for the pending promises to run

          expect(deviceManagerMock.device.activateCharging).toHaveBeenCalled();
          // Writing an attribute of the cluster being commanded deadlocks the command.
          expect(updateAttributeSpy).not.toHaveBeenCalled();
        });
      });

      describe('identify', () => {
        test('triggers the findme action', async () => {
          endpoint.commandHandler.executeHandler('identify', { request: {} } as unknown as CommandHandlerPayload<'identify'>);
          expect(deviceManagerMock.device.find).toHaveBeenCalled();
        });
      });

      describe('selectAreas', () => {
        test('is not registered, as no areas are exposed', () => {
          expect(endpoint.commandHandler.hasHandler('selectAreas')).toBe(false);
        });
      });
    });
  });

  describe('postRegister', () => {
    let endpoint: RoboticVacuumCleaner;
    let updateAttributeSpy: jest.SpiedFunction<typeof endpoint.updateAttribute>;

    beforeEach(async () => {
      findSpeedModesMock.mockReturnValueOnce({
        speed: speedmodes.gen2,
        waterspeed: watermodes.gen1,
      });

      const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();
      deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);
      endpoint = (await endpointPromise) as RoboticVacuumCleaner;
      updateAttributeSpy = jest.spyOn(endpoint, 'updateAttribute').mockResolvedValue(true);
    });

    test('does not touch the service area attributes', async () => {
      await deviceAccessory.postRegister();
      expect(updateAttributeSpy).not.toHaveBeenCalled();
    });

    describe('clean modes on a model whose water level has no "off" value', () => {
      // Dreame robots always report a water level (1-3), so the exact (suction, water) pair the
      // modes are built from never matches: the level that identifies what the robot is doing wins.
      beforeEach(async () => {
        findSpeedModesMock.mockReturnValueOnce({ speed: speedmodes.dreame, waterspeed: watermodes.dreame });

        const endpointPromise = deviceAccessory.initializeMatterbridgeEndpoint();
        deviceManagerMock.deviceConnected$.next(deviceManagerMock.device);
        endpoint = (await endpointPromise) as RoboticVacuumCleaner;
        updateAttributeSpy = jest.spyOn(endpoint, 'updateAttribute').mockResolvedValue(true);

        await deviceAccessory.postRegister();
        updateAttributeSpy.mockClear();
      });

      test('reports the suction power while vacuuming', async () => {
        deviceManagerMock.property.mockReturnValueOnce(2); // water_box_mode
        deviceManagerMock.property.mockReturnValueOnce('cleaning'); // state

        deviceManagerMock.stateChanged$.next({ key: 'fanSpeed', value: 2 });
        await Promise.resolve(); // Just waiting for the pending promises to run

        // "Strong Vacuum"
        expect(updateAttributeSpy).toHaveBeenCalledWith(RvcCleanMode.Cluster.id, 'currentMode', 3);
      });

      test('reports the water level while mopping', async () => {
        deviceManagerMock.property.mockReturnValueOnce(1); // fanSpeed
        deviceManagerMock.property.mockReturnValueOnce('mopping'); // state

        deviceManagerMock.stateChanged$.next({ key: 'water_box_mode', value: 3 });
        await Promise.resolve(); // Just waiting for the pending promises to run

        // "High Mop"
        expect(updateAttributeSpy).toHaveBeenCalledWith(RvcCleanMode.Cluster.id, 'currentMode', 7);
      });
    });

    describe('stateChangedHandlers', () => {
      beforeEach(async () => {
        await deviceAccessory.postRegister();
        updateAttributeSpy.mockClear();
      });

      describe('batteryLevel', () => {
        test('updates the battery level', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'batteryLevel', value: 100 });
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledTimes(2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batPercentRemaining', 200);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeLevel', PowerSource.BatChargeLevel.Ok);
        });

        test('updates the battery level (<20% - Warning)', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'batteryLevel', value: 10 });
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledTimes(2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batPercentRemaining', 20);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeLevel', PowerSource.BatChargeLevel.Warning);
        });
      });

      describe('charging', () => {
        test('when charging == true', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'charging', value: true });
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledTimes(2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeState', PowerSource.BatChargeState.IsCharging);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Charging);
        });

        test('when charging == true and battery level is 100%', async () => {
          deviceManagerMock.property.mockReturnValueOnce(100);
          deviceManagerMock.stateChanged$.next({ key: 'charging', value: true });
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledTimes(2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeState', PowerSource.BatChargeState.IsAtFullCharge);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
        });

        test('when charging == false', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'charging', value: false });
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeState', PowerSource.BatChargeState.IsNotCharging);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(1);
        });
      });

      describe('cleaning/cleaningMode', () => {
        test.each([
          ['cleaning', true],
          ['cleaningMode', 'cleaning'],
          ['cleaningMode', 'room-cleaning'],
        ])('when %s == %s', async (key, value) => {
          deviceManagerMock.stateChanged$.next({ key, value });
          await Promise.resolve();
          expect(updateAttributeSpy).toHaveBeenCalledTimes(2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
        });

        test('when cleaningMode == 1 but the state is "paused"', async () => {
          deviceManagerMock.property.mockReturnValueOnce('paused');
          deviceManagerMock.stateChanged$.next({ key: 'cleaningMode', value: 'cleaning' });
          await Promise.resolve();
          expect(updateAttributeSpy).toHaveBeenCalledTimes(1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 1);
        });

        test.each([
          ['cleaning', false],
          ['cleaningMode', 'idle'],
          ['cleaningMode', 'paused'],
        ])('when %s == %s', async (key, value) => {
          deviceManagerMock.stateChanged$.next({ key, value });
          await Promise.resolve();
          expect(updateAttributeSpy).toHaveBeenCalledTimes(1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 1);
        });
      });

      describe('in_returning', () => {
        test.each([
          ['in_returning', 1],
          ['in_returning', true],
        ])('when %s == %s', async (key, value) => {
          deviceManagerMock.stateChanged$.next({ key, value });
          await Promise.resolve();
          expect(updateAttributeSpy).toHaveBeenCalledTimes(1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
        });

        test.each([
          ['in_returning', 0],
          ['in_returning', false],
        ])('when %s == %s', async (key, value) => {
          deviceManagerMock.stateChanged$.next({ key, value });
          await Promise.resolve();
          expect(updateAttributeSpy).toHaveBeenCalledTimes(0);
        });
      });

      describe('fanSpeed', () => {
        test('when fanSpeed is known', async () => {
          deviceManagerMock.device.property.mockReturnValueOnce(200);
          deviceManagerMock.stateChanged$.next({ key: 'fanSpeed', value: 105 });
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcCleanMode.Cluster.id, 'currentMode', 1);
        });

        test('when fanSpeed is unknown', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'fanSpeed', value: 999 });
          expect(updateAttributeSpy).not.toHaveBeenCalled();
        });
      });

      describe('water_box_mode', () => {
        test('when water_box_mode is known', async () => {
          deviceManagerMock.device.property.mockReturnValueOnce(-1);
          deviceManagerMock.stateChanged$.next({ key: 'water_box_mode', value: 201 });
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcCleanMode.Cluster.id, 'currentMode', 6);
        });

        test('when water_box_mode is unknown', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'water_box_mode', value: 999 });
          expect(updateAttributeSpy).not.toHaveBeenCalled();
        });
      });

      describe('errorChanged', () => {
        test.each([
          [0, { errorStateId: RvcOperationalState.ErrorState.NoError }],
          [null, { errorStateId: RvcOperationalState.ErrorState.NoError }],
          [9, { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation, errorStateDetails: '9' }],
          [
            { id: 'id9', description: 'Install the dustbin and the filter.' },
            { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation, errorStateDetails: 'id9: Install the dustbin and the filter.' },
          ],
        ])('reports %s as the operational error', async (deviceError, expected) => {
          deviceManagerMock.errorChanged$.next(deviceError as never);
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledTimes(1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalError', expected);
        });

        test('truncates the details to the 64 characters Matter allows', async () => {
          deviceManagerMock.errorChanged$.next('a'.repeat(100) as never);
          await Promise.resolve(); // Just waiting for the pending promises to run
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalError', {
            errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation,
            errorStateDetails: 'a'.repeat(64),
          });
        });
      });

      describe('state', () => {
        const awaitNPromises = async (n: number) => {
          for (let i = 0; i < n; i++) {
            await Promise.resolve();
          }
        };

        test('unknown', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value: 'unknown' });
          const expectedCalls = 1; // The charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).toHaveBeenCalledWith('[Name=Test Vacuum][Model=unknown] Unknown state: unknown');
        });

        test('paused', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value: 'paused' });
          const expectedCalls = 3; // 2 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Paused);
        });

        test.each(['cleaning', 'spot-cleaning', 'room-cleaning', 'zone-cleaning', 'sweeping', 'mopping', 'sweeping-and-mopping', 'building'])('%s', async (value) => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value });
          const expectedCalls = 3; // 2 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 2);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
        });

        test.each(['returning', 'docking', 'returning-washing'])('%s', async (value) => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value });
          const expectedCalls = 2; // 1 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
        });

        test('error', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value: 'error' });
          const expectedCalls = 2; // 1 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
        });

        test.each(['fully-charged', 'drying', 'washing'])('%s', async (value) => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value });
          const expectedCalls = 2; // 1 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
        });

        test.each(['charging-error'])('%s', async (value) => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value });
          const expectedCalls = 3; // 2 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalError', {
            errorStateId: RvcOperationalState.ErrorState.FailedToFindChargingDock,
          });
        });

        test.each(['initializing', 'idle', 'sleeping', 'updating'])('%s', async (value) => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value });
          const expectedCalls = 3; // 2 + the charging update.
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcRunMode.Cluster.id, 'currentMode', 1);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Stopped);
        });

        test('charging', async () => {
          deviceManagerMock.stateChanged$.next({ key: 'state', value: 'charging' });
          const expectedCalls = 2; // the charging "true" updates (2).
          await awaitNPromises(expectedCalls + 1);
          expect(updateAttributeSpy).toHaveBeenCalledTimes(expectedCalls);
          expect(logger.warn).not.toHaveBeenCalled();
          expect(updateAttributeSpy).toHaveBeenCalledWith(PowerSource.Cluster.id, 'batChargeState', PowerSource.BatChargeState.IsCharging);
          expect(updateAttributeSpy).toHaveBeenCalledWith(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Charging);
        });
      });
    });
  });
});
