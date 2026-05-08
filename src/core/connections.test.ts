import { describe, expect, it } from 'vitest';
import { normalizeConnectionsResponse, normalizeLogLine, parseLogChunk } from './connections';

describe('connections', () => {
  it('normalizes Clash connection records for filtering and display', () => {
    const connections = normalizeConnectionsResponse({
      connections: [
        {
          id: 'a',
          metadata: {
            host: 'example.com',
            destinationIP: '93.184.216.34',
            destinationPort: '443',
            sourceIP: '10.0.0.55',
            network: 'tcp'
          },
          chains: ['hk-1', 'Proxy'],
          rule: 'DOMAIN-SUFFIX',
          rulePayload: 'example.com',
          upload: 1024,
          download: 2048
        }
      ]
    });

    expect(connections).toEqual([
      expect.objectContaining({
        id: 'a',
        source: '10.0.0.55',
        target: 'example.com:443',
        outbound: 'hk-1',
        rule: 'DOMAIN-SUFFIX example.com'
      })
    ]);
  });
});

describe('logs', () => {
  it('normalizes log payloads and plain text lines', () => {
    expect(normalizeLogLine('warn: dns timeout')).toEqual({
      level: 'warn',
      message: 'warn: dns timeout'
    });

    expect(normalizeLogLine({ type: 'info', payload: 'proxy selected' })).toEqual({
      level: 'info',
      message: 'proxy selected'
    });
  });

  it('parses newline-delimited log stream chunks', () => {
    expect(parseLogChunk('{"type":"info","payload":"one"}\n{"type":"warn","payload":"two"}\n')).toEqual([
      { type: 'info', payload: 'one' },
      { type: 'warn', payload: 'two' }
    ]);
  });
});
