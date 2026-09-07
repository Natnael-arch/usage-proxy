// Agent-side onboarding script: exchange a one-time activation code for a real
// auth token by POSTing to the usage proxy's public /v1/activate endpoint, then
// write that token into this agent-gateway's .env as PROXY_TOKEN.
//
// The token is NEVER printed to the console -- it exists only in the response
// and is written straight into the .env file.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'http://localhost:8787';

// Location of the agent-gateway .env. Override via arg 3, else env, else the
// repo sibling of this project's parent (the default checkout layout).
const envPath = (() => {
  const given = process.argv[3] || process.env.ENV_FILE_PATH;
  if (given) return path.resolve(given);
  return path.resolve(__dirname, '..', '..', 'Agent gatway in Native-languages', 'agent-gateway', '.env');
})();

async function activate() {
  const code = process.argv[2] || process.env.ACTIVATION_CODE;
  if (!code) {
    console.error('No activation code provided. Pass it as the 2nd arg or set ACTIVATION_CODE.');
    process.exit(1);
  }

  let res;
  try {
    res = await fetch(`${PROXY_BASE_URL}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activation_code: code }),
    });
  } catch (err) {
    console.error(`Could not reach usage proxy at ${PROXY_BASE_URL}:`, err.message);
    process.exit(1);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.token) {
    console.error(`Activation failed (HTTP ${res.status}): ${body.error || 'unknown error'}`);
    process.exit(1);
  }

  if (!fs.existsSync(envPath)) {
    console.error(`Env file not found: ${envPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const lines = raw.split('\n');
  const tokenLine = `PROXY_TOKEN=${body.token}`;
  let found = false;

  const updated = lines.map((line) => {
    if (/^PROXY_TOKEN=/.test(line)) {
      found = true;
      return tokenLine;
    }
    return line;
  });

  if (!found) {
    updated.push(tokenLine);
  }

  fs.writeFileSync(envPath, updated.join('\n'));

  console.log('Activation successful.');
  console.log(`  PROXY_TOKEN written to ${envPath}`);
  console.log('  Token is stored securely in .env and was not printed.');
}

activate().catch((err) => {
  console.error('activateInstance failed:', err.message);
  process.exit(1);
});
