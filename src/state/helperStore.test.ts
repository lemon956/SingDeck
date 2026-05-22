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
      testingSettings: null,
      trafficSettings: null,
      groups: [],
      scoresByGroup: {},
      activeProbeGroups: [],
      activeProbeNodesByGroup: {},
      eventStreamConnected: false,
      loading: false,
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
            minProbeIntervalSec: body.minProbeIntervalSec
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
      minProbeIntervalSec: 60
    });
  });

  it('saves minimum probe interval with testing settings', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    useHelperStore.setState({
      testingSettings: {
        defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
        delayTestTimeoutMs: 8000,
        minProbeIntervalSec: 180
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
      minProbeIntervalSec: 300
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

  it('loads a network usage window from summary, top, and connection endpoints', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/api/v1/network-usage/summary')) {
          return jsonResponse({
            fromMs: 1000,
            toMs: 2000,
            uploadBytes: 512,
            downloadBytes: 2048,
            totalBytes: 2560,
            connectionCount: 2,
            buckets: []
          });
        }
        if (parsed.pathname.endsWith('/api/v1/network-usage/top')) {
          return jsonResponse({
            groupBy: parsed.searchParams.get('groupBy'),
            items: [
              {
                label: parsed.searchParams.get('groupBy') === 'outbound' ? 'proxy-a' : 'example.com',
                uploadBytes: 128,
                downloadBytes: 1024,
                totalBytes: 1152,
                connectionCount: 1
              }
            ]
          });
        }
        if (parsed.pathname.endsWith('/api/v1/network-usage/connections')) {
          return jsonResponse({
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
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    await useHelperStore.getState().loadNetworkUsageWindow({
      from: 1000,
      to: 2000,
      bucket: 'minute',
      limit: 5
    });

    expect(requests.some((url) => url.includes('/api/v1/network-usage/summary'))).toBe(true);
    expect(requests.some((url) => url.includes('groupBy=host'))).toBe(true);
    expect(requests.some((url) => url.includes('groupBy=outbound'))).toBe(true);
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
