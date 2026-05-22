import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_HELPER_URL,
  HelperApiClient,
  type HelperConfigResponse,
  type HelperConfigSource,
  type HelperGroup,
  type HelperGroupConfig,
  type HelperGroupsResponse,
  type HelperHealth,
  type HelperNetworkUsageConnections,
  type HelperNetworkUsageSettings,
  type HelperNetworkUsageSummary,
  type HelperNetworkUsageTop,
  type HelperNetworkUsageWindowRequest,
  type HelperProbeStatusResponse,
  type HelperScoresResponse,
  type HelperTestingSettings,
  type HelperTrafficSettings,
  type HelperTrafficResponse
} from '../core/helperApi';
import { useControllerStore } from './controllerStore';

const ACTIVE_PROBE_POLL_INTERVAL_MS = 120;

type HelperState = {
  helperUrl: string;
  configPath: string;
  health: HelperHealth | null;
  testingSettings: HelperTestingSettings | null;
  trafficSettings: HelperTrafficSettings | null;
  networkUsageSettings: HelperNetworkUsageSettings | null;
  groups: HelperGroup[];
  scoresByGroup: Record<string, HelperScoresResponse>;
  activeProbeGroups: string[];
  activeProbeNodesByGroup: Record<string, string[]>;
  traffic: HelperTrafficResponse | null;
  trafficLoading: boolean;
  trafficError: string | null;
  networkUsageSummary: HelperNetworkUsageSummary | null;
  networkUsageTopHosts: HelperNetworkUsageTop | null;
  networkUsageTopOutbounds: HelperNetworkUsageTop | null;
  networkUsageConnections: HelperNetworkUsageConnections | null;
  networkUsageLoading: boolean;
  networkUsageError: string | null;
  eventStreamConnected: boolean;
  loading: boolean;
  probingGroups: string[];
  applyingGroups: string[];
  error: string | null;
  lastCheckedAt: string | null;
  updateSettings: (settings: Partial<Pick<HelperState, 'helperUrl' | 'configPath'>>) => void;
  checkHealth: () => Promise<void>;
  syncController: () => Promise<void>;
  loadTestingSettings: () => Promise<void>;
  loadTrafficSettings: () => Promise<void>;
  loadNetworkUsageSettings: () => Promise<void>;
  saveDefaultTestUrl: (defaultTestUrl: string) => Promise<void>;
  saveDelayTestTimeout: (delayTestTimeoutMs: number) => Promise<void>;
  saveConfigPath: () => Promise<void>;
  saveTrafficSettings: (settings: HelperTrafficSettings) => Promise<void>;
  saveNetworkUsageSettings: (settings: HelperNetworkUsageSettings) => Promise<void>;
  loadGroups: () => Promise<void>;
  loadActiveProbes: () => Promise<void>;
  setEventStreamConnected: (connected: boolean) => void;
  saveGroupConfig: (group: string, config: HelperGroupConfig) => Promise<void>;
  probeGroup: (group: string, concurrency: number) => Promise<void>;
  loadScores: (group: string) => Promise<void>;
  applyNode: (group: string, node?: string) => Promise<void>;
  loadHelperConfigContent: () => Promise<HelperConfigResponse>;
  loadTraffic: () => Promise<void>;
  loadNetworkUsageWindow: (request: HelperNetworkUsageWindowRequest) => Promise<void>;
};

export const useHelperStore = create<HelperState>()(
  persist(
    (set, get) => ({
      helperUrl: DEFAULT_HELPER_URL,
      configPath: '',
      health: null,
      testingSettings: null,
      trafficSettings: null,
      networkUsageSettings: null,
      groups: [],
      scoresByGroup: {},
      activeProbeGroups: [],
      activeProbeNodesByGroup: {},
      traffic: null,
      trafficLoading: false,
      trafficError: null,
      networkUsageSummary: null,
      networkUsageTopHosts: null,
      networkUsageTopOutbounds: null,
      networkUsageConnections: null,
      networkUsageLoading: false,
      networkUsageError: null,
      eventStreamConnected: false,
      loading: false,
      probingGroups: [],
      applyingGroups: [],
      error: null,
      lastCheckedAt: null,
      updateSettings: (settings) =>
        set((state) => ({
          helperUrl: settings.helperUrl === undefined ? state.helperUrl : settings.helperUrl,
          configPath: settings.configPath === undefined ? state.configPath : settings.configPath
        })),
      checkHealth: async () => {
        set({ loading: true, error: null });
        try {
          const health = await client().getJson<HelperHealth>('/api/v1/health');
          const testingSettings = await client().getJson<HelperTestingSettings>('/api/v1/settings/testing');
          const trafficSettings = await client().getJson<HelperTrafficSettings>('/api/v1/settings/traffic');
          const networkUsageSettings = await client().getJson<HelperNetworkUsageSettings>(
            '/api/v1/settings/network-usage'
          );
          set({
            health,
            testingSettings,
            trafficSettings,
            networkUsageSettings,
            loading: false,
            lastCheckedAt: new Date().toISOString(),
            error: health.error
          });
        } catch (error) {
          set({ loading: false, error: formatHelperError(error), lastCheckedAt: new Date().toISOString() });
        }
      },
      syncController: async () => {
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl) {
          set({ error: 'Controller URL is empty.' });
          return;
        }

        set({ loading: true, error: null });
        try {
          await client().putJson('/api/v1/controller', {
            controllerUrl: config.controllerUrl,
            secret: config.secret
          });
          const health = await client().getJson<HelperHealth>('/api/v1/health');
          const testingSettings = await client().getJson<HelperTestingSettings>('/api/v1/settings/testing');
          const trafficSettings = await client().getJson<HelperTrafficSettings>('/api/v1/settings/traffic');
          const networkUsageSettings = await client().getJson<HelperNetworkUsageSettings>(
            '/api/v1/settings/network-usage'
          );
          set({
            health,
            testingSettings,
            trafficSettings,
            networkUsageSettings,
            loading: false,
            lastCheckedAt: new Date().toISOString(),
            error: health.error
          });
        } catch (error) {
          set({ loading: false, error: formatHelperError(error), lastCheckedAt: new Date().toISOString() });
        }
      },
      loadTestingSettings: async () => {
        try {
          const testingSettings = await client().getJson<HelperTestingSettings>('/api/v1/settings/testing');
          set({ testingSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      loadTrafficSettings: async () => {
        try {
          const trafficSettings = await client().getJson<HelperTrafficSettings>('/api/v1/settings/traffic');
          set({ trafficSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      loadNetworkUsageSettings: async () => {
        try {
          const networkUsageSettings = await client().getJson<HelperNetworkUsageSettings>(
            '/api/v1/settings/network-usage'
          );
          set({ networkUsageSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveDefaultTestUrl: async (defaultTestUrl) => {
        try {
          const { config } = useControllerStore.getState();
          const delayTestTimeoutMs =
            get().testingSettings?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? 5000;
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', {
            defaultTestUrl,
            delayTestTimeoutMs
          });
          set({ testingSettings, error: null });
          await get().loadGroups();
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveDelayTestTimeout: async (delayTestTimeoutMs) => {
        try {
          const { config } = useControllerStore.getState();
          const defaultTestUrl = get().testingSettings?.defaultTestUrl ?? config.defaultTestUrl;
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', {
            defaultTestUrl,
            delayTestTimeoutMs
          });
          set({ testingSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveConfigPath: async () => {
        try {
          const response = await client().putJson<HelperConfigSource>('/api/v1/config/source', {
            path: get().configPath.trim()
          });
          set({ configPath: response.path, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveTrafficSettings: async (settings) => {
        try {
          const trafficSettings = await client().putJson<HelperTrafficSettings>('/api/v1/settings/traffic', settings);
          set({ trafficSettings, traffic: trafficSettings.enabled ? get().traffic : null, trafficError: null, error: null });
          if (trafficSettings.enabled) {
            await get().loadTraffic();
          }
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveNetworkUsageSettings: async (settings) => {
        try {
          const networkUsageSettings = await client().putJson<HelperNetworkUsageSettings>(
            '/api/v1/settings/network-usage',
            settings
          );
          set({
            networkUsageSettings,
            networkUsageSummary: networkUsageSettings.enabled ? get().networkUsageSummary : null,
            networkUsageTopHosts: networkUsageSettings.enabled ? get().networkUsageTopHosts : null,
            networkUsageTopOutbounds: networkUsageSettings.enabled ? get().networkUsageTopOutbounds : null,
            networkUsageConnections: networkUsageSettings.enabled ? get().networkUsageConnections : null,
            networkUsageError: null,
            error: null
          });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      loadGroups: async () => {
        set({ loading: true, error: null });
        try {
          const api = client();
          const response = await api.getJson<HelperGroupsResponse>('/api/v1/groups');
          const scoreEntries = await Promise.all(
            response.groups.map(async (group) => {
              const scores = await api.getJson<HelperScoresResponse>(
                `/api/v1/groups/${encodeURIComponent(group.name)}/scores`
              );
              return [group.name, scores] as const;
            })
          );

          set((state) => ({
            groups: response.groups,
            scoresByGroup: {
              ...state.scoresByGroup,
              ...Object.fromEntries(scoreEntries)
            },
            loading: false,
            error: null
          }));
        } catch (error) {
          set({ loading: false, error: formatHelperError(error) });
        }
      },
      loadActiveProbes: async () => {
        try {
          const response = await client().getJson<HelperProbeStatusResponse>('/api/v1/probes');
          const groups = Array.isArray(response.groups) ? response.groups : [];
          set({
            activeProbeGroups: groups.map((group) => group.group),
            activeProbeNodesByGroup: Object.fromEntries(
              groups.map((group) => [
                group.group,
                Array.isArray(group.activeNodes) ? group.activeNodes : []
              ])
            ),
            error: null
          });
        } catch (error) {
          set({ activeProbeGroups: [], activeProbeNodesByGroup: {} });
        }
      },
      setEventStreamConnected: (connected) => set({ eventStreamConnected: connected }),
      saveGroupConfig: async (group, config) => {
        try {
          const saved = await client().putJson<HelperGroupConfig>(
            `/api/v1/groups/${encodeURIComponent(group)}/config`,
            config
          );
          set((state) => ({
            groups: state.groups.map((item) => (item.name === group ? { ...item, config: saved } : item)),
            error: null
          }));
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      probeGroup: async (group, concurrency) => {
        const useHttpProbePolling = !get().eventStreamConnected;
        let activeProbeTimer: ReturnType<typeof setInterval> | null = null;
        const startActiveProbePolling = () => {
          void get().loadActiveProbes();
          activeProbeTimer = setInterval(() => {
            void get().loadActiveProbes();
          }, ACTIVE_PROBE_POLL_INTERVAL_MS);
        };
        const stopActiveProbePolling = async () => {
          if (activeProbeTimer !== null) {
            clearInterval(activeProbeTimer);
          }
          await get().loadActiveProbes();
        };

        set((state) => ({
          error: null,
          probingGroups: Array.from(new Set([...state.probingGroups, group]))
        }));
        if (useHttpProbePolling) {
          startActiveProbePolling();
        }
        try {
          const response = await client().postJson<HelperScoresResponse>(
            `/api/v1/groups/${encodeURIComponent(group)}/probe`,
            { concurrency }
          );
          if (useHttpProbePolling) {
            await stopActiveProbePolling();
          }
          set((state) => ({
            scoresByGroup: { ...state.scoresByGroup, [group]: response },
            probingGroups: state.probingGroups.filter((item) => item !== group),
            error: response.applyError
          }));
        } catch (error) {
          if (useHttpProbePolling) {
            await stopActiveProbePolling();
          }
          set((state) => ({
            probingGroups: state.probingGroups.filter((item) => item !== group),
            error: formatHelperError(error)
          }));
        }
      },
      loadScores: async (group) => {
        try {
          const response = await client().getJson<HelperScoresResponse>(
            `/api/v1/groups/${encodeURIComponent(group)}/scores`
          );
          set((state) => ({
            scoresByGroup: { ...state.scoresByGroup, [group]: response },
            error: null
          }));
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      applyNode: async (group, node) => {
        set((state) => ({
          error: null,
          applyingGroups: Array.from(new Set([...state.applyingGroups, group]))
        }));
        try {
          const updated = await client().postJson<HelperGroup>(
            `/api/v1/groups/${encodeURIComponent(group)}/apply`,
            { node }
          );
          set((state) => ({
            groups: state.groups.map((item) => (item.name === group ? updated : item)),
            applyingGroups: state.applyingGroups.filter((item) => item !== group),
            error: updated.applyError
          }));
        } catch (error) {
          set((state) => ({
            applyingGroups: state.applyingGroups.filter((item) => item !== group),
            error: formatHelperError(error)
          }));
        }
      },
      loadHelperConfigContent: async () => {
        await get().saveConfigPath();
        return client().getJson<HelperConfigResponse>('/api/v1/config');
      },
      loadTraffic: async () => {
        if (!get().trafficSettings?.enabled) {
          set({ traffic: null, trafficLoading: false, trafficError: null });
          return;
        }
        set({ trafficLoading: true, trafficError: null });
        try {
          const traffic = await client().getJson<HelperTrafficResponse>('/api/v1/traffic');
          set({ traffic, trafficLoading: false, trafficError: null });
        } catch (error) {
          set({ trafficLoading: false, trafficError: formatHelperError(error) });
        }
      },
      loadNetworkUsageWindow: async (request) => {
        set({ networkUsageLoading: true, networkUsageError: null });
        try {
          const limit = request.limit ?? 8;
          const [summary, topHosts, topOutbounds, connections] = await Promise.all([
            client().getJson<HelperNetworkUsageSummary>(
              `/api/v1/network-usage/summary?${networkUsageQuery(request)}`
            ),
            client().getJson<HelperNetworkUsageTop>(
              `/api/v1/network-usage/top?${networkUsageQuery({ ...request, groupBy: 'host', limit })}`
            ),
            client().getJson<HelperNetworkUsageTop>(
              `/api/v1/network-usage/top?${networkUsageQuery({ ...request, groupBy: 'outbound', limit })}`
            ),
            client().getJson<HelperNetworkUsageConnections>(
              `/api/v1/network-usage/connections?${networkUsageQuery({ ...request, limit })}`
            )
          ]);
          set({
            networkUsageSummary: summary,
            networkUsageTopHosts: topHosts,
            networkUsageTopOutbounds: topOutbounds,
            networkUsageConnections: connections,
            networkUsageLoading: false,
            networkUsageError: null
          });
        } catch (error) {
          set({ networkUsageLoading: false, networkUsageError: formatHelperError(error) });
        }
      }
    }),
    {
      name: 'singdeck-helper',
      partialize: (state) => ({
        helperUrl: state.helperUrl,
        configPath: state.configPath,
        trafficSettings: state.trafficSettings,
        networkUsageSettings: state.networkUsageSettings
      })
    }
  )
);

type NetworkUsageQueryInput = HelperNetworkUsageWindowRequest & {
  groupBy?: 'host' | 'outbound' | 'rule';
};

function networkUsageQuery(input: NetworkUsageQueryInput): string {
  const params = new URLSearchParams({
    from: String(input.from),
    to: String(input.to)
  });
  if (input.bucket) {
    params.set('bucket', input.bucket);
  }
  if (input.limit !== undefined) {
    params.set('limit', String(input.limit));
  }
  if (input.q?.trim()) {
    params.set('q', input.q.trim());
  }
  if (input.groupBy) {
    params.set('groupBy', input.groupBy);
  }
  return params.toString();
}

function client(): HelperApiClient {
  return new HelperApiClient({ baseUrl: useHelperStore.getState().helperUrl });
}

function formatHelperError(error: unknown): string {
  if (error instanceof Response) {
    return `Helper HTTP ${error.status}`;
  }

  return error instanceof Error ? error.message : 'Helper request failed';
}
