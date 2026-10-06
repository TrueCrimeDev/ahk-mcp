/**
 * Unit tests for LibraryScanner
 * T010: Unit tests for library scanner
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LibraryScanner } from '../../src/core/library-scanner.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('LibraryScanner', () => {
  let scanner: LibraryScanner;
  let testDir: string;

  beforeEach(async () => {
    scanner = new LibraryScanner();
    // Create a temporary test directory
    testDir = path.join(os.tmpdir(), `ahk-scanner-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('scanDirectory', () => {
    it('should scan valid directory and return .ahk files', async () => {
      // Create test .ahk files
      await fs.writeFile(path.join(testDir, 'test1.ahk'), '; Test file 1');
      await fs.writeFile(path.join(testDir, 'test2.ahk'), '; Test file 2');

      const results = await scanner.scanDirectory(testDir);

      expect(results).toHaveLength(2);
      expect(results.every(file => file.endsWith('.ahk'))).toBe(true);
    });

    it('should filter non-.ahk files correctly', async () => {
      // Create mixed files
      await fs.writeFile(path.join(testDir, 'test.ahk'), '; AHK file');
      await fs.writeFile(path.join(testDir, 'readme.txt'), 'Text file');
      await fs.writeFile(path.join(testDir, 'script.js'), '// JS file');

      const results = await scanner.scanDirectory(testDir);

      expect(results).toHaveLength(1);
      expect(results[0]).toContain('test.ahk');
    });

    it('should handle empty directory', async () => {
      const results = await scanner.scanDirectory(testDir);

      expect(results).toHaveLength(0);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should throw error for non-existent directory', async () => {
      const nonExistentDir = path.join(testDir, 'does-not-exist');

      await expect(scanner.scanDirectory(nonExistentDir)).rejects.toThrow('Directory not found');
    });

    it('should return absolute paths', async () => {
      await fs.writeFile(path.join(testDir, 'test.ahk'), '; Test');

      const results = await scanner.scanDirectory(testDir);

      expect(results[0]).toContain(testDir);
      expect(path.isAbsolute(results[0])).toBe(true);
    });

    it('should return sorted paths', async () => {
      // Create files in random order
      await fs.writeFile(path.join(testDir, 'z-last.ahk'), '; Last');
      await fs.writeFile(path.join(testDir, 'a-first.ahk'), '; First');
      await fs.writeFile(path.join(testDir, 'm-middle.ahk'), '; Middle');

      const results = await scanner.scanDirectory(testDir);

      expect(results[0]).toContain('a-first.ahk');
      expect(results[1]).toContain('m-middle.ahk');
      expect(results[2]).toContain('z-last.ahk');
    });
  });

  describe('scanLibraryNames', () => {
    it('should extract library names from filenames', async () => {
      await fs.writeFile(path.join(testDir, 'UIA.ahk'), '; UIA');
      await fs.writeFile(path.join(testDir, 'UIA_Browser.ahk'), '; Browser');

      const names = await scanner.scanLibraryNames(testDir);

      expect(names).toContain('UIA');
      expect(names).toContain('UIA_Browser');
    });

    it('should handle files with multiple dots', async () => {
      await fs.writeFile(path.join(testDir, 'lib.v2.ahk'), '; Library v2');

      const names = await scanner.scanLibraryNames(testDir);

      expect(names).toContain('lib.v2');
    });
  });
});
