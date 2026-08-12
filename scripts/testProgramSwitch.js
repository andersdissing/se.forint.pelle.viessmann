/*
 * Standalone test script for switching heating programs (Eco / Comfort /
 * Normal / Reduced) via the Viessmann ViCare API.
 *
 * BACKGROUND — programs are not the same thing as operating modes:
 *
 *   heating.circuits.N.operating.modes.active      <- "driftform"
 *       dhw | heating | dhwAndHeating | standby     (command: setMode)
 *
 *   heating.circuits.N.operating.programs.*        <- "program"
 *       normal | reduced | comfort | eco | ...      (commands: activate /
 *                                                   deactivate / setTemperature)
 *
 * The Homey driver currently only implements `modes.active` plus the
 * `programs.normal` target temperature (see drivers/vicare/config.js:29).
 * Comfort and Eco are NOT wired up yet — this script exists to discover what
 * the connected installation actually supports and to verify the switch
 * works end-to-end before implementing it in the driver.
 *
 * Program names vary between device generations (E3 devices sometimes expose
 * `comfortHeating` / `ecoHeating` instead of `comfort` / `eco`), so nothing is
 * hardcoded: every `programs.*` feature is discovered from the API response
 * and the command bodies are built from the reported `params`/`constraints`.
 *
 * USAGE (run from the repo root):
 *
 *   node scripts/testProgramSwitch.js
 *       Read-only. Lists every program on every circuit with its active
 *       state, temperature and executable commands.
 *
 *   node scripts/testProgramSwitch.js --to comfort
 *       Dry run. Prints the exact HTTP requests that WOULD be sent.
 *
 *   node scripts/testProgramSwitch.js --to comfort --apply
 *       Actually switches to Comfort, then re-reads to verify.
 *
 *   node scripts/testProgramSwitch.js --to eco --apply
 *       Switches to Eco (deactivating Comfort first, if it is active).
 *
 *   node scripts/testProgramSwitch.js --to comfort --temperature 22 --apply
 *       Only needed when the device's `activate` command requires a
 *       temperature parameter.
 *
 *   node scripts/testProgramSwitch.js --off --apply
 *       Deactivates whichever overlay program is currently active, returning
 *       the circuit to its base program.
 *
 * Other flags:
 *   --circuit N     Heating circuit to operate on (default: 0)
 *   --device ID     Device id to use (default: first deviceType==='heating')
 *   --json          Dump the raw programs.* feature JSON as well
 *
 * WARNING: with --apply this writes to a real heating system. The Viessmann
 * API is rate limited (HTTP 429) and enforces a daily command quota, so do
 * not run the apply path in a loop.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const API_URL = 'https://api.viessmann-climatesolutions.com/iot/v2';
const TOKEN_URL = 'https://iam.viessmann-climatesolutions.com/idp/v3/token';

// heating.circuits.0.operating.programs.comfort -> ['0', 'comfort']
const PROGRAM_RE = /^heating\.circuits\.(\d+)\.operating\.programs\.([A-Za-z0-9]+)$/;

// How long to wait before re-reading the features to verify a switch. The
// backend needs a moment to propagate the command down to the gateway.
const VERIFY_DELAY_MS = Number(process.env.VIESSMANN_VERIFY_DELAY_MS) || 6000;

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error(`[FAIL] .env not found at ${envPath}`);
    console.error('       Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function parseArgs(argv) {
  const opts = {
    to: null, off: false, apply: false, circuit: 0, device: null, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--to':
        opts.to = argv[++i];
        break;
      case '--off':
        opts.off = true;
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--circuit':
        opts.circuit = Number(argv[++i]);
        break;
      case '--device':
        opts.device = argv[++i];
        break;
      case '--temperature':
        opts.temperature = Number(argv[++i]);
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        console.error(`[FAIL] Unknown argument: ${arg}`);
        process.exit(1);
    }
  }
  if (opts.to && opts.off) {
    console.error('[FAIL] --to and --off are mutually exclusive.');
    process.exit(1);
  }
  if (!Number.isInteger(opts.circuit) || opts.circuit < 0) {
    console.error('[FAIL] --circuit must be a non-negative integer.');
    process.exit(1);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

async function refreshAccessToken(clientId, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: querystring.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${JSON.stringify(body)}`);
  }
  if (!body.access_token) {
    throw new Error(`Token refresh returned no access_token: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

async function apiGet(accessToken, pathAndQuery) {
  const res = await fetch(`${API_URL}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GET ${pathAndQuery} failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function apiPost(accessToken, pathAndQuery, body) {
  const res = await fetch(`${API_URL}${pathAndQuery}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const responseBody = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: responseBody };
}

/*
 * Pull the scalar value out of a Viessmann property wrapper, which is always
 * shaped as { type, value, unit? }.
 */
function propValue(feature, name) {
  const prop = feature.properties && feature.properties[name];
  if (!prop || typeof prop !== 'object') return undefined;
  return prop.value;
}

/*
 * Collect every heating.circuits.N.operating.programs.* feature, keyed by
 * program name, for the requested circuit.
 */
function collectPrograms(features, circuit) {
  const programs = [];
  for (const feature of features) {
    const match = PROGRAM_RE.exec(feature.feature);
    if (!match) continue;
    if (Number(match[1]) !== circuit) continue;
    const commands = feature.commands || {};
    programs.push({
      name: match[2],
      path: feature.feature,
      feature,
      isEnabled: feature.isEnabled !== false,
      active: propValue(feature, 'active'),
      demand: propValue(feature, 'demand'),
      temperature: propValue(feature, 'temperature'),
      commands,
      // An "overlay" program is one that can be turned on and off on top of
      // the circuit's base program. Base programs (normal, reduced) only
      // expose setTemperature and are therefore never activated directly.
      isOverlay: Boolean(commands.activate && commands.deactivate),
    });
  }
  return programs;
}

function describeCommand(command) {
  const params = Object.entries(command.params || {});
  const paramText = params.length === 0
    ? 'no params'
    : params.map(([paramName, param]) => {
      const constraints = param.constraints
        ? ` {${Object.entries(param.constraints).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}}`
        : '';
      return `${paramName}: ${param.type}${param.required ? '' : '?'}${constraints}`;
    }).join(', ');
  return `${command.isExecutable ? 'executable' : 'NOT executable'}  (${paramText})`;
}

function printPrograms(programs, circuit, dumpJson) {
  console.log(`\n=== heating.circuits.${circuit}.operating.programs.* ===`);
  if (programs.length === 0) {
    console.log(`[!] No programs found for circuit ${circuit}.`);
    console.log('    Try a different --circuit, or check that the circuit is enabled.');
    return;
  }
  for (const program of programs) {
    const flags = [
      program.isOverlay ? 'overlay' : 'base',
      program.isEnabled ? 'enabled' : 'DISABLED',
    ].join(', ');
    console.log(`\n---- ${program.name}  [${flags}] ----`);
    console.log(`  path        : ${program.path}`);
    console.log(`  active      : ${program.active === undefined ? 'n/a' : program.active}`);
    if (program.demand !== undefined) console.log(`  demand      : ${program.demand}`);
    if (program.temperature !== undefined) console.log(`  temperature : ${program.temperature}`);
    const commandNames = Object.keys(program.commands);
    if (commandNames.length === 0) {
      console.log('  commands    : none (read-only feature)');
    } else {
      console.log('  commands    :');
      for (const commandName of commandNames) {
        console.log(`      ${commandName.padEnd(16)} ${describeCommand(program.commands[commandName])}`);
      }
    }
    if (dumpJson) {
      console.log('  raw         :');
      console.log(JSON.stringify(program.feature, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
    }
  }
}

/*
 * Build the request body for a command from the params the API reports.
 * Anything required that we cannot fill in is reported back to the caller so
 * the script can fail with an actionable message instead of a 400.
 */
function buildCommandBody(command, opts) {
  const body = {};
  const missing = [];
  for (const [paramName, param] of Object.entries(command.params || {})) {
    if (!param.required) continue;
    if (/temp/i.test(paramName)) {
      if (Number.isFinite(opts.temperature)) {
        body[paramName] = opts.temperature;
      } else {
        missing.push(`${paramName} (pass --temperature <°C>)`);
      }
    } else {
      missing.push(`${paramName} (type ${param.type} — not supported by this script)`);
    }
  }
  return { body, missing };
}

/*
 * Work out the sequence of commands needed to reach the target state.
 * Comfort and Eco are mutually exclusive overlays, so switching from one to
 * the other means deactivate-then-activate, not a single call.
 */
function planSwitch(programs, opts) {
  const steps = [];
  const activeOverlays = programs.filter((p) => p.isOverlay && p.active === true);

  let target = null;
  if (opts.to) {
    target = programs.find((p) => p.name.toLowerCase() === opts.to.toLowerCase());
    if (!target) {
      const available = programs.map((p) => p.name).join(', ') || '(none)';
      throw new Error(`Program "${opts.to}" not found on circuit ${opts.circuit}. Available: ${available}`);
    }
    if (!target.isOverlay) {
      throw new Error(
        `Program "${target.name}" is a base program (no activate/deactivate commands), `
        + 'so it cannot be switched on. Use setTemperature on it instead.',
      );
    }
    if (target.active === true) {
      console.log(`\n[i] "${target.name}" is already active — nothing to activate.`);
    }
  }

  // Turn off any overlay that is not the target.
  for (const overlay of activeOverlays) {
    if (target && overlay.name === target.name) continue;
    steps.push({ program: overlay, commandName: 'deactivate' });
  }

  if (target && target.active !== true) {
    steps.push({ program: target, commandName: 'activate' });
  }

  if (opts.off && activeOverlays.length === 0) {
    console.log('\n[i] No overlay program is currently active — nothing to deactivate.');
  }

  return steps;
}

function commandPath(base, program, commandName) {
  return `${base}/${program.path}/commands/${commandName}`;
}

async function main() {
  loadEnv();
  const opts = parseArgs(process.argv.slice(2));

  const clientId = process.env.VIESSMANN_CLIENT_ID;
  const refreshToken = process.env.VIESSMANN_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    console.error('[FAIL] VIESSMANN_CLIENT_ID and VIESSMANN_REFRESH_TOKEN must be set in .env');
    process.exit(1);
  }

  console.log('[1/4] Refreshing access token...');
  const accessToken = await refreshAccessToken(clientId, refreshToken);
  console.log(`      OK (token length ${accessToken.length})`);

  console.log('[2/4] Discovering installation / gateway / device...');
  const installations = await apiGet(accessToken, '/equipment/installations?includeGateways=true');
  const list = installations.data || [];
  if (list.length === 0) {
    console.error('[FAIL] No installations returned for this account.');
    process.exit(1);
  }
  const installation = list[0];
  const installationId = installation.id;
  const gateways = installation.gateways || [];
  if (gateways.length === 0) {
    console.error(`[FAIL] Installation ${installationId} has no gateways.`);
    process.exit(1);
  }
  const gatewaySerial = gateways[0].serial;

  const devicesResp = await apiGet(
    accessToken,
    `/equipment/installations/${installationId}/gateways/${gatewaySerial}/devices`,
  );
  const devices = devicesResp.data || [];
  // Match the driver's logic (drivers/vicare/driver.js:211): only deviceType === 'heating'
  const heatingDevices = devices.filter((d) => d.deviceType === 'heating');
  if (heatingDevices.length === 0) {
    console.error('[FAIL] No devices with deviceType === "heating".');
    process.exit(1);
  }
  const device = opts.device
    ? devices.find((d) => String(d.id) === String(opts.device))
    : heatingDevices[0];
  if (!device) {
    console.error(`[FAIL] Device "${opts.device}" not found. Available: ${devices.map((d) => d.id).join(', ')}`);
    process.exit(1);
  }
  const deviceId = device.id;
  console.log(`      installationId=${installationId}  gatewaySerial=${gatewaySerial}  deviceId=${deviceId}`);
  console.log(`      model=${device.modelId || 'n/a'}  roles=${(device.roles || []).join('|') || 'n/a'}`);

  const basePath = `/features/installations/${installationId}/gateways/${gatewaySerial}/devices/${deviceId}/features`;

  console.log('[3/4] GET /features (unfiltered, skipDisabled=true)...');
  const featuresResp = await apiGet(accessToken, `${basePath}?skipDisabled=true`);
  const features = featuresResp.data || [];
  console.log(`      OK (${features.length} features)`);

  // Show which circuits exist at all, so a wrong --circuit is obvious.
  const circuits = [...new Set(
    features.map((f) => PROGRAM_RE.exec(f.feature)).filter(Boolean).map((m) => Number(m[1])),
  )].sort((a, b) => a - b);
  console.log(`      circuits exposing programs: ${circuits.length ? circuits.join(', ') : 'none'}`);

  const programs = collectPrograms(features, opts.circuit);
  printPrograms(programs, opts.circuit, opts.json);

  if (!opts.to && !opts.off) {
    console.log('\n[i] Read-only run. Pass --to <program> (e.g. --to comfort) to plan a switch,');
    console.log('    and add --apply to actually execute it.');
    console.log('\n[DONE]');
    return;
  }

  console.log('\n[4/4] Planning switch...');
  const steps = planSwitch(programs, opts);

  if (steps.length === 0) {
    console.log('      Nothing to do — already in the requested state.');
    console.log('\n[DONE]');
    return;
  }

  // Validate every step up front so we never half-apply a two-step switch.
  const plan = [];
  for (const step of steps) {
    const command = step.program.commands[step.commandName];
    if (!command) {
      console.error(`[FAIL] "${step.program.name}" has no "${step.commandName}" command.`);
      process.exit(1);
    }
    if (command.isExecutable === false) {
      console.error(`[FAIL] "${step.program.name}.${step.commandName}" is reported as NOT executable by the API.`);
      console.error('       The installation exposes this feature read-only — the driver cannot change it either.');
      process.exit(1);
    }
    const { body, missing } = buildCommandBody(command, opts);
    if (missing.length > 0) {
      console.error(`[FAIL] Cannot build body for "${step.program.name}.${step.commandName}" — missing: ${missing.join(', ')}`);
      process.exit(1);
    }
    plan.push({ ...step, command, body });
  }

  console.log(`      ${plan.length} request${plan.length === 1 ? '' : 's'}:`);
  for (const [i, step] of plan.entries()) {
    console.log(`        ${i + 1}. POST ${commandPath(basePath, step.program, step.commandName)}`);
    console.log(`           body: ${JSON.stringify(step.body)}`);
  }

  if (!opts.apply) {
    console.log('\n[DRY RUN] Nothing was sent. Re-run with --apply to execute the requests above.');
    console.log('\n[DONE]');
    return;
  }

  console.log('\n      --apply given, executing...');
  for (const [i, step] of plan.entries()) {
    const target = commandPath(basePath, step.program, step.commandName);
    const result = await apiPost(accessToken, target, step.body);
    if (result.ok) {
      console.log(`        ${i + 1}. OK (${result.status})  ${step.program.name}.${step.commandName}`);
    } else {
      console.error(`        ${i + 1}. FAILED (${result.status})  ${step.program.name}.${step.commandName}`);
      console.error(`           ${JSON.stringify(result.body)}`);
      if (result.status === 429) {
        console.error('           Rate limited — the API enforces a daily command quota. Wait and retry.');
      }
      if (result.status === 502 || result.status === 504) {
        console.error('           Gateway did not respond. The command may still have been queued.');
      }
      process.exit(1);
    }
  }

  console.log(`\n      Verifying (re-reading features in ${VERIFY_DELAY_MS / 1000}s)...`);
  await sleep(VERIFY_DELAY_MS);
  const afterResp = await apiGet(accessToken, `${basePath}?skipDisabled=true`);
  const after = collectPrograms(afterResp.data || [], opts.circuit);

  console.log('\n=== BEFORE -> AFTER ===');
  console.log('PROGRAM              | before | after');
  console.log('---------------------+--------+-------');
  for (const program of programs) {
    const updated = after.find((p) => p.name === program.name);
    const before = program.active === undefined ? ' n/a ' : String(program.active).padEnd(5);
    const now = !updated || updated.active === undefined ? ' n/a ' : String(updated.active).padEnd(5);
    const changed = updated && updated.active !== program.active ? '  <-- changed' : '';
    console.log(`${program.name.padEnd(21)}| ${before}  | ${now}${changed}`);
  }

  const activeAfter = after.filter((p) => p.isOverlay && p.active === true).map((p) => p.name);
  console.log(`\nActive overlay program(s) now: ${activeAfter.length ? activeAfter.join(', ') : 'none (base program)'}`);
  if (opts.to && !activeAfter.some((n) => n.toLowerCase() === opts.to.toLowerCase())) {
    console.log(`[!] "${opts.to}" is not reported active yet. The gateway can lag by a minute or two —`);
    console.log('    re-run the script without --apply to re-check before assuming it failed.');
  }

  console.log('\n[DONE]');
}

main().catch((err) => {
  console.error('\n[FAIL]', err.message);
  process.exit(1);
});
