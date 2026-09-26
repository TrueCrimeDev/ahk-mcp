import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { SpawnFunction } from '../../../src/core/run-manager.js';

/** Stands in for a child's stdout or stderr: the manager only listens for 'data'. */
export class FakeReadable extends EventEmitter {}

export class FakeStdin extends EventEmitter {
  readonly written: string[] = [];
  writableEnded = false;
  destroyed = false;

  write(data: string): boolean {
    this.written.push(data);
    return true;
  }

  end(): void {
    this.writableEnded = true;
  }
}

/**
 * A ChildProcess double. Tests drive it with out()/err()/exit(); 'spawn' is
 * emitted on a promise job, as Node emits it asynchronously, and promise jobs
 * are not affected by Jest's fake timers.
 */
export class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeStdin();
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  exited = false;
  /** Called by kill(); defaults to doing nothing, like a process that ignores it. */
  onKill: ((signal: NodeJS.Signals | number | undefined) => void) | null = null;

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
    readonly pid: number
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    this.onKill?.(signal);
    return true;
  }

  out(data: string | Buffer): void {
    this.stdout.emit('data', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  err(data: string | Buffer): void {
    this.stderr.emit('data', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  /** Emits 'exit' then 'close', as a process that ends and releases its pipes. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

export interface FakeSpawnerOptions {
  /** Runs once the child has emitted 'spawn'; drive output and exit from here. */
  onSpawn?: (child: FakeChild) => void;
  /** Throw from spawn() itself instead of returning a child. */
  throwOnSpawn?: Error;
  /** Emit 'error' instead of 'spawn' (e.g. ENOENT). */
  failWith?: Error;
  /** Whether taskkill ends its target. Default true. */
  taskkillKills?: boolean;
  /** Exit code taskkill reports. Default 0. */
  taskkillExitCode?: number;
}

export interface FakeSpawner {
  spawn: CountingSpawn;
  /** Every spawned child except taskkill. */
  readonly children: FakeChild[];
  /** taskkill invocations. */
  readonly killers: FakeChild[];
  last(): FakeChild;
}

type CountingSpawn = SpawnFunction & { calls: number };

let nextPid = 4000;

export function isTaskkill(command: string): boolean {
  return /taskkill\.exe$/i.test(command);
}

/** A spawn function that records calls and answers taskkill by ending its target. */
export function createFakeSpawner(options: FakeSpawnerOptions = {}): FakeSpawner {
  const children: FakeChild[] = [];
  const killers: FakeChild[] = [];

  const spawn = ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
    spawn.calls += 1;
    if (options.throwOnSpawn && !isTaskkill(command)) throw options.throwOnSpawn;
    const child = new FakeChild(command, args, spawnOptions, nextPid++);

    if (isTaskkill(command)) {
      killers.push(child);
      const targetPid = Number(args[args.indexOf('/PID') + 1]);
      void Promise.resolve().then(() => {
        child.emit('spawn');
        if (options.taskkillKills ?? true) {
          children.find(candidate => candidate.pid === targetPid)?.exit(1);
        }
        child.exit(options.taskkillExitCode ?? 0);
      });
      return child as unknown as ChildProcess;
    }

    children.push(child);
    void Promise.resolve().then(() => {
      if (options.failWith) {
        child.emit('error', options.failWith);
        child.emit('close', -4058, null);
        return;
      }
      child.emit('spawn');
      options.onSpawn?.(child);
    });
    return child as unknown as ChildProcess;
  }) as CountingSpawn;
  spawn.calls = 0;

  return {
    spawn,
    children,
    killers,
    last() {
      const child = children[children.length - 1];
      if (!child) throw new Error('nothing was spawned');
      return child;
    },
  };
}

/** Lets promise chains settle without touching (possibly faked) timers. */
export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}
