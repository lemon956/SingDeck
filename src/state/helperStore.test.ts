import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useControllerStore } from './controllerStore';
import { useHelperStore } from './helperStore';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('helper store', () => {
  beforeEach(() => {
    useHelperStore.setState({
      helperUrl: 'http://helper.local',
      configPath: '',
      health: null,
      testingSettings: null,
      trafficSettings: null,
      toolsSettings: null,
      networkUsageSettings: null,
      groups: [],
      nodeSources: [],
      scoresByGroup: {},
      activeProbeGroups: [],
      activeProbeNodesByGroup: {},
      eventStreamConnected: false,
      loading: false,
      lastSyncedControllerKey: null,
      error: null
    });
    useControllerStore.setState({
      config: {
        controllerUrl: 'http://controller.local',
        secret: '',
        defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
        delayTestConcurrency: 4,
        delayTestTimeoutMs: 10000
      },
      detection: null,
      detecting: false,
      lastCheckedAt: null,
      urlSecretWarning: false
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preloads scores for every group when loading strategy groups', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/groups')) {
        return jsonResponse({
          groups: [
            {
              name: 'GLOBAL',
              kind: 'Selector',
              now: 'hk-1',
              all: ['hk-1', 'jp-1'],
              config: {
                testUrl: 'https://cp.cloudflare.com/generate_204',
                testUrlOverridden: false,
                mode: 'score',
                scheme: 'Balanced',
                autoSwitch: true,
                autoProbe: true,
                probeIntervalSec: 60
              },
              recommended: 'hk-1',
              applyError: null
            },
            {
              name: 'download',
              kind: 'URLTest',
              now: 'jp-1',
              all: ['hk-1', 'jp-1'],
              config: {
                testUrl: 'https://cp.cloudflare.com/generate_204',
                testUrlOverridden: false,
                mode: 'delay',
                scheme: 'Balanced',
                autoSwitch: false,
                autoProbe: true,
                probeIntervalSec: 60
              },
              recommended: 'jp-1',
              applyError: null
            }
          ]
        });
      }

      if (url.endsWith('/api/v1/groups/GLOBAL/scores')) {
        return jsonResponse({
          group: 'GLOBAL',
          mode: 'score',
          scheme: 'Balanced',
          testUrl: 'https://cp.cloudflare.com/generate_204',
          recommended: 'hk-1',
          applyError: null,
          nodes: [{ name: 'hk-1', score: 91, delayMs: 48, components: {}, lastTestedAt: null, error: null }]
        });
      }

      if (url.endsWith('/api/v1/groups/download/scores')) {
        return jsonResponse({
          group: 'download',
          mode: 'delay',
          scheme: 'Balanced',
          testUrl: 'https://cp.cloudflare.com/generate_204',
          recommended: 'jp-1',
          applyError: null,
          nodes: [{ name: 'jp-1', score: 80, delayMs: 70, components: {}, lastTestedAt: null, error: null }]
        });
      }

      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await useHelperStore.getState().loadGroups();

    expect(useHelperStore.getState().groups.map((group) => group.name)).toEqual(['GLOBAL', 'download']);
    expect(Object.keys(useHelperStore.getState().scoresByGroup).sort()).toEqual(['GLOBAL', 'download']);
  });

  it('loads node sources from the helper API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/node-sources')) {
          return jsonResponse({
            sources: [
              {
                name: 'bing-us',
                url: 'https://example.com/sub',
                associate: true,
                lastSyncedAt: '2026-05-25T10:00:00+08:00',
                lastError: null,
                nodeCount: 2,
                nodes: ['us-1', 'us-2']
              }
            ]
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().loadNodeSources();

    expect(useHelperStore.getState().nodeSources.map((source) => source.name)).toEqual(['bing-us']);
  });

  it('keeps previous scores visible while strategy groups refresh', async () => {
    let resolveGroups!: () => void;
    useHelperStore.setState({
      scoresByGroup: {
        GLOBAL: {
          group: 'GLOBAL',
          mode: 'score',
          scheme: 'Balanced',
          testUrl: 'https://cp.cloudflare.com/generate_204',
          recommended: 'hk-1',
          applyError: null,
          nodes: [
            {
              name: 'hk-1',
              score: 88,
              delayMs: 58,
              components: { latency: 88, availability: 100, jitter: 80, freshness: 100 },
              lastTestedAt: null,
              error: null
            }
          ]
        }
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/groups')) {
          return new Promise<Response>((resolve) => {
            resolveGroups = () => resolve(jsonResponse({ groups: [] }));
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const refresh = useHelperStore.getState().loadGroups();

    expect(useHelperStore.getState().loading).toBe(false);
    expect(useHelperStore.getState().scoresByGroup.GLOBAL?.nodes[0].score).toBe(88);

    resolveGroups();
    await refresh;
  });

  it('keeps existing scores when a score preload fails', async () => {
    useHelperStore.setState({
      scoresByGroup: {
        GLOBAL: {
          group: 'GLOBAL',
          mode: 'score',
          scheme: 'Balanced',
          testUrl: 'https://cp.cloudflare.com/generate_204',
          recommended: 'hk-1',
          applyError: null,
          nodes: [
            {
              name: 'hk-1',
              score: 88,
              delayMs: 58,
              components: { latency: 88, availability: 100, jitter: 80, freshness: 100 },
              lastTestedAt: null,
              error: null
            }
          ]
        }
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/groups')) {
          return jsonResponse({
            groups: [
              {
                name: 'GLOBAL',
                kind: 'Selector',
                now: 'hk-1',
                all: ['hk-1'],
                config: {
                  testUrl: 'https://cp.cloudflare.com/generate_204',
                  testUrlOverridden: false,
                  mode: 'score',
                  scheme: 'Balanced',
                  autoSwitch: true,
                  autoProbe: true,
                  probeIntervalSec: 60
                },
                recommended: 'hk-1',
                applyError: null
              }
            ]
          });
        }
        if (url.endsWith('/api/v1/groups/GLOBAL/scores')) {
          return new Response('temporary score failure', { status: 503 });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().loadGroups();

    expect(useHelperStore.getState().groups.map((group) => group.name)).toEqual(['GLOBAL']);
    expect(useHelperStore.getState().scoresByGroup.GLOBAL?.nodes[0].score).toBe(88);
  });

  it('keeps strategy groups as an array when the helper returns a malformed group payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/groups')) {
          return jsonResponse({ nodes: [] });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().loadGroups();

    expect(useHelperStore.getState().groups).toEqual([]);
  });

  it('loads active helper probe groups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/probes')) {
          return jsonResponse({
            groups: [
              { group: 'select', startedAt: '2026-05-14T08:00:00.000Z', activeNodes: ['hk-1', 'jp-1'] },
              { group: 'download', startedAt: '2026-05-14T08:00:02.000Z', activeNodes: ['sg-1'] }
            ]
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await (useHelperStore.getState() as unknown as { loadActiveProbes: () => Promise<void> }).loadActiveProbes();

    expect((useHelperStore.getState() as unknown as { activeProbeGroups: string[] }).activeProbeGroups).toEqual([
      'select',
      'download'
    ]);
    expect(
      (useHelperStore.getState() as unknown as { activeProbeNodesByGroup: Record<string, string[]> })
        .activeProbeNodesByGroup
    ).toEqual({
      select: ['hk-1', 'jp-1'],
      download: ['sg-1']
    });
  });

  it('clears stale helper health and active probes when health check fails', async () => {
    useHelperStore.setState({
      health: {
        ok: true,
        version: '0.1.0',
        sqlite: true,
        controllerConfigured: true,
        controllerReachable: true,
        mobileConfigUrl: null,
        error: null
      },
      activeProbeGroups: ['select'],
      activeProbeNodesByGroup: { select: ['hk-1'] },
      eventStreamConnected: true
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('helper down', { status: 503 })));

    await useHelperStore.getState().checkHealth();

    expect(useHelperStore.getState().health).toBeNull();
    expect(useHelperStore.getState().activeProbeGroups).toEqual([]);
    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({});
    expect(useHelperStore.getState().eventStreamConnected).toBe(false);
  });

  it('marks helper ready as soon as health returns while settings are still loading', async () => {
    let resolveTestingSettings!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/health')) {
          return jsonResponse({
            ok: true,
            version: '0.1.0',
            sqlite: true,
            controllerConfigured: true,
            controllerReachable: true,
            mobileConfigUrl: null,
            error: null
          });
        }
        if (url.endsWith('/api/v1/settings/testing')) {
          await new Promise<void>((resolve) => {
            resolveTestingSettings = resolve;
          });
          return jsonResponse({
            defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
            delayTestTimeoutMs: 5000,
            minProbeIntervalSec: 60,
            probeConcurrency: 4
          });
        }
        if (url.endsWith('/api/v1/settings/traffic')) {
          return jsonResponse({ enabled: false, browserProfile: '' });
        }
        if (url.endsWith('/api/v1/settings/network-usage')) {
          return jsonResponse({ enabled: false, retentionDays: 7 });
        }
        if (url.endsWith('/api/v1/settings/tools')) {
          return jsonResponse({ proxyUrl: '', timeoutMs: 30000 });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const healthCheck = useHelperStore.getState().checkHealth();
    await vi.waitFor(() => expect(useHelperStore.getState().health?.ok).toBe(true));
    expect(useHelperStore.getState().loading).toBe(false);

    resolveTestingSettings();
    await healthCheck;
  });

  it('clears active probe state when polling active probes fails', async () => {
    useHelperStore.setState({
      activeProbeGroups: ['select'],
      activeProbeNodesByGroup: { select: ['hk-1'] },
      eventStreamConnected: true
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('temporary helper failure', { status: 503 })));

    await useHelperStore.getState().loadActiveProbes();

    expect(useHelperStore.getState().activeProbeGroups).toEqual([]);
    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({});
    expect(useHelperStore.getState().eventStreamConnected).toBe(false);
  });

  it('skips duplicate controller sync unless forced', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT' && url.endsWith('/api/v1/controller')) {
          requests.push('put-controller');
          return jsonResponse({ controllerUrl: 'http://controller.local', secret: '' });
        }
        if (url.endsWith('/api/v1/health')) {
          return jsonResponse({
            ok: true,
            version: '0.1.0',
            sqlite: true,
            controllerConfigured: true,
            controllerReachable: true,
            mobileConfigUrl: null,
            error: null
          });
        }
        if (url.endsWith('/api/v1/settings/testing')) {
          return jsonResponse({
            defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
            delayTestTimeoutMs: 10000,
            minProbeIntervalSec: 60,
            probeConcurrency: 4
          });
        }
        if (url.endsWith('/api/v1/settings/traffic')) {
          return jsonResponse({ enabled: false, browserProfile: '' });
        }
        if (url.endsWith('/api/v1/settings/network-usage')) {
          return jsonResponse({ enabled: false, retentionDays: 7 });
        }
        if (url.endsWith('/api/v1/settings/tools')) {
          return jsonResponse({ proxyUrl: '', timeoutMs: 30000 });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().syncController();
    await useHelperStore.getState().syncController();
    await useHelperStore.getState().syncController({ force: true });

    expect(requests).toEqual(['put-controller', 'put-controller']);
  });

  it('checks helper health when duplicate controller sync is skipped with unknown health', async () => {
    const requests: string[] = [];
    useHelperStore.setState({
      health: null,
      lastSyncedControllerKey: 'http://controller.local\n'
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT' && url.endsWith('/api/v1/controller')) {
          requests.push('put-controller');
          return jsonResponse({ controllerUrl: 'http://controller.local', secret: '' });
        }
        if (url.endsWith('/api/v1/health')) {
          requests.push('health');
          return jsonResponse({
            ok: true,
            version: '0.1.0',
            sqlite: true,
            controllerConfigured: true,
            controllerReachable: true,
            mobileConfigUrl: null,
            error: null
          });
        }
        if (url.endsWith('/api/v1/settings/testing')) {
          requests.push('testing');
          return jsonResponse({
            defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
            delayTestTimeoutMs: 10000,
            minProbeIntervalSec: 60,
            probeConcurrency: 4
          });
        }
        if (url.endsWith('/api/v1/settings/traffic')) {
          requests.push('traffic');
          return jsonResponse({ enabled: false, browserProfile: '' });
        }
        if (url.endsWith('/api/v1/settings/network-usage')) {
          requests.push('network-usage');
          return jsonResponse({ enabled: false, retentionDays: 7 });
        }
        if (url.endsWith('/api/v1/settings/tools')) {
          requests.push('tools');
          return jsonResponse({ proxyUrl: '', timeoutMs: 30000 });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().syncController();

    expect(requests).toEqual(['health', 'testing', 'traffic', 'network-usage', 'tools']);
    expect(useHelperStore.getState().health?.ok).toBe(true);
  });

  it('clears helper readiness when the helper URL changes', () => {
    useHelperStore.setState({
      health: {
        ok: true,
        version: '0.1.0',
        sqlite: true,
        controllerConfigured: true,
        controllerReachable: true,
        mobileConfigUrl: null,
        error: null
      },
      activeProbeGroups: ['select'],
      activeProbeNodesByGroup: { select: ['hk-1'] },
      eventStreamConnected: true,
      error: 'old helper error',
      lastCheckedAt: new Date().toISOString(),
      lastSyncedControllerKey: 'http://controller.local\n'
    });

    useHelperStore.getState().updateSettings({ helperUrl: 'http://new-helper.local' });

    expect(useHelperStore.getState().health).toBeNull();
    expect(useHelperStore.getState().activeProbeGroups).toEqual([]);
    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({});
    expect(useHelperStore.getState().eventStreamConnected).toBe(false);
    expect(useHelperStore.getState().error).toBeNull();
    expect(useHelperStore.getState().lastCheckedAt).toBeNull();
    expect(useHelperStore.getState().lastSyncedControllerKey).toBeNull();
  });

  it('polls active probe nodes while a manual group probe is pending', async () => {
    vi.useFakeTimers();
    let probeFinished = false;
    let resolveProbe!: () => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/groups/select/probe')) {
        return new Promise<Response>((resolve) => {
          resolveProbe = () => {
            probeFinished = true;
            resolve(
              jsonResponse({
                group: 'select',
                mode: 'score',
                scheme: 'Balanced',
                testUrl: 'https://cp.cloudflare.com/generate_204',
                recommended: 'jp-1',
                applyError: null,
                nodes: []
              })
            );
          };
        });
      }
      if (url.endsWith('/api/v1/probes')) {
        return jsonResponse({
          groups: probeFinished
            ? []
            : [{ group: 'select', startedAt: '2026-05-14T08:00:00.000Z', activeNodes: ['jp-1'] }]
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const probe = useHelperStore.getState().probeGroup('select', 2);

    await vi.advanceTimersByTimeAsync(200);

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v1/probes'))).toBe(true);
    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({ select: ['jp-1'] });

    resolveProbe();
    await probe;

    expect(useHelperStore.getState().activeProbeNodesByGroup).toEqual({});
    vi.useRealTimers();
  });

  it('does not short-poll active probe nodes while the helper event stream is connected', async () => {
    vi.useFakeTimers();
    let resolveProbe!: () => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v1/groups/select/probe')) {
        return new Promise<Response>((resolve) => {
          resolveProbe = () =>
            resolve(
              jsonResponse({
                group: 'select',
                mode: 'score',
                scheme: 'Balanced',
                testUrl: 'https://cp.cloudflare.com/generate_204',
                recommended: null,
                applyError: null,
                nodes: []
              })
            );
        });
      }
      if (url.endsWith('/api/v1/probes')) {
        return jsonResponse({ groups: [] });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    useHelperStore.setState({ eventStreamConnected: true });

    const probe = useHelperStore.getState().probeGroup('select', 2);

    await vi.advanceTimersByTimeAsync(300);

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v1/probes'))).toBe(false);

    resolveProbe();
    await probe;
    vi.useRealTimers();
  });

  it('saves default test URL without dropping the configured timeout', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/settings/testing')) {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ url, body });
          return jsonResponse({
            defaultTestUrl: body.defaultTestUrl,
            delayTestTimeoutMs: body.delayTestTimeoutMs,
            minProbeIntervalSec: body.minProbeIntervalSec,
            probeConcurrency: body.probeConcurrency
          });
        }
        if (url.endsWith('/api/v1/groups')) {
          return jsonResponse({ groups: [] });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().saveDefaultTestUrl('https://api.openai.com');

    expect(requests[0].body).toEqual({
      defaultTestUrl: 'https://api.openai.com',
      delayTestTimeoutMs: 10000,
      minProbeIntervalSec: 60,
      probeConcurrency: 4
    });
  });

  it('saves minimum probe interval with testing settings', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    useControllerStore.setState((state) => ({
      config: {
        ...state.config,
        delayTestConcurrency: 6
      }
    }));
    useHelperStore.setState({
      testingSettings: {
        defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
        delayTestTimeoutMs: 8000,
        minProbeIntervalSec: 180,
        probeConcurrency: 6
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/settings/testing')) {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ url, body });
          return jsonResponse(body);
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().saveMinProbeInterval(300);

    expect(requests[0].body).toEqual({
      defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
      delayTestTimeoutMs: 8000,
      minProbeIntervalSec: 300,
      probeConcurrency: 6
    });
  });

  it('saves provider traffic settings through the helper API', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/settings/traffic')) {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ url, body });
          return jsonResponse(body);
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().saveTrafficSettings({
      enabled: true,
      browserProfile: '/home/alice/.config/google-chrome/Default'
    });

    expect(requests[0].body).toEqual({
      enabled: true,
      browserProfile: '/home/alice/.config/google-chrome/Default'
    });
    expect(useHelperStore.getState().trafficSettings).toEqual({
      enabled: true,
      browserProfile: '/home/alice/.config/google-chrome/Default'
    });
  });

  it('syncs provider traffic immediately after enabling the module', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/api/v1/settings/traffic')) {
          return jsonResponse(JSON.parse(String(init?.body)));
        }
        if (url.endsWith('/api/v1/traffic')) {
          return jsonResponse({
            providers: [
              {
                id: 'haita',
                name: 'Haita',
                homepage: 'https://haita.io/dashboard',
                planName: null,
                usedUploadBytes: null,
                usedDownloadBytes: null,
                usedTotalBytes: null,
                totalBytes: null,
                remainingBytes: null,
                usedRatio: null,
                expireAt: null,
                resetDay: null,
                fetchedAt: '2026-05-09T15:30:00+08:00',
                error: 'cookie missing'
              }
            ],
            updatedAt: '2026-05-09T15:30:00+08:00',
            profile: '/home/alice/.config/google-chrome/Default'
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().saveTrafficSettings({
      enabled: true,
      browserProfile: '/home/alice/.config/google-chrome/Default'
    });

    expect(requests.some((url) => url.endsWith('/api/v1/traffic'))).toBe(true);
    expect(useHelperStore.getState().traffic?.providers[0]?.name).toBe('Haita');
  });

  it('saves network usage settings through the helper API', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/settings/network-usage')) {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ url, body });
          return jsonResponse(body);
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().saveNetworkUsageSettings({
      enabled: true,
      retentionDays: 7
    });

    expect(requests[0].body).toEqual({
      enabled: true,
      retentionDays: 7
    });
    expect(useHelperStore.getState().networkUsageSettings).toEqual({
      enabled: true,
      retentionDays: 7
    });
  });

  it('loads a network usage window through the aggregate endpoint while keeping stale data visible', async () => {
    const requests: string[] = [];
    useHelperStore.setState({
      networkUsageSummary: {
        fromMs: 0,
        toMs: 500,
        uploadBytes: 1,
        downloadBytes: 2,
        totalBytes: 3,
        connectionCount: 1,
        buckets: []
      },
      networkUsageTopHosts: { groupBy: 'host', items: [] },
      networkUsageTopOutbounds: { groupBy: 'outbound', items: [] },
      networkUsageConnections: { connections: [] }
    });
    let resolveWindow!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/api/v1/network-usage/window')) {
          await new Promise<void>((resolve) => {
            resolveWindow = resolve;
          });
          return jsonResponse({
            summary: {
              fromMs: 1000,
              toMs: 2000,
              uploadBytes: 512,
              downloadBytes: 2048,
              totalBytes: 2560,
              connectionCount: 2,
              buckets: []
            },
            topHosts: {
              groupBy: 'host',
              items: [
                {
                  label: 'example.com',
                  uploadBytes: 128,
                  downloadBytes: 1024,
                  totalBytes: 1152,
                  connectionCount: 1
                }
              ]
            },
            topOutbounds: {
              groupBy: 'outbound',
              items: [
                {
                  label: 'proxy-a',
                  uploadBytes: 128,
                  downloadBytes: 1024,
                  totalBytes: 1152,
                  connectionCount: 1
                }
              ]
            },
            connections: {
              connections: [
                {
                  id: 'conn-1',
                  host: 'example.com',
                  network: 'tcp',
                  rule: 'DOMAIN example.com',
                  outbound: 'proxy-a',
                  chains: ['proxy-a'],
                  firstSeenMs: 1000,
                  lastSeenMs: 2000,
                  uploadBytes: 128,
                  downloadBytes: 1024,
                  totalBytes: 1152
                }
              ]
            }
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const request = useHelperStore.getState().loadNetworkUsageWindow({
      from: 1000,
      to: 2000,
      bucket: 'minute',
      limit: 5
    });

    expect(useHelperStore.getState().networkUsageLoading).toBe(true);
    expect(useHelperStore.getState().networkUsageSummary?.totalBytes).toBe(3);
    resolveWindow();
    await request;

    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/api/v1/network-usage/window');
    expect(requests[0]).toContain('limit=5');
    expect(useHelperStore.getState().networkUsageSummary?.totalBytes).toBe(2560);
    expect(useHelperStore.getState().networkUsageTopHosts?.items[0]?.label).toBe('example.com');
    expect(useHelperStore.getState().networkUsageTopOutbounds?.items[0]?.label).toBe('proxy-a');
    expect(useHelperStore.getState().networkUsageConnections?.connections[0]?.host).toBe('example.com');
  });

  it('saves config path through the helper API', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/config/source')) {
          const body = init?.body ? JSON.parse(String(init.body)) : null;
          requests.push({ url, body });
          return jsonResponse(body);
        }
        return new Response('not found', { status: 404 });
      })
    );

    useHelperStore.getState().updateSettings({ configPath: ' /opt/sing-box/config.jsonc ' });

    await useHelperStore.getState().saveConfigPath();

    expect(requests[0].body).toEqual({ path: '/opt/sing-box/config.jsonc' });
    expect(useHelperStore.getState().configPath).toBe('/opt/sing-box/config.jsonc');
    expect(useHelperStore.getState().error).toBeNull();
  });
});
