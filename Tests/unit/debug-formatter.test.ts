import { describe, it, expect } from '@jest/globals';
import { DebugFormatter, createDebugFormatter } from '../../src/utils/debug-formatter.js';

describe('Debug Formatter Utility', () => {
  describe('DebugFormatter', () => {
    it('should create formatter with default settings', () => {
      const formatter = new DebugFormatter();
      expect(formatter.getEntryCount()).toBe(0);
    });

    it('should add entries correctly', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_File_Detect',
        reason: 'Test reason',
        duration: 100,
      });

      expect(formatter.getEntryCount()).toBe(1);
    });

    it('should add multiple entries', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_File_Detect',
        reason: 'First call',
        duration: 50,
      });

      formatter.addEntry({
        tool: 'AHK_Analyze',
        reason: 'Second call',
        duration: 100,
      });

      expect(formatter.getEntryCount()).toBe(2);
    });

    it('should format output with entries', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_File_Detect',
        reason: 'Testing',
        duration: 45,
      });

      const output = formatter.format();

      expect(output).toContain('🔍 **DEBUG: Orchestration Log**');
      expect(output).toContain('AHK_File_Detect');
      expect(output).toContain('Testing');
      expect(output).toContain('45ms');
    });

    it('should include cache status when provided', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_Analyze',
        reason: 'Cache test',
        duration: 10,
        cacheStatus: 'HIT',
      });

      const output = formatter.format();

      expect(output).toContain('Cache: HIT');
      expect(output).toContain('⚡'); // Cache hit emoji
    });

    it('should show cache MISS without emoji', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_Analyze',
        reason: 'Cache miss',
        duration: 100,
        cacheStatus: 'MISS',
      });

      const output = formatter.format();

      expect(output).toContain('Cache: MISS');
      expect(output).not.toContain('⚡');
    });

    it('should include metadata fields', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_File_View',
        reason: 'Reading file',
        duration: 25,
        metadata: {
          lines: '10-50',
          mode: 'structured',
        },
      });

      const output = formatter.format();

      expect(output).toContain('Lines: 10-50');
      expect(output).toContain('Mode: structured');
    });

    it('should show total summary', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Tool1',
        reason: 'First',
        duration: 50,
      });

      formatter.addEntry({
        tool: 'Tool2',
        reason: 'Second',
        duration: 75,
      });

      const output = formatter.format();

      expect(output).toContain('⏱️ **Total**');
      expect(output).toContain('2 tool call(s)');
    });

    it('should show cache efficiency summary', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Tool1',
        reason: 'First',
        duration: 50,
        cacheStatus: 'HIT',
      });

      formatter.addEntry({
        tool: 'Tool2',
        reason: 'Second',
        duration: 100,
        cacheStatus: 'HIT',
      });

      const output = formatter.format();

      expect(output).toContain('💾 **Cache**');
      expect(output).toContain('2 hit(s)');
    });

    it('should truncate output when exceeding maxLength', () => {
      const formatter = new DebugFormatter(Date.now(), 200); // Very small max length

      for (let i = 0; i < 10; i++) {
        formatter.addEntry({
          tool: `Tool${i}`,
          reason: `Reason ${i} with very long text to force truncation`,
          duration: 100,
        });
      }

      const output = formatter.format();

      expect(output).toContain('debug output truncated');
      expect(output.length).toBeLessThanOrEqual(300); // Some buffer for truncation message
    });

    it('should format time correctly', () => {
      const startTime = Date.now() - 65432; // 1 min 5 sec 432 ms ago
      const formatter = new DebugFormatter(startTime);

      // Add entry immediately
      formatter.addEntry({
        tool: 'Test',
        reason: 'Timing test',
        duration: 100,
      });

      const output = formatter.format();

      // Should show MM:SS.mmm format
      expect(output).toMatch(/\[\d{2}:\d{2}\.\d{3}\]/);
    });

    it('should return empty string when no entries', () => {
      const formatter = new DebugFormatter();
      const output = formatter.format();

      expect(output).toBe('');
    });

    it('should track elapsed time', () => {
      const formatter = new DebugFormatter();

      const elapsed = formatter.getElapsedTime();
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(100); // Should be very small
    });

    it('should clear entries and reset start time', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Test',
        reason: 'Before clear',
        duration: 50,
      });

      expect(formatter.getEntryCount()).toBe(1);

      formatter.clear();

      expect(formatter.getEntryCount()).toBe(0);
      expect(formatter.format()).toBe('');
    });

    it('should handle entries with no cache status', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'AHK_Run',
        reason: 'No cache needed',
        duration: 200,
      });

      const output = formatter.format();

      expect(output).not.toContain('Cache:');
      expect(output).toContain('Duration: 200ms');
    });

    it('should capitalize metadata keys', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Test',
        reason: 'Metadata test',
        duration: 10,
        metadata: {
          fileSize: '1024KB',
          encoding: 'utf-8',
        },
      });

      const output = formatter.format();

      expect(output).toContain('FileSize: 1024KB');
      expect(output).toContain('Encoding: utf-8');
    });
  });

  describe('createDebugFormatter', () => {
    it('should create formatter with default maxLength', () => {
      const formatter = createDebugFormatter();

      formatter.addEntry({
        tool: 'Test',
        reason: 'Factory test',
        duration: 10,
      });

      expect(formatter.getEntryCount()).toBe(1);
    });

    it('should create formatter with custom maxLength', () => {
      const formatter = createDebugFormatter(1000);

      // Add many entries
      for (let i = 0; i < 20; i++) {
        formatter.addEntry({
          tool: `Tool${i}`,
          reason: `Long reason text to test truncation at custom length ${i}`,
          duration: i * 10,
        });
      }

      const output = formatter.format();

      // Should truncate at custom length
      expect(output.length).toBeLessThanOrEqual(1100); // Some buffer
    });
  });

  describe('Edge cases', () => {
    it('should handle very large durations', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'SlowTool',
        reason: 'Very slow operation',
        duration: 999999,
      });

      const output = formatter.format();

      expect(output).toContain('999999ms');
    });

    it('should handle zero duration', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'InstantTool',
        reason: 'Instant operation',
        duration: 0,
      });

      const output = formatter.format();

      expect(output).toContain('0ms');
    });

    it('should handle empty reason', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Test',
        reason: '',
        duration: 10,
      });

      const output = formatter.format();

      expect(output).toContain('Reason: ');
    });

    it('should handle very long tool names', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'A'.repeat(100),
        reason: 'Long name test',
        duration: 10,
      });

      const output = formatter.format();

      expect(output).toContain('A'.repeat(100));
    });

    it('should handle special characters in metadata', () => {
      const formatter = new DebugFormatter();

      formatter.addEntry({
        tool: 'Test',
        reason: 'Special chars',
        duration: 10,
        metadata: {
          'special-key': 'value with $pecial ch@rs!',
        },
      });

      const output = formatter.format();

      expect(output).toContain('value with $pecial ch@rs!');
    });
  });
});
