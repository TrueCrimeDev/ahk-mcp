import { createHash } from 'node:crypto';
import {
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import path from 'node:path';

interface RegularFileStats {
  isFile(): boolean;
}

export interface VerifiedStudioScript {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly source: Buffer;
  assertIntegrity(): Promise<void>;
}

export interface PinStudioScriptOptions {
  rootPath?: string;
  realpath?: (filePath: string) => Promise<string>;
  stat?: (filePath: string) => Promise<RegularFileStats>;
  readFile?: (filePath: string) => Promise<Buffer>;
}

function hashSource(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function isStrictlyBeneath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function pinStudioScript(
  configuredPath: string,
  options: PinStudioScriptOptions = {}
): Promise<VerifiedStudioScript> {
  const realpath = options.realpath ?? nodeRealpath;
  const stat = options.stat ?? nodeStat;
  const readFile = options.readFile ?? nodeReadFile;
  const configuredRoot = options.rootPath ?? path.dirname(configuredPath);
  const canonicalRoot = await realpath(configuredRoot);
  const canonicalPath = await realpath(configuredPath);
  const metadata = await stat(canonicalPath);
  if (
    !metadata.isFile() ||
    !canonicalPath.toLowerCase().endsWith('.ahk') ||
    !isStrictlyBeneath(canonicalRoot, canonicalPath)
  ) {
    throw new Error('Studio helper integrity check failed.');
  }

  const pinnedSource = Buffer.from(await readFile(canonicalPath));
  const pinnedHash = hashSource(pinnedSource);
  return {
    canonicalPath,
    sha256: pinnedHash,
    source: Buffer.from(pinnedSource),
    async assertIntegrity(): Promise<void> {
      try {
        const currentRoot = await realpath(configuredRoot);
        const currentPath = await realpath(configuredPath);
        const currentMetadata = await stat(currentPath);
        if (
          currentRoot !== canonicalRoot ||
          currentPath !== canonicalPath ||
          !currentMetadata.isFile() ||
          !currentPath.toLowerCase().endsWith('.ahk') ||
          !isStrictlyBeneath(currentRoot, currentPath)
        ) {
          throw new Error('Studio helper integrity check failed.');
        }
        const currentHash = hashSource(await readFile(currentPath));
        if (currentHash !== pinnedHash) {
          throw new Error('Studio helper integrity check failed.');
        }
      } catch {
        throw new Error('Studio helper integrity check failed.');
      }
    },
  };
}
