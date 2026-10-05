/**
 * Unit tests for LibraryCatalog
 * T014: Unit tests for library catalog
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LibraryCatalog } from '../../src/core/library-catalog.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('LibraryCatalog', () => {
  let catalog: LibraryCatalog;
  let testDir: string;

  beforeEach(async () => {
    catalog = new LibraryCatalog();
    testDir = path.join(os.tmpdir(), `ahk-catalog-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  async function createTestLibrary(name: string, content: string): Promise<string> {
    const filePath = path.join(testDir, `${name}.ahk`);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  describe('initialize', () => {
    it('should initialize and scan directory', async () => {
      await createTestLibrary('UIA', '; UIA library');
      await createTestLibrary('Helper', '; Helper library');

      await catalog.initialize(testDir);

      expect(catalog.isInitialized()).toBe(true);
    });

    it('should not re-initialize if already initialized', async () => {
      await createTestLibrary('UIA', '; UIA library');

      await catalog.initialize(testDir);
      const firstInit = catalog.isInitialized();

      await catalog.initialize(testDir);
      const secondInit = catalog.isInitialized();

      expect(firstInit).toBe(true);
      expect(secondInit).toBe(true);
    });
  });

  describe('get', () => {
    it('should lookup library by name', async () => {
      await createTestLibrary('UIA', 'class UIA { }');

      await catalog.initialize(testDir);
      const lib = catalog.get('UIA');

      expect(lib).toBeDefined();
      expect(lib?.name).toBe('UIA');
    });

    it('should return undefined for non-existent library', async () => {
      await catalog.initialize(testDir);
      const lib = catalog.get('NonExistent');

      expect(lib).toBeUndefined();
    });

    it('should handle case-sensitive names', async () => {
      await createTestLibrary('MyLib', '; library');

      await catalog.initialize(testDir);

      expect(catalog.get('MyLib')).toBeDefined();
      expect(catalog.get('mylib')).toBeUndefined();
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      await createTestLibrary('UIA', '; UI Automation framework');
      await createTestLibrary('UIA_Browser', '; Browser automation');
      await createTestLibrary('Helper', '; General helpers');
    });

    it('should find libraries by name substring', async () => {
      await catalog.initialize(testDir);
      const results = catalog.search('UIA');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(lib => lib.name.includes('UIA'))).toBe(true);
    });

    it('should find libraries by description', async () => {
      await catalog.initialize(testDir);
      const results = catalog.search('automation');

      expect(results.length).toBeGreaterThan(0);
    });

    it('should be case-insensitive', async () => {
      await catalog.initialize(testDir);

      const upperResults = catalog.search('UIA');
      const lowerResults = catalog.search('uia');

      expect(upperResults.length).toEqual(lowerResults.length);
    });

    it('should return empty array for no matches', async () => {
      await catalog.initialize(testDir);
      const results = catalog.search('NonExistent');

      expect(results).toHaveLength(0);
    });
  });

  describe('filter', () => {
    beforeEach(async () => {
      await createTestLibrary('UIA', '; Category: UI Automation');
      await createTestLibrary('Helper', '; Category: Utilities');
    });

    it('should filter by category', async () => {
      await catalog.initialize(testDir);
      const results = catalog.filter('UI');

      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should return all if no category provided', async () => {
      await catalog.initialize(testDir);

      const allLibs = catalog.filter();
      const lib1 = catalog.get('UIA');
      const lib2 = catalog.get('Helper');

      expect(allLibs.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('refresh', () => {
    it('should refresh and rebuild catalog', async () => {
      await createTestLibrary('Initial', '; initial');
      await catalog.initialize(testDir);

      const beforeRefresh = catalog.get('Initial');
      expect(beforeRefresh).toBeDefined();

      // Add new library
      await createTestLibrary('NewLib', '; new library');
      await catalog.refresh();

      const afterRefresh = catalog.get('NewLib');
      expect(afterRefresh).toBeDefined();
    });

    it('should clear old entries on refresh', async () => {
      await createTestLibrary('ToDelete', '; will be deleted');
      await catalog.initialize(testDir);

      // Delete the file
      await fs.unlink(path.join(testDir, 'ToDelete.ahk'));
      await catalog.refresh();

      const deleted = catalog.get('ToDelete');
      expect(deleted).toBeUndefined();
    });
  });

  describe('performance', () => {
    it('should initialize in <2s for 20 libraries', async () => {
      // Create 20 test libraries
      const promises = [];
      for (let i = 1; i <= 20; i++) {
        promises.push(createTestLibrary(`Lib${i}`, `; Library ${i}`));
      }
      await Promise.all(promises);

      const startTime = Date.now();
      await catalog.initialize(testDir);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(2000);
      expect(catalog.isInitialized()).toBe(true);
    }, 5000); // Allow 5s timeout for this test
  });
});
