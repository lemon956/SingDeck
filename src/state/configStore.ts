import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createConfigSnapshot,
  formatDiagnosticCopy,
  type ConfigSnapshot
} from '../core/configWorkspace';
import { ClashApiClient } from '../core/clashApi';
import { validateNecessaryConfig, type ValidationIssue } from '../core/controller';
import { useControllerStore } from './controllerStore';
import { useHelperStore } from './helperStore';

type ConfigState = {
  content: string;
  issues: ValidationIssue[];
  snapshots: ConfigSnapshot[];
  loading: boolean;
  error: string | null;
  sourceEndpoint: string | null;
  lastLoadedAt: string | null;
  setContent: (content: string) => void;
  loadConfigFile: (content: string, sourceName: string) => void;
  loadRuntimeConfig: () => Promise<void>;
  saveSnapshot: (name: string) => void;
  restoreSnapshot: (id: string) => void;
  diagnosticCopy: () => string;
};

const INITIAL_CONFIG = `{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "secret": ""
    }
  }
}`;

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      content: INITIAL_CONFIG,
      issues: validateNecessaryConfig(INITIAL_CONFIG),
      snapshots: [],
      loading: false,
      error: null,
      sourceEndpoint: null,
      lastLoadedAt: null,
      setContent: (content) => set({ content, issues: validateNecessaryConfig(content) }),
      loadConfigFile: (content, sourceName) =>
        set({
          content,
          issues: validateNecessaryConfig(content),
          error: null,
          sourceEndpoint: sourceName,
          lastLoadedAt: new Date().toISOString()
        }),
      loadRuntimeConfig: async () => {
        set({ loading: true, error: null });
        const helper = useHelperStore.getState();

        try {
          const result = await helper.loadHelperConfigContent();
          if (result.error || !result.content) {
            throw new Error(result.error || 'Helper returned an empty config.');
          }

          set({
            content: result.content,
            issues: result.format.toLowerCase() === 'json' ? validateNecessaryConfig(result.content) : [],
            loading: false,
            sourceEndpoint: result.source ? `helper:${result.source}` : 'helper:/api/v1/config',
            lastLoadedAt: result.loadedAt || new Date().toISOString()
          });
          return;
        } catch (helperError) {
          const { config } = useControllerStore.getState();
          if (!config.controllerUrl) {
            set({
              loading: false,
              error: helperError instanceof Error ? helperError.message : 'Helper config API is unavailable.'
            });
            return;
          }

          const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });

          try {
            const result = await readRuntimeConfig(client);
            const content = JSON.stringify(result.data, null, 2);
            set({
              content,
              issues: [],
              loading: false,
              sourceEndpoint: result.endpoint,
              lastLoadedAt: new Date().toISOString()
            });
          } catch (error) {
            set({
              loading: false,
              error: error instanceof Error ? error.message : 'Failed to load runtime config'
            });
          }
        }
      },
      saveSnapshot: (name) =>
        set((state) => ({
          snapshots: [createConfigSnapshot(name, state.content), ...state.snapshots].slice(0, 24)
        })),
      restoreSnapshot: (id) => {
        const snapshot = get().snapshots.find((item) => item.id === id);
        if (snapshot) {
          set({ content: snapshot.content, issues: snapshot.issues });
        }
      },
      diagnosticCopy: () => formatDiagnosticCopy(get().content)
    }),
    {
      name: 'singdeck-config-workspace',
      partialize: (state) => ({
        content: state.content,
        issues: state.issues,
        snapshots: state.snapshots,
        sourceEndpoint: state.sourceEndpoint,
        lastLoadedAt: state.lastLoadedAt
      })
    }
  )
);

async function readRuntimeConfig(client: ClashApiClient): Promise<{ endpoint: string; data: unknown }> {
  const endpoints = ['/config', '/config.json', '/ui/config.json', '/configs'];
  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    try {
      return { endpoint, data: await client.getJson(endpoint) };
    } catch (error) {
      lastError = error;
      const isFinalFallback = endpoint === endpoints.at(-1);
      if (isFinalFallback || !canTryNextConfigEndpoint(error)) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to load runtime config');
}

function canTryNextConfigEndpoint(error: unknown): boolean {
  if (error instanceof Response) {
    return error.status === 404;
  }

  return error instanceof SyntaxError;
}
