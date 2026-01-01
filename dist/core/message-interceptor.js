import logger from '../logger.js';
import { detectFilePaths, resolveFilePath } from './config.js';
import { setActiveFilePath } from './active-file.js';
/**
 * Message interceptor for automatic file detection
 * This can be used to pre-process messages before they reach tools
 */
export class MessageInterceptor {
    constructor() {
        this.autoSetActive = true;
    }
    static getInstance() {
        if (!MessageInterceptor.instance) {
            MessageInterceptor.instance = new MessageInterceptor();
        }
        return MessageInterceptor.instance;
    }
    /**
     * Process a message and extract file paths
     * @param message The user message to process
     * @returns Extracted information
     */
    processMessage(message) {
        const result = {
            detectedFiles: [],
            resolvedFiles: [],
            activeFileSet: false,
            originalMessage: message,
            hasInstructions: false,
        };
        // Detect file paths in the message
        result.detectedFiles = detectFilePaths(message);
        if (result.detectedFiles.length === 0) {
            return result;
        }
        // Try to resolve each detected path
        for (const detected of result.detectedFiles) {
            const resolved = resolveFilePath(detected);
            if (resolved) {
                result.resolvedFiles.push(resolved);
            }
        }
        // Check if message has instructions beyond just the file path
        const lines = message
            .split('\n')
            .map(l => l.trim())
            .filter(l => l);
        const nonPathLines = lines.filter(line => {
            // Check if this line is just a file path
            return !result.detectedFiles.some(p => line === p || line === `"${p}"` || line === `'${p}'` || line.endsWith(p));
        });
        result.hasInstructions = nonPathLines.length > 0;
        // Auto-set the first resolved file as active if enabled
        if (this.autoSetActive && result.resolvedFiles.length > 0) {
            const firstFile = result.resolvedFiles[0];
            if (firstFile !== this.lastDetectedFile) {
                const setSuccess = setActiveFilePath(firstFile);
                if (setSuccess) {
                    this.lastDetectedFile = firstFile;
                    result.activeFileSet = true;
                    logger.info(`Auto-set active file: ${firstFile}`);
                }
                else {
                    logger.warn(`Failed to auto-set active file: ${firstFile}`);
                }
            }
        }
        return result;
    }
    /**
     * Check if a message contains file paths
     */
    hasFilePath(message) {
        const paths = detectFilePaths(message);
        return paths.length > 0;
    }
    /**
     * Parse a multi-line message into components
     */
    parseMultiLineMessage(message) {
        const lines = message.split('\n').map(l => l.trim());
        const result = {
            filePath: undefined,
            instructions: [],
            rawLines: lines,
        };
        // Check first few lines for file path
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            const line = lines[i];
            if (!line)
                continue;
            const paths = detectFilePaths(line);
            if (paths.length > 0) {
                const resolved = resolveFilePath(paths[0]);
                if (resolved) {
                    result.filePath = resolved;
                    // Rest of the lines are instructions
                    result.instructions = lines.slice(i + 1).filter(l => l);
                    break;
                }
            }
        }
        // If no file path found in first lines, check entire message
        if (!result.filePath) {
            const allPaths = detectFilePaths(message);
            if (allPaths.length > 0) {
                const resolved = resolveFilePath(allPaths[0]);
                if (resolved) {
                    result.filePath = resolved;
                    // Try to extract instructions by removing the path line
                    result.instructions = lines.filter(line => !allPaths.some(p => line.includes(p)));
                }
            }
        }
        return result;
    }
    /**
     * Enable or disable auto-setting active file
     */
    setAutoSetActive(enabled) {
        this.autoSetActive = enabled;
    }
    /**
     * Get the last detected file
     */
    getLastDetectedFile() {
        return this.lastDetectedFile;
    }
    /**
     * Clear the last detected file
     */
    clearLastDetected() {
        this.lastDetectedFile = undefined;
    }
}
// Export singleton instance
export const messageInterceptor = MessageInterceptor.getInstance();
