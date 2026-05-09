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
            delayTestTimeoutMs: body.delayTestTimeoutMs
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
      delayTestTimeoutMs: 10000
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
