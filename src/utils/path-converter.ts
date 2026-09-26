import * as path from 'path';
import { z } from 'zod/v3';

/**
 * Path format types for cross-platform compatibility
 */
export enum PathFormat {
  WINDOWS = 'windows',
  WSL = 'wsl',
  UNIX = 'unix',
  UNKNOWN = 'unknown',
}

/**
 * Drive mapping configuration for Windows to WSL conversion
 */
export interface DriveMapping {
  windowsDrive: string; // e.g., 'C:'
  wslMountPoint: string; // e.g., '/mnt/c'
}

/**
 * Path conversion result with metadata
 */
export interface PathConversionResult {
  originalPath: string;
  convertedPath: string;
  originalFormat: PathFormat;
  targetFormat: PathFormat;
  success: boolean;
  error?: string;
}

/**
 * PathConverter class for Windows-WSL path conversion
 * Handles conversion between Windows paths (C:\path\to\file) and WSL paths (/mnt/c/path/to/file)
 */
export class PathConverter {
  private driveMappings: Map<string, string> = new Map();
  private defaultWSLMountPoint: string = '/mnt';

  constructor(driveMappings?: DriveMapping[]) {
    // Initialize default drive mappings
    this.initializeDefaultMappings();

    // Apply custom mappings if provided
    if (driveMappings) {
      driveMappings.forEach(mapping => {
        this.driveMappings.set(mapping.windowsDrive.toLowerCase(), mapping.wslMountPoint);
      });
    }
  }

  /**
   * Initialize default drive mappings (A-Z to /mnt/a-z)
   */
  private initializeDefaultMappings(): void {
    for (let i = 65; i <= 90; i++) {
      // A-Z ASCII codes
      const drive = String.fromCharCode(i) + ':';
      const mountPoint = `${this.defaultWSLMountPoint}/${String.fromCharCode(i).toLowerCase()}`;
      this.driveMappings.set(drive.toLowerCase(), mountPoint);
    }
  }

  /**
   * Detect the format of a given path
   * @param inputPath The path to analyze
   * @returns The detected path format
   */
  public detectPathFormat(inputPath: string): PathFormat {
    if (!inputPath || typeof inputPath !== 'string') {
      return PathFormat.UNKNOWN;
    }

    const trimmedPath = inputPath.trim();

    // Windows path patterns
    if (/^[A-Za-z]:[\\/]/.test(trimmedPath)) {
      return PathFormat.WINDOWS;
    }

    // UNC path pattern (\\server\share)
    if (/^\\\\[\\]/.test(trimmedPath)) {
      return PathFormat.WINDOWS;
    }

    // WSL path pattern (/mnt/c/...)
    if (/^\/mnt\/[a-zA-Z]\//.test(trimmedPath)) {
      return PathFormat.WSL;
    }

    // Unix/Linux path pattern (starts with / but not /mnt/)
    if (/^\//.test(trimmedPath)) {
      return PathFormat.UNIX;
    }

    return PathFormat.UNKNOWN;
  }

  /**
   * Convert Windows path to WSL path
   * @param windowsPath The Windows path to convert
   * @returns The converted WSL path
   */
  public windowsToWSL(windowsPath: string): PathConversionResult {
    const originalFormat = this.detectPathFormat(windowsPath);

    try {
      if (originalFormat !== PathFormat.WINDOWS) {
        return {
          originalPath: windowsPath,
          convertedPath: windowsPath,
          originalFormat,
          targetFormat: PathFormat.WSL,
          success: false,
          error: `Input path is not in Windows format. Detected format: ${originalFormat}`,
        };
      }

      const trimmedPath = windowsPath.trim();

      // Handle UNC paths (\\server\share)
      if (trimmedPath.startsWith('\\\\')) {
        const uncParts = trimmedPath.substring(2).split('\\');
        if (uncParts.length >= 2) {
          const server = uncParts[0];
          const share = uncParts[1];
          const remainingPath = uncParts.slice(2).join('/');
          return {
            originalPath: windowsPath,
            convertedPath: `/mnt/share/${server}/${share}/${remainingPath}`,
            originalFormat,
            targetFormat: PathFormat.WSL,
            success: true,
          };
        }
      }

      // Handle drive letters (C:\path\to\file)
      const driveMatch = /^([A-Za-z]):[\\/](.*)$/.exec(trimmedPath);
      if (driveMatch) {
        const drive = driveMatch[1].toLowerCase();
        const remainingPath = driveMatch[2].replace(/\\/g, '/');
        const mountPoint = this.driveMappings.get(drive + ':');

        if (mountPoint) {
          return {
            originalPath: windowsPath,
            convertedPath: `${mountPoint}/${remainingPath}`,
            originalFormat,
            targetFormat: PathFormat.WSL,
            success: true,
          };
        } else {
          return {
            originalPath: windowsPath,
            convertedPath: windowsPath,
            originalFormat,
            targetFormat: PathFormat.WSL,
            success: false,
            error: `No mount point configured for drive ${drive.toUpperCase()}:`,
          };
        }
      }

      return {
        originalPath: windowsPath,
        convertedPath: windowsPath,
        originalFormat,
        targetFormat: PathFormat.WSL,
        success: false,
        error: 'Unable to parse Windows path format',
      };
    } catch (error) {
      return {
        originalPath: windowsPath,
        convertedPath: windowsPath,
        originalFormat,
        targetFormat: PathFormat.WSL,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Convert WSL path to Windows path
   * @param wslPath The WSL path to convert
   * @returns The converted Windows path
   */
  public wslToWindows(wslPath: string): PathConversionResult {
    const originalFormat = this.detectPathFormat(wslPath);

    try {
      if (originalFormat !== PathFormat.WSL) {
        return {
          originalPath: wslPath,
          convertedPath: wslPath,
          originalFormat,
          targetFormat: PathFormat.WINDOWS,
          success: false,
          error: `Input path is not in WSL format. Detected format: ${originalFormat}`,
        };
      }

      const trimmedPath = wslPath.trim();

      // Handle /mnt/drive/... pattern
      const mountMatch = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(trimmedPath);
      if (mountMatch) {
        const drive = mountMatch[1].toUpperCase();
        const remainingPath = this.normalizeWindowsPathCasing(mountMatch[2].replace(/\//g, '\\'));

        return {
          originalPath: wslPath,
          convertedPath: `${drive}:\\${remainingPath}`,
          originalFormat,
          targetFormat: PathFormat.WINDOWS,
          success: true,
        };
      }

      // Handle /mnt/share/server/share/... pattern (UNC conversion)
      const shareMatch = /^\/mnt\/share\/([^\/]+)\/([^\/]+)\/(.*)$/.exec(trimmedPath);
      if (shareMatch) {
        const server = shareMatch[1];
        const share = shareMatch[2];
        const remainingPath = this.normalizeWindowsPathCasing(shareMatch[3].replace(/\//g, '\\'));

        return {
          originalPath: wslPath,
          convertedPath: `\\\\${server}\\${share}\\${remainingPath}`,
          originalFormat,
          targetFormat: PathFormat.WINDOWS,
          success: true,
        };
      }

      return {
        originalPath: wslPath,
        convertedPath: wslPath,
        originalFormat,
        targetFormat: PathFormat.WINDOWS,
        success: false,
        error: 'Unable to parse WSL path format',
      };
    } catch (error) {
      return {
        originalPath: wslPath,
        convertedPath: wslPath,
        originalFormat,
        targetFormat: PathFormat.WINDOWS,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Auto-convert path based on current environment and target format
   * @param inputPath The path to convert
   * @param targetFormat The desired target format
   * @returns The conversion result
   */
  public autoConvert(inputPath: string, targetFormat: PathFormat): PathConversionResult {
    const originalFormat = this.detectPathFormat(inputPath);

    if (originalFormat === targetFormat) {
      return {
        originalPath: inputPath,
        convertedPath: inputPath,
        originalFormat,
        targetFormat,
        success: true,
      };
    }

    switch (targetFormat) {
      case PathFormat.WSL:
        return this.windowsToWSL(inputPath);
      case PathFormat.WINDOWS:
        return this.wslToWindows(inputPath);
      default:
        return {
          originalPath: inputPath,
          convertedPath: inputPath,
          originalFormat,
          targetFormat,
          success: false,
          error: `Conversion to ${targetFormat} format is not supported`,
        };
    }
  }

  /**
   * Add or update a drive mapping
   * @param windowsDrive Windows drive letter (e.g., 'C:')
   * @param wslMountPoint WSL mount point (e.g., '/mnt/c')
   */
  public addDriveMapping(windowsDrive: string, wslMountPoint: string): void {
    this.driveMappings.set(windowsDrive.toLowerCase(), wslMountPoint);
  }

  /**
   * Remove a drive mapping
   * @param windowsDrive Windows drive letter to remove
   */
  public removeDriveMapping(windowsDrive: string): boolean {
    return this.driveMappings.delete(windowsDrive.toLowerCase());
  }

  /**
   * Get all current drive mappings
   * @returns Array of drive mappings
   */
  public getDriveMappings(): DriveMapping[] {
    const mappings: DriveMapping[] = [];
    this.driveMappings.forEach((mountPoint, drive) => {
      mappings.push({
        windowsDrive: drive,
        wslMountPoint: mountPoint,
      });
    });
    return mappings;
  }

  /**
   * Validate if a path is in the expected format
   * @param inputPath The path to validate
   * @param expectedFormat The expected format
   * @returns True if the path matches the expected format
   */
  public validatePathFormat(inputPath: string, expectedFormat: PathFormat): boolean {
    return this.detectPathFormat(inputPath) === expectedFormat;
  }

  /**
   * Normalize path separators based on target format
   * @param inputPath The path to normalize
   * @param targetFormat The target format
   * @returns Normalized path
   */
  public normalizeSeparators(inputPath: string, targetFormat: PathFormat): string {
    if (targetFormat === PathFormat.WINDOWS) {
      return inputPath.replace(/\//g, '\\');
    } else {
      return inputPath.replace(/\\/g, '/');
    }
  }

  /**
   * Normalize common Windows path segments to canonical casing
   * @param pathFragment The path portion to normalize
   * @returns Path fragment with normalized casing for the first segment
   */
  private normalizeWindowsPathCasing(pathFragment: string): string {
    if (!pathFragment) {
      return pathFragment;
    }

    const segments = pathFragment.split('\\');
    if (segments.length === 0) {
      return pathFragment;
    }

    const canonicalSegments: Record<string, string> = {
      users: 'Users',
      'program files': 'Program Files',
      'program files (x86)': 'Program Files (x86)',
      programdata: 'ProgramData',
      windows: 'Windows',
    };

    const firstSegment = segments[0];
    const canonical = canonicalSegments[firstSegment.toLowerCase()];
    if (canonical) {
      segments[0] = canonical;
    } else if (firstSegment.length > 0) {
      segments[0] = firstSegment[0].toUpperCase() + firstSegment.slice(1);
    }

    return segments.join('\\');
  }
}

// Singleton instance for global use
export const pathConverter = new PathConverter();

// Zod schema for path conversion validation
export const PathConversionSchema = z.object({
  inputPath: z.string().min(1, 'Path cannot be empty'),
  targetFormat: z.nativeEnum(PathFormat),
  validateInput: z.boolean().optional().default(true),
});
