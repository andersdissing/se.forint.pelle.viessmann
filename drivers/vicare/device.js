/*
 * 
 *  Copyright (C) 2024 Per Rosengren
 *  This file is part of se.forint.pelle.viessmann project.
 * 
 *  se.forint.pelle.viessmann project is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 * 
 *  se.forint.pelle.viessmann project is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 * 
 *  You should have received a copy of the GNU General Public License
 *  along with se.forint.pelle.viessmann project.  If not, see <http://www.gnu.org/licenses/>.
 * 
 */

'use strict';

const { OAuth2Device } = require('homey-oauth2app');
const {
  FEATURES, PATHS, getCapability, getAllCapabilities, getCapabilityOptions,
} = require('./config');

module.exports = class ViessmannDevice extends OAuth2Device {

  static FEATURES = FEATURES;
  static PATHS = PATHS;
  // No static capabilities. button.refresh used to live here; removing it from
  // this list is also what retires it from already-paired devices, because the
  // cleanup pass in initializeCapabilities drops any capability that is
  // neither static nor backed by a configured feature.
  static STATIC_CAPABILITIES = [];
  // If the Viessmann API timestamp on the summary.* features stops
  // advancing for longer than this, assume the heat pump is idle and
  // force measure_power to 0. Otherwise the capability stays stuck at
  // whatever watts value was computed from the last positive delta —
  // observed: 7181 W left over from an earlier active cycle while the
  // device was actually drawing 0 W.
  static MAX_STALE_POWER_MS = 15 * 60 * 1000;

  async onOAuth2Init() {
    await this.checkUpgradeSpecifics();
    this._installationId = this.getStoreValue('installationId');
    this._gatewaySerial = this.getStoreValue('gatewaySerial');
    this._deviceId = this.getStoreValue('deviceId');
    this._roles = this.getStoreValue('roles');
    this._features = this.getStoreValue('features');
    this._constraints = this.getStoreValue('constraints');
    this._operatingModes = this.getStoreValue('operatingModes');

    if (process.env.DEBUG) {
      this.log(
        'ViessmannDevice::onOAuth2Init installationId:', this._installationId,
        'gatewaySerial:', this._gatewaySerial,
        'deviceId:', this._deviceId,
        'roles:', this._roles,
        'features:', this._features,
        'constraints:', this._constraints,
        'operatingModes:', this._operatingModes,
        'version:', this.getStoreValue('version'),
      );
    }

    this._listeners = [];

    await this.initializeCapabilities();
    await this.initializeOperatingModes();
    await this.initializeDhwModes();
    await this.registerCapabilityListeners();

    const lastMeasurePower = this.getStoreValue('lastMeasurePower');
    if (typeof lastMeasurePower === 'number') {
      await this.setCapabilityValueIfPossible('measure_power', Math.max(0, lastMeasurePower));
    }

    this.onFeaturesUpdated = this.onFeaturesUpdated.bind(this);

    const deviceKey = `${this._installationId}-${this._gatewaySerial}-${this._deviceId}`;
    await this.driver._startPolling(this, deviceKey);
  }

  async onInit() {
    await super.onInit();
    if (process.env.DEBUG) {
      this.log('[ViessmannDevice::onInit] called');
    }
  }

  async initializeCapabilities() {
    // Ensure static (non-feature-driven) capabilities are always present
    for (const cap of this.constructor.STATIC_CAPABILITIES) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }

    // Remove capabilities that are no longer in config or don't match device roles
    for (const existingCap of this.getCapabilities()) {
      if (this.constructor.STATIC_CAPABILITIES.includes(existingCap)) continue;
      let shouldKeep = false;
      for (const path of Object.values(PATHS)) {
        try {
          const capabilities = getAllCapabilities(path);
          if (capabilities.some((cap) => cap.capabilityName === existingCap) && this.hasRequiredRole(path)) {
            if (this._features.includes(path)) {
              shouldKeep = true;
              break;
            }
          }
        } catch (err) {
          continue;
        }
      }

      if (!shouldKeep) {
        await this.removeCapability(existingCap);
        this.log(`Removed capability: ${existingCap}`);
      }
    }

    // Add configured capabilities if device has required role and feature is enabled
    for (const path of Object.values(PATHS)) {
      if (!this.hasRequiredRole(path) || !this._features.includes(path)) continue;

      try {
        const capabilities = getAllCapabilities(path);
        for (const capability of capabilities) {
          if (!this.hasCapability(capability.capabilityName)) {
            // Set capability options
            let capabilityOptions = getCapabilityOptions(capability.capabilityName);

            // Update with constraints if they exist
            if (this._constraints && this._constraints[path]) {
              // For temperature/targetTemperature constraints
              const tempConstraints = this._constraints[path].temperature || this._constraints[path].targetTemperature;
              if (tempConstraints) {
                capabilityOptions = {
                  ...capabilityOptions,
                  min: tempConstraints.min,
                  max: tempConstraints.max,
                  step: tempConstraints.stepping || capabilityOptions.step || 1,
                };
              }
            }

            await this.setCapabilityOptions(capability.capabilityName, capabilityOptions);
            await this.addCapability(capability.capabilityName);
          }
        }
      } catch (err) {
        this.error(`Error handling capability for ${path}:`, err);
      }
    }
  }

  async updateCapabilityOptions() {
    const capabilities = this.getCapabilities();
    for (const capability of capabilities) {
      const capabilityOptions = getCapabilityOptions(capability);
      await this.setCapabilityOptions(capability, capabilityOptions);
    }
  }

  async initializeOperatingModes() {
    // Not that bad if this fails, we can just use the default operating modes
    try {
      const { capabilityName } = getCapability(PATHS.HEATING_CIRCUIT_0_MODE);
      const operatingModesCapOpt = this.getCapabilityOptions(capabilityName);
      const capabilityOperatingModes = operatingModesCapOpt.values;

      for (const opMode of capabilityOperatingModes) {
        if (!this._operatingModes.some((mode) => mode.id === opMode.id)) {
          capabilityOperatingModes.splice(capabilityOperatingModes.indexOf(opMode), 1);
          if (process.env.DEBUG) {
            this.log('[ViessmannDevice::onInit] Removed operating mode:', opMode);
          }
        }
      }

      for (const opMode of this._operatingModes) {
        if (!capabilityOperatingModes.some((mode) => mode.id === opMode.id)) {
          capabilityOperatingModes.push(opMode);
          if (process.env.DEBUG) {
            this.log('[ViessmannDevice::onInit] Added operating mode:', opMode);
          }
        }
      }
      operatingModesCapOpt.values = capabilityOperatingModes;
      await this.setCapabilityOptions(capabilityName, operatingModesCapOpt);
    } catch (err) {
      if (process.env.DEBUG) {
        this.log('Error initializing operating modes:', err);
      }
    }
  }

  /*
   * The hot water mode capability is declared with the union of the modes seen
   * across device generations, because a device paired on one generation must
   * not be offered another's vocabulary. The installation reports the modes it
   * actually accepts in the setMode constraints, so prune the picker down to
   * those. Same idea as initializeOperatingModes, for the dhw side.
   */
  async initializeDhwModes() {
    try {
      const { capabilityName } = getCapability(PATHS.HOT_WATER_MODE);
      if (!this.hasCapability(capabilityName)) return;

      const supported = this._constraints?.[PATHS.HOT_WATER_MODE]?.mode?.enum;
      if (!Array.isArray(supported) || supported.length === 0) return;

      // Start from the options in config, NOT from the ones already stored on
      // the device: once pruned, the stored copy has the right ids forever and
      // would never pick up a corrected label. Shallow-copy so the shared
      // config object is not mutated.
      const declared = getCapabilityOptions(capabilityName);
      const pruned = (declared.values || []).filter((value) => supported.includes(value.id));
      if (pruned.length === 0) return;

      await this.setCapabilityOptions(capabilityName, { ...declared, values: pruned });
      if (process.env.DEBUG) {
        this.log('[ViessmannDevice::initializeDhwModes] hot water modes limited to:', supported.join(', '));
      }
    } catch (err) {
      if (process.env.DEBUG) {
        this.log('Error initializing hot water modes:', err);
      }
    }
  }

  async registerCapabilityListeners() {
    for (const path of Object.values(PATHS)) {
      try {
        const capabilities = getAllCapabilities(path);

        for (const capability of capabilities) {
          // Skip if no command is defined or listener already exists
          if (!capability.command || this._listeners.includes(path)) continue;

          this.registerCapabilityListenerIfPossible(
            capability.capabilityName,
            async (value) => {
              if (process.env.DEBUG) {
                this.log(`${capability.capabilityName}:`, value);
              }

              await this.executeCommand(path, capability, value);
            },
          );

          this._listeners.push(path);
        }
      } catch (err) {
        this.error(`Error setting up listener for ${path}:`, err);
      }
    }
  }

  async executeCommand(path, capability, value) {
    try {
      const { command } = capability;

      if (command?.useValueAsCommand) {
        const mappedValue = capability.valueMapping?.[value] || value;
        await this.oAuth2Client.executeCommand({
          installationId: this._installationId,
          gatewaySerial: this._gatewaySerial,
          deviceId: this._deviceId,
          feature: path,
          command: mappedValue,
          body: {},
        });
      } else {
        const parameters = {};
        for (const [, apiParam] of Object.entries(command.parameterMapping)) {
          parameters[apiParam] = value;
        }

        this.assertParametersAllowed(path, parameters);

        await this.oAuth2Client.executeCommand({
          installationId: this._installationId,
          gatewaySerial: this._gatewaySerial,
          deviceId: this._deviceId,
          feature: path,
          command: command.name,
          body: parameters,
        });
      }
    } catch (error) {
      this.log('Error executing command:', error);
      // Keep the reason. `new Error(msg, error)` silently drops the second
      // argument — it is an options bag, not a cause — which is why every
      // failure used to reach the user as a bare "Error executing command".
      throw new Error(`Error executing command: ${error.message}`, { cause: error });
    }
    // Update every capability fed by this feature, not just the one that was
    // written. heating.dhw.operating.modes.active backs two: the picker
    // (raw id) and measure_hot_water_mode (the label used as a flow tag).
    // Updating only the picker left the tag reporting the previous mode until
    // the next poll — up to a full poll interval — so a flow that set the mode
    // and then read the tag got a stale answer.
    // setCapabilityValueIfPossible applies each capability's own valueMapping,
    // so the raw API value is the right thing to hand to all of them.
    let capabilities;
    try {
      capabilities = getAllCapabilities(path);
    } catch (err) {
      capabilities = [capability];
    }
    for (const target of capabilities) {
      if (target.derived) continue;
      await this.setCapabilityValueIfPossible(target.capabilityName, value);
    }
    return true;
  }

  /*
   * Select the Comfort / Normal / Eco temperature level for heating circuit 0.
   *
   * WHY THIS GOES THROUGH THE SCHEDULE: the obvious route —
   * heating.circuits.0.operating.programs.comfort.activate — does not exist on
   * E3 devices. There the programs are named comfortHeating / normalHeating /
   * reducedHeating and their activate/deactivate commands are reported as
   * isExecutable:false, i.e. read-only. Verified against a Vitocal 222S
   * (E3_Vitocal_16) on 2026-08-13.
   *
   * What IS writable is heating.circuits.0.heating.schedule, whose setSchedule
   * command is constrained to modes ["normal","comfort"] with
   * defaultMode "reduced". So:
   *
   *   comfort/normal -> write an all-day entry with that mode
   *   eco            -> write an empty schedule; every hour then falls back to
   *                     the constraint's defaultMode ("reduced")
   *   auto           -> put the user's own schedule back
   *
   * Because this overwrites the user's weekly program, the original is saved
   * to the device store on the first override and restored by 'auto'.
   */
  static SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  static SCHEDULE_BACKUP_KEY = 'scheduleOverride';

  async setHeatingProgram(program) {
    const path = PATHS.HEATING_CIRCUIT_0_SCHEDULE;
    const feature = await this.getScheduleFeature(path);

    const setSchedule = feature?.commands?.setSchedule;
    if (!setSchedule) {
      throw new Error(`This installation does not expose ${path}/commands/setSchedule, so the heating program cannot be changed.`);
    }
    if (setSchedule.isExecutable === false) {
      throw new Error(`${path}/commands/setSchedule is read-only on this installation.`);
    }

    const constraints = setSchedule.params?.newSchedule?.constraints || {};
    const availableModes = constraints.modes || [];
    const currentSchedule = feature.properties?.entries?.value;
    const backup = this.getStoreValue(this.constructor.SCHEDULE_BACKUP_KEY);

    let newSchedule;
    if (program === 'auto') {
      if (!backup?.original) {
        this.log('setHeatingProgram(auto): no override active, leaving the schedule untouched');
        return true;
      }
      newSchedule = backup.original;
    } else if (program === 'eco') {
      // Empty schedule -> nothing is scheduled -> defaultMode ("reduced")
      // applies around the clock. Confirmed accepted by the API.
      newSchedule = this.buildEmptySchedule();
    } else if (program === 'comfort' || program === 'normal') {
      if (availableModes.length > 0 && !availableModes.includes(program)) {
        throw new Error(`This installation only supports the schedule modes [${availableModes.join(', ')}], not "${program}".`);
      }
      newSchedule = this.buildAllDaySchedule(program);
    } else {
      throw new Error(`Unknown heating program: ${program}`);
    }

    // Save the user's own schedule before the first override, never over an
    // override we wrote ourselves.
    if (program !== 'auto' && !backup?.original && currentSchedule) {
      await this.setStoreValue(this.constructor.SCHEDULE_BACKUP_KEY, {
        original: currentSchedule,
        savedAt: new Date().toISOString(),
      });
      this.log('setHeatingProgram: saved the original weekly schedule before overriding it');
    }

    await this.oAuth2Client.executeCommand({
      installationId: this._installationId,
      gatewaySerial: this._gatewaySerial,
      deviceId: this._deviceId,
      feature: path,
      command: 'setSchedule',
      body: { newSchedule },
    });
    this.log(`setHeatingProgram: ${program} applied`);

    if (program === 'auto') {
      await this.unsetStoreValue(this.constructor.SCHEDULE_BACKUP_KEY);
      this.log('setHeatingProgram: original schedule restored, override cleared');
    }

    return true;
  }

  async getScheduleFeature(featureName) {
    const response = await this.oAuth2Client.getFeature({
      installationId: this._installationId,
      gatewaySerial: this._gatewaySerial,
      deviceId: this._deviceId,
      featureName,
    });
    // A single-feature GET returns { data: {...} }; the collection endpoint
    // returns { data: [...] }. Accept either so this keeps working if the
    // client is ever pointed at the filtered list endpoint.
    const { data } = response || {};
    if (Array.isArray(data)) {
      return data.find((f) => f.feature === featureName);
    }
    return data;
  }

  buildEmptySchedule() {
    return Object.fromEntries(this.constructor.SCHEDULE_DAYS.map((day) => [day, []]));
  }

  buildAllDaySchedule(mode) {
    const entry = [{
      mode, start: '00:00', end: '24:00', position: 0,
    }];
    return Object.fromEntries(this.constructor.SCHEDULE_DAYS.map((day) => [day, entry]));
  }

  /*
   * Flow card dropdowns are generated once for the whole app, so they offer
   * every value any device generation supports — the hot water card lists
   * eco/comfort/balanced, which an E3 heat pump rejects with a 400. The
   * installation already told us what it accepts when the device was paired,
   * so check that first and name the supported values instead of spending an
   * API call to be told no.
   */
  assertParametersAllowed(path, parameters) {
    const constraints = this._constraints && this._constraints[path];
    if (!constraints) return;

    for (const [name, value] of Object.entries(parameters)) {
      const allowed = constraints[name] && constraints[name].enum;
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(value)) {
        throw new Error(`"${value}" is not supported by this installation. Supported values: ${allowed.join(', ')}`);
      }
    }
  }

  async checkUpgradeSpecifics() {
    if (!this.getStoreValue('installationId')) {
      // 1.0.2 & 1.0.3 => 1.0.4, add roles and operatingModes and store them
      const {
        installationId, gatewaySerial, deviceId, roles, operatingModes,
      } = this.getData();
      this.setStoreValue('installationId', installationId);
      this.setStoreValue('gatewaySerial', gatewaySerial);
      this.setStoreValue('deviceId', deviceId);
      if (!roles) {
        // 1.0.2 => 1.0.4
        this.setStoreValue('roles', ['type:heating', 'type:heatpump', 'type:dhw']);
        this.setStoreValue('operatingModes', [
          { id: 'dhw', title: { en: 'Hot water' } },
          { id: 'dhwAndHeating', title: { en: 'Hot water and Heating' } },
          { id: 'standby', title: { en: 'Standby' } },
        ]);
      } else {
        // 1.0.3 => 1.0.4
        this.setStoreValue('roles', roles);
        this.setStoreValue('operatingModes', operatingModes);
      }
    }
    // started to store version in 1.0.9
    if (this.storeVersionBefore('1.0.9')) {
      this.log('Upgrading to 1.0.9');
      // add features and operating modes
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints, operatingModes } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      if (process.env.DEBUG) {
        this.log('Features:', features);
        this.log('Constraints:', constraints);
        this.log('Operating modes:', operatingModes);
      }
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      this.setStoreValue('operatingModes', operatingModes);
      await this.updateCapabilityOptions();
      this.setStoreValue('version', '1.0.9');
    }
    // 1.0.15: refresh features from API to pick up new config entries (e.g. heating.power.consumption.total)
    if (this.storeVersionBefore('1.0.15')) {
      this.log('Upgrading to 1.0.15: refreshing features from API');
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      this.setStoreValue('version', '1.0.15');
    }
    // 1.0.16: meter_power / measure_power source switched from
    // heating.power.consumption.total (whose inner `day` array can be 40+
    // hours stale) to the sum of heating.power.consumption.summary.*
    // currentDay values. Refresh _features so the new paths are recognised,
    // and reset the accumulator's per-day cache so the next poll seeds
    // cleanly from the new source instead of computing a spurious delta
    // against the old `day.value[0]` value.
    if (this.storeVersionBefore('1.0.16')) {
      this.log('Upgrading to 1.0.16: switching power source to summary.*');
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      await this.unsetStoreValue('lastDayKwh');
      await this.unsetStoreValue('lastApiTimestamp');
      this.setStoreValue('version', '1.0.16');
    }
    // 1.0.17: live measure_power derivation from compressor + fan. Refresh
    // _features so the new compressor.speed.current and primary fan paths
    // are recognised by the polling loop.
    if (this.storeVersionBefore('1.0.17')) {
      this.log('Upgrading to 1.0.17: refreshing features for live-wattage paths');
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      this.setStoreValue('version', '1.0.17');
    }
    // 1.0.18: measure_heating_program shows which temperature level the
    // circuit is on (Comfort / Normal / Eco). Refresh _features so the newly
    // configured programs.active path is recognised on devices that were
    // paired before it existed — without this the capability is never added.
    if (this.storeVersionBefore('1.0.18')) {
      this.log('Upgrading to 1.0.18: refreshing features for the heating-program capability');
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      this.setStoreValue('version', '1.0.18');
    }
    // 1.0.19: thermostat_mode.hotWater exposes heating.dhw.operating.modes.active.
    // Refresh features AND constraints — the constraints are what
    // initializeDhwModes uses to prune the mode picker to this installation.
    if (this.storeVersionBefore('1.0.19')) {
      this.log('Upgrading to 1.0.19: refreshing features for the hot water mode capability');
      const installationId = this.getStoreValue('installationId');
      const gatewaySerial = this.getStoreValue('gatewaySerial');
      const deviceId = this.getStoreValue('deviceId');
      const { features, constraints } = await this.driver._getEnabledFeaturesAndOpModes(this.oAuth2Client, installationId, gatewaySerial, deviceId);
      this.setStoreValue('features', features);
      this.setStoreValue('constraints', constraints);
      this.setStoreValue('version', '1.0.19');
    }
    // 1.0.20: measure_hot_water_mode was first shipped with uiComponent:null,
    // which left its flow tag without a value. capabilityOptions are only
    // written when a capability is added, so drop it here and let
    // initializeCapabilities add it back with the corrected options.
    if (this.storeVersionBefore('1.0.20')) {
      this.log('Upgrading to 1.0.20: re-adding measure_hot_water_mode so its flow tag carries a value');
      if (this.hasCapability('measure_hot_water_mode')) {
        await this.removeCapability('measure_hot_water_mode');
      }
      this.setStoreValue('version', '1.0.20');
    }
  }

  async onFeaturesUpdated(response, extendedResponse) {
    try {
      if (process.env.DEBUG) {
        this.log('Starting feature update processing...', 'extendedResponse:', extendedResponse);
      }
      if (extendedResponse) {
        // get all enabled features from the response
        const enabledFeatures = [];
        for (const feature of response.data) {
          if (feature.isEnabled && feature.properties?.status?.value !== 'notConnected') {
            enabledFeatures.push(feature.feature);
          }
        }
        // find features in the response that are not in the device store
        const newFeatures = enabledFeatures.filter((feature) => !this._features.includes(feature));
        if (newFeatures.length > 0) {
          this.log('New features found:', newFeatures);
          // add new features to this._features
          this._features = [...this._features, ...newFeatures];
          // update the store
          this.setStore('features', this._features);
          // Initialize capabilities and listeners
          await this.initializeCapabilities();
          await this.registerCapabilityListeners();
        }
      }

      // Helper to safely get nested property values; hoisted out of the loop so
      // the post-loop power aggregation can reuse it.
      const getValue = (obj, path) => {
        try {
          return path.split('.').reduce((acc, part) => acc && acc[part], obj);
        } catch (error) {
          if (process.env.DEBUG) {
            this.log(`Error getting value for path: ${path}, error:`, error);
          }
          return undefined;
        }
      };

      // Collect today's kWh from the three summary.* features as they pass
      // through the loop, then aggregate into meter_power / measure_power once
      // the loop has finished. See the long comment below the loop for why.
      const POWER_SUMMARY_PATHS = [
        PATHS.POWER_CONSUMPTION_SUMMARY_HEATING,
        PATHS.POWER_CONSUMPTION_SUMMARY_DHW,
        PATHS.POWER_CONSUMPTION_SUMMARY_COOLING,
      ];
      const summaryCurrentDay = {};
      let latestSummaryTimestampMs = null;

      // Live activity signals — used to derive an instantaneous measure_power
      // estimate, since the API has no direct wattage sensor on most Vitocal
      // models (heating.inverters.0.sensors.power.current returns
      // status=notConnected). compressor.active updates within ~30s vs. the
      // kWh-summary counters which tick only every 5–20 min.
      let compressorActive = null;
      let compressorSpeedRps = null;
      let fanModulationPct = null;

      for (const feature of response.data) {
        if (!feature.isEnabled || !feature.properties || feature.properties?.status?.value === 'notConnected') {
          if (process.env.DEBUG && !extendedResponse) {
            this.log(`Skipping disabled/empty feature: ${feature.feature}`);
          }
          continue;
        }

        const featureConfig = FEATURES[feature.feature];
        if (!featureConfig) {
          if (process.env.DEBUG && !extendedResponse) {
            this.log(`Skipping unknown feature: ${feature.feature}`);
          }
          continue;
        }

        // Check if device has required role for this feature
        if (featureConfig.requireRole && !this._roles.includes(featureConfig.requireRole)) {
          if (process.env.DEBUG && !extendedResponse) {
            this.log(`Skipping feature due to missing role: ${feature.feature}, required role: ${featureConfig.requireRole}`);
          }
          continue;
        }

        // Update all capabilities associated with this feature
        for (const capability of featureConfig.capabilities) {
          // Derived capabilities are computed elsewhere (e.g. measure_power from kWh delta)
          if (capability.derived) continue;

          const value = getValue(feature.properties, capability.propertyPath);
          if (value !== undefined) {
            await this.setCapabilityValueIfPossible(capability.capabilityName, value);
          } else if (process.env.DEBUG) {
            this.log(`No value found for capability: ${capability.capabilityName}, path: ${capability.propertyPath}`);
          }
        }

        if (POWER_SUMMARY_PATHS.includes(feature.feature)) {
          const currentDay = getValue(feature.properties, 'currentDay.value');
          if (typeof currentDay === 'number') {
            summaryCurrentDay[feature.feature] = currentDay;
            const tsMs = feature.timestamp ? Date.parse(feature.timestamp) : NaN;
            if (Number.isFinite(tsMs) && (latestSummaryTimestampMs === null || tsMs > latestSummaryTimestampMs)) {
              latestSummaryTimestampMs = tsMs;
            }
          }
        }
        if (feature.feature === PATHS.COMPRESSOR) {
          const v = getValue(feature.properties, 'active.value');
          if (typeof v === 'boolean') compressorActive = v;
        }
        if (feature.feature === PATHS.COMPRESSOR_SPEED) {
          const v = getValue(feature.properties, 'value.value');
          if (typeof v === 'number') compressorSpeedRps = v;
        }
        if (feature.feature === PATHS.PRIMARY_FAN_MODULATION) {
          const v = getValue(feature.properties, 'value.value');
          if (typeof v === 'number') fanModulationPct = v;
        }
      }

      // Aggregate today's kWh from the three summary.* features and feed the
      // monotonic lifetime accumulator (Homey's Energy tab requires meter_power
      // to be cumulative). measure_power is derived from the delta over the
      // API's own timestamp, not wall-clock poll time, to avoid fake spikes
      // when a chunk that accumulated over hours is attributed to the gap
      // between two polls.
      //
      // Why summary.* instead of heating.power.consumption.total: the
      // outer feature.timestamp on `.total` updates each poll, but the inner
      // `dayValueReadAt` can be 40+ hours stale on some devices (observed on
      // Vitocal 222S), so the old `day.value[0]`-based path silently froze.
      // The summary.{heating,dhw,cooling} features expose a fresh
      // `currentDay` property whose values sum to the figure shown in the
      // Viessmann mobile app.
      // First: kWh accumulator (meter_power, always — this is the lifetime
      // counter Homey's Energy tab requires). Capture deltaKwh/apiAdvanced so
      // the measure_power fallback below can reuse them without re-reading
      // state that has just been updated.
      let kwhDeltaKwh = null;
      let kwhApiAdvanced = false;
      let kwhDeltaHours = null;
      const summaryKeys = Object.keys(summaryCurrentDay);
      if (summaryKeys.length > 0 && latestSummaryTimestampMs !== null) {
        const todayKwh = Object.values(summaryCurrentDay).reduce((sum, v) => sum + v, 0);
        const apiTimestampMs = latestSummaryTimestampMs;
        const breakdown = summaryKeys.map((k) => `${k.split('.').pop()}=${summaryCurrentDay[k]}`).join(' ');

        const lastDayKwh = this.getStoreValue('lastDayKwh');
        const lastApiTimestamp = this.getStoreValue('lastApiTimestamp');
        const previousLifetime = this.getStoreValue('lifetimeKwh');
        const lifetimeBase = typeof previousLifetime === 'number' ? previousLifetime : 0;

        let deltaReason;
        if (typeof lastDayKwh !== 'number') {
          kwhDeltaKwh = todayKwh;
          deltaReason = 'first reading (seeded)';
        } else if (todayKwh >= lastDayKwh) {
          kwhDeltaKwh = todayKwh - lastDayKwh;
          deltaReason = 'today >= last';
        } else {
          kwhDeltaKwh = todayKwh;
          deltaReason = 'midnight reset';
        }

        const lifetimeKwh = lifetimeBase + kwhDeltaKwh;
        kwhApiAdvanced = typeof lastApiTimestamp === 'number' && apiTimestampMs > lastApiTimestamp;
        kwhDeltaHours = typeof lastApiTimestamp === 'number'
          ? (apiTimestampMs - lastApiTimestamp) / 3600000 : null;
        this.log(
          `[power] todayKwh=${todayKwh} (${breakdown}) lastDayKwh=${lastDayKwh} deltaKwh=${kwhDeltaKwh} (${deltaReason}) `
          + `lifetimeKwh=${lifetimeKwh} apiAdvanced=${kwhApiAdvanced} deltaHours=${kwhDeltaHours}`,
        );

        await this.setStoreValue('lifetimeKwh', lifetimeKwh);
        await this.setStoreValue('lastDayKwh', todayKwh);
        await this.setCapabilityValueIfPossible('meter_power', lifetimeKwh);

        if (kwhApiAdvanced || typeof lastApiTimestamp !== 'number') {
          await this.setStoreValue('lastApiTimestamp', apiTimestampMs);
        }
      }

      // measure_power derivation. Prefer the live compressor-based estimate
      // when the user has maxCompressorW > 0 — it tracks the heat pump within
      // ~30 s of the compressor turning on/off, instead of lagging the kWh
      // summary chunks by 5–20 min. Falls back to the kWh-delta path when the
      // compressor signals are missing or the user has disabled the live
      // estimate (maxCompressorW = 0).
      // Setting defaults apply only to newly-paired devices. For existing
      // devices the setting comes back undefined, so apply the same defaults
      // in code as in driver.compose.json.
      const rawMaxW = Number(this.getSetting('maxCompressorW'));
      const rawBaseW = Number(this.getSetting('baselineW'));
      const maxCompressorW = Number.isFinite(rawMaxW) ? rawMaxW : 3500;
      const baselineW = Number.isFinite(rawBaseW) ? rawBaseW : 150;
      const MAX_COMPRESSOR_RPS = 120;

      if (maxCompressorW > 0 && typeof compressorActive === 'boolean') {
        let watts;
        if (compressorActive) {
          const speedRatio = Math.min(1, Math.max(0, (compressorSpeedRps || 0) / MAX_COMPRESSOR_RPS));
          watts = baselineW + speedRatio * maxCompressorW;
        } else {
          watts = baselineW;
        }
        this.log(`[power] measure_power (live) = ${Math.round(watts)} W  compressor=${compressorActive} speed=${compressorSpeedRps}rps fan=${fanModulationPct}%`);
        await this.setStoreValue('lastMeasurePower', watts);
        await this.setCapabilityValueIfPossible('measure_power', watts);
      } else if (kwhDeltaKwh !== null) {
        if (kwhApiAdvanced && kwhDeltaHours > 0) {
          const watts = Math.max(0, (kwhDeltaKwh / kwhDeltaHours) * 1000);
          this.log(`[power] measure_power (kWh-delta) = ${Math.round(watts)} W`);
          await this.setStoreValue('lastMeasurePower', watts);
          await this.setCapabilityValueIfPossible('measure_power', watts);
        } else {
          const lastApiTimestamp = this.getStoreValue('lastApiTimestamp');
          if (typeof lastApiTimestamp === 'number') {
            const staleMs = Date.now() - lastApiTimestamp;
            if (staleMs > this.constructor.MAX_STALE_POWER_MS) {
              this.log(`[power] API timestamp stale for ${Math.round(staleMs / 60000)} min — assuming idle, setting measure_power=0`);
              await this.setStoreValue('lastMeasurePower', 0);
              await this.setCapabilityValueIfPossible('measure_power', 0);
            }
          }
        }
      }

      if (process.env.DEBUG) {
        this.log('Feature update processing completed');
      }

      this.setAvailable();
    } catch (error) {
      this.error('Error processing features update:', error);
      this.setUnavailable(error);
    }
  }

  hasRequiredRole(featurePath) {
    const feature = FEATURES[featurePath];
    return !feature.requireRole || this._roles.includes(feature.requireRole);
  }

  getConfigCapabilityByName(capabilityName) {
    for (const feature of Object.values(FEATURES)) {
      const capability = feature.capabilities.find((cap) => cap.capabilityName === capabilityName);
      if (capability) return { ...capability, requireRole: feature.requireRole };
    }
    return null;
  }

  async setCapabilityValueIfPossible(capabilityName, value) {
    try {
      if (this.hasCapability(capabilityName)) {
        const capability = this.getConfigCapabilityByName(capabilityName);
        if (!capability) {
          this.error(`No configuration found for capability: ${capabilityName}`);
          return;
        }

        // Compare with original value before value mapping
        const currentValue = this.getCapabilityValue(capabilityName);
        if (currentValue !== value) {
          let processedValue = value;
          if (capability.valueMapping && value in capability.valueMapping) {
            processedValue = capability.valueMapping[value];
          }

          await this.setCapabilityValue(capabilityName, processedValue);

          try {
            const triggerCard = this.driver.getTriggerCard(capabilityName);
            if (triggerCard) {
              await triggerCard.trigger(this, { mode: value }, {});
            }
          } catch (error) {
            // Ignore if no trigger card exists
          }
        }
      }
    } catch (error) {
      this.error(`Failed to set capability ${capabilityName}:`, error);
    }
  }

  registerCapabilityListenerIfPossible(capabilityName, listener) {
    if (this.hasCapability(capabilityName)) {
      this.registerCapabilityListener(capabilityName, listener);
    } else {
      this.log(`Capability ${capabilityName} not found, skipping listener registration`);
    }
  }

  async getGatewayFeatures() {
    return this.oAuth2Client.getGatewayFeatures({
      installationId: this._installationId,
      gatewaySerial: this._gatewaySerial,
      deviceId: this._deviceId,
    });
  }

  async getFeatures(useFilter) {
    // Use PATHS directly for feature filtering
    const featuresFilter = useFilter ? Object.values(PATHS).join(',') : undefined;

    return this.oAuth2Client.getFeatures({
      installationId: this._installationId,
      gatewaySerial: this._gatewaySerial,
      deviceId: this._deviceId,
      filter: featuresFilter,
    });
  }

  /*
    Get the compressor status
  */
  async isCompressorRunning() {
    const { capabilityName } = getCapability(PATHS.COMPRESSOR);
    return this.getCapabilityValue(capabilityName);
  }

  async onOAuth2Uninit() {
    // Stop polling for this device
    const deviceKey = `${this._installationId}-${this._gatewaySerial}-${this._deviceId}`;
    this.driver._stopPolling(deviceKey);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('pollInterval')) {
      const deviceKey = `${this._installationId}-${this._gatewaySerial}-${this._deviceId}`;
      // Pass the new value through explicitly. device.getSetting() inside
      // onSettings can still return the OLD value before the change is
      // committed, which is why the previous version of this handler
      // appeared to "ignore" pollInterval changes until app restart.
      const intervalMs = this.driver.constructor._toIntervalMs(newSettings.pollInterval);
      this.log(`pollInterval changed to ${newSettings.pollInterval} min → restarting polling at ${intervalMs / 1000}s`);
      await this.driver._startPolling(this, deviceKey, intervalMs);
    }
  }

  // Method to handle dynamic feature paths based on installation
  /* // Method not used, we probably want to handle the ids in a different way (have it as a device setting)
  updateFeaturePaths(compressorId, heatingCircuitsId, burnerId) {
    // Instead of modifying FEATURES directly, we create installation-specific paths
    this._installationPaths = {
      ...PATHS,
      COMPRESSOR: `heating.compressors.${compressorId}`,
      COMPRESSOR_STATS: `heating.compressors.${compressorId}.statistics`,
      BURNER: `heating.burners.${burnerId}`,
      BURNER_STATS: `heating.burners.${burnerId}.statistics`,
      BURNER_MODULATION: `heating.burners.${burnerId}.modulation`,
      HEATING_MODE: `heating.circuits.${heatingCircuitsId}.operating.modes.active`,
      HEATING_TARGET: `heating.circuits.${heatingCircuitsId}.operating.programs.normal`,
    };
  }
  */

  storeVersionBefore(targetVersion) {
    const currentVersion = this.getStoreValue('version');
    const parts1 = (currentVersion || '0.0.0').split('.').map(Number);
    const parts2 = targetVersion.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (parts1[i] > parts2[i]) return false;
      if (parts1[i] < parts2[i]) return true;
    }
    return false;
  }

};
