import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of this module's file.
 *
 * import.meta.url would be simpler, but ts-jest compiles to CommonJS, where import.meta is a
 * syntax error. A V8 call site names the executing file in both module systems, including the
 * esbuild bundle of the portable runtime.
 */
function ownModuleFile(): string {
  const { prepareStackTrace, stackTraceLimit } = Error;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const callSites = new Error().stack as unknown as NodeJS.CallSite[];
    const fileName = callSites[0]?.getFileName();
    if (!fileName) throw new Error('call site has no file name');
    return fileName.startsWith('file:') ? fileURLToPath(fileName) : fileName;
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = stackTraceLimit;
  }
}

/**
 * Walks up from this module to the nearest package.json that declares a version. That is the
 * repository root for src/ and dist/, and the runtime root for the portable bundle, which writes
 * its own package.json one level above dist/.
 */
function readPackageVersion(): string {
  const start = path.dirname(ownModuleFile());
  for (let dir = start; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const { version } = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof version === 'string' && version.length > 0) return version;
    }
    if (path.dirname(dir) === dir) break;
  }
  throw new Error(`No package.json with a version found above ${start}`);
}

/** The package version, read once from package.json when this module loads. */
export const SERVER_VERSION: string = readPackageVersion();
