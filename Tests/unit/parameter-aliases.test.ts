import { describe, it, expect } from '@jest/globals';
import {
  resolveContentParameter,
  detectDeprecatedParameters,
  addDeprecationWarning,
  resolveWithTracking,
} from '../../src/core/parameter-aliases.js';

describe('Parameter Aliases Utility', () => {
  describe('resolveContentParameter', () => {
    it('should return newContent when only newContent provided', () => {
      const result = resolveContentParameter({ newContent: 'test' });
      expect(result).toBe('test');
    });

    it('should return content when only content provided (deprecated)', () => {
      const result = resolveContentParameter({ content: 'test' });
      expect(result).toBe('test');
    });

    it('should return newContent when both provided (priority)', () => {
      const result = resolveContentParameter({
        content: 'old',
        newContent: 'new',
      });
      expect(result).toBe('new');
    });

    it('should return undefined when neither provided', () => {
      const result = resolveContentParameter({});
      expect(result).toBe(undefined);
    });

    it('should handle empty strings correctly', () => {
      const result1 = resolveContentParameter({ newContent: '' });
      expect(result1).toBe('');

      const result2 = resolveContentParameter({ content: '' });
      expect(result2).toBe('');
    });

    it('should handle null-like values', () => {
      const result1 = resolveContentParameter({ newContent: null });
      expect(result1).toBe(undefined);

      const result2 = resolveContentParameter({ content: undefined });
      expect(result2).toBe(undefined);
    });
  });

  describe('detectDeprecatedParameters', () => {
    it('should detect content when used alone', () => {
      const result = detectDeprecatedParameters({ content: 'test' });
      expect(result).toStrictEqual(['"content" (use "newContent")']);
    });

    it('should not detect when newContent provided', () => {
      const result = detectDeprecatedParameters({ newContent: 'test' });
      expect(result).toStrictEqual([]);
    });

    it('should not detect when both provided (newContent takes priority)', () => {
      const result = detectDeprecatedParameters({
        content: 'old',
        newContent: 'new',
      });
      expect(result).toStrictEqual([]);
    });

    it('should return empty array when neither provided', () => {
      const result = detectDeprecatedParameters({});
      expect(result).toStrictEqual([]);
    });

    it('should handle object with other properties', () => {
      const result = detectDeprecatedParameters({
        content: 'test',
        action: 'replace',
        search: 'foo',
      });
      expect(result).toStrictEqual(['"content" (use "newContent")']);
    });
  });

  describe('addDeprecationWarning', () => {
    it('should prepend warning to text content', () => {
      const result = {
        content: [{ type: 'text', text: 'Original message' }],
      };

      const updated = addDeprecationWarning(result, ['"content" (use "newContent")']);

      expect(updated.content[0].text).toContain('⚠️ **Deprecated parameter(s)**');
      expect(updated.content[0].text).toContain('"content" (use "newContent")');
      expect(updated.content[0].text).toContain('Original message');
    });

    it('should handle multiple deprecated parameters', () => {
      const result = {
        content: [{ type: 'text', text: 'Original' }],
      };

      const updated = addDeprecationWarning(result, [
        '"content" (use "newContent")',
        '"preview" (use "dryRun")',
      ]);

      expect(updated.content[0].text).toContain('"content" (use "newContent")');
      expect(updated.content[0].text).toContain('"preview" (use "dryRun")');
    });

    it('should not modify result when no deprecated params', () => {
      const result = {
        content: [{ type: 'text', text: 'Original message' }],
      };

      const updated = addDeprecationWarning(result, []);

      expect(updated.content[0].text).toBe('Original message');
    });

    it('should handle empty content array', () => {
      const result = { content: [] };
      const updated = addDeprecationWarning(result, ['"content"']);
      expect(updated.content).toStrictEqual([]);
    });

    it('should handle non-text content types', () => {
      const result = {
        content: [{ type: 'image', data: 'base64...' }],
      };

      const updated = addDeprecationWarning(result, ['"content"']);
      expect(updated.content[0].type).toBe('image');
    });
  });

  describe('resolveWithTracking', () => {
    it('should return content and deprecated list', () => {
      const result = resolveWithTracking({ content: 'test' });

      expect(result.content).toBe('test');
      expect(result.deprecatedUsed).toStrictEqual(['"content" (use "newContent")']);
    });

    it('should return newContent with empty deprecated list', () => {
      const result = resolveWithTracking({ newContent: 'test' });

      expect(result.content).toBe('test');
      expect(result.deprecatedUsed).toStrictEqual([]);
    });

    it('should prioritize newContent and return empty deprecated list', () => {
      const result = resolveWithTracking({
        content: 'old',
        newContent: 'new',
      });

      expect(result.content).toBe('new');
      expect(result.deprecatedUsed).toStrictEqual([]);
    });

    it('should return undefined content when neither provided', () => {
      const result = resolveWithTracking({});

      expect(result.content).toBe(undefined);
      expect(result.deprecatedUsed).toStrictEqual([]);
    });
  });

  describe('Edge cases', () => {
    it('should handle numeric values in content fields', () => {
      const result1 = resolveContentParameter({ newContent: 0 });
      expect(result1).toBe(undefined); // 0 is falsy but not undefined

      const result2 = resolveContentParameter({ content: 123 });
      expect(result2).toBe(undefined);
    });

    it('should handle boolean values', () => {
      const result1 = resolveContentParameter({ newContent: false });
      expect(result1).toBe(undefined);

      const result2 = resolveContentParameter({ newContent: true });
      expect(result2).toBe(undefined);
    });

    it('should preserve whitespace-only strings', () => {
      const result = resolveContentParameter({ newContent: '   ' });
      expect(result).toBe('   ');
    });
  });
});
