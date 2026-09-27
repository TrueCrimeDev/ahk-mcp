import { afterEach, describe, expect, it } from '@jest/globals';
import {
  DEFAULT_WINDOW_TIMEOUT_MS,
  WindowDetectError,
  detectWindows,
} from '../../../src/core/window-detect.js';
import {
  RunManager,
  getHelperScriptPath,
  setHelperPathMapper,
} from '../../../src/core/run-manager.js';
import {
  UnavailableError,
  configureRuntimeResolver,
  resetRuntimeCache,
} from '../../../src/core/ahk-runtime.js';
import { parseEnv } from '../../../src/core/env-config.js';
import { createFakeSpawner, flushMicrotasks, type FakeChild } from './fake-spawn.js';

// The suite drives AutoHotkey as it runs on Windows. On a POSIX host the bundled
// helpers sit at '/…' paths, which AutoHotkey would read as switches; stand in
// for the WSL mapper the server installs there.
if (process.platform !== 'win32') setHelperPathMapper(file => `C:${file}`);

const EXE = 'C:\\AutoHotkey\\v2\\AutoHotkey64.exe';

function helper(respond: (child: FakeChild) => void) {
  const spawner = createFakeSpawner({ onSpawn: respond });
  const runManager = new RunManager({
    spawn: spawner.spawn,
    platform: 'win32',
    systemRoot: 'C:\\Windows',
  });
  return { spawner, runManager };
}

describe('detectWindows', () => {
  afterEach(() => {
    resetRuntimeCache();
  });

  it('runs the helper hidden with the pid, timeout and filters, and returns its windows', async () => {
    const windows = [{ hwnd: 132456, title: 'Café "Settings" \\ 😀', className: 'AutoHotkeyGUI' }];
    const { spawner, runManager } = helper(child => {
      child.out(JSON.stringify(windows));
      child.exit(0);
    });
    const result = await detectWindows({
      pid: 4242,
      title: 'settings',
      className: 'AutoHotkeyGUI',
      timeoutMs: 1500,
      exe: EXE,
      runManager,
    });

    expect(result.outcome).toBe('found');
    expect(result.windows).toEqual(windows);
    const child = spawner.last();
    expect(child.args).toEqual([
      '/ErrorStdOut=utf-8',
      getHelperScriptPath('window-detect'),
      'pid=4242',
      'timeout=1500',
      'title=settings',
      'class=AutoHotkeyGUI',
    ]);
    expect(child.options.windowsHide).toBe(true);
  });

  it('omits filters that are not given and uses the default timeout', async () => {
    const { spawner, runManager } = helper(child => {
      child.out('[]');
      child.exit(1);
    });
    await detectWindows({ pid: 7, exe: EXE, runManager });
    expect(spawner.last().args.slice(2)).toEqual(['pid=7', `timeout=${DEFAULT_WINDOW_TIMEOUT_MS}`]);
  });

  it('maps the helper exit codes to outcomes', async () => {
    for (const [code, outcome] of [
      [1, 'timeout'],
      [3, 'process-exited'],
    ] as const) {
      const { runManager } = helper(child => {
        child.out('[]');
        child.exit(code);
      });
      await expect(detectWindows({ pid: 7, exe: EXE, runManager })).resolves.toMatchObject({
        outcome,
        windows: [],
      });
    }
  });

  it('fails on a helper error, with its message', async () => {
    const { runManager } = helper(child => {
      child.err('window-detect: pid must be a positive integer\n');
      child.exit(4);
    });
    const error = await detectWindows({ pid: 7, exe: EXE, runManager }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(WindowDetectError);
    expect((error as Error).message).toBe(
      'The window helper exited with code 4: window-detect: pid must be a positive integer'
    );
  });

  it('fails on output that is not a window list', async () => {
    const { runManager } = helper(child => {
      child.out('[{"hwnd":"x"}]');
      child.exit(0);
    });
    await expect(detectWindows({ pid: 7, exe: EXE, runManager })).rejects.toBeInstanceOf(
      WindowDetectError
    );
  });

  it('validates its arguments before starting anything', async () => {
    const { spawner, runManager } = helper(child => child.exit(0));
    await expect(detectWindows({ pid: 0, exe: EXE, runManager })).rejects.toThrow(RangeError);
    await expect(detectWindows({ pid: 1.5, exe: EXE, runManager })).rejects.toThrow(RangeError);
    await expect(
      detectWindows({ pid: 7, timeoutMs: 600_001, exe: EXE, runManager })
    ).rejects.toThrow(RangeError);
    await expect(
      detectWindows({ pid: 7, title: 'two\nlines', exe: EXE, runManager })
    ).rejects.toThrow(TypeError);
    expect(spawner.spawn.calls).toBe(0);
  });

  it('stops the helper and rejects when the signal aborts', async () => {
    const { spawner, runManager } = helper(() => undefined);
    const controller = new AbortController();
    const pending = detectWindows({ pid: 7, exe: EXE, runManager, signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawner.killers).toHaveLength(1);
  });

  it('needs an AutoHotkey runtime when no executable is given', async () => {
    const { runManager } = helper(child => child.exit(0));
    configureRuntimeResolver({
      runManager,
      env: () => parseEnv({}, { warn: () => undefined }).config,
      envSources: () => ({}),
      operatorConfig: async () => ({}),
      platformEnv: {},
      platform: 'win32',
      isFile: () => false,
    });
    await expect(detectWindows({ pid: 7, runManager })).rejects.toBeInstanceOf(UnavailableError);
  });
});
