import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useControllerStore } from './controllerStore';
import { useProxyStore } from './proxyStore';

const CONFIGURED_TEST_URL = 'https://latency.example.test/generate_204';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('proxy store latency tests', () => {
  beforeEach(() => {
    useControllerStore.setState({
      config: {
        controllerUrl: 'http://controller.local',
        secret: '',
        defaultTestUrl: CONFIGURED_TEST_URL,
        delayTestConcurrency: 5,
        delayTestTimeoutMs: 10000
      },
      detection: null,
      detecting: false,
      lastCheckedAt: null,
      urlSecretWarning: false
    });
    useProxyStore.setState({
      proxies: [
        { name: 'Auto', type: 'Selector', now: 'hk-1', all: ['hk-1', 'jp-1'], delay: 90 },
        { name: 'hk-1', type: 'Trojan', now: '', all: [], delay: 48 },
        { name: 'jp-1', type: 'Trojan', now: '', all: [], delay: 88 }
      ],
      groupTestUrls: {},
      nodeTestUrls: {},
      groupDelayResults: {},
      optimisticSelections: {},
      switchingGroups: [],
      testingProxies: [],
      testingAllNodes: false,
      loading: false,
      error: null
    });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('tests selector members through their current leaf node with zashboard timeout', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        if (String(input).endsWith('/proxies')) {
          return jsonResponse({ proxies: {} });
        }
        return jsonResponse({ delay: 48 });
      })
    );

    await useProxyStore.getState().testGroupNodes('GLOBAL', ['Auto']);

    expect(urls[0]).toBe(
      `http://controller.local/proxies/hk-1/delay?timeout=10000&url=${encodeURIComponent(CONFIGURED_TEST_URL)}`
    );
  });

  it('refreshes native group latency through zashboard group endpoint first', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(String(input));
        if (String(input).endsWith('/proxies')) {
          return jsonResponse({ proxies: {} });
        }
        return jsonResponse({ 'hk-1': 48 });
      })
    );

    await useProxyStore.getState().testNativeGroupDelay('Auto');

    expect(urls[0]).toBe(
      `http://controller.local/group/Auto/delay?timeout=10000&url=${encodeURIComponent(CONFIGURED_TEST_URL)}`
    );
  });

  it('keeps native group latency scoped to the tested group', async () => {
    const urls: string[] = [];
    useProxyStore.setState({
      proxies: [
        { name: 'Auto', type: 'URLTest', now: 'hk-1', all: ['hk-1', 'jp-1'], delay: 90 },
        { name: 'Other', type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'], delay: 120 },
        { name: 'hk-1', type: 'Trojan', now: '', all: [], delay: 48 },
        { name: 'jp-1', type: 'Trojan', now: '', all: [], delay: 88 }
      ],
      groupDelayResults: { Other: 777 }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/proxies')) {
          return new Response('unexpected full refresh', { status: 500 });
        }
        return jsonResponse({ 'hk-1': 52, 'jp-1': 86 });
      })
    );

    await useProxyStore.getState().testNativeGroupDelay('Auto');

    expect(urls.some((url) => url.endsWith('/proxies'))).toBe(false);
    expect(useProxyStore.getState().groupDelayResults).toEqual({
      Auto: 52,
      Other: 777
    });
    expect(useProxyStore.getState().proxies.find((proxy) => proxy.name === 'Other')?.delay).toBe(120);
  });

  it('updates selected proxy immediately while the controller switch is pending', async () => {
    let resolveSwitch!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/proxies/Auto') && init?.method === 'PUT') {
          return new Promise<Response>((resolve) => {
            resolveSwitch = () => resolve(new Response(null, { status: 204 }));
          });
        }
        if (url.endsWith('/proxies')) {
          return jsonResponse({
            proxies: {
              Auto: { type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'], history: [{ delay: 88 }] },
              'hk-1': { type: 'Trojan', history: [{ delay: 48 }] },
              'jp-1': { type: 'Trojan', history: [{ delay: 88 }] }
            }
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const switchRequest = useProxyStore.getState().switchProxy('Auto', 'jp-1');

    expect(useProxyStore.getState().proxies.find((proxy) => proxy.name === 'Auto')?.now).toBe('jp-1');

    resolveSwitch();
    await switchRequest;
  });

  it('rolls back optimistic selected proxy when controller confirmation times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/proxies/Auto') && init?.method === 'PUT') {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/proxies')) {
          return jsonResponse({
            proxies: {
              Auto: { type: 'Selector', now: 'hk-1', all: ['hk-1', 'jp-1'], history: [{ delay: 48 }] },
              'hk-1': { type: 'Trojan', history: [{ delay: 48 }] },
              'jp-1': { type: 'Trojan', history: [{ delay: 88 }] }
            }
          });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const request = useProxyStore.getState().switchProxy('Auto', 'jp-1');
    await vi.advanceTimersByTimeAsync(5_500);
    await request;

    expect(useProxyStore.getState().proxies.find((proxy) => proxy.name === 'Auto')?.now).toBe('hk-1');
    expect(useProxyStore.getState().switchingGroups).toEqual([]);
    expect(useProxyStore.getState().error).toMatch(/Switch failed for Auto/);
  });

});
