import { PathConverter, PathFormat, PathConversionResult } from '../utils/path-converter.js';
import { z } from 'zod/v3';
import logger from '../logger.js';

/**
 * Tool path configuration for path conversion
 */
export interface ToolPathConfig {
  toolName: string;
  pathParameters: string[]; // Parameter names that contain paths
  convertInput: boolean; // Whether to convert input paths
  convertOutput: boolean; // Whether to convert output paths
  targetFormat: PathFormat; // Target format for this tool
}

/**
 * Interception result with metadata
 */
export interface InterceptionResult {
  success: boolean;
  originalData: unknown;
  modifiedData: unknown;
  conversions: PathConversionResult[];
  error?: string;
}

/**
 * PathInterceptor class for intercepting and converting paths in tool calls
 * Handles both input arguments and output results
 */
export class PathInterceptor {
  private pathConverter: PathConverter;
  private toolConfigs: Map<string, ToolPathConfig> = new Map();
  private enabled: boolean = true;

  constructor(pathConverter?: PathConverter) {
    this.pathConverter = pathConverter || new PathConverter();
    this.initializeDefaultConfigs();
  }

  /**
   * Initialize default tool configurations
   */
  private initializeDefaultConfigs(): void {
    // AHK file tools typically need Windows paths
    const ahkFileTools = [
      'AHK_File_Edit',
      'AHK_File_Edit_Advanced',
      'AHK_File_Edit_Diff',
      'AHK_File_Edit_Small',
      'AHK_File_View',
      'AHK_File_List',
      'AHK_File_Active',
      'AHK_File_Create',
      'AHK_File_Detect',
      'AHK_Run',
      'AHK_Analyze',
    ];

    ahkFileTools.forEach(toolName => {
      this.toolConfigs.set(toolName, {
        toolName,
        pathParameters: ['filePath', 'file', 'path', 'scriptDir', 'workingDirectory'],
        convertInput: true,
        convertOutput: true,
        targetFormat: PathFormat.WINDOWS,
      });
    });

    // File system tools typically use WSL paths
    const fileSystemTools = [
      'read_file',
      'write_file',
      'edit_file',
      'create_directory',
      'list_directory',
      'search_files',
      'get_file_info',
    ];

    // Detect OS to determine target format
    const isWindows = process.platform === 'win32';
    const targetFormat = isWindows ? PathFormat.WINDOWS : PathFormat.WSL;

    fileSystemTools.forEach(toolName => {
      this.toolConfigs.set(toolName, {
        toolName,
        pathParameters: ['path', 'source', 'destination'],
        convertInput: true,
        convertOutput: false,
        targetFormat: targetFormat,
      });
    });
  }

  /**
   * Add or update a tool configuration
   * @param config The tool configuration
   */
  public addToolConfig(config: ToolPathConfig): void {
    this.toolConfigs.set(config.toolName, config);
  }

  /**
   * Remove a tool configuration
   * @param toolName The tool name to remove
   */
  public removeToolConfig(toolName: string): boolean {
    return this.toolConfigs.delete(toolName);
  }

  /**
   * Get configuration for a specific tool
   * @param toolName The tool name
   * @returns The tool configuration or undefined
   */
  public getToolConfig(toolName: string): ToolPathConfig | undefined {
    return this.toolConfigs.get(toolName);
  }

  /**
   * Get all tool configurations
   * @returns Array of all tool configurations
   */
  public getAllToolConfigs(): ToolPathConfig[] {
    return Array.from(this.toolConfigs.values());
  }

  /**
   * Enable or disable path interception
   * @param enabled Whether to enable interception
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Check if path interception is enabled
   * @returns True if interception is enabled
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Intercept and convert paths in tool arguments
   * @param toolName The name of the tool being called
   * @param arguments The tool arguments
   * @returns The interception result
   */
  public interceptInput(toolName: string, args: Record<string, unknown>): InterceptionResult {
    if (!this.enabled) {
      return {
        success: true,
        originalData: arguments,
        modifiedData: arguments,
        conversions: [],
      };
    }

    const config = this.toolConfigs.get(toolName);
    if (!config || !config.convertInput) {
      return {
        success: true,
        originalData: arguments,
        modifiedData: arguments,
        conversions: [],
      };
    }

    try {
      const modifiedArgs = { ...args };
      const conversions: PathConversionResult[] = [];

      // Process each path parameter
      for (const paramName of config.pathParameters) {
        if (args[paramName]) {
          const conversionResult = this.processPathValue(
            args[paramName],
            config.targetFormat,
            paramName
          );

          if (conversionResult.success) {
            modifiedArgs[paramName] = conversionResult.convertedPath;
            conversions.push(conversionResult);
          } else {
            // Log the error but don't fail the entire operation
            logger.warn(
              `Path conversion failed for ${toolName}.${paramName}: ${conversionResult.error}`
            );
          }
        }
      }

      // Handle nested path parameters (e.g., in arrays or objects)
      this.processNestedPaths(modifiedArgs, config, conversions);

      return {
        success: true,
        originalData: args,
        modifiedData: modifiedArgs,
        conversions,
      };
    } catch (error) {
      return {
        success: false,
        originalData: args,
        modifiedData: args,
        conversions: [],
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Intercept and convert paths in tool results
   * @param toolName The name of the tool that was called
   * @param result The tool result
   * @returns The interception result
   */
  public interceptOutput(toolName: string, result: unknown): InterceptionResult {
    if (!this.enabled) {
      return {
        success: true,
        originalData: result,
        modifiedData: result,
        conversions: [],
      };
    }

    const config = this.toolConfigs.get(toolName);
    if (!config || !config.convertOutput) {
      return {
        success: true,
        originalData: result,
        modifiedData: result,
        conversions: [],
      };
    }

    try {
      const modifiedResult = this.cloneObject(result);
      const conversions: PathConversionResult[] = [];

      // Process paths in the result
      this.processResultPaths(modifiedResult, config, conversions);

      return {
        success: true,
        originalData: result,
        modifiedData: modifiedResult,
        conversions,
      };
    } catch (error) {
      return {
        success: false,
        originalData: result,
        modifiedData: result,
        conversions: [],
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Process a single path value
   * @param value The path value to process
   * @param targetFormat The target format
   * @param context Context information for logging
   * @returns The conversion result
   */
  private processPathValue(
    value: unknown,
    targetFormat: PathFormat,
    context: string
  ): PathConversionResult {
    if (typeof value !== 'string') {
      return {
        originalPath: String(value),
        convertedPath: String(value),
        originalFormat: PathFormat.UNKNOWN,
        targetFormat,
        success: false,
        error: `Path value is not a string: ${typeof value}`,
      };
    }

    return this.pathConverter.autoConvert(value, targetFormat);
  }

  /**
   * Process nested path parameters in complex data structures
   * @param data The data to process
   * @param config The tool configuration
   * @param conversions Array to collect conversion results
   */
  private processNestedPaths(
    data: Record<string, unknown> | unknown[],
    config: ToolPathConfig,
    conversions: PathConversionResult[]
  ): void {
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (typeof item === 'object' && item !== null) {
          this.processNestedPaths(item as Record<string, unknown>, config, conversions);
        }
      });
    } else if (typeof data === 'object' && data !== null) {
      const dataRecord = data as Record<string, unknown>;
      Object.keys(dataRecord).forEach(key => {
        const value = dataRecord[key];

        // Check if this key matches any of our path parameters
        const isPathParameter = config.pathParameters.some(param =>
          key.toLowerCase().includes(param.toLowerCase())
        );

        if (isPathParameter && typeof value === 'string') {
          const conversionResult = this.processPathValue(value, config.targetFormat, key);
          if (conversionResult.success) {
            dataRecord[key] = conversionResult.convertedPath;
            conversions.push(conversionResult);
          }
        } else if (typeof value === 'object' && value !== null) {
          this.processNestedPaths(value as Record<string, unknown>, config, conversions);
        }
      });
    }
  }

  /**
   * Process paths in tool results
   * @param result The result to process
   * @param config The tool configuration
   * @param conversions Array to collect conversion results
   */
  private processResultPaths(
    result: unknown,
    config: ToolPathConfig,
    conversions: PathConversionResult[]
  ): void {
    if (Array.isArray(result)) {
      result.forEach(item => {
        if (typeof item === 'object' && item !== null) {
          this.processResultPaths(item, config, conversions);
        }
      });
    } else if (typeof result === 'object' && result !== null) {
      const resultRecord = result as Record<string, unknown>;

      // Handle MCP content array format
      if (resultRecord['content'] && Array.isArray(resultRecord['content'])) {
        (resultRecord['content'] as Array<{ type: string; text?: string }>).forEach(contentItem => {
          if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
            // Try to find and convert paths in text content
            const convertedText = this.convertPathsInText(contentItem.text, config, conversions);
            if (convertedText !== contentItem.text) {
              contentItem.text = convertedText;
            }
          }
        });
      }

      // Process other object properties
      Object.keys(resultRecord).forEach(key => {
        const value = resultRecord[key];
        if (typeof value === 'object' && value !== null) {
          this.processResultPaths(value, config, conversions);
        }
      });
    } else if (typeof result === 'string') {
      // Try to convert paths in string results
      const converted = this.convertPathsInText(result, config, conversions);
      if (converted !== result) {
        // Note: We can't modify the string directly here since it's passed by value
        // This would need to be handled at a higher level
      }
    }
  }

  /**
   * Convert paths found in text content
   * @param text The text to process
   * @param config The tool configuration
   * @param conversions Array to collect conversion results
   * @returns The text with converted paths
   */
  private convertPathsInText(
    text: string,
    config: ToolPathConfig,
    conversions: PathConversionResult[]
  ): string {
    // Simple regex to find potential paths
    // This is a basic implementation - could be enhanced for more sophisticated detection
    const pathRegex = /([A-Za-z]:[\\/][^\s"']|\/[^\s"']+)/g;
    let convertedText = text;
    let match;

    while ((match = pathRegex.exec(text)) !== null) {
      const path = match[1];
      const conversionResult = this.processPathValue(path, config.targetFormat, 'text-content');

      if (conversionResult.success && conversionResult.convertedPath !== path) {
        convertedText = convertedText.replace(path, conversionResult.convertedPath);
        conversions.push(conversionResult);
      }
    }

    return convertedText;
  }

  /**
   * Clone an object deeply
   * @param obj The object to clone
   * @returns The cloned object
   */
  private cloneObject(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime());
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.cloneObject(item));
    }

    const cloned: Record<string, unknown> = {};
    Object.keys(obj as Record<string, unknown>).forEach(key => {
      cloned[key] = this.cloneObject((obj as Record<string, unknown>)[key]);
    });

    return cloned;
  }

  /**
   * Get statistics about path conversions
   * @returns Conversion statistics
   */
  public getStatistics(): {
    enabled: boolean;
    toolConfigsCount: number;
    supportedTools: string[];
  } {
    return {
      enabled: this.enabled,
      toolConfigsCount: this.toolConfigs.size,
      supportedTools: Array.from(this.toolConfigs.keys()),
    };
  }
}

// Singleton instance for global use
export const pathInterceptor = new PathInterceptor();

// Zod schema for tool path configuration
export const ToolPathConfigSchema = z.object({
  toolName: z.string().min(1, 'Tool name cannot be empty'),
  pathParameters: z.array(z.string()).min(1, 'At least one path parameter is required'),
  convertInput: z.boolean().default(true),
  convertOutput: z.boolean().default(true),
  targetFormat: z.nativeEnum(PathFormat),
});
