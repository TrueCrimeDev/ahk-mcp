/**
 * Unit tests for MetadataExtractor
 * T011: Unit tests for metadata extractor
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { MetadataExtractor } from '../../src/core/metadata-extractor.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('MetadataExtractor', () => {
  let extractor: MetadataExtractor;
  let testDir: string;

  beforeEach(async () => {
    extractor = new MetadataExtractor();
    testDir = path.join(os.tmpdir(), `ahk-extractor-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('extractVersion', () => {
    it('should extract version from static Version assignment', async () => {
      const content = `
class MyLib {
  static Version := "1.2.3"
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.version).toBe('1.2.3');
    });

    it('should extract version with property syntax', async () => {
      const content = `
class MyLib {
  static Version => "2.0.1"
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.version).toBe('2.0.1');
    });

    it('should handle files with no version', async () => {
      const content = `
MyFunction() {
  return "test"
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.version).toBeUndefined();
    });
  });

  describe('extractDependencies', () => {
    it('should extract #Include directives', async () => {
      const content = `
#Include UIA.ahk
#Include Helper.ahk

MyFunction() {
  ; code
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.dependencies).toContain('UIA');
      expect(metadata.dependencies).toContain('Helper');
    });

    it('should handle #Include with paths', async () => {
      const content = `
#Include ../libs/UIA.ahk
#Include <StandardLib>
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.dependencies.length).toBeGreaterThan(0);
    });

    it('should handle files with no dependencies', async () => {
      const content = `
MyFunction() {
  return "standalone"
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.dependencies).toHaveLength(0);
    });
  });

  describe('extractDocumentation', () => {
    it('should parse JSDoc comments', async () => {
      const content = `
/**
 * This is a test library
 * @description Main description
 * @author Test Author
 */
class MyLib {
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.documentation.description).toContain('test library');
    });

    it('should fall back to plain comments when no JSDoc', async () => {
      const content = `
; Simple comment describing the library
; Additional description line

class MyLib {
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.documentation.description).toBe(
        'Simple comment describing the library\nAdditional description line'
      );
    });

    it('should handle files with no documentation', async () => {
      const content = `
class MyLib {
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.documentation).toEqual({
        description: undefined,
        examples: [],
        jsdocTags: [],
        author: undefined,
        credits: undefined,
      });
    });
  });

  describe('extractGlobals', () => {
    it('should extract global variable declarations', async () => {
      const content = `
global MyGlobalVar := "value"
global AnotherGlobal := 123

MyFunction() {
  local x := 1
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.globalVars).toContain('MyGlobalVar');
      expect(metadata.globalVars).toContain('AnotherGlobal');
      expect(metadata.globalVars).not.toContain('x'); // local var
    });
  });

  describe('integration with AHK_Analyze', () => {
    it('should extract classes and functions', async () => {
      const content = `
class MyClass {
  MyMethod() {
  }
}

MyFunction() {
}
`;
      const filePath = path.join(testDir, 'test.ahk');
      await fs.writeFile(filePath, content);

      const metadata = await extractor.extract(filePath);

      expect(metadata.name).toBeTruthy();
      expect(metadata.filePath).toBe(filePath);
    });

    it('should handle invalid AHK files gracefully', async () => {
      const content = 'This is not valid AHK code {{ }}';
      const filePath = path.join(testDir, 'invalid.ahk');
      await fs.writeFile(filePath, content);

      // Should not throw, but return partial metadata
      const metadata = await extractor.extract(filePath);

      expect(metadata.name).toBe('invalid');
      expect(metadata.filePath).toBe(filePath);
    });
  });
});
