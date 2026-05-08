import { describe, expect, it } from 'vitest';
import { formatBytes, formatRate, parseTrafficChunk, summarizeRuntime } from './runtime';

describe('runtime formatting', () => {
  it('formats byte totals and rates for dashboard cards', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatRate(2048)).toBe('2.0 KiB/s');
  });
});

describe('runtime summary', () => {
  it('combines traffic and connection counts into display metrics', () => {
    expect(
      summarizeRuntime({
        traffic: { up: 2048, down: 4096 },
        totals: { uploadTotal: 1_048_576, downloadTotal: 2_097_152 },
        connectionCount: 7,
        mode: 'rule'
      })
    ).toEqual({
      uploadRate: '2.0 KiB/s',
      downloadRate: '4.0 KiB/s',
      uploadTotal: '1.0 MiB',
      downloadTotal: '2.0 MiB',
      connectionCount: '7',
      mode: 'rule'
    });
  });
});

describe('traffic stream parsing', () => {
  it('parses the first streamed traffic object', () => {
    expect(parseTrafficChunk('{"up":2544,"down":18844}\n')).toEqual({ up: 2544, down: 18844 });
  });
});
