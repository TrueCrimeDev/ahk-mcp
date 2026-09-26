import { z } from 'zod/v3';
import { PathFormat, DriveMapping } from '../utils/path-converter.js';
import { ToolPathConfig } from './path-interceptor.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const moduleDirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Path converter configuration interface
 */
export interface PathConverterConfig {
  enabled: boolean;
  defaultTargetFormat: PathFormat;
  autoDetectEnvironment: boolean;
  driveMappings: DriveMapping[];
  toolConfigs: ToolPathConfig[];
  logging: {
    enabled: boolean;
    level: 'debug' | 'info' | 'warn' | 'error';
    logConversions: boolean;
    logFailures: boolean;
  };
  performance: {
    enableCaching: boolean;
    maxCacheSize: number;
    cacheTimeout: number; // in milliseconds
  };
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: PathConverterConfig = {
  enabled: true,
  defaultTargetFormat: PathFormat.WINDOWS,
  autoDetectEnvironment: true,
  driveMappings: [
    // Default A-Z drive mappings will be generated automatically
  ],
  toolConfigs: [
    // Default tool configurations will be generated automatically
  ],
  logging: {
    enabled: true,
    level: 'info',
    logConversions: false,
    logFailures: true,
  },
  performance: {
    enableCaching: true,
    maxCacheSize: 1000,
    cacheTimeout: 300000, // 5 minutes
  },
};

/**
 * Configuration file paths
 */
export const CONFIG_PATHS = {
  userConfig: path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.ahk-mcp',
    'path-converter.json'
  ),
  projectConfig: path.join(process.cwd(), '.ahk-mcp', 'path-converter.json'),
  fallbackConfig: path.join(moduleDirname, '../../config', 'path-converter-default.json'),
};

/**
 * PathConverterConfigManager class for managing path converter configuration
 * Handles loading, saving, and validating configuration
 */
export class PathConverterConfigManager {
  private config: PathConverterConfig;
  private configPath: string;
  private watchers: Map<string, () => void> = new Map();

  constructor(configPath?: string) {
    this.configPath = configPath || CONFIG_PATHS.projectConfig;
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Determine the best configuration file path to use
   * @returns The configuration file path
   */
  private async determineConfigPath(): Promise<string> {
    // Check for project config first
    if (await this.fileExists(CONFIG_PATHS.projectConfig)) {
      return CONFIG_PATHS.projectConfig;
    }

    // Check for user config
    if (await this.fileExists(CONFIG_PATHS.userConfig)) {
      return CONFIG_PATHS.userConfig;
    }

    // Use project config as default (will be created if it doesn't exist)
    return CONFIG_PATHS.projectConfig;
  }

  /**
   * Check if a file exists
   * @param filePath The file path to check
   * @returns True if the file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load configuration from file
   * @param configPath Optional custom config path
   * @returns The loaded configuration
   */
  public async loadConfig(configPath?: string): Promise<PathConverterConfig> {
    const targetPath = configPath || this.configPath;

    try {
      if (!(await this.fileExists(targetPath))) {
        logger.info(`Configuration file not found at ${targetPath}, using defaults`);
        await this.saveConfig(targetPath);
        return this.config;
      }

      const configData = await fs.readFile(targetPath, 'utf-8');
      const parsedConfig = JSON.parse(configData);

      // Validate the loaded configuration
      const validatedConfig = ConfigSchema.parse(parsedConfig);

      // Merge with defaults to ensure all properties are present
      this.config = this.mergeWithDefaults(validatedConfig);

      logger.info(`Configuration loaded from ${targetPath}`);
      return this.config;
    } catch (error) {
      logger.error(`Failed to load configuration from ${targetPath}:`, error);
      logger.info('Using default configuration');
      return this.config;
    }
  }

  /**
   * Save configuration to file
   * @param configPath Optional custom config path
   * @returns True if successful
   */
  public async saveConfig(configPath?: string): Promise<boolean> {
    const targetPath = configPath || this.configPath;

    try {
      // Ensure directory exists
      const dir = path.dirname(targetPath);
      await fs.mkdir(dir, { recursive: true });

      // Validate configuration before saving
      const validatedConfig = ConfigSchema.parse(this.config);

      // Write configuration file
      const configData = JSON.stringify(validatedConfig, null, 2);
      await fs.writeFile(targetPath, configData, 'utf-8');

      logger.info(`Configuration saved to ${targetPath}`);
      return true;
    } catch (error) {
      logger.error(`Failed to save configuration to ${targetPath}:`, error);
      return false;
    }
  }

  /**
   * Get current configuration
   * @returns The current configuration
   */
  public getConfig(): PathConverterConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   * @param updates The configuration updates
   * @returns True if successful
   */
  public updateConfig(updates: Partial<PathConverterConfig>): boolean {
    try {
      const mergedConfig = this.mergeWithDefaults(updates);
      const validatedConfig = ConfigSchema.parse(mergedConfig) as PathConverterConfig;
      this.config = validatedConfig;
      return true;
    } catch (error) {
      logger.error('Failed to update configuration:', error);
      return false;
    }
  }

  /**
   * Reset configuration to defaults
   */
  public resetToDefaults(): void {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Add or update a drive mapping
   * @param mapping The drive mapping to add
   */
  public addDriveMapping(mapping: DriveMapping): void {
    const existingIndex = this.config.driveMappings.findIndex(
      m => m.windowsDrive.toLowerCase() === mapping.windowsDrive.toLowerCase()
    );

    if (existingIndex >= 0) {
      this.config.driveMappings[existingIndex] = mapping;
    } else {
      this.config.driveMappings.push(mapping);
    }
  }

  /**
   * Remove a drive mapping
   * @param windowsDrive The Windows drive to remove
   * @returns True if removed
   */
  public removeDriveMapping(windowsDrive: string): boolean {
    const initialLength = this.config.driveMappings.length;
    this.config.driveMappings = this.config.driveMappings.filter(
      m => m.windowsDrive.toLowerCase() !== windowsDrive.toLowerCase()
    );
    return this.config.driveMappings.length < initialLength;
  }

  /**
   * Add or update a tool configuration
   * @param toolConfig The tool configuration to add
   */
  public addToolConfig(toolConfig: ToolPathConfig): void {
    const existingIndex = this.config.toolConfigs.findIndex(
      c => c.toolName === toolConfig.toolName
    );

    if (existingIndex >= 0) {
      this.config.toolConfigs[existingIndex] = toolConfig;
    } else {
      this.config.toolConfigs.push(toolConfig);
    }
  }

  /**
   * Remove a tool configuration
   * @param toolName The tool name to remove
   * @returns True if removed
   */
  public removeToolConfig(toolName: string): boolean {
    const initialLength = this.config.toolConfigs.length;
    this.config.toolConfigs = this.config.toolConfigs.filter(c => c.toolName !== toolName);
    return this.config.toolConfigs.length < initialLength;
  }

  /**
   * Enable or disable path conversion
   * @param enabled Whether to enable path conversion
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  /**
   * Set the default target format
   * @param format The target format
   */
  public setDefaultTargetFormat(format: PathFormat): void {
    this.config.defaultTargetFormat = format;
  }

  /**
   * Update logging configuration
   * @param loggingConfig The logging configuration
   */
  public updateLoggingConfig(loggingConfig: Partial<PathConverterConfig['logging']>): void {
    this.config.logging = { ...this.config.logging, ...loggingConfig };
  }

  /**
   * Update performance configuration
   * @param performanceConfig The performance configuration
   */
  public updatePerformanceConfig(
    performanceConfig: Partial<PathConverterConfig['performance']>
  ): void {
    this.config.performance = { ...this.config.performance, ...performanceConfig };
  }

  /**
   * Watch for configuration file changes
   * @param callback Callback function when config changes
   */
  public watchConfig(callback: () => void): void {
    const watcherId = Date.now().toString();
    this.watchers.set(watcherId, callback);

    // Note: In a real implementation, you would use fs.watch or chokidar
    // For now, we'll just store the callback for future implementation
    logger.info(`Configuration watcher registered for ${this.configPath}`);
  }

  /**
   * Stop watching for configuration changes
   * @param watcherId The watcher ID to remove
   */
  public unwatchConfig(watcherId: string): void {
    this.watchers.delete(watcherId);
  }

  /**
   * Merge configuration with defaults
   * @param config The configuration to merge
   * @returns The merged configuration
   */
  private mergeWithDefaults(config: Partial<PathConverterConfig>): PathConverterConfig {
    return {
      enabled: config.enabled !== undefined ? config.enabled : DEFAULT_CONFIG.enabled,
      defaultTargetFormat: config.defaultTargetFormat || DEFAULT_CONFIG.defaultTargetFormat,
      autoDetectEnvironment:
        config.autoDetectEnvironment !== undefined
          ? config.autoDetectEnvironment
          : DEFAULT_CONFIG.autoDetectEnvironment,
      driveMappings: Array.isArray(config.driveMappings)
        ? config.driveMappings
        : DEFAULT_CONFIG.driveMappings,
      toolConfigs: Array.isArray(config.toolConfigs)
        ? config.toolConfigs
        : DEFAULT_CONFIG.toolConfigs,
      logging: {
        ...DEFAULT_CONFIG.logging,
        ...(config.logging || {}),
      },
      performance: {
        ...DEFAULT_CONFIG.performance,
        ...(config.performance || {}),
      },
    };
  }

  /**
   * Validate configuration against schema
   * @param config The configuration to validate
   * @returns True if valid
   */
  public validateConfig(config: unknown): boolean {
    try {
      ConfigSchema.parse(config);
      return true;
    } catch (error) {
      logger.error('Configuration validation failed:', error);
      return false;
    }
  }

  /**
   * Get configuration summary
   * @returns Configuration summary
   */
  public getSummary(): {
    enabled: boolean;
    targetFormat: PathFormat;
    driveMappingsCount: number;
    toolConfigsCount: number;
    configPath: string;
  } {
    return {
      enabled: this.config.enabled,
      targetFormat: this.config.defaultTargetFormat,
      driveMappingsCount: this.config.driveMappings.length,
      toolConfigsCount: this.config.toolConfigs.length,
      configPath: this.configPath,
    };
  }
}

// Zod schema for configuration validation
export const ConfigSchema = z.object({
  enabled: z.boolean(),
  defaultTargetFormat: z.nativeEnum(PathFormat),
  autoDetectEnvironment: z.boolean(),
  driveMappings: z.array(
    z.object({
      windowsDrive: z.string().regex(/^[A-Za-z]:$/, 'Invalid drive format'),
      wslMountPoint: z.string().min(1, 'Mount point cannot be empty'),
    })
  ),
  toolConfigs: z.array(
    z.object({
      toolName: z.string().min(1, 'Tool name cannot be empty'),
      pathParameters: z.array(z.string()).min(1, 'At least one path parameter is required'),
      convertInput: z.boolean(),
      convertOutput: z.boolean(),
      targetFormat: z.nativeEnum(PathFormat),
    })
  ),
  logging: z.object({
    enabled: z.boolean(),
    level: z.enum(['debug', 'info', 'warn', 'error']),
    logConversions: z.boolean(),
    logFailures: z.boolean(),
  }),
  performance: z.object({
    enableCaching: z.boolean(),
    maxCacheSize: z.number().min(1).max(10000),
    cacheTimeout: z.number().min(1000),
  }),
});

// Singleton instance for global use
export const configManager = new PathConverterConfigManager();
