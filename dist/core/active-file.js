import path from 'path';
import fs from 'fs';
import logger from '../logger.js';
import { toolSettings } from './tool-settings.js';
import { detectFilePaths, resolveFilePath, getActiveFile as getPersistedActiveFile, setActiveFile as persistActiveFile, clearActiveFile as clearPersistedActiveFile, } from './config.js';
/**
 * Simple global variable system for active file tracking
 * ALL tools can read and write to this shared state
 */
class ActiveFileManager {
    constructor() {
        // THE SINGLE SHARED VARIABLE - this is what all tools use
        this.activeFilePath = undefined;
        // Additional tracking
        this.lastDetectedPath = undefined;
        this.lastModified = undefined;
        // Load from environment variable first
        if (process.env.AHK_ACTIVE_FILE && this.setActiveFile(process.env.AHK_ACTIVE_FILE)) {
            return;
        }
        // Fall back to persisted configuration
        const persisted = getPersistedActiveFile();
        if (persisted && fs.existsSync(persisted)) {
            this.activeFilePath = path.resolve(persisted);
            this.lastModified = new Date();
            logger.info(`Restored active file: ${this.activeFilePath}`);
        }
    }
    static getInstance() {
        if (!ActiveFileManager.instance) {
            ActiveFileManager.instance = new ActiveFileManager();
        }
        return ActiveFileManager.instance;
    }
    /**
     * Set the active file path - used by ALL tools
     */
    setActiveFile(filePath) {
        if (!filePath) {
            this.activeFilePath = undefined;
            this.lastModified = undefined;
            this.lastDetectedPath = undefined;
            logger.info('Active file cleared');
            try {
                clearPersistedActiveFile();
            }
            catch (error) {
                logger.warn('Failed to clear persisted active file:', error);
            }
            return true;
        }
        // Resolve to absolute path
        const resolved = path.resolve(filePath);
        // Check if it's an .ahk file
        if (!resolved.toLowerCase().endsWith('.ahk')) {
            logger.warn(`Not an AHK file: ${resolved}`);
            return false;
        }
        // Check if file exists
        if (!fs.existsSync(resolved)) {
            logger.warn(`File does not exist: ${resolved}`);
            return false;
        }
        // Set the active file
        this.activeFilePath = resolved;
        this.lastModified = new Date();
        logger.info(`✅ Active file set: ${resolved}`);
        try {
            persistActiveFile(resolved);
        }
        catch (error) {
            logger.warn('Failed to persist active file:', error);
        }
        return true;
    }
    /**
     * Get the active file path - used by ALL tools
     */
    getActiveFile() {
        return this.activeFilePath;
    }
    /**
     * Quick check if we have an active file
     */
    hasActiveFile() {
        return this.activeFilePath !== undefined;
    }
    /**
     * Try to detect and set file from any text input
     * This is called automatically by tools
     */
    detectAndSetFromText(text) {
        // Check if file detection is allowed
        if (!toolSettings.isFileDetectionAllowed()) {
            logger.debug('File detection is disabled in settings');
            return undefined;
        }
        const detectedPaths = detectFilePaths(text);
        for (const candidate of detectedPaths) {
            let resolved = resolveFilePath(candidate) || undefined;
            if (!resolved && path.isAbsolute(candidate) && fs.existsSync(candidate)) {
                resolved = path.resolve(candidate);
            }
            if (!resolved) {
                const relative = path.resolve(candidate);
                if (fs.existsSync(relative)) {
                    resolved = relative;
                }
            }
            if (resolved && this.setActiveFile(resolved)) {
                this.lastDetectedPath = candidate;
                return resolved;
            }
        }
        return undefined;
    }
    /**
     * Clear the active file
     */
    clear() {
        this.setActiveFile(undefined);
    }
    /**
     * Get status information
     */
    getStatus() {
        return {
            activeFile: this.activeFilePath,
            lastDetected: this.lastDetectedPath,
            lastModified: this.lastModified,
            exists: this.activeFilePath ? fs.existsSync(this.activeFilePath) : false,
        };
    }
}
// Export the singleton instance - this is THE shared variable
export const activeFile = ActiveFileManager.getInstance();
// Helper functions for easy access
export function getActiveFilePath() {
    return activeFile.getActiveFile();
}
export function setActiveFilePath(filePath) {
    return activeFile.setActiveFile(filePath);
}
export function detectFileInText(text) {
    return activeFile.detectAndSetFromText(text);
}
export function hasActiveFile() {
    return activeFile.hasActiveFile();
}
export function clearActiveFile() {
    activeFile.clear();
}
// Auto-detect file paths in any text (can be called by any tool)
export function autoDetect(text) {
    activeFile.detectAndSetFromText(text);
}
