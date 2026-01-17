import fs from 'fs';
import path from 'path';
import logger from '../logger.js';
/**
 * Alpha version management system
 * Tracks and creates versioned copies of scripts
 */
export class AlphaVersionManager {
    constructor() {
        // Track version numbers for each base file
        this.versionMap = new Map();
        // Track failure counts for automatic alpha creation
        this.failureMap = new Map();
        // Configuration
        this.FAILURE_THRESHOLD = 3; // Create alpha after 3 failures
        this.loadVersionState();
    }
    static getInstance() {
        if (!AlphaVersionManager.instance) {
            AlphaVersionManager.instance = new AlphaVersionManager();
        }
        return AlphaVersionManager.instance;
    }
    /**
     * Load version state from a persistent file
     */
    loadVersionState() {
        try {
            const statePath = this.getStatePath();
            if (fs.existsSync(statePath)) {
                const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                this.versionMap = new Map(Object.entries(data.versions || {}));
                this.failureMap = new Map(Object.entries(data.failures || {}));
            }
        }
        catch (error) {
            logger.warn('Could not load alpha version state:', error);
        }
    }
    /**
     * Save version state to persistent file
     */
    saveVersionState() {
        try {
            const statePath = this.getStatePath();
            const stateDir = path.dirname(statePath);
            if (!fs.existsSync(stateDir)) {
                fs.mkdirSync(stateDir, { recursive: true });
            }
            const data = {
                versions: Object.fromEntries(this.versionMap),
                failures: Object.fromEntries(this.failureMap),
                lastUpdated: new Date().toISOString(),
            };
            fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch (error) {
            logger.error('Could not save alpha version state:', error);
        }
    }
    /**
     * Get the state file path
     */
    getStatePath() {
        const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
        const base = process.platform === 'win32' ? appData : path.join(process.env.HOME || '', '.config');
        return path.join(base, 'ahk-mcp', 'alpha-versions.json');
    }
    /**
     * Generate the next alpha version filename
     */
    getNextAlphaName(originalPath) {
        const dir = path.dirname(originalPath);
        const ext = path.extname(originalPath);
        const basename = path.basename(originalPath, ext);
        // Get current version number for this file
        const currentVersion = this.versionMap.get(originalPath) || 0;
        const nextVersion = currentVersion + 1;
        // Create alpha filename: original_a1.ahk, original_a2.ahk, etc.
        const alphaName = `${basename}_a${nextVersion}${ext}`;
        const alphaPath = path.join(dir, alphaName);
        return alphaPath;
    }
    /**
     * Create an alpha version of a script
     */
    async createAlphaVersion(originalPath, content) {
        try {
            // Ensure it's an .ahk file
            if (!originalPath.toLowerCase().endsWith('.ahk')) {
                throw new Error('Can only create alpha versions of .ahk files');
            }
            // Get or read content
            if (!content) {
                if (!fs.existsSync(originalPath)) {
                    throw new Error(`Original file not found: ${originalPath}`);
                }
                content = fs.readFileSync(originalPath, 'utf-8');
            }
            // Generate alpha filename
            const alphaPath = this.getNextAlphaName(originalPath);
            // Add header comment to indicate this is an alpha version
            const header = `; Alpha Version ${this.getVersionNumber(originalPath) + 1}\n` +
                `; Created: ${new Date().toISOString()}\n` +
                `; Original: ${path.basename(originalPath)}\n` +
                `; Reason: ${this.getCreationReason(originalPath)}\n\n`;
            const alphaContent = header + content;
            // Write the alpha file
            fs.writeFileSync(alphaPath, alphaContent, 'utf-8');
            // Update version tracking
            this.versionMap.set(originalPath, (this.versionMap.get(originalPath) || 0) + 1);
            this.saveVersionState();
            logger.info(`Created alpha version: ${alphaPath}`);
            return alphaPath;
        }
        catch (error) {
            logger.error('Failed to create alpha version:', error);
            throw error;
        }
    }
    /**
     * Get current version number for a file
     */
    getVersionNumber(originalPath) {
        return this.versionMap.get(originalPath) || 0;
    }
    /**
     * Track a failure for automatic alpha creation
     */
    trackFailure(filePath) {
        const failures = (this.failureMap.get(filePath) || 0) + 1;
        this.failureMap.set(filePath, failures);
        this.saveVersionState();
        logger.info(`Failure ${failures} tracked for ${filePath}`);
        // Return true if threshold reached
        return failures >= this.FAILURE_THRESHOLD;
    }
    /**
     * Reset failure count
     */
    resetFailures(filePath) {
        this.failureMap.delete(filePath);
        this.saveVersionState();
    }
    /**
     * Get the reason for creating this version
     */
    getCreationReason(originalPath) {
        const failures = this.failureMap.get(originalPath) || 0;
        if (failures >= this.FAILURE_THRESHOLD) {
            return `Multiple failures (${failures}) - changing approach`;
        }
        return 'Manual alpha version request';
    }
    /**
     * List all alpha versions of a file
     */
    listAlphaVersions(originalPath) {
        const dir = path.dirname(originalPath);
        const ext = path.extname(originalPath);
        const basename = path.basename(originalPath, ext);
        const versions = [];
        try {
            const files = fs.readdirSync(dir);
            const pattern = new RegExp(`^${basename}_a(\\d+)${ext.replace('.', '\\.')}$`);
            for (const file of files) {
                if (pattern.test(file)) {
                    versions.push(path.join(dir, file));
                }
            }
        }
        catch (error) {
            logger.error('Error listing alpha versions:', error);
        }
        return versions.sort();
    }
    /**
     * Get the latest alpha version of a file
     */
    getLatestAlphaVersion(originalPath) {
        const versions = this.listAlphaVersions(originalPath);
        return versions.length > 0 ? versions[versions.length - 1] : null;
    }
    /**
     * Check if we should automatically create an alpha version
     */
    shouldCreateAlpha(filePath) {
        const failures = this.failureMap.get(filePath) || 0;
        return failures >= this.FAILURE_THRESHOLD;
    }
    /**
     * Clear all version history for a file
     */
    clearVersionHistory(originalPath) {
        this.versionMap.delete(originalPath);
        this.failureMap.delete(originalPath);
        this.saveVersionState();
    }
}
// Export singleton instance
export const alphaVersions = AlphaVersionManager.getInstance();
// Helper functions
export async function createAlphaVersion(originalPath, content) {
    return alphaVersions.createAlphaVersion(originalPath, content);
}
export function trackEditFailure(filePath) {
    return alphaVersions.trackFailure(filePath);
}
export function shouldCreateAlpha(filePath) {
    return alphaVersions.shouldCreateAlpha(filePath);
}
export function resetFailures(filePath) {
    alphaVersions.resetFailures(filePath);
}
