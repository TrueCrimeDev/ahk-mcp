import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  SmartContextCache,
  OrchestrationContext,
  FileAnalysisResult,
} from '../../src/core/orchestration-context.js';
import { promises as fs } from 'fs';
import path from 'path';

describe('SmartContextCache', () => {
  let cache: SmartContextCache;
  const testFilePath = 'C:\\test\\file.ahk';

  beforeEach(() => {
    cache = new SmartContextCache();
  });

  describe('get and set', () => {
    it('should return null for non-existent file', () => {
      const result = cache.get(testFilePath);
      expect(result).toBeNull();
    });

    it('should store and retrieve context', () => {
      const ctx: OrchestrationContext = {
        filePath: testFilePath,
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      cache.set(testFilePath, ctx);
      const retrieved = cache.get(testFilePath);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.filePath).toBe(testFilePath);
    });

    it('should throw error for invalid file path', () => {
      const ctx: OrchestrationContext = {
        filePath: 'invalid-path',
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      expect(() => cache.set('invalid-path', ctx)).toThrow();
    });
  });

  describe('invalidate', () => {
    it('should remove cached context', () => {
      const ctx: OrchestrationContext = {
        filePath: testFilePath,
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      cache.set(testFilePath, ctx);
      expect(cache.get(testFilePath)).not.toBeNull();

      cache.invalidate(testFilePath);
      expect(cache.get(testFilePath)).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all cached contexts', () => {
      const ctx1: OrchestrationContext = {
        filePath: 'C:\\test\\file1.ahk',
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      const ctx2: OrchestrationContext = {
        filePath: 'C:\\test\\file2.ahk',
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      cache.set('C:\\test\\file1.ahk', ctx1);
      cache.set('C:\\test\\file2.ahk', ctx2);

      const stats = cache.stats();
      expect(stats.size).toBe(2);

      cache.clear();
      expect(cache.stats().size).toBe(0);
    });
  });

  describe('stats', () => {
    it('should track cache hits and misses', () => {
      const ctx: OrchestrationContext = {
        filePath: testFilePath,
        analysisResult: null,
        analysisTimestamp: Date.now(),
        fileModifiedTime: Date.now(),
        operationHistory: [],
      };

      cache.set(testFilePath, ctx);

      cache.get(testFilePath); // Hit
      cache.get('C:\\nonexistent.ahk'); // Miss
      cache.get(testFilePath); // Hit

      const stats = cache.stats();
      expect(stats.size).toBe(1);
      expect(stats.hitRate).toBeGreaterThan(0);
      expect(stats.missRate).toBeGreaterThan(0);
    });
  });
});
