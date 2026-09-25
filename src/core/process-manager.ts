/**
 * Process management utilities for graceful shutdown and resource cleanup
 */

import logger from '../logger.js';

export interface ProcessInfo {
  pid: number;
  startTime: number;
  filePath: string;
}

/**
 * Global process manager for tracking and cleaning up running processes
 */
export class ProcessManager {
  private static instance: ProcessManager;
  private runningProcesses: Map<number, ProcessInfo> = new Map();
  private cleanupHandlers: Set<() => void> = new Set();
  private isCleaningUp: boolean = false;
  private cleanupTimeoutMs: number = 10000; // 10 second timeout for cleanup

  private constructor() {
    this.setupGlobalHandlers();
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ProcessManager {
    if (!ProcessManager.instance) {
      ProcessManager.instance = new ProcessManager();
    }
    return ProcessManager.instance;
  }

  /**
   * Register a process as running
   */
  registerProcess(pid: number, filePath: string): void {
    const processInfo: ProcessInfo = {
      pid,
      startTime: Date.now(),
      filePath,
    };
    this.runningProcesses.set(pid, processInfo);
    logger.debug(`Process registered: PID ${pid} (${filePath})`);
  }

  /**
   * Unregister a process
   */
  unregisterProcess(pid: number): void {
    const info = this.runningProcesses.get(pid);
    if (info) {
      this.runningProcesses.delete(pid);
      const runtime = Date.now() - info.startTime;
      logger.debug(`Process unregistered: PID ${pid} (runtime: ${runtime}ms)`);
    }
  }

  /**
   * Register a cleanup handler to be called during shutdown
   */
  registerCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.add(handler);
  }

  /**
   * Unregister a cleanup handler
   */
  unregisterCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.delete(handler);
  }

  /**
   * Get all running processes
   */
  getRunningProcesses(): ProcessInfo[] {
    return Array.from(this.runningProcesses.values());
  }

  /**
   * Get count of running processes
   */
  getProcessCount(): number {
    return this.runningProcesses.size;
  }

  /**
   * Kill all running processes gracefully
   */
  killAllProcesses(): void {
    if (this.runningProcesses.size === 0) {
      logger.debug('No processes to kill');
      return;
    }

    logger.info(`Killing ${this.runningProcesses.size} running process(es)`);

    const pids = Array.from(this.runningProcesses.keys());
    for (const pid of pids) {
      this.killProcess(pid);
    }

    // Give processes time to die gracefully, then force kill any remaining
    setTimeout(() => {
      const remaining = Array.from(this.runningProcesses.keys());
      if (remaining.length > 0) {
        logger.warn(`Forcing kill of ${remaining.length} remaining process(es)`);
        for (const pid of remaining) {
          try {
            process.kill(pid, 'SIGKILL');
            logger.info(`Force killed process: PID ${pid}`);
          } catch (err) {
            logger.debug(`Failed to force kill PID ${pid}:`, err);
          }
        }
      }
    }, 5000);
  }

  /**
   * Kill a specific process
   */
  private killProcess(pid: number): void {
    try {
      logger.info(`Killing process: PID ${pid}`);
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      logger.warn(`Failed to kill process PID ${pid}:`, err);
      this.unregisterProcess(pid);
    }
  }

  /**
   * Perform full cleanup
   */
  async performCleanup(): Promise<void> {
    if (this.isCleaningUp) {
      logger.debug('Cleanup already in progress');
      return;
    }

    this.isCleaningUp = true;
    logger.info('Starting graceful shutdown');

    // Call all registered cleanup handlers
    const handlers = Array.from(this.cleanupHandlers);
    for (const handler of handlers) {
      try {
        handler();
      } catch (err) {
        logger.warn('Error in cleanup handler:', err);
      }
    }

    // Kill remaining processes
    this.killAllProcesses();

    // Wait for processes to terminate
    await new Promise(resolve => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.runningProcesses.size === 0) {
          clearInterval(checkInterval);
          resolve(undefined);
        } else if (Date.now() - startTime > this.cleanupTimeoutMs) {
          logger.warn(`Cleanup timeout: ${this.runningProcesses.size} processes still running`);
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);
    });

    logger.info('Graceful shutdown complete');
  }

  /**
   * Setup global process signal handlers
   */
  private setupGlobalHandlers(): void {
    // SIGINT/SIGTERM and stdin EOF are handled by the server's single shutdown path,
    // which calls performCleanup(); registering them here too raced its process.exit.

    // Handle uncaught exceptions
    process.on('uncaughtException', async err => {
      logger.error('Uncaught exception:', err);
      await this.performCleanup();
      process.exit(1);
    });

    // Handle unhandled rejections
    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('Unhandled rejection at:', promise, 'reason:', reason);
      await this.performCleanup();
      process.exit(1);
    });
  }
}

// Export singleton instance
export const processManager = ProcessManager.getInstance();
