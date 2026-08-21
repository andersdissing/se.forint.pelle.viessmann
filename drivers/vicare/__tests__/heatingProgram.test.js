/* eslint-env jest */

'use strict';

const ViessmannDevice = require('../device');
const { PATHS } = require('../config');
const { FLOW_ACTIONS } = require('../flowCards');

jest.mock('homey-oauth2app', () => ({
  OAuth2Device: class {

    constructor() {
      this.log = jest.fn();
      this.error = jest.fn();
    }

  },
  OAuth2Driver: class {

    constructor() {
      this.log = jest.fn();
      this.error = jest.fn();
    }

  },
  // ViessmannOAuth2Client extends OAuth2Client and throws OAuth2Error, so both
  // have to exist for the client module to be require-able under test.
  OAuth2Client: class {

    constructor() {
      this.log = jest.fn();
      this.error = jest.fn();
    }

  },
  OAuth2Error: class extends Error {},
  OAuth2Token: class {},
  fetch: jest.fn(),
}));

const SCHEDULE_PATH = PATHS.HEATING_CIRCUIT_0_SCHEDULE;
const USER_SCHEDULE = {
  mon: [{
    mode: 'normal', start: '04:30', end: '21:00', position: 0,
  }],
  tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
};

/*
 * Build a device whose store is in memory and whose oAuth2Client records the
 * commands it is asked to send. `scheduleFeature` overrides let each test
 * reproduce a different installation's constraints.
 */
function makeDevice({ commands, entries = USER_SCHEDULE } = {}) {
  const device = new ViessmannDevice();
  const store = {};
  const sent = [];

  device._installationId = 'i';
  device._gatewaySerial = 'g';
  device._deviceId = '0';
  device.getStoreValue = (k) => store[k];
  device.setStoreValue = async (k, v) => { store[k] = v; };
  device.unsetStoreValue = async (k) => { delete store[k]; };
  device.oAuth2Client = {
    getFeature: jest.fn().mockResolvedValue({
      data: {
        feature: SCHEDULE_PATH,
        properties: { entries: { type: 'Schedule', value: entries } },
        commands: commands !== undefined ? commands : {
          setSchedule: {
            isExecutable: true,
            params: {
              newSchedule: {
                type: 'Schedule',
                required: true,
                constraints: {
                  modes: ['normal', 'comfort'], maxEntries: 4, resolution: 10, defaultMode: 'reduced',
                },
              },
            },
          },
        },
      },
    }),
    executeCommand: jest.fn().mockImplementation(async (args) => {
      sent.push(args);
      return { data: { success: true } };
    }),
  };

  return { device, store, sent };
}

describe('setHeatingProgram', () => {
  test('comfort writes an all-day comfort entry for every weekday', async () => {
    const { device, sent } = makeDevice();

    await device.setHeatingProgram('comfort');

    expect(sent).toHaveLength(1);
    expect(sent[0].feature).toBe(SCHEDULE_PATH);
    expect(sent[0].command).toBe('setSchedule');
    const { newSchedule } = sent[0].body;
    expect(Object.keys(newSchedule)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    for (const day of Object.keys(newSchedule)) {
      expect(newSchedule[day]).toEqual([{
        mode: 'comfort', start: '00:00', end: '24:00', position: 0,
      }]);
    }
  });

  test('eco writes an empty schedule so the reduced default applies all day', async () => {
    const { device, sent } = makeDevice();

    await device.setHeatingProgram('eco');

    const { newSchedule } = sent[0].body;
    expect(Object.values(newSchedule).every((day) => day.length === 0)).toBe(true);
  });

  test('the first override saves the user schedule, the second does not overwrite the backup', async () => {
    const { device, store } = makeDevice();

    await device.setHeatingProgram('comfort');
    expect(store.scheduleOverride.original).toEqual(USER_SCHEDULE);

    // The client keeps reporting the ORIGINAL entries here, but even if the
    // API had already reflected the comfort override the backup must not move.
    await device.setHeatingProgram('eco');
    expect(store.scheduleOverride.original).toEqual(USER_SCHEDULE);
  });

  test('auto restores the saved schedule and clears the override', async () => {
    const { device, store, sent } = makeDevice();

    await device.setHeatingProgram('comfort');
    await device.setHeatingProgram('auto');

    expect(sent[1].body.newSchedule).toEqual(USER_SCHEDULE);
    expect(store.scheduleOverride).toBeUndefined();
  });

  test('auto without an active override sends nothing', async () => {
    const { device, sent } = makeDevice();

    await expect(device.setHeatingProgram('auto')).resolves.toBe(true);
    expect(sent).toHaveLength(0);
  });

  test('rejects a program the installation does not list in its schedule modes', async () => {
    const { device, sent } = makeDevice({
      commands: {
        setSchedule: {
          isExecutable: true,
          params: { newSchedule: { constraints: { modes: ['normal'], defaultMode: 'reduced' } } },
        },
      },
    });

    await expect(device.setHeatingProgram('comfort')).rejects.toThrow(/only supports the schedule modes \[normal\]/);
    expect(sent).toHaveLength(0);
  });

  test('rejects when setSchedule is missing or read-only, without sending anything', async () => {
    const missing = makeDevice({ commands: {} });
    await expect(missing.device.setHeatingProgram('comfort')).rejects.toThrow(/does not expose/);
    expect(missing.sent).toHaveLength(0);

    const readOnly = makeDevice({
      commands: { setSchedule: { isExecutable: false, params: {} } },
    });
    await expect(readOnly.device.setHeatingProgram('comfort')).rejects.toThrow(/read-only/);
    expect(readOnly.sent).toHaveLength(0);
  });

  test('rejects an unknown program name', async () => {
    const { device, sent } = makeDevice();

    await expect(device.setHeatingProgram('banana')).rejects.toThrow(/Unknown heating program/);
    expect(sent).toHaveLength(0);
  });

  test('reads the feature from a collection response too', async () => {
    const { device } = makeDevice();
    device.oAuth2Client.getFeature = jest.fn().mockResolvedValue({
      data: [
        { feature: 'heating.other', properties: {}, commands: {} },
        {
          feature: SCHEDULE_PATH,
          properties: { entries: { value: USER_SCHEDULE } },
          commands: { setSchedule: { isExecutable: true, params: { newSchedule: { constraints: { modes: ['normal', 'comfort'] } } } } },
        },
      ],
    });

    await expect(device.setHeatingProgram('comfort')).resolves.toBe(true);
  });
});

describe('measure_heating_program capability', () => {
  const { FEATURES } = require('../config');

  test('is configured on the programs.active feature as a read-only sensor', () => {
    const entry = FEATURES[PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE];
    expect(entry).toBeDefined();
    const cap = entry.capabilities[0];
    expect(cap.capabilityName).toBe('measure_heating_program');
    expect(cap.propertyPath).toBe('value.value');
    expect(cap.command).toBeUndefined();
  });

  test('maps the raw program names onto the words the flow card uses', () => {
    const { valueMapping } = FEATURES[PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE].capabilities[0];
    expect(valueMapping.comfortHeating).toBe('Comfort');
    expect(valueMapping.normalHeating).toBe('Normal');
    expect(valueMapping.reducedHeating).toBe('Eco (reduced)');
  });

  test('a polled programs.active value reaches the capability, mapped', async () => {
    const device = new ViessmannDevice();
    device._roles = [];
    device._features = [PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE];
    device.hasCapability = jest.fn().mockReturnValue(true);
    device.getCapabilityValue = jest.fn().mockReturnValue(null);
    device.setCapabilityValue = jest.fn();
    device.setAvailable = jest.fn();
    device.setUnavailable = jest.fn();
    device.getSetting = jest.fn().mockReturnValue(undefined);
    device.driver = { getTriggerCard: () => null };

    await device.onFeaturesUpdated({
      data: [{
        feature: PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE,
        isEnabled: true,
        properties: { value: { type: 'string', value: 'comfortHeating' } },
      }],
    }, false);

    expect(device.setCapabilityValue).toHaveBeenCalledWith('measure_heating_program', 'Comfort');
  });

  test('an unmapped program name is passed through rather than mislabelled', async () => {
    const device = new ViessmannDevice();
    device._roles = [];
    device._features = [PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE];
    device.hasCapability = jest.fn().mockReturnValue(true);
    device.getCapabilityValue = jest.fn().mockReturnValue(null);
    device.setCapabilityValue = jest.fn();
    device.setAvailable = jest.fn();
    device.setUnavailable = jest.fn();
    device.getSetting = jest.fn().mockReturnValue(undefined);
    device.driver = { getTriggerCard: () => null };

    await device.onFeaturesUpdated({
      data: [{
        feature: PATHS.HEATING_CIRCUIT_0_PROGRAM_ACTIVE,
        isEnabled: true,
        properties: { value: { type: 'string', value: 'frostprotection' } },
      }],
    }, false);

    expect(device.setCapabilityValue).toHaveBeenCalledWith('measure_heating_program', 'frostprotection');
  });
});

describe('hot water mode', () => {
  const { FEATURES, getCapability } = require('../config');

  test('is a separate feature from the heating circuit mode', () => {
    expect(PATHS.HOT_WATER_MODE).toBe('heating.dhw.operating.modes.active');
    expect(PATHS.HOT_WATER_MODE).not.toBe(PATHS.HEATING_CIRCUIT_0_MODE);
    const cap = getCapability(PATHS.HOT_WATER_MODE);
    expect(cap.capabilityName).toBe('thermostat_mode.hotWater');
    expect(cap.command).toEqual({ name: 'setMode', parameterMapping: { value: 'mode' } });
  });

  test('the flow card writes setMode to the dhw feature, not the circuit', async () => {
    const device = new ViessmannDevice();
    const sent = [];
    device._installationId = 'i';
    device._gatewaySerial = 'g';
    device._deviceId = '0';
    device.oAuth2Client = { executeCommand: async (args) => { sent.push(args); } };
    device.setCapabilityValueIfPossible = jest.fn();

    const cap = getCapability(PATHS.HOT_WATER_MODE);
    await device.executeCommand(PATHS.HOT_WATER_MODE, cap, 'off');

    expect(sent).toEqual([{
      installationId: 'i',
      gatewaySerial: 'g',
      deviceId: '0',
      feature: 'heating.dhw.operating.modes.active',
      command: 'setMode',
      body: { mode: 'off' },
    }]);
  });

  test('exposes a label-carrying twin for use as a flow tag', () => {
    const caps = FEATURES[PATHS.HOT_WATER_MODE].capabilities;

    // Order matters: the flow card resolves through getCapability(), which
    // returns capabilities[0]. The tag twin must not displace the control.
    expect(caps[0].capabilityName).toBe('thermostat_mode.hotWater');
    expect(getCapability(PATHS.HOT_WATER_MODE).capabilityName).toBe('thermostat_mode.hotWater');

    const tag = caps[1];
    expect(tag.capabilityName).toBe('measure_hot_water_mode');
    expect(tag.command).toBeUndefined();
    expect(tag.valueMapping).toMatchObject({
      efficient: 'Eco', efficientWithMinComfort: 'Comfort', off: 'Off',
    });

    // Exactly one of the two may be offered as a tag, otherwise the picker
    // shows two entries both titled "Hot water mode".
    const tagged = caps.filter((c) => c.capabilityOptions.preventTag !== true);
    expect(tagged).toHaveLength(1);
    expect(tagged[0].capabilityName).toBe('measure_hot_water_mode');
    expect(tagged[0].capabilityOptions.title.en).toBe('Hot water mode');
  });

  test('a polled mode reaches both capabilities: raw id and label', async () => {
    const device = new ViessmannDevice();
    device._roles = [];
    device._features = [PATHS.HOT_WATER_MODE];
    device.hasCapability = jest.fn().mockReturnValue(true);
    device.getCapabilityValue = jest.fn().mockReturnValue(null);
    device.setCapabilityValue = jest.fn();
    device.setAvailable = jest.fn();
    device.setUnavailable = jest.fn();
    device.getSetting = jest.fn().mockReturnValue(undefined);
    device.driver = { getTriggerCard: () => null };

    await device.onFeaturesUpdated({
      data: [{
        feature: PATHS.HOT_WATER_MODE,
        isEnabled: true,
        properties: { value: { type: 'string', value: 'efficientWithMinComfort' } },
      }],
    }, false);

    expect(device.setCapabilityValue).toHaveBeenCalledWith('thermostat_mode.hotWater', 'efficientWithMinComfort');
    expect(device.setCapabilityValue).toHaveBeenCalledWith('measure_hot_water_mode', 'Comfort');
  });

  test('setting the mode updates the label twin immediately, not on the next poll', async () => {
    const device = new ViessmannDevice();
    device._installationId = 'i';
    device._gatewaySerial = 'g';
    device._deviceId = '0';
    device._constraints = {};
    device.oAuth2Client = { executeCommand: jest.fn().mockResolvedValue({}) };
    const written = {};
    device.setCapabilityValueIfPossible = jest.fn(async (name, value) => { written[name] = value; });

    await device.executeCommand(PATHS.HOT_WATER_MODE, getCapability(PATHS.HOT_WATER_MODE), 'efficient');

    // Both the picker and the tag must reflect the new mode straight away.
    expect(written['thermostat_mode.hotWater']).toBe('efficient');
    expect(written.measure_hot_water_mode).toBe('efficient');
  });

  test('the mode picker is pruned to what the installation reports', async () => {
    const device = new ViessmannDevice();
    device.hasCapability = jest.fn().mockReturnValue(true);
    device._constraints = {
      [PATHS.HOT_WATER_MODE]: { mode: { enum: ['efficientWithMinComfort', 'efficient', 'off'] } },
    };
    const declared = FEATURES[PATHS.HOT_WATER_MODE].capabilities[0].capabilityOptions;
    // initializeDhwModes now reads the declared options from config directly
    device.setCapabilityOptions = jest.fn();

    await device.initializeDhwModes();

    const written = device.setCapabilityOptions.mock.calls[0][1];
    expect(written.values.map((v) => v.id)).toEqual(['efficient', 'efficientWithMinComfort', 'off']);
    // and the labels are the ones the ViCare app uses, not the raw API names
    expect(written.values.map((v) => v.title.en)).toEqual(['Eco', 'Comfort', 'Off']);
  });

  test('leaves the picker alone when the installation reports no constraints', async () => {
    const device = new ViessmannDevice();
    device.hasCapability = jest.fn().mockReturnValue(true);
    device._constraints = {};
    device.getCapabilityOptions = jest.fn().mockReturnValue({ values: [{ id: 'off' }] });
    device.setCapabilityOptions = jest.fn();

    await device.initializeDhwModes();

    expect(device.setCapabilityOptions).not.toHaveBeenCalled();
  });
});

describe('command errors are actionable', () => {
  const { getCapability } = require('../config');
  const ViessmannOAuth2Client = require('../../../lib/ViessmannOAuth2Client');

  function deviceWithConstraints() {
    const device = new ViessmannDevice();
    device._installationId = 'i';
    device._gatewaySerial = 'g';
    device._deviceId = '0';
    device._constraints = {
      [PATHS.HOT_WATER_MODE]: { mode: { type: 'string', enum: ['efficientWithMinComfort', 'efficient', 'off'] } },
    };
    device.setCapabilityValueIfPossible = jest.fn();
    return device;
  }

  test('an unsupported mode is refused locally, naming what is allowed', async () => {
    const device = deviceWithConstraints();
    const executeCommand = jest.fn();
    device.oAuth2Client = { executeCommand };

    await expect(device.executeCommand(PATHS.HOT_WATER_MODE, getCapability(PATHS.HOT_WATER_MODE), 'eco'))
      .rejects.toThrow(/"eco" is not supported by this installation\. Supported values: efficientWithMinComfort, efficient, off/);

    // and it never spent an API call to find out
    expect(executeCommand).not.toHaveBeenCalled();
  });

  test('a supported mode still goes through', async () => {
    const device = deviceWithConstraints();
    const executeCommand = jest.fn().mockResolvedValue({});
    device.oAuth2Client = { executeCommand };

    await expect(device.executeCommand(PATHS.HOT_WATER_MODE, getCapability(PATHS.HOT_WATER_MODE), 'off'))
      .resolves.toBe(true);
    expect(executeCommand).toHaveBeenCalled();
  });

  test('a failure from the API keeps its explanation instead of "Error executing command"', async () => {
    const device = deviceWithConstraints();
    device.oAuth2Client = {
      executeCommand: jest.fn().mockRejectedValue(new Error("Value 'x' is not within allowed values: a, b")),
    };

    await expect(device.executeCommand(PATHS.HOT_WATER_MODE, getCapability(PATHS.HOT_WATER_MODE), 'off'))
      .rejects.toThrow(/is not within allowed values: a, b/);
  });

  test('the API error body is decoded rather than reported as "Unknown error"', () => {
    const body = {
      statusCode: 400,
      errorType: 'DEVICE_COMMUNICATION_ERROR',
      message: 'Device communication error',
      extendedPayload: {
        reason: 'VALIDATION_ERROR',
        details: "Value 'eco' is not within allowed values: efficientWithMinComfort, efficient, off",
      },
    };
    expect(ViessmannOAuth2Client.describeApiError(body)).toMatch(/not within allowed values/);
    expect(ViessmannOAuth2Client.describeApiError({ message: 'Boom' })).toBe('Boom');
    expect(ViessmannOAuth2Client.describeApiError({})).toBeNull();
    expect(ViessmannOAuth2Client.describeApiError(null)).toBeNull();
  });
});

describe('set-heating-program flow card', () => {
  test('is declared with the four program options and a device method', () => {
    const action = FLOW_ACTIONS.SET_HEATING_PROGRAM;
    expect(action.id).toBe('set-heating-program');
    expect(action.deviceMethod).toBe('setHeatingProgram');
    expect(action.args[0].name).toBe('program');
    expect(action.args[0].values.map((v) => v.id)).toEqual(['comfort', 'normal', 'eco', 'auto']);
  });

  test('every declared program id is accepted by setHeatingProgram', async () => {
    for (const value of FLOW_ACTIONS.SET_HEATING_PROGRAM.args[0].values) {
      const { device } = makeDevice();
      // 'auto' with no override is a no-op but must not throw.
      // eslint-disable-next-line no-await-in-loop
      await expect(device.setHeatingProgram(value.id)).resolves.toBe(true);
    }
  });

  test('driver routes a deviceMethod action to the device instead of a capability', async () => {
    const ViessmannDriver = require('../driver');

    const listeners = {};
    const driver = Object.create(ViessmannDriver.prototype);
    driver.log = jest.fn();
    driver.error = jest.fn();
    driver.homey = {
      flow: {
        getConditionCard: () => ({ registerRunListener: () => {} }),
        getActionCard: (id) => ({
          registerRunListener: (fn) => { listeners[id] = fn; },
        }),
      },
    };

    driver._registerFlowCards();

    const device = { setHeatingProgram: jest.fn().mockResolvedValue(true) };
    await listeners['set-heating-program']({ device, program: 'eco' });

    expect(device.setHeatingProgram).toHaveBeenCalledWith('eco');
  });
});
