import { describe, expect, it } from 'vitest';
import {
  buildNodeSourceTagStyles,
  formatRelativeTime,
  sourceNameHash,
  sourceRestrictionAllowsNode
} from './nodeSources';

describe('nodeSources utilities', () => {
  describe('sourceNameHash and buildNodeSourceTagStyles', () => {
    it('produces deterministic hash for same string', () => {
      const hash1 = sourceNameHash('airport-us');
      const hash2 = sourceNameHash('airport-us');
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe('number');
    });

    it('generates distinctive styles with CSS custom properties', () => {
      const styles = buildNodeSourceTagStyles(['sub-1', 'sub-2', 'sub-1']);
      const sub1Style = styles.get('sub-1') as Record<string, string> | undefined;
      expect(sub1Style).toBeDefined();
      expect(sub1Style?.['--source-color']).toContain('hsl(');
      expect(sub1Style?.['--source-background']).toContain('hsla(');
      expect(sub1Style?.['--source-border']).toContain('hsla(');
    });
  });

  describe('sourceRestrictionAllowsNode', () => {
    const sourceMap = new Map([
      ['hk-01', 'sub-hk'],
      ['us-01', 'sub-us'],
      ['unlabeled-01', '']
    ]);

    it('allows all nodes when restriction is disabled', () => {
      expect(sourceRestrictionAllowsNode('hk-01', false, [], false, sourceMap, false)).toBe(true);
    });

    it('blocks nested proxy groups from direct leaf selection under restriction', () => {
      expect(sourceRestrictionAllowsNode('auto-group', true, ['sub-hk'], true, sourceMap, true)).toBe(false);
    });

    it('allows nodes matching allowed sources set', () => {
      const allowed = new Set(['sub-hk']);
      expect(sourceRestrictionAllowsNode('hk-01', false, allowed, false, sourceMap, true)).toBe(true);
      expect(sourceRestrictionAllowsNode('us-01', false, allowed, false, sourceMap, true)).toBe(false);
    });

    it('handles unlabeled nodes based on allowUnlabeled flag', () => {
      const allowed = new Set(['sub-hk']);
      expect(sourceRestrictionAllowsNode('other-node', false, allowed, true, sourceMap, true)).toBe(true);
      expect(sourceRestrictionAllowsNode('other-node', false, allowed, false, sourceMap, true)).toBe(false);
    });
  });

  describe('formatRelativeTime', () => {
    const baseNow = new Date('2026-08-28T12:00:00Z');

    it('returns -- for invalid or null time', () => {
      expect(formatRelativeTime(null)).toBe('--');
      expect(formatRelativeTime(undefined)).toBe('--');
      expect(formatRelativeTime('invalid-time')).toBe('--');
    });

    it('returns 刚刚 for timestamps within 45 seconds', () => {
      const recent = new Date(baseNow.getTime() - 20 * 1000).toISOString();
      expect(formatRelativeTime(recent, baseNow)).toBe('刚刚');
    });

    it('formats minutes, hours, and days correctly', () => {
      const fiveMinAgo = new Date(baseNow.getTime() - 5 * 60 * 1000).toISOString();
      expect(formatRelativeTime(fiveMinAgo, baseNow)).toBe('5 分钟前');

      const twoHoursAgo = new Date(baseNow.getTime() - 2 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(twoHoursAgo, baseNow)).toBe('2 小时前');

      const threeDaysAgo = new Date(baseNow.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatRelativeTime(threeDaysAgo, baseNow)).toBe('3 天前');
    });
  });
});
