import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ClashApiClient } from '../core/clashApi';
import { getDelayTestUrl } from '../core/controller';
import {
  ZASHBOARD_SINGLE_NODE_TIMEOUT_MS,
  buildProxyDelayPath,
  buildProxyGroupDelayPath,
  normalizeProxiesResponse,
  resolveNowProxyName,
  type ProxyRecord,
  type ProxiesResponse
} from '../core/proxies';
import { useControllerStore } from './controllerStore';

type ProxyState = {
  proxies: ProxyRecord[];
  query: string;
  groupTestUrls: Record<string, string>;
  nodeTestUrls: Record<string, string>;
  groupDelayResults: Record<string, number>;
  testingProxies: string[];
  testingAllNodes: boolean;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  setQuery: (query: string) => void;
  setGroupTestUrl: (name: string, url: string) => void;
  setNodeTestUrl: (name: string, url: string) => void;
  refresh: () => Promise<void>;
  switchProxy: (group: string, name: string) => Promise<void>;
  testProxy: (name: string, group?: string, testUrl?: string) => Promise<void>;
  testNativeGroupDelay: (group: string, testUrl?: string) => Promise<void>;
  testAllNodes: (names: string[]) => Promise<void>;
  testGroupNodes: (group: string, names: string[], testUrl?: string) => Promise<void>;
};

export const useProxyStore = create<ProxyState>()(
  persist(
    (set, get) => ({
      proxies: [],
      query: '',
      groupTestUrls: {},
      nodeTestUrls: {},
      groupDelayResults: {},
      testingProxies: [],
      testingAllNodes: false,
      loading: false,
      error: null,
      lastUpdatedAt: null,
      setQuery: (query) => set({ query }),
      setGroupTestUrl: (name, url) =>
        set((state) => ({
          groupTestUrls: { ...state.groupTestUrls, [name]: url }
        })),
      setNodeTestUrl: (name, url) =>
        set((state) => ({
          nodeTestUrls: { ...state.nodeTestUrls, [name]: url }
        })),
      refresh: async () => {
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl) {
          return;
        }

        set({ loading: true, error: null });
        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        try {
          const response = await client.getJson<ProxiesResponse>('/proxies');
          set({
            proxies: normalizeProxiesResponse(response),
            groupDelayResults: {},
            loading: false,
            lastUpdatedAt: new Date().toISOString()
          });
        } catch (error) {
          set({ loading: false, error: error instanceof Error ? error.message : 'Failed to load proxies' });
        }
      },
      switchProxy: async (group, name) => {
        const { config } = useControllerStore.getState();
        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        await client.request(`/proxies/${encodeURIComponent(group)}`, {
          method: 'PUT',
          body: JSON.stringify({ name }),
          headers: { 'content-type': 'application/json' }
        });
        await get().refresh();
      },
      testProxy: async (name, group, testUrl) => {
        const { config } = useControllerStore.getState();
        const state = get();
        const url = getDelayTestUrl({
          nodeUrl: state.nodeTestUrls[name],
          groupUrl: testUrl || (group ? state.groupTestUrls[group] : undefined),
          controllerUrl: config.defaultTestUrl
        });
        const timeout = config.delayTestTimeoutMs ?? ZASHBOARD_SINGLE_NODE_TIMEOUT_MS;
        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        set((current) => ({
          error: null,
          testingProxies: Array.from(new Set([...current.testingProxies, name]))
        }));

        try {
          const target = resolveNowProxyName(name, proxyMapFrom(get().proxies));
          await client.getJson(buildProxyDelayPath(target, { timeout, url }));
          await get().refresh();
        } catch (error) {
          set({ error: `Delay test failed for ${name}: ${formatProxyError(error)}` });
        } finally {
          set((current) => ({
            testingProxies: current.testingProxies.filter((item) => item !== name)
          }));
        }
      },
      testNativeGroupDelay: async (group, testUrl) => {
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl) {
          return;
        }

        const state = get();
        const url = getDelayTestUrl({
          groupUrl: testUrl || state.groupTestUrls[group],
          controllerUrl: config.defaultTestUrl
        });
        const timeout = config.delayTestTimeoutMs ?? ZASHBOARD_SINGLE_NODE_TIMEOUT_MS;
        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        set((current) => ({
          error: null,
          testingProxies: Array.from(new Set([...current.testingProxies, group]))
        }));

        try {
          let response: unknown;
          try {
            response = await client.getJson(buildProxyGroupDelayPath(group, { timeout, url }));
          } catch {
            response = await client.getJson(buildProxyDelayPath(group, { timeout, url }));
          }
          const delay = nativeGroupDelayFromResponse(response, group, get().proxies);
          if (typeof delay === 'number') {
            set((current) => ({
              groupDelayResults: {
                ...current.groupDelayResults,
                [group]: delay
              }
            }));
          }
        } catch (error) {
          set({ error: `Native URLTest refresh failed for ${group}: ${formatProxyError(error)}` });
        } finally {
          set((current) => ({
            testingProxies: current.testingProxies.filter((item) => item !== group)
          }));
        }
      },
      testAllNodes: async (names) => {
        const uniqueNames = Array.from(new Set(names)).filter(Boolean);
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl || uniqueNames.length === 0) {
          return;
        }

        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        const timeout = config.delayTestTimeoutMs ?? ZASHBOARD_SINGLE_NODE_TIMEOUT_MS;
        const failures: string[] = [];
        set((current) => ({
          error: null,
          testingAllNodes: true,
          testingProxies: current.testingProxies
        }));

        await runWithConcurrency(
          uniqueNames,
          config.delayTestConcurrency ?? 4,
          async (name) => {
            const current = get();
            const url = getDelayTestUrl({
              nodeUrl: current.nodeTestUrls[name],
              controllerUrl: config.defaultTestUrl
            });
            const target = resolveNowProxyName(name, proxyMapFrom(current.proxies));

            set((state) => ({
              testingProxies: Array.from(new Set([...state.testingProxies, name]))
            }));

            try {
              await client.getJson(buildProxyDelayPath(target, { timeout, url }));
            } catch (error) {
              failures.push(`${name}: ${formatProxyError(error)}`);
            } finally {
              set((state) => ({
                testingProxies: state.testingProxies.filter((item) => item !== name)
              }));
            }
          }
        );

        await get().refresh();
        set((current) => ({
          testingAllNodes: false,
          testingProxies: current.testingProxies.filter((item) => !uniqueNames.includes(item)),
          error: failures.length > 0 ? `${failures.length} delay tests failed. ${failures.slice(0, 2).join(' / ')}` : null
        }));
      },
      testGroupNodes: async (group, names, testUrl) => {
        const uniqueNames = Array.from(new Set(names)).filter(Boolean);
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl || uniqueNames.length === 0) {
          return;
        }

        const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
        const timeout = config.delayTestTimeoutMs ?? ZASHBOARD_SINGLE_NODE_TIMEOUT_MS;
        const failures: string[] = [];
        set((current) => ({
          error: null,
          testingAllNodes: true,
          testingProxies: current.testingProxies
        }));

        await runWithConcurrency(
          uniqueNames,
          config.delayTestConcurrency ?? 4,
          async (name) => {
            const current = get();
            const url = getDelayTestUrl({
              nodeUrl: current.nodeTestUrls[name],
              groupUrl: testUrl || current.groupTestUrls[group],
              controllerUrl: config.defaultTestUrl
            });
            const target = resolveNowProxyName(name, proxyMapFrom(current.proxies));

            set((state) => ({
              testingProxies: Array.from(new Set([...state.testingProxies, name]))
            }));

            try {
              await client.getJson(buildProxyDelayPath(target, { timeout, url }));
            } catch (error) {
              failures.push(`${name}: ${formatProxyError(error)}`);
            } finally {
              set((state) => ({
                testingProxies: state.testingProxies.filter((item) => item !== name)
              }));
            }
          }
        );

        await get().refresh();
        set((current) => ({
          testingAllNodes: false,
          testingProxies: current.testingProxies.filter((item) => !uniqueNames.includes(item)),
          error: failures.length > 0 ? `${failures.length} delay tests failed. ${failures.slice(0, 2).join(' / ')}` : null
        }));
      }
    }),
    {
      name: 'singdeck-proxy-preferences',
      partialize: (state) => ({
        groupTestUrls: state.groupTestUrls
      })
    }
  )
);

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        await worker(item);
      }
    }
  });

  await Promise.all(workers);
}

function proxyMapFrom(proxies: ProxyRecord[]): Map<string, ProxyRecord> {
  return new Map(proxies.map((proxy) => [proxy.name, proxy]));
}

function nativeGroupDelayFromResponse(response: unknown, group: string, proxies: ProxyRecord[]): number | null {
  if (typeof response === 'number') {
    return response;
  }
  if (!response || typeof response !== 'object') {
    return null;
  }

  const values = response as Record<string, unknown>;
  if (typeof values.delay === 'number') {
    return values.delay;
  }

  const proxyMap = proxyMapFrom(proxies);
  const groupProxy = proxyMap.get(group);
  const candidates = [groupProxy?.now, groupProxy?.now ? resolveNowProxyName(groupProxy.now, proxyMap) : undefined, group]
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (typeof values[candidate] === 'number') {
      return values[candidate] as number;
    }
  }

  const numericValues = Object.values(values).filter((value): value is number => typeof value === 'number');
  return numericValues.length > 0 ? Math.min(...numericValues) : null;
}

function formatProxyError(error: unknown): string {
  if (error instanceof Response) {
    return `HTTP ${error.status}`;
  }

  return error instanceof Error ? error.message : 'unknown error';
}
