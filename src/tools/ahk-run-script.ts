import { z } from 'zod';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import logger from '../logger.js';
import { activeFile, autoDetect } from '../core/active-file.js';
import {
  createErrorResponse,
  createSuccessResponse,
  createMultiPartResponse,
} from '../utils/response-helpers.js';
import { processManager } from '../core/process-manager.js';
import { safeParse } from '../core/validation-middleware.js';

const execAsync = promisify(exec);

export const AhkRunArgsSchema = z.object({
  mode: z.enum(['run', 'watch']).default('run'),
  filePath: z.string().optional(),
  ahkPath: z.string().optional(),
  errorStdOut: z.enum(['utf-8', 'cp1252']).optional().default('utf-8'),
  workingDirectory: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  runner: z.enum(['native', 'powershell']).optional().default('native'),
  wait: z.boolean().optional().default(true),
  scriptArgs: z.array(z.string()).optional().default([]),
  timeout: z.number().optional().default(30000),
  killOnExit: z.boolean().optional().default(true),
  detectWindow: z.boolean().optional().default(false),
  windowDetectTimeout: z.number().optional().default(3000),
  windowTitle: z.string().optional(),
  windowClass: z.string().optional(),
});

export const ahkRunToolDefinition = {
  name: 'AHK_Run',
  description: `Ahk run
Run an AutoHotkey v2 script, or watch a file and auto-run it after edits.`,
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['run', 'watch'],
        default: 'run',
        description: 'Run once or enable edit watch',
      },
      filePath: {
        type: 'string',
        description: 'Absolute path to .ahk file. If omitted, falls back to active file.',
      },
      ahkPath: {
        type: 'string',
        description: 'Path to AutoHotkey v2 executable (auto-detected if not provided)',
      },
      errorStdOut: {
        type: 'string',
        enum: ['utf-8', 'cp1252'],
        default: 'utf-8',
        description: 'Encoding for /ErrorStdOut',
      },
      workingDirectory: { type: 'string', description: 'Working directory for the script' },
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Enable/disable watcher in watch mode',
      },
      runner: {
        type: 'string',
        enum: ['native', 'powershell'],
        default: 'native',
        description: 'Process runner: native spawn or PowerShell Start-Process',
      },
      wait: {
        type: 'boolean',
        default: true,
        description: 'Wait for process to exit (run mode only)',
      },
      scriptArgs: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description: 'Arguments forwarded to the AHK script',
      },
      timeout: { type: 'number', default: 30000, description: 'Process timeout in milliseconds' },
      killOnExit: {
        type: 'boolean',
        default: true,
        description: 'Kill running processes when stopping watcher',
      },
      detectWindow: {
        type: 'boolean',
        default: false,
        description: 'Detect if script creates a window',
      },
      windowDetectTimeout: {
        type: 'number',
        default: 3000,
        description: 'Time to wait for window detection (ms)',
      },
      windowTitle: { type: 'string', description: 'Expected window title pattern (optional)' },
      windowClass: { type: 'string', description: 'Expected window class pattern (optional)' },
    },
  },
};

interface WatchState {
  filePath?: string;
  watcher?: fsSync.FSWatcher;
  lastRun?: number;
  debounceTimer?: NodeJS.Timeout;
}

export class AhkRunTool {
  private static state: WatchState = {};

  private static readonly AHK_COMMON_PATHS = [
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
  ];

  private async detectWindow(
    pid: number,
    options: {
      timeout?: number;
      windowTitle?: string;
      windowClass?: string;
    }
  ): Promise<{ detected: boolean; windowInfo?: any }> {
    const detectTimeout = options.timeout || 3000;
    const startTime = Date.now();

    return new Promise(resolve => {
      const checkInterval = setInterval(async () => {
        try {
          // Use PowerShell to check for windows created by the process
          const psScript = `
            $pid = ${pid}
            $windows = Get-Process -Id $pid -ErrorAction SilentlyContinue | ForEach-Object {
              $_.MainWindowTitle
            }
            if ($windows) {
              Write-Output $windows
            }
          `;

          const { stdout } = await execAsync(
            `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
          );
          const windowTitle = stdout.trim();

          if (windowTitle) {
            clearInterval(checkInterval);
            logger.info(`Window detected for PID ${pid}: ${windowTitle}`);
            resolve({
              detected: true,
              windowInfo: {
                title: windowTitle,
                pid: pid,
                detectionTime: Date.now() - startTime,
              },
            });
          }
        } catch (err) {
          // Process might not exist or have no window yet
        }

        // Check for timeout
        if (Date.now() - startTime >= detectTimeout) {
          clearInterval(checkInterval);
          logger.info(`No window detected for PID ${pid} within ${detectTimeout}ms`);
          resolve({ detected: false });
        }
      }, 100); // Check every 100ms
    });
  }

  private static async findAutoHotkeyPath(): Promise<string | undefined> {
    // Check common installation paths
    for (const ahkPath of AhkRunTool.AHK_COMMON_PATHS) {
      try {
        await fs.access(ahkPath);
        logger.info(`Found AutoHotkey at: ${ahkPath}`);
        return ahkPath;
      } catch {
        // Continue checking other paths
      }
    }

    // Try to find via registry or PATH
    if (os.platform() === 'win32') {
      try {
        const { stdout } = await execAsync('where AutoHotkey64.exe');
        const foundPath = stdout.trim().split('\n')[0];
        if (foundPath) {
          logger.info(`Found AutoHotkey in PATH: ${foundPath}`);
          return foundPath;
        }
      } catch {
        // Fall through to return null
      }
    }

    return undefined;
  }

  private runOnce(
    ahkExe: string,
    scriptPath: string,
    options: {
      cwd?: string;
      errorStdOut?: string;
      runner?: 'native' | 'powershell';
      wait?: boolean;
      scriptArgs?: string[];
      timeout?: number;
    }
  ): Promise<
    | {
        exitCode: number;
        command: string;
        pid?: number;
        stdout?: string;
        stderr?: string;
        stdoutTruncated?: boolean;
        stderrTruncated?: boolean;
      }
    | { started: true; command: string; pid?: number }
  > {
    return new Promise((resolve, reject) => {
      try {
        const runner = options.runner ?? 'native';
        const wait = options.wait !== false;
        const scriptArgs = options.scriptArgs || [];
        const errorStdOut = options.errorStdOut || 'utf-8';
        const timeout = options.timeout || 30000;
        const maxOutputChars = 8000;
        let capturedStdout = '';
        let capturedStderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;

        const appendOutput = (current: string, chunk: Buffer, type: 'stdout' | 'stderr') => {
          if (current.length >= maxOutputChars) {
            if (type === 'stdout') stdoutTruncated = true;
            if (type === 'stderr') stderrTruncated = true;
            return current;
          }
          const text = chunk.toString();
          const remaining = maxOutputChars - current.length;
          if (text.length > remaining) {
            if (type === 'stdout') stdoutTruncated = true;
            if (type === 'stderr') stderrTruncated = true;
            return current + text.slice(0, remaining);
          }
          return current + text;
        };

        // Properly escape arguments
        const escapedArgs = scriptArgs.map(arg => {
          if (typeof arg !== 'string') return String(arg);
          // For Windows, escape quotes and wrap in quotes if contains spaces
          if (arg.includes(' ') || arg.includes('"')) {
            return `"${arg.replace(/"/g, '\\"')}"`;
          }
          return arg;
        });

        const directCmd = `"${ahkExe}" "${scriptPath}"${escapedArgs.length ? ' ' + escapedArgs.join(' ') : ''}`;
        const spCmd = `Start-Process -FilePath '${ahkExe.replace(/'/g, "''")}' -ArgumentList @('${scriptPath.replace(/'/g, "''")}' ${scriptArgs.map(a => `, '${String(a).replace(/'/g, "''")}'`).join('')})${wait ? ' -Wait' : ''}`;

        let timeoutId: NodeJS.Timeout | null = null;
        let isResolved = false;

        const cleanup = () => {
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
        };

        if (runner === 'native') {
          const args = [`/ErrorStdOut=${errorStdOut}`, scriptPath, ...scriptArgs];
          logger.info(
            `Launching AHK (native): "${ahkExe}" ${args.map(a => JSON.stringify(a)).join(' ')}`
          );

          const child = spawn(ahkExe, args, {
            cwd: options.cwd || path.dirname(scriptPath),
            windowsHide: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          // Register process with global manager
          processManager.registerProcess(child.pid!, scriptPath);

          child.stdout?.on('data', (data: Buffer) => {
            capturedStdout = appendOutput(capturedStdout, data, 'stdout');
          });

          child.stderr?.on('data', (data: Buffer) => {
            capturedStderr = appendOutput(capturedStderr, data, 'stderr');
          });

          child.on('error', err => {
            cleanup();
            if (!isResolved) {
              isResolved = true;
              logger.error('Failed to start AHK:', err);
              reject(new Error(`Failed to start AutoHotkey: ${err.message}`));
            }
          });

          if (wait) {
            timeoutId = setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                logger.warn(`AHK process timed out after ${timeout}ms, killing process`);
                child.kill('SIGTERM');
                setTimeout(() => child.kill('SIGKILL'), 5000);
                reject(new Error(`Process timed out after ${timeout}ms`));
              }
            }, timeout);

            child.on('exit', (code, signal) => {
              cleanup();
              if (!isResolved) {
                isResolved = true;
                logger.info(`AHK exited with code ${code}, signal ${signal}`);
                resolve({
                  exitCode: code ?? -1,
                  command: directCmd,
                  pid: child.pid,
                  stdout: capturedStdout,
                  stderr: capturedStderr,
                  stdoutTruncated,
                  stderrTruncated,
                });
              }
            });

            child.on('close', () => {
              processManager.unregisterProcess(child.pid!);
            });
          } else {
            // For non-wait mode, give the process a moment to confirm it started
            setTimeout(() => {
              if (!isResolved) {
                isResolved = true;
                // Check if process is still running after brief delay
                try {
                  process.kill(child.pid!, 0); // Signal 0 checks if process exists
                  resolve({ started: true, command: directCmd, pid: child.pid });
                } catch {
                  reject(new Error('Process failed to start or exited immediately'));
                }
              }
            }, 200); // 200ms delay to confirm startup
          }
          return;
        }

        // PowerShell Start-Process runner
        const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', spCmd];
        logger.info(
          `Launching AHK (powershell): pwsh ${psArgs.map(a => JSON.stringify(a)).join(' ')}`
        );

        const child = spawn('pwsh', psArgs, {
          cwd: options.cwd || path.dirname(scriptPath),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Register process with global manager
        processManager.registerProcess(child.pid!, scriptPath);

        child.stdout?.on('data', (data: Buffer) => {
          capturedStdout = appendOutput(capturedStdout, data, 'stdout');
        });

        child.stderr?.on('data', (data: Buffer) => {
          capturedStderr = appendOutput(capturedStderr, data, 'stderr');
        });

        child.on('error', err => {
          cleanup();
          if (!isResolved) {
            isResolved = true;
            logger.error('Failed to start AHK via PowerShell:', err);
            reject(new Error(`Failed to start AutoHotkey via PowerShell: ${err.message}`));
          }
        });

        if (wait) {
          timeoutId = setTimeout(() => {
            if (!isResolved) {
              isResolved = true;
              logger.warn(`AHK process (PowerShell) timed out after ${timeout}ms, killing process`);
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 5000);
              reject(new Error(`Process timed out after ${timeout}ms`));
            }
          }, timeout);

          child.on('exit', (code, signal) => {
            cleanup();
            if (!isResolved) {
              isResolved = true;
              logger.info(`AHK (powershell) exited with code ${code}, signal ${signal}`);
              resolve({
                exitCode: code ?? -1,
                command: spCmd,
                pid: child.pid,
                stdout: capturedStdout,
                stderr: capturedStderr,
                stdoutTruncated,
                stderrTruncated,
              });
            }
          });

          child.on('close', () => {
            processManager.unregisterProcess(child.pid!);
          });
        } else {
          // For non-wait mode, give the process a moment to confirm it started
          setTimeout(() => {
            if (!isResolved) {
              isResolved = true;
              // Check if process is still running after brief delay
              try {
                process.kill(child.pid!, 0); // Signal 0 checks if process exists
                resolve({ started: true, command: spCmd, pid: child.pid });
              } catch {
                reject(new Error('Process failed to start or exited immediately'));
              }
            }
          }, 200); // 200ms delay to confirm startup
        }
      } catch (err) {
        logger.error('Error in runOnce:', err);
        reject(
          new Error(
            `Error launching AutoHotkey: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });
  }

  private async ensureFile(pathToFile?: string): Promise<string> {
    // If a path is provided, try to auto-detect and set it
    if (pathToFile) {
      autoDetect(pathToFile);
    }

    // Get the file from either the provided path or the active file
    const file = pathToFile ? path.resolve(pathToFile) : activeFile.getActiveFile();

    if (!file) {
      throw new Error('No filePath provided and no active file set.');
    }

    try {
      await fs.access(file);
    } catch {
      throw new Error(`File not found: ${file}`);
    }

    const normalizedPath = path.resolve(file);
    if (!normalizedPath.toLowerCase().endsWith('.ahk')) {
      throw new Error('filePath must point to a .ahk file');
    }

    // Update the shared active file variable
    activeFile.setActiveFile(normalizedPath);

    return normalizedPath;
  }

  private stopWatcher(): void {
    try {
      if (AhkRunTool.state.debounceTimer) {
        clearTimeout(AhkRunTool.state.debounceTimer);
        AhkRunTool.state.debounceTimer = undefined;
      }
      AhkRunTool.state.watcher?.close();
    } catch (err) {
      logger.warn('Error stopping watcher:', err);
    }
    AhkRunTool.state.watcher = undefined;
  }

  private killRunningProcesses(): void {
    // Delegate to global process manager
    processManager.killAllProcesses();
  }

  async execute(args: unknown): Promise<any> {
    try {
      const parsed = safeParse(args, AhkRunArgsSchema, 'AHK_Run');
      if (!parsed.success) return parsed.error;

      const {
        mode,
        filePath,
        ahkPath,
        errorStdOut,
        workingDirectory,
        enabled,
        runner,
        wait,
        scriptArgs,
        timeout,
        killOnExit,
        detectWindow,
        windowDetectTimeout,
        windowTitle,
        windowClass,
      } = parsed.data;

      // Auto-detect AutoHotkey path if not provided
      let resolvedAhkPath = ahkPath;
      if (!resolvedAhkPath) {
        resolvedAhkPath = await AhkRunTool.findAutoHotkeyPath();
        if (!resolvedAhkPath) {
          throw new Error(
            'AutoHotkey v2 not found. Please install AutoHotkey v2 or provide ahkPath parameter.'
          );
        }
      }

      // Validate AutoHotkey executable
      try {
        await fs.access(resolvedAhkPath);
      } catch {
        throw new Error(`AutoHotkey executable not found at: ${resolvedAhkPath}`);
      }

      if (mode === 'run') {
        const file = await this.ensureFile(filePath);
        const result = await this.runOnce(resolvedAhkPath, file, {
          cwd: workingDirectory,
          errorStdOut,
          runner,
          wait,
          scriptArgs,
          timeout,
        });

        const commandPreview =
          runner === 'powershell'
            ? `Start-Process -FilePath '${resolvedAhkPath}' -ArgumentList @('${file}'${(scriptArgs || []).map(a => `, '${a.replace(/'/g, "''")}'`).join('')})${wait ? ' -Wait' : ''}`
            : `"${resolvedAhkPath}" "${file}"${(scriptArgs || []).length ? ' ' + (scriptArgs || []).join(' ') : ''}`;

        const response: any = {
          command: commandPreview,
          runner,
          waited: !!wait,
          exitCode: 'exitCode' in result ? result.exitCode : null,
          pid: result.pid || null,
          started: 'started' in result ? result.started : false,
          filePath: file,
          ahkPath: resolvedAhkPath,
        };

        if ('stdout' in result && result.stdout) {
          response.stdout = result.stdout;
          response.stdoutTruncated = result.stdoutTruncated || false;
        }
        if ('stderr' in result && result.stderr) {
          response.stderr = result.stderr;
          response.stderrTruncated = result.stderrTruncated || false;
        }

        // Detect window if requested and not waiting for process to exit
        if (detectWindow && !wait && result.pid) {
          logger.info(`Detecting window for PID ${result.pid}...`);
          const windowResult = await this.detectWindow(result.pid, {
            timeout: windowDetectTimeout,
            windowTitle,
            windowClass,
          });
          response.windowDetected = windowResult.detected;
          if (windowResult.windowInfo) {
            response.windowInfo = windowResult.windowInfo;
          }
        }

        // Determine if the script failed
        const hasError = wait && response.exitCode !== 0;
        const hasStderr = response.stderr && response.stderr.trim().length > 0;

        // Provide consistent feedback structure
        const statusText = wait
          ? hasError
            ? `AHK script failed: ${file} (exit code: ${response.exitCode})`
            : `AHK script completed: ${file} (exit code: ${response.exitCode})`
          : `AHK script started: ${file} (PID: ${response.pid})`;

        const windowText = response.windowDetected
          ? `Window detected: ${response.windowInfo?.title}`
          : detectWindow
            ? 'No window detected within timeout'
            : '';

        // Include stderr prominently if present
        const stderrText = hasStderr ? `**Error Output:**\n\`\`\`\n${response.stderr}\n\`\`\`` : '';

        return {
          content: [
            { type: 'text', text: statusText },
            ...(stderrText ? [{ type: 'text', text: stderrText }] : []),
            ...(windowText ? [{ type: 'text', text: windowText }] : []),
            { type: 'text', text: `Execution details:\n${JSON.stringify(response, null, 2)}` },
          ],
          // Set isError flag for non-zero exit codes or stderr output
          ...(hasError || hasStderr ? { isError: true } : {}),
        };
      }

      // watch mode
      if (!enabled) {
        this.stopWatcher();
        const processCount = processManager.getProcessCount();
        if (killOnExit) {
          this.killRunningProcesses();
        }
        return {
          content: [
            { type: 'text', text: `File watcher stopped` },
            {
              type: 'text',
              text: killOnExit
                ? `Cleaned up ${processCount} running process(es)`
                : 'Running processes left active',
            },
          ],
        };
      }

      const file = await this.ensureFile(filePath);
      AhkRunTool.state.filePath = file;

      // debounce runs to avoid double-trigger
      const debounceMs = 250;

      this.stopWatcher();

      try {
        AhkRunTool.state.watcher = fsSync.watch(file, { persistent: true }, event => {
          if (event !== 'change') return;

          if (AhkRunTool.state.debounceTimer) {
            clearTimeout(AhkRunTool.state.debounceTimer);
          }

          AhkRunTool.state.debounceTimer = setTimeout(async () => {
            try {
              logger.info(`File changed, auto-running: ${file}`);
              await this.runOnce(resolvedAhkPath, file, {
                cwd: workingDirectory,
                errorStdOut,
                runner,
                wait: false,
                scriptArgs,
                timeout,
              });
            } catch (err) {
              logger.error('Auto-run failed:', err);
            }
          }, debounceMs);
        });

        AhkRunTool.state.watcher.on('error', err => {
          logger.error('File watcher error:', err);
        });

        return {
          content: [
            { type: 'text', text: `File watcher started successfully` },
            { type: 'text', text: `Watching: ${file}` },
            { type: 'text', text: `AutoHotkey: ${resolvedAhkPath}` },
            {
              type: 'text',
              text: `Config: ${runner} runner, ${killOnExit ? 'auto-kill enabled' : 'auto-kill disabled'}`,
            },
          ],
        };
      } catch (watchErr) {
        logger.error('Failed to start file watcher:', watchErr);
        throw new Error(
          `Failed to start file watcher: ${watchErr instanceof Error ? watchErr.message : String(watchErr)}`
        );
      }
    } catch (error) {
      logger.error('Error in AHK_Run tool:', error);

      // Provide more helpful error messages
      let errorMessage = 'Unknown error occurred';
      if (error instanceof Error) {
        errorMessage = error.message;
        // Add suggestions for common errors
        if (error.message.includes('AutoHotkey') && error.message.includes('not found')) {
          errorMessage +=
            '\n\nTip: Install AutoHotkey v2 from https://autohotkey.com or specify the ahkPath parameter.';
        } else if (error.message.includes('File not found')) {
          errorMessage += '\n\nTip: Make sure the .ahk file exists and the path is correct.';
        } else if (error.message.includes('EACCES') || error.message.includes('permission')) {
          errorMessage += '\n\nTip: Check file permissions or run with appropriate privileges.';
        }
      }

      return createErrorResponse(errorMessage);
    }
  }

  // Cleanup method for graceful shutdown
  static cleanup(): void {
    const instance = new AhkRunTool();
    instance.stopWatcher();
    instance.killRunningProcesses();
  }
}

// Register cleanup handler with process manager
processManager.registerCleanupHandler(() => {
  AhkRunTool.cleanup();
});
