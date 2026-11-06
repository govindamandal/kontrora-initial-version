const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Skip nested installs triggered by this script.
if (process.env.MOTIONOPS_PRIVATE_INSTALL) {
  process.exit(0);
}

const token = process.env.NPM_TOKEN || ''

// Keep these OUT of package.json dependencies. npm resolves the tree before
// postinstall, so a private (or privately-dependent) package listed there
// 404s before this script can authenticate.
const privatePackages = [
  'automic-style-engine@^1.2.6',
];

if (!token) {
  console.error(
    'ERROR: NPM token is missing.\n' +
      'Open scripts/install-private.cjs and set `const token = ...`.\n'
  );
  process.exit(1);
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      // try next candidate
    }
  }

  return null;
}

const npmCli = resolveNpmCli();
if (!npmCli) {
  console.error('ERROR: Unable to locate npm CLI.\n');
  process.exit(1);
}

// Auth via a temporary userconfig (env _authToken is unreliable across npm versions).
const npmrcPath = path.join(os.tmpdir(), `kontrora-npmrc-${process.pid}`);
fs.writeFileSync(
  npmrcPath,
  [
    'registry=https://registry.npmjs.org/',
    '//registry.npmjs.org/:_authToken=' + token,
    '@utilitycraft:registry=https://registry.npmjs.org/',
  ].join('\n') + '\n',
  { mode: 0o600 }
);

const env = {
  ...process.env,
  MOTIONOPS_PRIVATE_INSTALL: '1',
  npm_config_loglevel: 'silent',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_update_notifier: 'false',
};

if (env.NPM_CONFIG_CACHE && String(env.NPM_CONFIG_CACHE).includes('cursor-sandbox-cache')) {
  delete env.NPM_CONFIG_CACHE;
  delete env.npm_config_cache;
}

let exitCode = 0;
try {
  const result = spawnSync(
    process.execPath,
    [
      npmCli,
      'install',
      ...privatePackages,
      '--no-save',
      '--package-lock=false',
      '--userconfig',
      npmrcPath,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  if (result.error) {
    console.error(result.error.message);
    exitCode = 1;
  } else if (result.status !== 0) {
    const err = (result.stderr || '').trim();
    if (err) console.error(err);
    exitCode = result.status ?? 1;
  }
} finally {
  try {
    fs.unlinkSync(npmrcPath);
  } catch {
    // ignore cleanup errors
  }
}

process.exit(exitCode);
