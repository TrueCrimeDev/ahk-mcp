import { describe, it, expect } from '@jest/globals';
import { DryRunPreviewGenerator, createPreviewGenerator } from '../../src/utils/dry-run-preview.js';

describe('Dry Run Preview Generator Utility', () => {
  const sampleContent = `#Requires AutoHotkey v2.0
class TestClass {
    __New() {
        this.oldText := "original value"
        this.DarkMode := true
        this.testValue := "initial"
    }
}`;

  describe('DryRunPreviewGenerator', () => {
    it('should create generator with default maxSamples', () => {
      const generator = new DryRunPreviewGenerator();
      expect(generator).toBeInstanceOf(DryRunPreviewGenerator);
    });

    it('should create generator with custom maxSamples', () => {
      const generator = new DryRunPreviewGenerator(5);
      expect(generator).toBeInstanceOf(DryRunPreviewGenerator);
    });
  });

  describe('generatePreview - replace operations', () => {
    it('should generate preview for simple text replacement', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(sampleContent, 'oldText', 'newText', {
        regex: false,
        all: false,
      });

      expect(preview.summary.filesAffected).toBe(1);
      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.summary.operationType).toBe('replace');
      expect(preview.samples.length).toBe(1);
    });

    it('should generate preview for replace all occurrences', () => {
      const content = 'foo bar foo baz foo';
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(content, 'foo', 'bar', { regex: false, all: true });

      expect(preview.summary.totalChanges).toBe(3);
      // Samples are per affected line, so the one line shows all three replacements.
      expect(preview.samples).toEqual([
        { lineNumber: 1, before: 'foo bar foo baz foo', after: 'bar bar bar baz bar' },
      ]);
    });

    it('should limit samples to maxSamples', () => {
      const content = 'foo\nfoo\nfoo\nfoo\nfoo';
      const generator = new DryRunPreviewGenerator(2);

      const preview = generator.generatePreview(content, 'foo', 'bar', { regex: false, all: true });

      expect(preview.summary.totalChanges).toBe(5);
      expect(preview.samples.length).toBe(2); // Limited to maxSamples
    });

    it('should handle regex patterns', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(sampleContent, 'this\\.(\\w+)', 'self.$1', {
        regex: true,
        all: true,
      });

      expect(preview.summary.totalChanges).toBeGreaterThan(0);
      expect(preview.summary.operationType).toBe('replace');
    });

    it('should return zero changes when pattern not found', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(sampleContent, 'nonexistent', 'replacement', {
        regex: false,
        all: false,
      });

      expect(preview.summary.totalChanges).toBe(0);
      expect(preview.samples.length).toBe(0);
    });

    it('should stop after first match when all=false', () => {
      const content = 'foo\nfoo\nfoo';
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(content, 'foo', 'bar', {
        regex: false,
        all: false,
      });

      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.samples.length).toBe(1);
    });

    it('should track character differences', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('short', 'short', 'much longer text', {
        regex: false,
        all: false,
      });

      const { characterDiff } = preview.summary;
      expect(characterDiff).toBeDefined();
      expect(characterDiff!.added).toBeGreaterThan(characterDiff!.removed);
    });

    it('should handle empty replacement string', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('remove this text', 'this ', '', {
        regex: false,
        all: false,
      });

      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.samples[0].after).toBe('remove text');
    });
  });

  describe('generateInsertPreview', () => {
    it('should generate preview for line insertion', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview(sampleContent, 3, 'new line content');

      expect(preview.summary.filesAffected).toBe(1);
      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.summary.operationType).toBe('insert');
      expect(preview.samples.length).toBe(1);
    });

    it('should show before and after for insertion', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview('line1\nline2\nline3', 2, 'inserted');

      expect(preview.samples[0].before).toBeTruthy();
      expect(preview.samples[0].after).toContain('inserted');
    });

    it('should handle insertion at end of file', () => {
      const content = 'line1\nline2';
      const lines = content.split('\n');
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview(content, lines.length + 1, 'new last line');

      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.samples[0].before).toBe('(end of file)');
    });

    it('should return warning for invalid line number', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview('line1\nline2', 100, 'content');

      expect(preview.summary.totalChanges).toBe(0);
      expect(preview.warnings.length).toBeGreaterThan(0);
      expect(preview.warnings[0]).toContain('Invalid line number');
    });

    it('should track added characters for insertion', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview('existing', 1, 'new content');

      expect(preview.summary.characterDiff?.added).toBe('new content'.length);
      expect(preview.summary.characterDiff?.removed).toBe(0);
    });
  });

  describe('generateDeletePreview', () => {
    it('should generate preview for single line deletion', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateDeletePreview(sampleContent, 3);

      expect(preview.summary.filesAffected).toBe(1);
      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.summary.operationType).toBe('delete');
      expect(preview.samples.length).toBe(1);
    });

    it('should generate preview for range deletion', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateDeletePreview(sampleContent, 3, 5);

      expect(preview.summary.totalChanges).toBe(3); // Lines 3-5
      expect(preview.samples.length).toBeLessThanOrEqual(3);
    });

    it('should limit delete samples to maxSamples', () => {
      const generator = new DryRunPreviewGenerator(2);

      const preview = generator.generateDeletePreview('line1\nline2\nline3\nline4\nline5', 1, 5);

      expect(preview.summary.totalChanges).toBe(5);
      expect(preview.samples.length).toBe(2); // Limited to maxSamples
    });

    it('should show deleted indicator in samples', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateDeletePreview('line to delete', 1);

      expect(preview.samples[0].after).toBe('(deleted)');
    });

    it('should return warning for invalid start line', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateDeletePreview('line1\nline2', 100);

      expect(preview.summary.totalChanges).toBe(0);
      expect(preview.warnings.length).toBeGreaterThan(0);
      expect(preview.warnings[0]).toContain('Invalid start line');
    });

    it('should track removed characters for deletion', () => {
      const content = 'line to delete';
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateDeletePreview(content, 1);

      expect(preview.summary.characterDiff?.added).toBe(0);
      expect(preview.summary.characterDiff?.removed).toBeGreaterThan(0);
    });
  });

  describe('formatPreview', () => {
    it('should format preview with DRY RUN marker', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('test', 'test', 'changed', {
        regex: false,
        all: false,
      });

      const formatted = generator.formatPreview(preview, '/path/to/file.ahk');

      expect(formatted).toContain('[DRY RUN] **DRY RUN - No changes made**');
      expect(formatted).toContain('/path/to/file.ahk');
    });

    it('should show "no matches" message when no changes', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('test', 'nonexistent', 'replacement', {
        regex: false,
        all: false,
      });

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('no matches found');
      expect(formatted).toContain('pattern not found');
    });

    it('should indicate single vs multiple replacements', () => {
      const generator = new DryRunPreviewGenerator();

      const preview1 = generator.generatePreview('foo', 'foo', 'bar', { regex: false, all: false });

      const formatted1 = generator.formatPreview(preview1, 'file.ahk');
      expect(formatted1).toContain('Replace first occurrence');

      const preview2 = generator.generatePreview('foo foo', 'foo', 'bar', {
        regex: false,
        all: true,
      });

      const formatted2 = generator.formatPreview(preview2, 'file.ahk');
      expect(formatted2).toContain('Replace all occurrences');
    });

    it('should show sample changes with line numbers', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('line1\nline2 old\nline3', 'old', 'new', {
        regex: false,
        all: false,
      });

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('Line 2:');
      expect(formatted).toContain('→');
    });

    it('should show "showing first X of Y" when truncated', () => {
      const content = 'foo\nfoo\nfoo\nfoo\nfoo';
      const generator = new DryRunPreviewGenerator(2);

      const preview = generator.generatePreview(content, 'foo', 'bar', { regex: false, all: true });

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('showing first 2 of 5');
    });

    it('should include character diff statistics', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('short', 'short', 'much longer', {
        regex: false,
        all: false,
      });

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('Characters changed:');
      expect(formatted).toMatch(/\+\d+ -\d+/);
    });

    it('should show warnings section when present', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generateInsertPreview('test', 999, 'content');

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('[WARN] **Warnings:**');
      expect(formatted).toContain('Invalid line number');
    });

    it('should end with dry run disclaimer', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('test', 'test', 'new', {
        regex: false,
        all: false,
      });

      const formatted = generator.formatPreview(preview, 'file.ahk');

      expect(formatted).toContain('[WARN] **DRY RUN**: File was NOT modified');
    });
  });

  describe('createPreviewGenerator', () => {
    it('should create generator with default settings', () => {
      const generator = createPreviewGenerator();

      const preview = generator.generatePreview('test', 'test', 'new', {});

      expect(preview).toBeTruthy();
    });

    it('should create generator with custom maxSamples', () => {
      const generator = createPreviewGenerator(5);

      const content = 'a\na\na\na\na\na\na';
      const preview = generator.generatePreview(content, 'a', 'b', { all: true });

      expect(preview.samples.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty content', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('', 'test', 'new', {});

      expect(preview.summary.totalChanges).toBe(0);
    });

    it('should handle multiline patterns', () => {
      const generator = new DryRunPreviewGenerator();

      const content = 'line1\nline2\nline3';
      const preview = generator.generatePreview(content, 'line2', 'modified', {});

      expect(preview.summary.totalChanges).toBe(1);
    });

    it('should handle special regex characters in literal mode', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('test.value', '.', '_', {
        regex: false,
        all: false,
      });

      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.samples[0].after).toBe('test_value');
    });

    it('should handle very long lines', () => {
      const longLine = 'a'.repeat(10000);
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview(longLine, 'a', 'b', { regex: false, all: false });

      expect(preview.summary.totalChanges).toBe(1);
    });

    it('should handle unicode characters', () => {
      const generator = new DryRunPreviewGenerator();

      const preview = generator.generatePreview('Hello 世界', '世界', 'World', {});

      expect(preview.summary.totalChanges).toBe(1);
      expect(preview.samples[0].after).toBe('Hello World');
    });
  });
});
