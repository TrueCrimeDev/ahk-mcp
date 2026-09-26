import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';
import {
  OutputBuffer,
  RUN_RETENTION_MS,
  RunLimitError,
  RunManager,
  UnknownRunError,
  buildAhkArgv,
  getHelperScriptPath,
  validate,
  type RunEvent,
} from '../../../src/core/run-manager.js';
import { parseEnv } from '../../../src/core/env-config.js';
import {
  UnavailableError,
  configureRuntimeResolver,
  resetRuntimeCache,
} from '../../../src/core/ahk-runtime.js';
import { createFakeSpawner, flushMicrotasks, type FakeChild } from './fake-spawn.js';

const EXE = 'C:\\AutoHotkey\\v2\\AutoHotkey64.exe';
const SCRIPT = 'C:\\scripts\\demo.ahk';

function manager(
  spawner: ReturnType<typeof createFakeSpawner>,
  options: ConstructorParameters<typeof RunManager>[0] = {}
) {
  return new RunManager({
    spawn: spawner.spawn,
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    ...options,
  });
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

describe('buildAhkArgv', () => {
  it('puts every switch before the script path, then the script arguments', () => {
    expect(
      buildAhkArgv(SCRIPT, ['--flag', 'x y'], {
        validate: true,
        include: 'C:\\prelude.ahk',
        debug: { host: '127.0.0.1', port: 9005 },
      })
    ).toEqual([
      '/ErrorStdOut=utf-8',
      '/Validate',
      '/include',
      'C:\\prelude.ahk',
      '/Debug=127.0.0.1:9005',
      SCRIPT,
      '--flag',
      'x y',
    ]);
    expect(buildAhkArgv(SCRIPT)).toEqual(['/ErrorStdOut=utf-8', SCRIPT]);
  });

  it('accepts * (script on stdin) but refuses scripts that would parse as switches', () => {
    expect(buildAhkArgv('*')).toEqual(['/ErrorStdOut=utf-8', '*']);
    expect(() => buildAhkArgv('/Debug=evil:1')).toThrow(TypeError);
    expect(() => buildAhkArgv('')).toThrow(TypeError);
  });

  it('rejects malformed debugger addresses', () => {
    expect(() => buildAhkArgv(SCRIPT, [], { debug: { host: 'a b', port: 9000 } })).toThrow(
      TypeError
    );
    expect(() => buildAhkArgv(SCRIPT, [], { debug: { host: '127.0.0.1', port: 70000 } })).toThrow(
      RangeError
    );
  });
});

describe('OutputBuffer', () => {
  it('keeps the newest text, reports truncation and keeps absolute offsets', () => {
    const buffer = new OutputBuffer(10);
    buffer.append('0123456789');
    expect(buffer.truncated).toBe(false);
    buffer.append('abcde');
    expect(buffer.toString()).toBe('56789abcde');
    expect(buffer.truncated).toBe(true);
    expect(buffer.start).toBe(5);
    expect(buffer.end).toBe(15);

    expect(buffer.slice(12)).toMatchObject({
      text: 'cde',
      from: 12,
      nextOffset: 15,
      missed: false,
    });
    expect(buffer.slice(0)).toMatchObject({ text: '56789abcde', from: 5, missed: true });
    expect(buffer.slice(99)).toMatchObject({ text: '', from: 15, nextOffset: 15 });
  });

  it('never starts on the second half of a surrogate pair', () => {
    const buffer = new OutputBuffer(3);
    buffer.append('a😀b'); // a, high, low, b
    buffer.append('c');
    expect(buffer.toString()).toBe('bc');
    expect(buffer.end).toBe(5);
  });

  it('rejects a negative limit', () => {
    expect(() => new OutputBuffer(-1)).toThrow(RangeError);
  });
});

describe('RunManager', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('exit codes', () => {
    it('reports a clean exit with its output', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out('hello\r\n');
          child.err('note');
          child.exit(0);
        },
      });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT, args: ['a'] });

      expect(snapshot).toMatchObject({
        status: 'exited',
        exitCode: 0,
        stdout: 'hello\r\n',
        stderr: 'note',
        stdoutTruncated: false,
        error: null,
      });
      expect(snapshot.endedAt).not.toBeNull();
      const child = spawner.last();
      expect(child.command).toBe(EXE);
      expect(child.args).toEqual(['/ErrorStdOut=utf-8', SCRIPT, 'a']);
      expect(child.options).toMatchObject({ windowsHide: false, detached: false });
    });

    it('reports a non-zero exit code as exited, with the error text', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.err('demo.ahk (3) : ==> Missing ")"\n');
          child.exit(2);
        },
      });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT });
      expect(snapshot.status).toBe('exited');
      expect(snapshot.exitCode).toBe(2);
      expect(snapshot.stderr).toContain('Missing ")"');
    });

    it('marks a process that cannot start as failed instead of rejecting', async () => {
      const spawner = createFakeSpawner({ failWith: new Error('spawn demo ENOENT') });
      const handle = await manager(spawner).start({ exe: EXE, script: SCRIPT });
      const snapshot = await handle.done;
      expect(snapshot.status).toBe('failed');
      expect(snapshot.error).toContain('ENOENT');
      expect(snapshot.exitCode).toBeNull();
    });

    it('marks a synchronous spawn exception as failed', async () => {
      const spawner = createFakeSpawner({ throwOnSpawn: new Error('EINVAL') });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT });
      expect(snapshot).toMatchObject({ status: 'failed', error: 'EINVAL' });
    });

    it('keeps the server secrets out of the child environment', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.exit(0) });
      await manager(spawner).run({
        exe: EXE,
        script: SCRIPT,
        env: { AHK_MCP_AUTH_TOKEN: 'secret', AHK_MCP_DAP_TOKEN: 'secret', KEEP: '1' },
      });
      expect(spawner.last().options.env).toEqual({ KEEP: '1' });
    });
  });

  describe('decoding', () => {
    it('decodes UTF-8 characters split across chunks', async () => {
      const text = 'Café – 😀 ü\n';
      const bytes = Buffer.from(text, 'utf8');
      const spawner = createFakeSpawner({
        onSpawn: child => {
          // One byte per chunk splits every multi-byte character.
          for (const byte of bytes) child.out(Buffer.from([byte]));
          for (const byte of bytes) child.err(Buffer.from([byte]));
          child.exit(0);
        },
      });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT });
      expect(snapshot.stdout).toBe(text);
      expect(snapshot.stderr).toBe(text);
    });

    it('flushes a trailing incomplete sequence as a replacement character', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out(Buffer.from([0x61, 0xe2, 0x82])); // 'a' + first two bytes of '€'
          child.exit(0);
        },
      });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT });
      expect(snapshot.stdout).toBe('a\ufffd');
    });

    it('caps each stream and says so', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out('x'.repeat(30));
          child.out('tail');
          child.exit(0);
        },
      });
      const snapshot = await manager(spawner).run({ exe: EXE, script: SCRIPT, outputLimit: 10 });
      expect(snapshot.stdout).toBe('xxxxxxtail');
      expect(snapshot.stdoutTruncated).toBe(true);
      expect(snapshot.stderrTruncated).toBe(false);
    });
  });

  describe('timeout, cancel and stop', () => {
    it('keeps the partial output on timeout and kills the process tree', async () => {
      jest.useFakeTimers();
      const spawner = createFakeSpawner({ onSpawn: child => child.out('partial') });
      const handle = await manager(spawner).start({ exe: EXE, script: SCRIPT, timeoutMs: 1000 });

      await jest.advanceTimersByTimeAsync(999);
      expect(spawner.killers).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(1);
      const snapshot = await handle.done;

      expect(snapshot.status).toBe('timeout');
      expect(snapshot.stdout).toBe('partial');
      expect(spawner.killers).toHaveLength(1);
      expect(spawner.killers[0].command).toBe(
        path.win32.join('C:\\Windows', 'System32', 'taskkill.exe')
      );
      expect(spawner.killers[0].args).toEqual(['/PID', String(handle.pid), '/T', '/F']);
      expect(spawner.killers[0].options).toMatchObject({ windowsHide: true });
    });

    it('kills the tree when the signal aborts and marks the run killed', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.out('before cancel\n') });
      const controller = new AbortController();
      const handle = await manager(spawner).start({
        exe: EXE,
        script: SCRIPT,
        signal: controller.signal,
      });
      controller.abort();
      const snapshot = await handle.done;

      expect(snapshot.status).toBe('killed');
      expect(snapshot.stdout).toBe('before cancel\n');
      expect(spawner.killers.map(killer => killer.args)).toEqual([
        ['/PID', String(handle.pid), '/T', '/F'],
      ]);
    });

    it('stop(runId) kills the tree and returns the partial output', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.err('warming up') });
      const runs = manager(spawner);
      const handle = await runs.start({ exe: EXE, script: SCRIPT });

      const snapshot = await runs.stop(handle.runId);
      expect(snapshot).toMatchObject({ status: 'killed', stderr: 'warming up' });
      expect(spawner.killers).toHaveLength(1);
      // Stopping a finished run changes nothing.
      await expect(runs.stop(handle.runId)).resolves.toMatchObject({ status: 'killed' });
      expect(spawner.killers).toHaveLength(1);
    });

    it('signals the process group on POSIX hosts', async () => {
      const spawner = createFakeSpawner();
      const killProcess = jest.fn((pid: number) => {
        spawner.children.find(child => child.pid === -pid)?.exit(null, 'SIGKILL');
      });
      const runs = manager(spawner, { platform: 'linux', killProcess });
      const handle = await runs.start({ exe: EXE, script: SCRIPT });

      expect(spawner.last().options.detached).toBe(true);
      const snapshot = await runs.stop(handle.runId);
      expect(killProcess).toHaveBeenCalledWith(-(handle.pid as number), 'SIGKILL');
      expect(snapshot).toMatchObject({ status: 'killed', signal: 'SIGKILL' });
      expect(spawner.killers).toHaveLength(0);
    });

    it('falls back to killing the child directly when taskkill fails', async () => {
      const spawner = createFakeSpawner({
        taskkillKills: false,
        taskkillExitCode: 1,
        onSpawn: child => {
          child.onKill = () => child.exit(1);
        },
      });
      const runs = manager(spawner);
      const handle = await runs.start({ exe: EXE, script: SCRIPT });
      const snapshot = await runs.stop(handle.runId);
      expect(spawner.last().kills).toEqual(['SIGKILL']);
      expect(snapshot.status).toBe('killed');
    });

    it('gives up on a process that survives the kill after a grace period', async () => {
      jest.useFakeTimers();
      const spawner = createFakeSpawner({ taskkillKills: false });
      const runs = manager(spawner);
      const handle = await runs.start({ exe: EXE, script: SCRIPT, timeoutMs: 100 });
      await jest.advanceTimersByTimeAsync(100);
      expect(runs.get(handle.runId)?.endedAt).toBeNull();
      await jest.advanceTimersByTimeAsync(3000);
      const snapshot = await handle.done;
      expect(snapshot.status).toBe('timeout');
      expect(snapshot.error).toMatch(/did not report its exit/);
    });

    it('rejects without spawning when the signal is already aborted', async () => {
      const spawner = createFakeSpawner();
      await expect(
        manager(spawner).start({ exe: EXE, script: SCRIPT, signal: AbortSignal.abort() })
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(spawner.spawn.calls).toBe(0);
    });

    it('finalizes after exit when a grandchild keeps the pipes open', async () => {
      jest.useFakeTimers();
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out('done');
          child.emit('exit', 0, null); // no 'close'
        },
      });
      const handle = await manager(spawner).start({ exe: EXE, script: SCRIPT });
      await jest.advanceTimersByTimeAsync(1000);
      await expect(handle.done).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
      // Late output after the run is final is ignored.
      spawner.last().out('late');
      expect(handle.snapshot().stdout).toBe('done');
    });

    it('stopAll kills every live process, retained or not', async () => {
      const spawner = createFakeSpawner();
      const runs = manager(spawner);
      const first = await runs.start({ exe: EXE, script: SCRIPT });
      const second = await runs.start({ exe: EXE, script: SCRIPT, retain: false });
      expect(runs.activeCount()).toBe(2);
      await runs.stopAll();
      expect((await first.done).status).toBe('killed');
      expect((await second.done).status).toBe('killed');
      expect(runs.activeCount()).toBe(0);
    });
  });

  describe('run registry', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('keeps a finished run for 30 minutes, then reports it as expired', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out('result');
          child.exit(0);
        },
      });
      const runs = manager(spawner);
      const snapshot = await runs.run({ exe: EXE, script: SCRIPT });

      await jest.advanceTimersByTimeAsync(RUN_RETENTION_MS - 1);
      expect(runs.get(snapshot.runId)?.stdout).toBe('result');
      expect(runs.list().map(run => run.runId)).toEqual([snapshot.runId]);

      await jest.advanceTimersByTimeAsync(1);
      expect(runs.get(snapshot.runId)).toBeUndefined();
      expect(runs.list()).toEqual([]);
      const error = thrownBy(() => runs.read(snapshot.runId));
      expect(error).toBeInstanceOf(UnknownRunError);
      expect(error).toMatchObject({ code: 'NOT_FOUND', reason: 'expired' });
      await expect(runs.stop(snapshot.runId)).rejects.toMatchObject({ reason: 'expired' });
      await expect(runs.wait(snapshot.runId)).rejects.toBeInstanceOf(UnknownRunError);
    });

    it('keeps running processes addressable however long they run', async () => {
      const spawner = createFakeSpawner();
      const runs = manager(spawner);
      const handle = await runs.start({ exe: EXE, script: SCRIPT });
      await jest.advanceTimersByTimeAsync(RUN_RETENTION_MS * 2);
      expect(runs.get(handle.runId)?.status).toBe('running');
    });

    it('distinguishes ids it never issued', () => {
      const runs = manager(createFakeSpawner());
      expect(thrownBy(() => runs.read('nope'))).toMatchObject({ reason: 'unknown' });
    });

    it('lists retained runs only and issues distinct UUIDs', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.exit(0) });
      const runs = manager(spawner);
      const first = await runs.run({ exe: EXE, script: SCRIPT, label: 'demo.ahk' });
      const hidden = await runs.run({ exe: EXE, script: SCRIPT, retain: false });
      const second = await runs.run({ exe: EXE, script: SCRIPT });

      expect(runs.list().map(run => run.runId)).toEqual([first.runId, second.runId]);
      expect(runs.get(hidden.runId)).toBeUndefined();
      expect(first.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.runId).not.toBe(second.runId);
      expect(first.label).toBe('demo.ahk');
    });

    it('evicts the oldest finished runs beyond maxRetainedRuns', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.exit(0) });
      const runs = manager(spawner, { maxRetainedRuns: 2 });
      const a = await runs.run({ exe: EXE, script: SCRIPT });
      const b = await runs.run({ exe: EXE, script: SCRIPT });
      const c = await runs.run({ exe: EXE, script: SCRIPT });
      expect(runs.list().map(run => run.runId)).toEqual([b.runId, c.runId]);
      expect(thrownBy(() => runs.read(a.runId))).toMatchObject({ reason: 'expired' });
    });

    it('reads new output incrementally with per-stream offsets', async () => {
      let child!: FakeChild;
      const spawner = createFakeSpawner({ onSpawn: spawned => (child = spawned) });
      const runs = manager(spawner);
      const handle = await runs.start({ exe: EXE, script: SCRIPT });

      child.out('one\n');
      const first = runs.read(handle.runId);
      expect(first.stdout).toMatchObject({ text: 'one\n', nextOffset: 4 });
      child.out('two\n');
      child.err('oops');
      const second = runs.read(handle.runId, {
        stdout: first.stdout.nextOffset,
        stderr: first.stderr.nextOffset,
      });
      expect(second.stdout.text).toBe('two\n');
      expect(second.stderr.text).toBe('oops');
      expect(second.status).toBe('running');
      child.exit(0);
      await handle.done;
    });
  });

  describe('startup line', () => {
    it('resolves start() when a stdout line matches', async () => {
      let child!: FakeChild;
      const spawner = createFakeSpawner({
        onSpawn: spawned => {
          child = spawned;
          spawned.out('loading...\r\nRE');
          spawned.out('ADY on port 5\r\nmore');
        },
      });
      const handle = await manager(spawner).start({
        exe: EXE,
        script: SCRIPT,
        startupLine: /^READY on port \d+$/,
      });
      expect(handle.startup).toEqual({ matched: true, line: 'READY on port 5', timedOut: false });
      expect(handle.snapshot().status).toBe('running');
      child.exit(0);
    });

    it('matches a ready marker printed without a newline', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.out('ready') });
      const handle = await manager(spawner).start({
        exe: EXE,
        script: SCRIPT,
        startupLine: 'ready',
      });
      expect(handle.startup?.matched).toBe(true);
      await handle.stop();
    });

    it('gives up after startupTimeoutMs but leaves the process running', async () => {
      jest.useFakeTimers();
      const spawner = createFakeSpawner({ onSpawn: child => child.out('still loading\n') });
      const started = manager(spawner).start({
        exe: EXE,
        script: SCRIPT,
        startupLine: 'READY',
        startupTimeoutMs: 2000,
      });
      await jest.advanceTimersByTimeAsync(2000);
      const handle = await started;
      expect(handle.startup).toEqual({ matched: false, line: null, timedOut: true });
      expect(handle.snapshot().status).toBe('running');
      await handle.stop();
    });

    it('reports a process that exits before the line appears', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.err('boom');
          child.exit(2);
        },
      });
      const handle = await manager(spawner).start({
        exe: EXE,
        script: SCRIPT,
        startupLine: 'READY',
      });
      expect(handle.startup).toEqual({ matched: false, line: null, timedOut: false });
      expect(handle.snapshot()).toMatchObject({ status: 'exited', exitCode: 2 });
    });
  });

  describe('concurrency', () => {
    it('rejects a run over the cap for its key', async () => {
      const spawner = createFakeSpawner();
      const runs = manager(spawner, { concurrency: { run: 1 } });
      const first = await runs.start({ exe: EXE, script: SCRIPT, concurrencyKey: 'run' });
      await expect(
        runs.start({ exe: EXE, script: SCRIPT, concurrencyKey: 'run' })
      ).rejects.toBeInstanceOf(RunLimitError);
      // Other keys are unaffected.
      await runs.start({ exe: EXE, script: SCRIPT, concurrencyKey: 'other' });
      await first.stop();
      await expect(
        runs.start({ exe: EXE, script: SCRIPT, concurrencyKey: 'run' })
      ).resolves.toBeDefined();
      await runs.stopAll();
    });

    it('queues a waiting run until a slot frees, and honours abort while waiting', async () => {
      const spawner = createFakeSpawner();
      const runs = manager(spawner, { concurrency: { validate: 1 } });
      const first = await runs.start({ exe: EXE, script: SCRIPT, concurrencyKey: 'validate' });

      const controller = new AbortController();
      const abandoned = runs.start({
        exe: EXE,
        script: SCRIPT,
        concurrencyKey: 'validate',
        whenBusy: 'wait',
        signal: controller.signal,
      });
      const queued = runs.start({
        exe: EXE,
        script: SCRIPT,
        concurrencyKey: 'validate',
        whenBusy: 'wait',
      });
      await flushMicrotasks();
      expect(spawner.children).toHaveLength(1);

      controller.abort();
      await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

      spawner.children[0].exit(0);
      const second = await queued;
      expect(spawner.children).toHaveLength(2);
      expect(runs.activeCount('validate')).toBe(1);
      await second.stop();
      await first.done;
      expect(runs.activeCount('validate')).toBe(0);
    });

    it('rejects invalid caps', () => {
      expect(() => new RunManager({ concurrency: { run: 0 } })).toThrow(RangeError);
    });
  });

  describe('stdin and events', () => {
    it('writes input to stdin and closes it unless asked to keep it open', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.exit(0) });
      await manager(spawner).run({ exe: EXE, script: '*', input: 'MsgBox 1' });
      expect(spawner.last().stdin.written).toEqual(['MsgBox 1']);
      expect(spawner.last().stdin.writableEnded).toBe(true);

      const open = createFakeSpawner();
      const handle = await manager(open).start({ exe: EXE, script: SCRIPT, keepStdinOpen: true });
      expect(handle.write('1+1\n')).toBe(true);
      expect(open.last().stdin.writableEnded).toBe(false);
      handle.endInput();
      expect(open.last().stdin.writableEnded).toBe(true);
      expect(handle.write('late')).toBe(false);
      await handle.stop();
    });

    it('emits start, output and exit for retained runs only', async () => {
      const spawner = createFakeSpawner({
        onSpawn: child => {
          child.out('hi');
          child.exit(0);
        },
      });
      const onOutput = jest.fn();
      const onExit = jest.fn();
      const runs = manager(spawner, { onOutput, onExit });
      const events: RunEvent['type'][] = [];
      const unsubscribe = runs.subscribe(event => events.push(event.type));

      const snapshot = await runs.run({ exe: EXE, script: SCRIPT });
      await runs.run({ exe: EXE, script: SCRIPT, retain: false });

      expect(events).toEqual(['start', 'output', 'exit']);
      expect(onOutput).toHaveBeenCalledWith({
        type: 'output',
        runId: snapshot.runId,
        stream: 'stdout',
        text: 'hi',
      });
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ runId: snapshot.runId }));

      unsubscribe();
      await runs.run({ exe: EXE, script: SCRIPT });
      expect(events).toHaveLength(3);
    });

    it('survives a listener that throws', async () => {
      const spawner = createFakeSpawner({ onSpawn: child => child.exit(0) });
      const runs = manager(spawner);
      runs.subscribe(() => {
        throw new Error('listener bug');
      });
      await expect(runs.run({ exe: EXE, script: SCRIPT })).resolves.toMatchObject({
        status: 'exited',
      });
    });
  });
});

describe('validate', () => {
  afterEach(() => {
    resetRuntimeCache();
    jest.useRealTimers();
  });

  it('runs /Validate with the warning prelude, hidden, and returns exit code and output', async () => {
    const spawner = createFakeSpawner({
      onSpawn: child => {
        child.out('demo.ahk (4) : ==> Warning: This line will never execute\n');
        child.err('demo.ahk (2) : ==> Missing ")"\n');
        child.exit(2);
      },
    });
    const result = await validate(SCRIPT, { exe: EXE, manager: manager(spawner) });

    expect(result).toMatchObject({ exe: EXE, exitCode: 2, status: 'exited', timedOut: false });
    expect(result.stderr).toContain('Missing ")"');
    expect(result.stdout).toContain('Warning');
    const child = spawner.last();
    expect(child.args).toEqual([
      '/ErrorStdOut=utf-8',
      '/Validate',
      '/include',
      getHelperScriptPath('validate-prelude'),
      SCRIPT,
    ]);
    expect(child.options.windowsHide).toBe(true);
    if (process.platform === 'win32') expect(child.options.cwd).toBe(path.dirname(SCRIPT));
  });

  it('reports a load that never finishes as timed out', async () => {
    jest.useFakeTimers();
    const spawner = createFakeSpawner();
    const pending = validate(SCRIPT, { exe: EXE, manager: manager(spawner), timeoutMs: 500 });
    await jest.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({
      status: 'timeout',
      timedOut: true,
      exitCode: 1,
    });
  });

  it('throws UnavailableError when no AutoHotkey runtime can be found', async () => {
    configureRuntimeResolver({
      runManager: manager(createFakeSpawner()),
      env: () => parseEnv({}, { warn: () => undefined }).config,
      envSources: () => ({}),
      operatorConfig: async () => ({}),
      platformEnv: {},
      platform: 'win32',
      isFile: () => false,
    });
    await expect(
      validate(SCRIPT, { manager: manager(createFakeSpawner()) })
    ).rejects.toBeInstanceOf(UnavailableError);
  });
});

describe('getHelperScriptPath', () => {
  it('finds the bundled helpers under scripts/ahk', () => {
    for (const name of ['version-probe', 'window-detect', 'validate-prelude'] as const) {
      expect(path.basename(getHelperScriptPath(name))).toBe(`${name}.ahk`);
      expect(path.basename(path.dirname(getHelperScriptPath(name)))).toBe('ahk');
    }
  });
});
