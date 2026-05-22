import { describe, expect, it, beforeEach } from 'vitest';
import { useConnectionStore } from './connectionStore';
import { applyHelperEvent } from './helperEventStream';
import { useHelperStore } from './helperStore';
import { useRuntimeStore } from './runtimeStore';

describe('helper event stream', () => {
  beforeEach(() => {
    useHelperStore.setState({
      scoresByGroup: {},
      activeProbeGroups: [],
      activeProbeNodesByGroup: {}
    });
    useConnectionStore.setState({
      connections: [],
      loading: false,
      error: null
    });
    useRuntimeStore.setState({
      history: [],
      lastUpdatedAt: null
    });
  });

  it('applies probe status and final scores events', () => {
    applyHelperEvent({
      type: 'probeStatus',
      groups: [{ group: 'select', startedAt: '2026-05-21T10:00:00+08:00', activeNodes: ['hk-1'] }]
    });
    applyHelperEvent({
      type: 'probeScores',
      scores: {
        group: 'select',
        mode: 'score',
        scheme: 'Balanced',
        testUrl: 'https://cp.cloudflare.com/generate_204',
        recommended: 'hk-1',
        applyError: null,
        nodes: [
          {
            name: 'hk-1',
            score: 98,
            delayMs: 42,
            components: { latency: 100, availability: 100, jitter: 100, freshness: 100 },
            lastTestedAt: '2026-05-21T10:00:01+08:00',
            error: null
          }
        ]
      }
    });

    expect(useHelperStore.getState().activeProbeGroups).toEqual(['select']);
    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({ select: ['hk-1'] });
    expect(useHelperStore.getState().scoresByGroup.select?.recommended).toBe('hk-1');
  });

  it('applies connection snapshots to the connection store', () => {
    applyHelperEvent({
      type: 'connectionsSnapshot',
      sampledAt: '2026-05-21T10:00:00+08:00',
      snapshot: {
        connections: [
          {
            id: 'conn-1',
            metadata: { host: 'example.com', destinationPort: '443', sourceIP: '127.0.0.1', network: 'tcp' },
            chains: ['proxy-a'],
            rule: 'MATCH',
            upload: 1024,
            download: 2048
          }
        ]
      }
    });

    expect(useConnectionStore.getState().connections[0]).toMatchObject({
      id: 'conn-1',
      target: 'example.com:443',
      outbound: 'proxy-a'
    });
  });

  it('applies traffic snapshots to the runtime store', () => {
    applyHelperEvent({
      type: 'trafficSnapshot',
      up: 1024,
      down: 2048,
      uploadTotal: 4096,
      downloadTotal: 8192,
      connectionCount: 2,
      mode: 'rule',
      sampledAt: '2026-05-21T10:00:01+08:00'
    });

    expect(useRuntimeStore.getState().summary).toMatchObject({
      uploadRate: '1.0 KiB/s',
      downloadRate: '2.0 KiB/s',
      connectionCount: '2',
      mode: 'rule'
    });
    expect(useRuntimeStore.getState().history).toEqual([
      { time: '2026-05-21T10:00:01+08:00', up: 1024, down: 2048, connections: 2 }
    ]);
  });
});
