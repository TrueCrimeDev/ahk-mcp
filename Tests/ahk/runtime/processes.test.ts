import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findAutoHotkey } from '../../setup/ahk-runtime.js';
import { RunManager } from '../../../src/core/run-manager.js';
import { detectWindows } from '../../../src/core/window-detect.js';

const ahk = findAutoHotkey();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

(ahk ? describe : describe.skip)('run manager with AutoHotkey', () => {
  const exe = ahk as string;
  const runs = new RunManager();
  let dir: string;

  const script = async (name: string, content: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, content, 'utf8');
    return file;
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ahk-mcp-runs-'));
  });

  afterAll(async () => {
    await runs.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('captures UTF-8 output and the exit code', async () => {
    const file = await script(
      'exit.ahk',
      'FileAppend("héllo 😀`n", "*", "UTF-8-RAW")\nFileAppend("to stderr", "**", "UTF-8-RAW")\nExitApp(3)\n'
    );
    const snapshot = await runs.run({ exe, script: file, windowsHide: true, timeoutMs: 15000 });
    expect(snapshot).toMatchObject({
      status: 'exited',
      exitCode: 3,
      stdout: 'héllo 😀\n',
      stderr: 'to stderr',
    });
  });

  it('passes arguments after the script path to the script', async () => {
    const file = await script(
      'args.ahk',
      'for arg in A_Args\n    FileAppend(arg "|", "*", "UTF-8-RAW")\n'
    );
    const snapshot = await runs.run({
      exe,
      script: file,
      args: ['/Validate', 'two words', 'é'],
      windowsHide: true,
      timeoutMs: 15000,
    });
    expect(snapshot.stdout).toBe('/Validate|two words|é|');
  });

  // /ErrorStdOut covers load errors only: an unhandled runtime error still opens a
  // dialog, so a hidden run waits for its timeout. An OnError prelude passed with
  // switches.include reports it on stderr in the same "file (line) : ==>" format.
  it('needs an /include prelude to report runtime errors instead of hanging', async () => {
    const file = await script('throws.ahk', 'x := 1\nthrow Error("boom")\n');
    const bare = await runs.run({ exe, script: file, windowsHide: true, timeoutMs: 2000 });
    expect(bare).toMatchObject({ status: 'timeout', stderr: '' });

    const prelude = await script(
      'report-errors.ahk',
      [
        'OnError(ReportRuntimeError)',
        'ReportRuntimeError(e, mode) {',
        '    FileAppend(e.File " (" e.Line ") : ==> " Type(e) ": " e.Message "`n", "**", "UTF-8-RAW")',
        '    ExitApp(2)',
        '}',
      ].join('\n')
    );
    const reported = await runs.run({
      exe,
      script: file,
      switches: { include: prelude },
      windowsHide: true,
      timeoutMs: 15000,
    });
    expect(reported).toMatchObject({ status: 'exited', exitCode: 2 });
    expect(reported.stderr).toBe(`${file} (2) : ==> Error: boom\n`);
  });

  it('kills the whole tree on timeout and keeps the partial output', async () => {
    const file = await script(
      'tree.ahk',
      [
        'Run(A_ComSpec " /c ping -n 60 127.0.0.1 >nul", , "Hide", &childPid)',
        'FileAppend(childPid "`n", "*")',
        'Sleep(60000)',
      ].join('\n')
    );
    const snapshot = await runs.run({ exe, script: file, windowsHide: true, timeoutMs: 2000 });
    expect(snapshot.status).toBe('timeout');
    const childPid = Number(snapshot.stdout.trim());
    expect(childPid).toBeGreaterThan(0);
    expect(await waitUntilGone(childPid)).toBe(true);
    expect(await waitUntilGone(snapshot.pid as number)).toBe(true);
  });

  it('waits for a startup line, then stops the background run by runId', async () => {
    const file = await script(
      'background.ahk',
      'Persistent\nFileAppend("booting`n", "*")\nSleep(200)\nFileAppend("READY", "*")\n'
    );
    const handle = await runs.start({
      exe,
      script: file,
      windowsHide: true,
      startupLine: 'READY',
      startupTimeoutMs: 10000,
    });
    expect(handle.startup).toMatchObject({ matched: true, line: 'READY' });
    expect(runs.get(handle.runId)?.status).toBe('running');

    const stopped = await runs.stop(handle.runId);
    expect(stopped.status).toBe('killed');
    expect(stopped.stdout).toBe('booting\nREADY');
    expect(await waitUntilGone(handle.pid as number)).toBe(true);
  });
});

(ahk ? describe : describe.skip)('window detection with AutoHotkey', () => {
  const exe = ahk as string;
  const runs = new RunManager();
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ahk-mcp-windows-'));
  });

  afterAll(async () => {
    await runs.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a script's window by title and class, and notices when the process is gone", async () => {
    const file = path.join(dir, 'gui.ahk');
    await writeFile(
      file,
      [
        '#NoTrayIcon',
        'g := Gui(, \'ahk-mcp détection "test" \\ \' Chr(0x1F600))',
        'g.Show("w220 h80 NoActivate")',
        'SetTimer(() => ExitApp(), -30000)',
      ].join('\n'),
      'utf8'
    );
    const gui = await runs.start({ exe, script: file });
    const pid = gui.pid as number;

    const found = await detectWindows({ pid, title: 'DÉTECTION', exe, timeoutMs: 10000 });
    expect(found.outcome).toBe('found');
    expect(found.windows).toEqual([
      {
        hwnd: expect.any(Number),
        title: 'ahk-mcp détection "test" \\ 😀',
        className: 'AutoHotkeyGUI',
      },
    ]);

    const byClass = await detectWindows({ pid, className: 'AutoHotkeyGUI', exe, timeoutMs: 5000 });
    expect(byClass.windows).toHaveLength(1);

    const none = await detectWindows({ pid, title: 'no such window', exe, timeoutMs: 300 });
    expect(none).toMatchObject({ outcome: 'timeout', windows: [] });

    await gui.stop();
    const gone = await detectWindows({ pid, exe, timeoutMs: 5000 });
    expect(gone.outcome).toBe('process-exited');
  });
});
