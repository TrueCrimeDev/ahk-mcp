/**
 * Unit tests for VersionManager
 * T013: Unit tests for version manager
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { VersionManager } from '../../src/core/version-manager.js';
import type { SemanticVersion } from '../../src/types/library-types.js';

describe('VersionManager', () => {
  let manager: VersionManager;

  beforeEach(() => {
    manager = new VersionManager();
  });

  /** Parse a version string that the test knows is valid. */
  function semver(version: string): SemanticVersion {
    const parsed = manager.parseVersion(version);
    if (!parsed) throw new Error(`Test setup: invalid version ${version}`);
    return parsed;
  }

  describe('parseVersion', () => {
    it('should parse valid semantic version', () => {
      const version = manager.parseVersion('1.2.3');

      expect(version).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
      });
    });

    it('should reject a leading v (format is strictly MAJOR.MINOR.PATCH)', () => {
      expect(manager.parseVersion('v2.0.1')).toBeNull();
      expect(manager.parseVersion(' 2.0.1 ')).toEqual({ major: 2, minor: 0, patch: 1 });
    });

    it('should parse version with zeros', () => {
      const version = manager.parseVersion('0.0.1');

      expect(version).toEqual({
        major: 0,
        minor: 0,
        patch: 1,
      });
    });

    it('should return null for invalid version (missing parts)', () => {
      expect(manager.parseVersion('1.2')).toBeNull();
      expect(manager.parseVersion('1')).toBeNull();
    });

    it('should return null for invalid version (non-numeric)', () => {
      expect(manager.parseVersion('a.b.c')).toBeNull();
      expect(manager.parseVersion('1.x.3')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(manager.parseVersion('')).toBeNull();
    });
  });

  describe('formatVersion', () => {
    it('should format version correctly', () => {
      const formatted = manager.formatVersion({ major: 1, minor: 2, patch: 3 });

      expect(formatted).toBe('1.2.3');
    });

    it('should handle zeros', () => {
      const formatted = manager.formatVersion({ major: 0, minor: 0, patch: 1 });

      expect(formatted).toBe('0.0.1');
    });
  });

  describe('checkCompatibility', () => {
    it('should detect MAJOR version compatibility', () => {
      const result = manager.checkCompatibility('1.0.0', '1.5.2');

      expect(result.compatible).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });

    it('should warn about MAJOR version breaking changes', () => {
      const result = manager.checkCompatibility('1.0.0', '2.0.0');

      expect(result.compatible).toBe(false);
      expect(result.error).toContain('Breaking change');
      expect(result.details).toContain('breaking');
    });

    it('should handle MINOR version updates', () => {
      const result = manager.checkCompatibility('1.2.0', '1.3.0');

      expect(result.compatible).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });

    it('should handle PATCH version updates', () => {
      const result = manager.checkCompatibility('1.2.3', '1.2.5');

      expect(result.compatible).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });

    it('should handle exact version match', () => {
      const result = manager.checkCompatibility('1.2.3', '1.2.3');

      expect(result.compatible).toBe(true);
      expect(result.details).toBe('Exact version match: v1.2.3');
    });

    it('should warn about unversioned libraries', () => {
      const result = manager.checkCompatibility('1.0.0', 'unversioned');

      expect(result.compatible).toBe(true);
      expect(result.warning).toContain('unversioned');
    });

    it('should handle both unversioned', () => {
      const result = manager.checkCompatibility('unversioned', 'unversioned');

      expect(result.compatible).toBe(true);
      expect(result.warning).toContain('unversioned');
    });
  });

  describe('compareVersions', () => {
    it('should correctly order versions', () => {
      expect(manager.compareVersions(semver('1.0.0'), semver('2.0.0'))).toBeLessThan(0);
      expect(manager.compareVersions(semver('2.0.0'), semver('1.0.0'))).toBeGreaterThan(0);
      expect(manager.compareVersions(semver('1.0.0'), semver('1.0.0'))).toBe(0);
    });

    it('should handle minor version differences', () => {
      expect(manager.compareVersions(semver('1.1.0'), semver('1.2.0'))).toBeLessThan(0);
      expect(manager.compareVersions(semver('1.2.0'), semver('1.1.0'))).toBeGreaterThan(0);
    });

    it('should handle patch version differences', () => {
      expect(manager.compareVersions(semver('1.0.1'), semver('1.0.2'))).toBeLessThan(0);
      expect(manager.compareVersions(semver('1.0.2'), semver('1.0.1'))).toBeGreaterThan(0);
    });
  });
});
