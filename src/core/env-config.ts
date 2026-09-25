/**
 * Centralized environment configuration module
 * Provides type-safe access to all environment variables with sensible defaults
 */

import path from 'path';
import os from 'os';

/**
 * Log levels in order of verbosity
 */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

/**
 * Data loading mode
 */
export enum DataMode {
  LIGHT = 'light',
  FULL = 'full',
}

/**
 * Centralized configuration with type-safe getters and sensible defaults
 */
class EnvironmentConfig {
  /**
   * Get the log level from environment variables
   * Priority: AHK_MCP_LOG_LEVEL > LOG_LEVEL > 'warn'
   */
  getLogLevel(): LogLevel {
    const raw = (process.env.AHK_MCP_LOG_LEVEL || process.env.LOG_LEVEL || 'warn').toLowerCase();
    const valid = Object.values(LogLevel) as string[];
    return (valid.includes(raw) ? raw : 'warn') as LogLevel;
  }

  /**
   * Get the HTTP server port
   * Parses PORT from environment, falls back to 3000
   */
  getPort(): number {
    const portStr = process.env.PORT;
    if (!portStr) return 3000;
    const parsed = parseInt(portStr, 10);
    return isNaN(parsed) ? 3000 : parsed;
  }

  /**
   * Determine if the HTTP transport should be used instead of stdio.
   * Requires an explicit opt-in (--http, the legacy --sse flag, or
   * AHK_MCP_TRANSPORT=http): a stray PORT in the environment must not silently
   * turn a stdio launch into an HTTP server the client never connects to.
   */
  useSSEMode(): boolean {
    return (
      process.argv.includes('--http') ||
      process.argv.includes('--sse') ||
      process.env.AHK_MCP_TRANSPORT?.trim().toLowerCase() === 'http'
    );
  }

  /**
   * Get the tool execution timeout in milliseconds
   * Defaults to 45000ms; set to 0 to disable timeouts
   */
  getToolTimeoutMs(): number {
    const raw = process.env.AHK_MCP_TOOL_TIMEOUT_MS;
    if (!raw) return 45000;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 45000;
    return parsed;
  }

  /**
   * Get the polling interval for MCP tasks in milliseconds
   * Defaults to 2000ms
   */
  getTaskPollIntervalMs(): number {
    const raw = process.env.AHK_MCP_TASK_POLL_INTERVAL_MS;
    if (!raw) return 2000;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) return 2000;
    return parsed;
  }

  /**
   * Get the task execution timeout in milliseconds
   * Defaults to 0 (no timeout)
   */
  getTaskTimeoutMs(): number {
    const raw = process.env.AHK_MCP_TASK_TIMEOUT_MS;
    if (!raw) return 0;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 0;
    return parsed;
  }

  /**
   * Get the active AutoHotkey file path from environment
   * Optional, used to persist the currently active file
   */
  getActiveFilePath(): string | undefined {
    return process.env.AHK_ACTIVE_FILE;
  }

  /**
   * Get the MCP configuration directory
   * Priority: AHK_MCP_CONFIG_DIR > %APPDATA%\ahk-mcp > ~/.config/ahk-mcp
   */
  getConfigDir(): string {
    if (process.env.AHK_MCP_CONFIG_DIR) {
      return process.env.AHK_MCP_CONFIG_DIR;
    }

    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'ahk-mcp');
    }

    return path.join(os.homedir(), '.config', 'ahk-mcp');
  }

  /**
   * Get the MCP settings file path
   * Priority: AHK_MCP_SETTINGS_PATH > configDir/settings.json
   */
  getSettingsPath(): string {
    if (process.env.AHK_MCP_SETTINGS_PATH) {
      return process.env.AHK_MCP_SETTINGS_PATH;
    }
    return path.join(this.getConfigDir(), 'settings.json');
  }

  /**
   * Get the script directory for resolving search paths
   * Optional override for A_ScriptDir
   */
  getScriptDir(): string | undefined {
    return process.env.AHK_MCP_SCRIPT_DIR;
  }

  /**
   * Get the data loading mode (light vs full)
   * Light mode reduces memory usage, full loads all documentation
   */
  getDataMode(): DataMode {
    const mode = (process.env.AHK_MCP_DATA_MODE || '').toLowerCase();
    if (mode === 'light') return DataMode.LIGHT;
    if (mode === 'full') return DataMode.FULL;
    // Auto-detect: use light mode if AHK_MCP_LIGHT=1
    if (process.env.AHK_MCP_LIGHT === '1') return DataMode.LIGHT;
    return DataMode.FULL;
  }

  /**
   * Check if light mode is enabled
   * Convenience getter for data mode
   */
  isLightMode(): boolean {
    return this.getDataMode() === DataMode.LIGHT;
  }

  /**
   * Get the home directory (cross-platform)
   */
  getHomeDir(): string {
    return os.homedir();
  }

  /**
   * Get the platform
   */
  getPlatform(): string {
    return process.platform;
  }

  /**
   * Check if running on Windows
   */
  isWindows(): boolean {
    return this.getPlatform() === 'win32';
  }

  /**
   * Check if running on macOS
   */
  isMacOS(): boolean {
    return this.getPlatform() === 'darwin';
  }

  /**
   * Check if running on Linux
   */
  isLinux(): boolean {
    return this.getPlatform() === 'linux';
  }

  /**
   * Get NODE_ENV (development, production, test)
   */
  getNodeEnv(): 'development' | 'production' | 'test' {
    const env = (process.env.NODE_ENV || 'development').toLowerCase();
    if (env === 'production' || env === 'test') {
      return env;
    }
    return 'development';
  }

  /**
   * Check if running in development mode
   */
  isDevelopment(): boolean {
    return this.getNodeEnv() === 'development';
  }

  /**
   * Check if running in production mode
   */
  isProduction(): boolean {
    return this.getNodeEnv() === 'production';
  }

  /**
   * Check if running in test mode
   */
  isTest(): boolean {
    return this.getNodeEnv() === 'test';
  }

  /**
   * Get all current configuration as an object (for debugging)
   */
  getAllConfig(): Record<string, unknown> {
    return {
      logLevel: this.getLogLevel(),
      port: this.getPort(),
      useSSEMode: this.useSSEMode(),
      toolTimeoutMs: this.getToolTimeoutMs(),
      taskPollIntervalMs: this.getTaskPollIntervalMs(),
      taskTimeoutMs: this.getTaskTimeoutMs(),
      activeFilePath: this.getActiveFilePath(),
      configDir: this.getConfigDir(),
      settingsPath: this.getSettingsPath(),
      scriptDir: this.getScriptDir(),
      dataMode: this.getDataMode(),
      isLightMode: this.isLightMode(),
      platform: this.getPlatform(),
      nodeEnv: this.getNodeEnv(),
      isDevelopment: this.isDevelopment(),
      isProduction: this.isProduction(),
    };
  }
}

// Export singleton instance
export const envConfig = new EnvironmentConfig();

// Export class for testing
export default EnvironmentConfig;
