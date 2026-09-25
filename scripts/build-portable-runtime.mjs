#!/usr/bin/env node
/** Build a relocatable stdio MCP package; Node and AutoHotkey are supplied by the host. */
import { build, version as esbuildVersion } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out')) {
  throw new Error('Usage: node scripts/build-portable-runtime.mjs [--out <directory>]');
}
const output = path.resolve(args[1] || path.join(repository, 'artifacts', 'mcp-runtime'));
const relativeOutput = path.relative(repository, output);
function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}
if (
  output === path.parse(output).root ||
  isWithin(output, repository) ||
  (isWithin(repository, output) && relativeOutput.split(path.sep)[0] !== 'artifacts')
) {
  throw new Error(
    'Output must be inside artifacts/ or an external generated-runtime directory, never a source directory or ancestor.'
  );
}

async function optionalStat(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function validateReplaceableOutput() {
  const info = await optionalStat(output);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Output must be a regular directory.');
  if ((await readdir(output)).length === 0) return;
  let previous;
  try {
    previous = JSON.parse(await readFile(path.join(output, 'portable-runtime.json'), 'utf8'));
  } catch {
    throw new Error(
      'Refusing to replace a nonempty directory without a portable-runtime.json marker.'
    );
  }
  if (
    previous.formatVersion !== 1 ||
    previous.name !== 'ahk-server-v2' ||
    previous.entrypoint !== 'launch.mjs'
  ) {
    throw new Error('Refusing to replace an unrecognized runtime directory.');
  }
}

async function filesIn(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symlinks are not portable runtime assets: ${file}`);
    if (entry.isDirectory()) result.push(...(await filesIn(directory, file)));
    else if (entry.isFile()) result.push(file);
    else throw new Error(`Unsupported runtime asset: ${file}`);
  }
  return result.sort();
}

async function copyAssetTree(stage, directory, extension) {
  const source = path.join(repository, directory);
  if (!(await optionalStat(source))) return [];
  const copied = [];
  for (const file of await filesIn(source)) {
    if (!file.toLowerCase().endsWith(extension)) continue;
    const relative = `${directory}/${file}`;
    await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
    await cp(path.join(repository, relative), path.join(stage, relative));
    copied.push(relative);
  }
  return copied;
}

async function dependencyNotices(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(repository, input));
    while (directory !== path.dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name && metadata.version) {
          packages.set(directory, metadata);
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = path.dirname(directory);
    }
  }
  const records = [];
  const notices = [
    'Bundled dependency notices',
    '',
    'License texts below are copied verbatim from installed dependency packages.',
    '',
  ];
  for (const [directory, metadata] of [...packages.entries()].sort((a, b) =>
    a[1].name.localeCompare(b[1].name)
  )) {
    const license =
      typeof metadata.license === 'string'
        ? metadata.license
        : JSON.stringify(metadata.license || metadata.licenses || 'Unspecified');
    records.push({ name: metadata.name, version: metadata.version, license });
    notices.push(`${metadata.name}@${metadata.version}`, `Declared license: ${license}`, '');
    const licenseFiles = (await readdir(directory))
      .filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name))
      .sort();
    for (const file of licenseFiles) {
      if ((await lstat(path.join(directory, file))).isFile()) {
        notices.push(`--- ${file} ---`, await readFile(path.join(directory, file), 'utf8'), '');
      }
    }
    if (!licenseFiles.length)
      notices.push('No standalone license file present in the installed package.', '');
  }
  return { records, text: notices.join('\n') };
}

function gitValue(args) {
  try {
    return execFileSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

const launcher = `#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Configure before importing the server: several modules capture environment at load time.
const runtimeRoot = fileURLToPath(new URL('./', import.meta.url));
process.chdir(runtimeRoot);
process.argv.splice(2);
delete process.env.PORT;
process.env.AHK_MCP_OBSERVABILITY_ENABLED = 'false';
process.env.AHK_DAP_ENABLED = '0';
process.env.AHK_MCP_OTEL_ENABLED = 'false';
process.env.AHK_MCP_STUDIO_EXECUTION = 'off';
process.env.AHK_MCP_UNIFIED_LOG = 'false';
// Keep tool settings beside the host-selected config, rather than another installation's settings.
if (process.env.AHK_MCP_CONFIG_DIR && !process.env.AHK_MCP_SETTINGS_PATH) {
  process.env.AHK_MCP_SETTINGS_PATH = path.join(process.env.AHK_MCP_CONFIG_DIR, 'tool-settings.json');
}
await import('./dist/core/server.mjs');
`;

await validateReplaceableOutput();
const outputParent = path.dirname(output);
await mkdir(outputParent, { recursive: true });
const stage = await mkdtemp(path.join(outputParent, '.mcp-runtime-'));
let published = false;
try {
  const result = await build({
    absWorkingDir: repository,
    entryPoints: ['src/index.ts'],
    outfile: path.join(stage, 'dist', 'core', 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    metafile: true,
    legalComments: 'inline',
    banner: {
      js: "import { createRequire as __portableCreateRequire } from 'node:module'; const require = __portableCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const built of Object.values(result.metafile.outputs)) {
    for (const imported of built.imports) {
      if (imported.external && !builtins.has(imported.path)) {
        throw new Error(`Unbundled runtime dependency: ${imported.path}`);
      }
    }
  }
  const runtimeAssets = [];
  for (const [directory, extension] of [
    ['data', '.json'],
    ['docs/Modules', '.md'],
    ['inspector', '.ahk'],
    ['scripts', '.ahk'],
    ['config', '.json'],
  ]) {
    runtimeAssets.push(...(await copyAssetTree(stage, directory, extension)));
  }
  const metadata = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const notices = await dependencyNotices(result.metafile.inputs);
  await writeFile(path.join(stage, 'launch.mjs'), launcher);
  await writeFile(
    path.join(stage, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        private: true,
        type: 'module',
        main: 'launch.mjs',
        engines: { node: '>=20' },
      },
      null,
      2
    ) + '\n'
  );
  await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.text);
  const sourceLicense = await optionalStat(path.join(repository, 'LICENSE'));
  if (sourceLicense?.isFile())
    await cp(path.join(repository, 'LICENSE'), path.join(stage, 'LICENSE'));
  await writeFile(
    path.join(stage, 'README.md'),
    `# Portable AutoHotkey MCP runtime

Run node /absolute/path/to/launch.mjs with Node.js 20 or newer. In a VS Code desktop host, Code.exe may be used with ELECTRON_RUN_AS_NODE=1. This package requires no npm install and may be relocated intact.

The launcher always selects stdio, disables startup HTTP/observability/DAP listeners and telemetry export, and uses this package as its resource working directory. Supply AHK_MCP_SCRIPT_DIR for the user's workspace, AHK_MCP_CONFIG_DIR for host-owned writable settings, AHK_PATH and AHK_PATH_WIN for the interpreter, and optionally AHK_THQBY_LSP_SERVER for an separately installed language server. MCP roots and explicit file paths are supported. Clear AHK_ACTIVE_FILE when starting a new workspace session.

AutoHotkey itself and the optional THQBY language server are not included. AHK execution/UI Automation require a compatible Windows interpreter and interactive desktop. Tools retain their native host permissions; this package is not a sandbox. Debug tools can create listeners when explicitly called even though startup listeners are off. Existing tools write runtime logs/config to the package working directory, so the package directory must be writable.

Source: ahk-mcp, source entry src/index.ts. The manifest records source revision and whether the source had local changes. The source package ${sourceLicense ? 'includes LICENSE.' : 'does not declare a project license or contain LICENSE; no additional license grant is asserted here.'} Bundled dependencies retain their own licenses, reproduced in THIRD_PARTY_NOTICES.txt. Included AutoHotkey assets retain their original source comments and notices.
`
  );
  const manifest = {
    formatVersion: 1,
    name: metadata.name,
    version: metadata.version,
    entrypoint: 'launch.mjs',
    node: '>=20',
    transport: 'stdio',
    source: 'ahk-mcp/src/index.ts',
    sourceRevision: gitValue(['rev-parse', 'HEAD']) || null,
    sourceDirty: Boolean(gitValue(['status', '--porcelain'])),
    bundler: { name: 'esbuild', version: esbuildVersion },
    bundledDependencies: notices.records,
    runtimeAssets: runtimeAssets.sort(),
    files: [...(await filesIn(stage)), 'portable-runtime.json'].sort(),
  };
  await writeFile(
    path.join(stage, 'portable-runtime.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  // Only replace a directory already identified as generated output, after the new build succeeds.
  await validateReplaceableOutput();
  if (path.dirname(output) !== outputParent) throw new Error('Output path boundary changed.');
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  published = true;
  console.log(
    JSON.stringify({
      output,
      entrypoint: 'launch.mjs',
      files: manifest.files.length,
      dependencies: notices.records.length,
    })
  );
} finally {
  if (!published) {
    if (path.dirname(stage) !== outputParent || !path.basename(stage).startsWith('.mcp-runtime-'))
      throw new Error('Invalid staging boundary.');
    await rm(stage, { recursive: true, force: true });
  }
}
