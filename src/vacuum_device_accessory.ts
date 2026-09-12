import { MatterbridgeEndpoint } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import type { Logger } from 'matterbridge/logger';
import { firstValueFrom, mergeMap, Subject, takeUntil } from 'rxjs';
import { PowerSource, RvcRunMode, RvcCleanMode, RvcOperationalState } from 'matterbridge/matter/clusters';

import { applyConfigDefaults, type Config } from './services/config_service.js';
import { DeviceManager } from './services/device_manager.js';
import { getLogger, type ModelLogger } from './utils/logger.js';
import { findSpeedModes } from './utils/find_speed_modes.js';
import type { ModelDefinition } from './models/types.js';
import { MODELS } from './models/models.js';

type SupportedCleanMode = RvcCleanMode.ModeOption & { miLevels: { vacuum: number; mop?: number } };

const SUPPORTED_MODES: RvcRunMode.ModeOption[] = [
  { label: 'Idle', mode: 1, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
  { label: 'Cleaning', mode: 2, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },

  // I noticed that the matterbridge code has hardcoded 1 and 2 for Idle and Cleaning.
  // However, upgrading from a pre-existing version will fail if 0 is not a valid mode (because of its persisted state).
  // TODO: remove it in a few versions.
  { label: 'Deprecated Idle', mode: 0, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
];

/** States in which the water level, and not the suction power, identifies what the robot is doing. */
const MOPPING_STATES = ['mopping', 'sweeping-and-mopping'];

const SUPPORTED_OPERATIONAL_STATES: RvcOperationalState.OperationalStateStruct[] = [
  { operationalStateId: RvcOperationalState.OperationalState.Docked },
  { operationalStateId: RvcOperationalState.OperationalState.SeekingCharger },
  { operationalStateId: RvcOperationalState.OperationalState.Charging },
  { operationalStateId: RvcOperationalState.OperationalState.Running },
  { operationalStateId: RvcOperationalState.OperationalState.Stopped },
  { operationalStateId: RvcOperationalState.OperationalState.Paused },
  { operationalStateId: RvcOperationalState.OperationalState.Error },
];

export class VacuumDeviceAccessory {
  private readonly config: Config;
  private readonly log: ModelLogger;
  private readonly deviceManager: DeviceManager;
  private readonly stop$ = new Subject<void>();
  private endpoint?: RoboticVacuumCleaner;
  private modelSpeeds: ModelDefinition = MODELS.default[0];

  constructor(config: Partial<Config>, logger: Logger) {
    this.config = applyConfigDefaults(config);
    this.log = getLogger(logger, this.config);
    this.deviceManager = new DeviceManager(this.log, this.config);
  }

  public async initializeMatterbridgeEndpoint(): Promise<MatterbridgeEndpoint> {
    this.log.info(`Waiting for the connection to the vacuum to be established...`);

    // Wait for the device to be connected
    await firstValueFrom(this.deviceManager.deviceConnected$);
    this.log.info(`Connected to device!`);

    const serialNumber = await this.deviceManager.device.getSerialNumber().catch((error) => {
      this.log.warn(`Failed to retrieve serial number: ${error}`);
      return 'Unknown';
    });
    const deviceInfo = await this.deviceManager.device.getDeviceInfo().catch((error) => {
      this.log.warn(`Failed to retrieve device info: ${error}`);
      return { fw_ver: 'Unknown' };
    });
    this.log.info(`Serial number: ${serialNumber}`);
    this.log.info(`Firmware: ${deviceInfo.fw_ver}`);

    this.modelSpeeds = findSpeedModes(this.deviceManager.model, deviceInfo.fw_ver);
    const supportedCleanModes = this.supportedCleanModes;

    this.endpoint = new RoboticVacuumCleaner(
      this.config.name,
      serialNumber,
      'server', // Use 'server' or 'matter' if you want Apple Home compatibility.
      // RvcRunMode
      SUPPORTED_MODES[0].mode,
      SUPPORTED_MODES,
      // RvcCleanMode
      supportedCleanModes[0].mode,
      supportedCleanModes,
      undefined,
      undefined,
      RvcOperationalState.OperationalState.Docked,
      SUPPORTED_OPERATIONAL_STATES,
      // Rooms are not exposed: no model covered by this plugin can be told to clean a single
      // segment over MIoT, so advertising service areas only produces controls that do not work.
      [],
      [],
      null,
    );

    this.endpoint.vendorName = 'Xiaomi';
    this.endpoint.productName = this.deviceManager.model;
    this.endpoint.softwareVersionString = deviceInfo.fw_ver;
    this.endpoint.productUrl = 'https://github.com/lirik44/matterbridge-xiaomi-dreame';
    this.endpoint.hardwareVersionString = this.deviceManager.model;

    this.endpoint.lifecycle.destroying.on(() => {
      this.deviceManager.stop();
    });

    this.endpoint.addCommandHandler('RvcCleanMode.changeToMode', async (data) => {
      // Defines the selected cleaning mode (mop or vacuum)
      const newCleanMode = supportedCleanModes[data.request.newMode - 1];
      await this.deviceManager.device.changeFanSpeed(newCleanMode.miLevels.vacuum);
      if (typeof newCleanMode.miLevels.mop === 'number') {
        await this.deviceManager.device.setWaterBoxMode(newCleanMode.miLevels.mop);
      }
    });

    this.endpoint.addCommandHandler('RvcRunMode.changeToMode', async (data) => {
      // Actual start command
      switch (data.request.newMode) {
        case 1: // Idle
          // TODO: Confirm what to do here
          // await this.deviceManager.device.pause();
          break;
        case 2:
          // Cleaning
          this.log.info(`Initiating full cleaning...`);
          await this.deviceManager.device.activateCleaning();
          break;
        default:
          this.log.warn(`Unknown mode ${data.request.newMode}`);
          break;
      }
    });

    this.endpoint.addCommandHandler('stop', async () => {
      await this.deviceManager.device.deactivateCleaning();
    });
    this.endpoint.addCommandHandler('pause', async () => {
      await this.deviceManager.device.pause();
    });
    this.endpoint.addCommandHandler('resume', async () => {
      await this.deviceManager.device.activateCleaning();
    });
    this.endpoint.addCommandHandler('goHome', async () => {
      // Never write an attribute of the cluster being commanded from inside its own handler:
      // matter.js opens a transaction for the write that waits for the lock the command itself
      // holds, the command never returns and the controller reports the vacuum as unresponsive.
      // Matterbridge sets the operational state once this resolves, and the next poll reports
      // what the robot is actually doing.
      await this.deviceManager.device.activateCharging();
    });
    this.endpoint.addCommandHandler('identify', async () => {
      await this.deviceManager.device.find();
    });
    return this.endpoint;
  }

  public async postRegister() {
    this.deviceManager.stateChanged$
      .pipe(
        mergeMap(async ({ key, value }) => {
          this.log.debug(`Device state changed: ${key} = ${value}`);

          if (key in this.stateChangedHandlers) {
            // @ts-expect-error key is a string, this.stateChangedHandlers is not an index signature, and value is unknown
            await this.stateChangedHandlers[key](value);
          }
        }),
        takeUntil(this.stop$),
      )
      .subscribe();

    this.deviceManager.errorChanged$
      .pipe(
        mergeMap(async (error) => {
          const operationalError = toOperationalError(error);
          this.log.debug(`Device error changed: ${JSON.stringify(error)}`);
          // Only the error details are reported here: the operational state itself is driven by
          // the `state` handler below, which knows whether the robot stopped because of the fault.
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalError', operationalError);
        }),
        takeUntil(this.stop$),
      )
      .subscribe();
  }

  public stop() {
    this.deviceManager.stop();
    this.stop$.next();
    this.stop$.complete();
  }

  private readonly stateChangedHandlers = {
    batteryLevel: async (level: number) => {
      this.log.debug(`Battery level: ${level}`);
      await this.endpoint?.updateAttribute(PowerSource.Cluster.id, 'batPercentRemaining', level * 2);
      await this.endpoint?.updateAttribute(PowerSource.Cluster.id, 'batChargeLevel', getBatteryChargeLevel(level));
    },
    charging: async (charging: boolean) => {
      const isCharging = charging === true;
      const isChargingAndFull = isCharging && this.deviceManager.property<number>('batteryLevel') === 100;

      await this.endpoint?.updateAttribute(
        PowerSource.Cluster.id,
        'batChargeState',
        isChargingAndFull ? PowerSource.BatChargeState.IsAtFullCharge : isCharging ? PowerSource.BatChargeState.IsCharging : PowerSource.BatChargeState.IsNotCharging,
      );
      if (isChargingAndFull) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
      } else if (isCharging) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Charging);
      }
    },
    cleaning: async (cleaning: boolean) => {
      if (this.deviceManager.property('state') === 'error' || this.deviceManager.property('state') === 'paused') {
        return; // Do not update the state if there is an error or paused
      }
      await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', cleaning === false ? SUPPORTED_MODES[0].mode : SUPPORTED_MODES[1].mode);
      if (cleaning) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
      }
    },
    cleaningMode: async (cleaningMode: string) => {
      if (this.deviceManager.property<string>('state') === 'paused') {
        await this.stateChangedHandlers.cleaning(false);
      } else {
        await this.stateChangedHandlers.cleaning(['cleaning', 'zone-cleaning', 'spot-cleaning', 'room-cleaning', 'manual-cleaning'].includes(cleaningMode));
      }
    },
    in_returning: async (inReturning: number) => {
      if (inReturning) {
        await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
      }
    },
    fanSpeed: async (miLevel: number) => {
      await this.updateCleanMode(miLevel, this.deviceManager.property<number>('water_box_mode'));
    },
    water_box_mode: async (miLevel: number) => {
      await this.updateCleanMode(this.deviceManager.property<number>('fanSpeed'), miLevel);
    },
    state: async (state: string) => {
      await this.stateChangedHandlers.charging(state === 'charging');
      switch (state) {
        case 'charging':
          // No need to call it again, as it's called 3 lines above.
          // await this.stateChangedHandlers.charging(true);
          break;

        case 'paused':
          await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[0].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Paused);
          break;

        case 'cleaning':
        case 'spot-cleaning':
        case 'room-cleaning':
        case 'zone-cleaning':
        case 'sweeping':
        case 'mopping':
        case 'sweeping-and-mopping':
        case 'building': // Mapping run
          await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[1].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Running);
          break;

        case 'returning': // We might want to emit the optional RvcOperationalState.Cluster.events.operationCompletion when completed cleaning (or when errors occur)
        case 'docking':
        case 'returning-washing':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.SeekingCharger);
          break;

        case 'error':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
          // await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalError', RvcOperationalState.ErrorState.CommandInvalidInState);
          // We might want to emit the optional RvcOperationalState.Cluster.events.operationCompletion when completed cleaning (or when errors occur)
          break;

        // Drying and washing both happen at the dock, with the robot unavailable until they finish.
        case 'fully-charged':
        case 'drying':
        case 'washing':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Docked);
          break;

        case 'charging-error':
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Error);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalError', { errorStateId: RvcOperationalState.ErrorState.FailedToFindChargingDock });
          break;

        case 'initializing':
        case 'idle':
        case 'sleeping':
        case 'updating':
          await this.endpoint?.updateAttribute(RvcRunMode.Cluster.id, 'currentMode', SUPPORTED_MODES[0].mode);
          await this.endpoint?.updateAttribute(RvcOperationalState.Cluster.id, 'operationalState', RvcOperationalState.OperationalState.Stopped);
          break;

        default:
          this.log.warn(`Unknown state: ${state}`);
          break;
      }
    },
  };

  /**
   * Reports the clean mode matching the levels the robot is currently running with.
   *
   * @param {number?} vacuumLevel The suction power reported by the robot.
   * @param {number?} mopLevel The water level reported by the robot.
   */
  private async updateCleanMode(vacuumLevel?: number, mopLevel?: number) {
    const cleanMode = this.findCleanMode(vacuumLevel, mopLevel);
    if (cleanMode) {
      await this.endpoint?.updateAttribute(RvcCleanMode.Cluster.id, 'currentMode', cleanMode.mode);
    }
  }

  /**
   * Finds the clean mode matching the levels reported by the robot.
   *
   * Each mode flattens a (suction, water) pair, so the exact pair is looked up first. Some models
   * (Dreame) always report a water level because theirs has no "off" value: the pair then never
   * matches, and the level that identifies what the robot is doing wins instead — the water level
   * while it mops, the suction power otherwise.
   *
   * @param {number?} vacuumLevel The suction power reported by the robot.
   * @param {number?} mopLevel The water level reported by the robot.
   * @returns {SupportedCleanMode?} The matching clean mode, if any.
   */
  private findCleanMode(vacuumLevel?: number, mopLevel?: number): SupportedCleanMode | undefined {
    const cleanModes = this.supportedCleanModes;

    const exactMatch = cleanModes.find(({ miLevels }) => miLevels.vacuum === vacuumLevel && miLevels.mop === mopLevel);
    if (exactMatch) {
      return exactMatch;
    }

    const byMopLevel = cleanModes.find(({ miLevels }) => miLevels.mop === mopLevel);
    const byVacuumLevel = cleanModes.find(({ miLevels }) => miLevels.vacuum === vacuumLevel);

    return this.isMopping ? (byMopLevel ?? byVacuumLevel) : (byVacuumLevel ?? byMopLevel);
  }

  private get isMopping(): boolean {
    return MOPPING_STATES.includes(this.deviceManager.property<string>('state') as string);
  }

  private get supportedCleanModes(): Array<SupportedCleanMode> {
    const [vacuumSpeedOff, ...vacuumSpeedModes] = this.modelSpeeds.speed;
    const [mopSpeedOff, ...mopSpeedModes] = this.modelSpeeds.waterspeed ?? [];

    let mode = 1;

    const supportedCleanModes: SupportedCleanMode[] = vacuumSpeedModes.map(({ name, miLevel, label }) => ({
      label: `${name} Vacuum`,
      mode: mode++,
      modeTags: [
        // If the label is "Mop", do not add "Vacuum" as a mode tag.
        ...(label === RvcCleanMode.ModeTag.Mop ? [] : [{ value: RvcCleanMode.ModeTag.Vacuum }]),
        { value: label },
      ],
      miLevels: {
        vacuum: miLevel,
        mop: mopSpeedOff?.miLevel,
      },
    }));

    mopSpeedModes.forEach(({ name, miLevel, label }) => {
      supportedCleanModes.push({
        label: `${name} Mop`,
        mode: mode++,
        modeTags: [{ value: RvcCleanMode.ModeTag.Mop }, { value: label }],
        miLevels: {
          vacuum: vacuumSpeedOff.miLevel,
          mop: miLevel,
        },
      });
    });

    return supportedCleanModes;
  }
}

/** Matter caps `ErrorStateDetails` at 64 characters. */
const MAX_ERROR_DETAILS_LENGTH = 64;

/**
 * Translates the error reported by the robot into the Matter operational error.
 *
 * The fault codes are vendor-specific (a number on Dreame, an `{ id, description }` pair on
 * Roborock), so anything unknown is reported as a generic failure carrying the original code.
 *
 * @param {unknown} error The error reported by the device, if any.
 * @returns {object} The `operationalError` attribute value.
 */
function toOperationalError(error: unknown): { errorStateId: RvcOperationalState.ErrorState; errorStateDetails?: string } {
  if (error === null || error === undefined || error === 0 || error === '') {
    return { errorStateId: RvcOperationalState.ErrorState.NoError };
  }

  const details = typeof error === 'object' ? Object.values(error).filter(Boolean).join(': ') : String(error);

  return {
    errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation,
    errorStateDetails: details.slice(0, MAX_ERROR_DETAILS_LENGTH),
  };
}

/**
 *
 * @param {number} batteryLevel The battery level in percentage
 * @returns {PowerSource.BatChargeLevel} The battery charge level (OK, Warning, Critical)
 */
function getBatteryChargeLevel(batteryLevel: number): PowerSource.BatChargeLevel {
  return batteryLevel < 10 ? PowerSource.BatChargeLevel.Critical : batteryLevel < 20 ? PowerSource.BatChargeLevel.Warning : PowerSource.BatChargeLevel.Ok;
}
