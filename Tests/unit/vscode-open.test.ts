import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openFileInVSCode, resetVSCodeCommandCache } from '../../src/utils/vscode-open.js';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

describe('VS Code opens from an Electron Node MCP worker', () => {
  const savedElectron = process.env.ELECTRON_RUN_AS_NODE;
  const savedCommand = process.env.AHK_MCP_VSCODE_PATH;
  const savedIpc = process.env.VSCODE_IPC_HOOK_CLI;

  afterEach(() => {
    for (const [name, value] of [
      ['ELECTRON_RUN_AS_NODE', savedElectron],
      ['AHK_MCP_VSCODE_PATH', savedCommand],
      ['VSCODE_IPC_HOOK_CLI', savedIpc],
    ]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
    resetVSCodeCommandCache();
    jest.clearAllMocks();
  });

  it.each(['Code.exe', 'code.cmd'])(
    'clears Electron Node mode for both %s probe and open while retaining the worker environment',
    async command => {
      const calls: Array<{ args: readonly string[]; options: SpawnOptions }> = [];
      const mockedSpawn = jest.mocked(spawn);
      mockedSpawn.mockImplementation(((
        executable: string,
        args: readonly string[],
        options: SpawnOptions
      ) => {
        expect(executable).toBe(command);
        calls.push({ args, options });
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: jest.fn(),
        });
        queueMicrotask(() => child.emit('close', 0));
        return child as unknown as ChildProcess;
      }) as typeof spawn);

      process.env.ELECTRON_RUN_AS_NODE = '1';
      process.env.AHK_MCP_VSCODE_PATH = command;
      process.env.VSCODE_IPC_HOOK_CLI = 'test-editor-ipc-hook';
      resetVSCodeCommandCache();
      const directory = await mkdtemp(path.join(os.tmpdir(), 'ahk-vscode-env-test-'));
      try {
        const target = path.join(directory, 'example.ahk');
        await writeFile(target, '; test only: never executed');
        const result = await openFileInVSCode(target, { line: 1, reuseWindow: true });
        expect(result.exitCode).toBe(0);
        expect(calls).toHaveLength(2);
        expect(calls[0].args).toEqual(['--version']);
        expect(calls[1].args).toEqual(['--reuse-window', '--goto', `${target}:1`]);
        for (const call of calls) {
          expect(call.options.env).toBeDefined();
          expect(call.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
          expect(call.options.env?.VSCODE_IPC_HOOK_CLI).toBe('test-editor-ipc-hook');
        }
        expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1');
      } finally {
        expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
        expect(path.basename(directory)).toMatch(/^ahk-vscode-env-test-/);
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});
