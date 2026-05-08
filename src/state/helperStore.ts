import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_HELPER_URL,
  HelperApiClient,
  type HelperConfigResponse,
  type HelperGroup,
  type HelperGroupConfig,
  type HelperGroupsResponse,
  type HelperHealth,
  type HelperScoresResponse,
  type HelperTestingSettings,
  type HelperTrafficResponse
} from '../core/helperApi';
import { useControllerStore } from './controllerStore';

type HelperState = {
  helperUrl: string;
  configPath: string;
  health: HelperHealth | null;
  testingSettings: HelperTestingSettings | null;
  groups: HelperGroup[];
  scoresByGroup: Record<string, HelperScoresResponse>;
  traffic: HelperTrafficResponse | null;
  trafficLoading: boolean;
  trafficError: string | null;
  loading: boolean;
  probingGroups: string[];
  applyingGroups: string[];
  error: string | null;
  lastCheckedAt: string | null;
  updateSettings: (settings: Partial<Pick<HelperState, 'helperUrl' | 'configPath'>>) => void;
  checkHealth: () => Promise<void>;
  syncController: () => Promise<void>;
  loadTestingSettings: () => Promise<void>;
  saveDefaultTestUrl: (defaultTestUrl: string) => Promise<void>;
  saveDelayTestTimeout: (delayTestTimeoutMs: number) => Promise<void>;
  loadGroups: () => Promise<void>;
  saveGroupConfig: (group: string, config: HelperGroupConfig) => Promise<void>;
  probeGroup: (group: string, concurrency: number) => Promise<void>;
  loadScores: (group: string) => Promise<void>;
  applyNode: (group: string, node?: string) => Promise<void>;
  loadHelperConfigContent: () => Promise<HelperConfigResponse>;
  loadTraffic: () => Promise<void>;
};

export const useHelperStore = create<HelperState>()(
  persist(
    (set, get) => ({
      helperUrl: DEFAULT_HELPER_URL,
      configPath: '',
      health: null,
      testingSettings: null,
      groups: [],
      scoresByGroup: {},
      traffic: null,
      trafficLoading: false,
      trafficError: null,
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
          set({
            health,
            testingSettings,
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
          set({ health, testingSettings, loading: false, lastCheckedAt: new Date().toISOString(), error: health.error });
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
        set((state) => ({
          error: null,
          probingGroups: Array.from(new Set([...state.probingGroups, group]))
        }));
        try {
          const response = await client().postJson<HelperScoresResponse>(
            `/api/v1/groups/${encodeURIComponent(group)}/probe`,
            { concurrency }
          );
          set((state) => ({
            scoresByGroup: { ...state.scoresByGroup, [group]: response },
            probingGroups: state.probingGroups.filter((item) => item !== group),
            error: response.applyError
          }));
        } catch (error) {
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
        const { configPath } = get();
        if (configPath.trim()) {
          await client().putJson('/api/v1/config/source', { path: configPath.trim() });
        }
        return client().getJson<HelperConfigResponse>('/api/v1/config');
      },
      loadTraffic: async () => {
        set({ trafficLoading: true, trafficError: null });
        try {
          const traffic = await client().getJson<HelperTrafficResponse>('/api/v1/traffic');
          set({ traffic, trafficLoading: false, trafficError: null });
        } catch (error) {
          set({ trafficLoading: false, trafficError: formatHelperError(error) });
        }
      }
    }),
    {
      name: 'singdeck-helper',
      partialize: (state) => ({
        helperUrl: state.helperUrl,
        configPath: state.configPath
      })
    }
  )
);

function client(): HelperApiClient {
  return new HelperApiClient({ baseUrl: useHelperStore.getState().helperUrl });
}

function formatHelperError(error: unknown): string {
  if (error instanceof Response) {
    return `Helper HTTP ${error.status}`;
  }

  return error instanceof Error ? error.message : 'Helper request failed';
}
