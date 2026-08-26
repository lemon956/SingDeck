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
  type HelperInspectionRequest,
  type HelperNodeSource,
  type HelperNodeSourcesResponse,
  type HelperNetworkUsageConnections,
  type HelperNetworkUsageSettings,
  type HelperNetworkUsageSourceTrend,
  type HelperNetworkUsageSourceTrendRequest,
  type HelperNetworkUsageSummary,
  type HelperNetworkUsageTop,
  type HelperNetworkUsageWindow,
  type HelperNetworkUsageWindowRequest,
  type HelperProbeStatusResponse,
  type HelperProbeRequest,
  type HelperScoresResponse,
  type HelperTestingSettings,
  type HelperTrafficSettings,
  type HelperTrafficResponse
} from '../core/helperApi';
import { useControllerStore } from './controllerStore';

const ACTIVE_PROBE_POLL_INTERVAL_MS = 120;
const DEFAULT_MIN_PROBE_INTERVAL_SEC = 60;
const DEFAULT_PROBE_CONCURRENCY = 4;

// Monotonic id so a slow in-flight active-probe poll cannot overwrite the state
// written by a later poll (e.g. the final poll after a probe finishes).
let activeProbeLoadGeneration = 0;

type HelperState = {
  helperUrl: string;
  helperToken: string;
  configPath: string;
  health: HelperHealth | null;
  testingSettings: HelperTestingSettings | null;
  trafficSettings: HelperTrafficSettings | null;
  networkUsageSettings: HelperNetworkUsageSettings | null;
  groups: HelperGroup[];
  nodeSources: HelperNodeSource[];
  scoresByGroup: Record<string, HelperScoresResponse>;
  activeProbeGroups: string[];
  activeProbeNodesByGroup: Record<string, string[]>;
  traffic: HelperTrafficResponse | null;
  trafficFetchedAt: number | null;
  trafficLoading: boolean;
  trafficError: string | null;
  networkUsageSummary: HelperNetworkUsageSummary | null;
  networkUsageTopHosts: HelperNetworkUsageTop | null;
  networkUsageTopOutbounds: HelperNetworkUsageTop | null;
  networkUsageTopStrategies: HelperNetworkUsageTop | null;
  networkUsageConnections: HelperNetworkUsageConnections | null;
  networkUsageSourceTrend: HelperNetworkUsageSourceTrend | null;
  networkUsageSourceTrendLoading: boolean;
  networkUsageSourceTrendError: string | null;
  networkUsageSourceTrendRefreshing: boolean;
  networkUsageSourceTrendRefreshError: string | null;
  networkUsageLoading: boolean;
  networkUsageError: string | null;
  eventStreamConnected: boolean;
  loading: boolean;
  probingGroups: string[];
  inspectingGroups: string[];
  applyingGroups: string[];
  error: string | null;
  lastCheckedAt: string | null;
  lastSyncedControllerKey: string | null;
  updateSettings: (settings: Partial<Pick<HelperState, 'helperUrl' | 'helperToken' | 'configPath'>>) => void;
  checkHealth: () => Promise<void>;
  syncController: (options?: { force?: boolean }) => Promise<void>;
  loadTestingSettings: () => Promise<void>;
  loadTrafficSettings: () => Promise<void>;
  loadNetworkUsageSettings: () => Promise<void>;
  saveDefaultTestUrl: (defaultTestUrl: string) => Promise<void>;
  saveDelayTestTimeout: (delayTestTimeoutMs: number) => Promise<void>;
  saveMinProbeInterval: (minProbeIntervalSec: number) => Promise<void>;
  saveTestingSettings: (patch: Partial<HelperTestingSettings>) => Promise<void>;
  saveGeminiLocationGroup: (group: string) => Promise<void>;
  saveConfigPath: () => Promise<void>;
  saveTrafficSettings: (settings: HelperTrafficSettings) => Promise<void>;
  saveNetworkUsageSettings: (settings: HelperNetworkUsageSettings) => Promise<void>;
  loadGroups: () => Promise<void>;
  loadNodeSources: () => Promise<void>;
  loadActiveProbes: () => Promise<void>;
  setEventStreamConnected: (connected: boolean) => void;
  saveGroupConfig: (group: string, config: HelperGroupConfig) => Promise<void>;
  probeGroup: (group: string, concurrency: number) => Promise<void>;
  inspectGroup: (group: string, inspection: HelperInspectionRequest) => Promise<void>;
  loadScores: (group: string) => Promise<void>;
  applyNode: (group: string, node?: string) => Promise<void>;
  loadHelperConfigContent: () => Promise<HelperConfigResponse>;
  loadTraffic: () => Promise<void>;
  refreshTrafficIfStale: (maxAgeMs: number) => Promise<void>;
  loadNetworkUsageWindow: (request: HelperNetworkUsageWindowRequest) => Promise<void>;
  loadNetworkUsageSourceTrend: (request: HelperNetworkUsageSourceTrendRequest) => Promise<void>;
  refreshNetworkUsageSourceTrend: (request: HelperNetworkUsageSourceTrendRequest) => Promise<void>;
};

export const useHelperStore = create<HelperState>()(
  persist(
    (set, get) => ({
      helperUrl: DEFAULT_HELPER_URL,
      helperToken: '',
      configPath: '',
      health: null,
      testingSettings: null,
      trafficSettings: null,
      networkUsageSettings: null,
      groups: [],
      nodeSources: [],
      scoresByGroup: {},
      activeProbeGroups: [],
      activeProbeNodesByGroup: {},
      traffic: null,
      trafficFetchedAt: null,
      trafficLoading: false,
      trafficError: null,
      networkUsageSummary: null,
      networkUsageTopHosts: null,
      networkUsageTopOutbounds: null,
      networkUsageTopStrategies: null,
      networkUsageConnections: null,
      networkUsageSourceTrend: null,
      networkUsageSourceTrendLoading: false,
      networkUsageSourceTrendError: null,
      networkUsageSourceTrendRefreshing: false,
      networkUsageSourceTrendRefreshError: null,
      networkUsageLoading: false,
      networkUsageError: null,
      eventStreamConnected: false,
      loading: false,
      probingGroups: [],
      inspectingGroups: [],
      applyingGroups: [],
      error: null,
      lastCheckedAt: null,
      lastSyncedControllerKey: null,
      updateSettings: (settings) =>
        set((state) => {
          const helperUrlChanged = settings.helperUrl !== undefined && settings.helperUrl !== state.helperUrl;
          const helperTokenChanged =
            settings.helperToken !== undefined && settings.helperToken !== state.helperToken;
          const connectionChanged = helperUrlChanged || helperTokenChanged;
          return {
            helperUrl: settings.helperUrl === undefined ? state.helperUrl : settings.helperUrl,
            helperToken: settings.helperToken === undefined ? state.helperToken : settings.helperToken,
            configPath: settings.configPath === undefined ? state.configPath : settings.configPath,
            health: connectionChanged ? null : state.health,
            eventStreamConnected: connectionChanged ? false : state.eventStreamConnected,
            activeProbeGroups: connectionChanged ? [] : state.activeProbeGroups,
            activeProbeNodesByGroup: connectionChanged ? {} : state.activeProbeNodesByGroup,
            inspectingGroups: connectionChanged ? [] : state.inspectingGroups,
            nodeSources: connectionChanged ? [] : state.nodeSources,
            error: connectionChanged ? null : state.error,
            lastCheckedAt: connectionChanged ? null : state.lastCheckedAt,
            lastSyncedControllerKey: connectionChanged ? null : state.lastSyncedControllerKey
          };
        }),
      checkHealth: async () => {
        set({ loading: true, error: null });
        try {
          const health = await client().getJson<HelperHealth>('/api/v1/health');
          set({
            health,
            loading: false,
            lastCheckedAt: new Date().toISOString(),
            error: health.error
          });
          const [testingSettings, trafficSettings, networkUsageSettings] = await Promise.all([
            client().getJson<HelperTestingSettings>('/api/v1/settings/testing'),
            client().getJson<HelperTrafficSettings>('/api/v1/settings/traffic'),
            client().getJson<HelperNetworkUsageSettings>('/api/v1/settings/network-usage')
          ]);
          set({
            testingSettings,
            trafficSettings,
            networkUsageSettings,
            error: health.error
          });
        } catch (error) {
          set(helperUnavailablePatch(formatHelperError(error)));
        }
      },
      syncController: async (options) => {
        const { config } = useControllerStore.getState();
        if (!config.controllerUrl) {
          set({ error: 'Controller URL is empty.' });
          return;
        }
        const syncKey = controllerSyncKey(config.controllerUrl, config.secret);
        if (!options?.force && get().lastSyncedControllerKey === syncKey) {
          if (!get().health) {
            await get().checkHealth();
          }
          return;
        }

        set({ loading: true, error: null });
        try {
          await client().putJson('/api/v1/controller', {
            controllerUrl: config.controllerUrl,
            secret: config.secret
          });
          const health = await client().getJson<HelperHealth>('/api/v1/health');
          set({
            health,
            loading: false,
            lastCheckedAt: new Date().toISOString(),
            lastSyncedControllerKey: syncKey,
            error: health.error
          });
          const [testingSettings, trafficSettings, networkUsageSettings] = await Promise.all([
            client().getJson<HelperTestingSettings>('/api/v1/settings/testing'),
            client().getJson<HelperTrafficSettings>('/api/v1/settings/traffic'),
            client().getJson<HelperNetworkUsageSettings>('/api/v1/settings/network-usage')
          ]);
          set({
            testingSettings,
            trafficSettings,
            networkUsageSettings,
            error: health.error
          });
        } catch (error) {
          set(helperUnavailablePatch(formatHelperError(error)));
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
      saveTestingSettings: async (patch: Partial<HelperTestingSettings>) => {
        try {
          const current = get().testingSettings;
          const { config } = useControllerStore.getState();
          const defaultTestUrl = patch.defaultTestUrl ?? current?.defaultTestUrl ?? config.defaultTestUrl;
          const delayTestTimeoutMs =
            patch.delayTestTimeoutMs ?? current?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? 5000;
          const minProbeIntervalSec =
            patch.minProbeIntervalSec ?? current?.minProbeIntervalSec ?? DEFAULT_MIN_PROBE_INTERVAL_SEC;
          const probeConcurrency =
            patch.probeConcurrency ?? config.delayTestConcurrency ?? current?.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
          const payload: HelperTestingSettings = {
            defaultTestUrl,
            delayTestTimeoutMs,
            minProbeIntervalSec,
            probeConcurrency
          };
          const geminiLocationGroup = patch.geminiLocationGroup ?? current?.geminiLocationGroup;
          if (geminiLocationGroup !== undefined) {
            payload.geminiLocationGroup = geminiLocationGroup;
          }
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', payload);
          set({ testingSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveGeminiLocationGroup: async (geminiLocationGroup: string) => {
        await get().saveTestingSettings({ geminiLocationGroup });
      },
      saveDefaultTestUrl: async (defaultTestUrl) => {
        try {
          const { config } = useControllerStore.getState();
          const delayTestTimeoutMs =
            get().testingSettings?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? 5000;
          const minProbeIntervalSec = get().testingSettings?.minProbeIntervalSec ?? DEFAULT_MIN_PROBE_INTERVAL_SEC;
          const probeConcurrency =
            config.delayTestConcurrency ?? get().testingSettings?.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
          const payload: HelperTestingSettings = {
            defaultTestUrl,
            delayTestTimeoutMs,
            minProbeIntervalSec,
            probeConcurrency
          };
          if (get().testingSettings?.geminiLocationGroup !== undefined) {
            payload.geminiLocationGroup = get().testingSettings?.geminiLocationGroup;
          }
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', payload);
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
          const minProbeIntervalSec = get().testingSettings?.minProbeIntervalSec ?? DEFAULT_MIN_PROBE_INTERVAL_SEC;
          const probeConcurrency =
            config.delayTestConcurrency ?? get().testingSettings?.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
          const payload: HelperTestingSettings = {
            defaultTestUrl,
            delayTestTimeoutMs,
            minProbeIntervalSec,
            probeConcurrency
          };
          if (get().testingSettings?.geminiLocationGroup !== undefined) {
            payload.geminiLocationGroup = get().testingSettings?.geminiLocationGroup;
          }
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', payload);
          set({ testingSettings, error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      saveMinProbeInterval: async (minProbeIntervalSec) => {
        try {
          const { config } = useControllerStore.getState();
          const defaultTestUrl = get().testingSettings?.defaultTestUrl ?? config.defaultTestUrl;
          const delayTestTimeoutMs =
            get().testingSettings?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? 5000;
          const probeConcurrency =
            config.delayTestConcurrency ?? get().testingSettings?.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
          const payload: HelperTestingSettings = {
            defaultTestUrl,
            delayTestTimeoutMs,
            minProbeIntervalSec,
            probeConcurrency
          };
          if (get().testingSettings?.geminiLocationGroup !== undefined) {
            payload.geminiLocationGroup = get().testingSettings?.geminiLocationGroup;
          }
          const testingSettings = await client().putJson<HelperTestingSettings>('/api/v1/settings/testing', payload);
          set({ testingSettings, error: null });
          await get().loadGroups();
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
          set({
            trafficSettings,
            traffic: trafficSettings.enabled ? get().traffic : null,
            trafficFetchedAt: trafficSettings.enabled ? get().trafficFetchedAt : null,
            trafficError: null,
            error: null
          });
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
            networkUsageTopStrategies: networkUsageSettings.enabled ? get().networkUsageTopStrategies : null,
            networkUsageConnections: networkUsageSettings.enabled ? get().networkUsageConnections : null,
            networkUsageError: null,
            error: null
          });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      loadGroups: async () => {
        try {
          const api = client();
          const response = await api.getJson<HelperGroupsResponse>('/api/v1/groups');
          const groups = Array.isArray(response.groups) ? response.groups : [];
          set({ groups, loading: false, error: null });
          const scoreResults = await Promise.allSettled(
            groups.map(async (group) => {
              const scores = await api.getJson<HelperScoresResponse>(
                `/api/v1/groups/${encodeURIComponent(group.name)}/scores`
              );
              return [group.name, scores] as const;
            })
          );
          const scoreEntries = scoreResults
            .filter((result): result is PromiseFulfilledResult<readonly [string, HelperScoresResponse]> => {
              return result.status === 'fulfilled';
            })
            .map((result) => result.value);

          const firstScoreError = scoreResults.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
          );
          set((state) => ({
            scoresByGroup: {
              ...state.scoresByGroup,
              ...Object.fromEntries(scoreEntries)
            },
            error: firstScoreError ? formatHelperError(firstScoreError.reason) : null
          }));
        } catch (error) {
          set({ loading: false, error: formatHelperError(error) });
        }
      },
      loadNodeSources: async () => {
        try {
          const response = await client().getJson<HelperNodeSourcesResponse>('/api/v1/node-sources');
          set({ nodeSources: Array.isArray(response.sources) ? response.sources : [], error: null });
        } catch (error) {
          set({ error: formatHelperError(error) });
        }
      },
      loadActiveProbes: async () => {
        const generation = ++activeProbeLoadGeneration;
        try {
          const response = await client().getJson<HelperProbeStatusResponse>('/api/v1/probes');
          if (generation !== activeProbeLoadGeneration) {
            return;
          }
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
          if (generation !== activeProbeLoadGeneration) {
            return;
          }
          set({
            activeProbeGroups: [],
            activeProbeNodesByGroup: {},
            eventStreamConnected: false,
            error: formatHelperError(error)
          });
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
            activeProbeTimer = null;
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
          const request: HelperProbeRequest = { concurrency };
          const response = await client().postJson<HelperScoresResponse>(
            `/api/v1/groups/${encodeURIComponent(group)}/probe`,
            request
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
        } finally {
          // Backstop: guarantee the high-frequency poller is never leaked even if
          // a result handler above throws before stopActiveProbePolling runs.
          if (activeProbeTimer !== null) {
            clearInterval(activeProbeTimer);
            activeProbeTimer = null;
          }
        }
      },
      inspectGroup: async (group, inspection) => {
        set((state) => ({
          error: null,
          inspectingGroups: Array.from(new Set([...state.inspectingGroups, group]))
        }));
        try {
          const response = await client().postJson<HelperScoresResponse>(
            `/api/v1/groups/${encodeURIComponent(group)}/inspection`,
            inspection
          );
          set((state) => ({
            scoresByGroup: { ...state.scoresByGroup, [group]: response },
            inspectingGroups: state.inspectingGroups.filter((item) => item !== group),
            error: response.applyError
          }));
        } catch (error) {
          set((state) => ({
            inspectingGroups: state.inspectingGroups.filter((item) => item !== group),
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
          set({ traffic: null, trafficFetchedAt: null, trafficLoading: false, trafficError: null });
          return;
        }
        // Keep the previously cached `traffic` visible while this refresh runs so
        // the module never flashes empty on a background/silent sync.
        set({ trafficLoading: true, trafficError: null });
        try {
          const traffic = await client().getJson<HelperTrafficResponse>('/api/v1/traffic');
          set({ traffic, trafficFetchedAt: Date.now(), trafficLoading: false, trafficError: null });
        } catch (error) {
          set({ trafficLoading: false, trafficError: formatHelperError(error) });
        }
      },
      refreshTrafficIfStale: async (maxAgeMs) => {
        const state = get();
        if (!state.trafficSettings?.enabled) {
          return;
        }
        const isFresh =
          state.traffic !== null &&
          state.trafficFetchedAt !== null &&
          Date.now() - state.trafficFetchedAt < maxAgeMs;
        if (isFresh) {
          return; // silently skip: cached data is recent enough
        }
        await get().loadTraffic();
      },
      loadNetworkUsageWindow: async (request) => {
        set({ networkUsageLoading: true, networkUsageError: null });
        try {
          const limit = request.limit ?? 10;
          const window = await client().getJson<HelperNetworkUsageWindow>(
            `/api/v1/network-usage/window?${networkUsageQuery({ ...request, limit })}`
          );
          set({
            networkUsageSummary: window.summary,
            networkUsageTopHosts: window.topHosts,
            networkUsageTopOutbounds: window.topOutbounds,
            networkUsageTopStrategies: window.topStrategies,
            networkUsageConnections: window.connections,
            networkUsageLoading: false,
            networkUsageError: null
          });
        } catch (error) {
          set({ networkUsageLoading: false, networkUsageError: formatHelperError(error) });
        }
      },
      loadNetworkUsageSourceTrend: async (request) => {
        set({ networkUsageSourceTrendLoading: true, networkUsageSourceTrendError: null });
        try {
          const trend = await client().getJson<HelperNetworkUsageSourceTrend>(
            `/api/v1/network-usage/source-trend?${networkUsageSourceTrendQuery(request)}`
          );
          set({
            networkUsageSourceTrend: trend,
            networkUsageSourceTrendLoading: false,
            networkUsageSourceTrendError: null
          });
        } catch (error) {
          set({
            networkUsageSourceTrendLoading: false,
            networkUsageSourceTrendError: formatHelperError(error)
          });
        }
      },
      refreshNetworkUsageSourceTrend: async (request) => {
        set({ networkUsageSourceTrendRefreshing: true, networkUsageSourceTrendRefreshError: null });
        try {
          const trend = await client().postJson<HelperNetworkUsageSourceTrend>(
            `/api/v1/network-usage/source-trend/refresh?${networkUsageSourceTrendQuery(request)}`,
            {}
          );
          set({
            networkUsageSourceTrend: trend,
            networkUsageSourceTrendRefreshing: false,
            networkUsageSourceTrendRefreshError: null
          });
        } catch (error) {
          set({
            networkUsageSourceTrendRefreshing: false,
            networkUsageSourceTrendRefreshError: formatHelperError(error)
          });
        }
      }
    }),
    {
      name: 'singdeck-helper',
      partialize: (state) => ({
        helperUrl: state.helperUrl,
        helperToken: state.helperToken,
        configPath: state.configPath,
        trafficSettings: state.trafficSettings,
        networkUsageSettings: state.networkUsageSettings,
        // Cache the last traffic snapshot so the module renders instantly on
        // reload instead of flashing empty until the slow sync completes.
        // TrafficSnapshot carries no secrets/tokens, only usage numbers.
        traffic: state.traffic,
        trafficFetchedAt: state.trafficFetchedAt
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

function networkUsageSourceTrendQuery(input: HelperNetworkUsageSourceTrendRequest): string {
  const params = new URLSearchParams({
    days: String(input.days),
    bucket: input.bucket,
    tzOffsetMinutes: String(input.tzOffsetMinutes)
  });
  return params.toString();
}

function client(): HelperApiClient {
  const { helperUrl, helperToken } = useHelperStore.getState();
  return new HelperApiClient({ baseUrl: helperUrl, token: helperToken });
}

function controllerSyncKey(controllerUrl: string, secret: string): string {
  return `${controllerUrl.trim().replace(/\/+$/, '')}\n${secret}`;
}

function helperUnavailablePatch(error: string): Partial<HelperState> {
  return {
    health: null,
    loading: false,
    eventStreamConnected: false,
    activeProbeGroups: [],
    activeProbeNodesByGroup: {},
    probingGroups: [],
    inspectingGroups: [],
    error,
    lastCheckedAt: new Date().toISOString()
  };
}

function formatHelperError(error: unknown): string {
  if (error instanceof Response) {
    return `Helper HTTP ${error.status}`;
  }

  return error instanceof Error ? error.message : 'Helper request failed';
}
