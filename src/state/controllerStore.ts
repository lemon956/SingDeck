import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectController, type DetectionResult } from '../core/clashApi';
import {
  inferControllerFromLocation,
  normalizeControllerUrl,
  parseControllerFromHash,
  type ControllerConfig
} from '../core/controller';

const DEFAULT_TEST_URL = 'https://cp.cloudflare.com/generate_204';
const DEFAULT_DELAY_TEST_CONCURRENCY = 4;
const DEFAULT_DELAY_TEST_TIMEOUT_MS = 5000;

type ControllerState = {
  config: ControllerConfig;
  detection: DetectionResult | null;
  detecting: boolean;
  lastCheckedAt: string | null;
  urlSecretWarning: boolean;
  applyUrlStartup: (hash: string) => void;
  applyBrowserStartup: (hash: string, origin: string, pathname: string) => void;
  updateConfig: (config: Partial<ControllerConfig>) => void;
  detect: () => Promise<void>;
};

export const useControllerStore = create<ControllerState>()(
  persist(
    (set, get) => ({
      config: {
        controllerUrl: '',
        secret: '',
        note: '',
        defaultTestUrl: DEFAULT_TEST_URL,
        delayTestConcurrency: DEFAULT_DELAY_TEST_CONCURRENCY,
        delayTestTimeoutMs: DEFAULT_DELAY_TEST_TIMEOUT_MS
      },
      detection: null,
      detecting: false,
      lastCheckedAt: null,
      urlSecretWarning: false,
      applyUrlStartup: (hash) => {
        const parsed = parseControllerFromHash(hash);
        if (!parsed) {
          return;
        }

        set((state) => ({
          config: {
            ...state.config,
            ...parsed,
            delayTestConcurrency: state.config.delayTestConcurrency ?? DEFAULT_DELAY_TEST_CONCURRENCY,
            delayTestTimeoutMs: state.config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS,
            updatedAt: new Date().toISOString()
          },
          urlSecretWarning: Boolean(parsed.secret)
        }));
      },
      applyBrowserStartup: (hash, origin, pathname) => {
        const parsed = parseControllerFromHash(hash);
        if (parsed) {
          get().applyUrlStartup(hash);
          return;
        }

        const inferredControllerUrl = inferControllerFromLocation(origin, pathname);
        if (!inferredControllerUrl) {
          return;
        }

        set((state) => ({
          config: {
            ...state.config,
            controllerUrl: inferredControllerUrl,
            delayTestConcurrency: state.config.delayTestConcurrency ?? DEFAULT_DELAY_TEST_CONCURRENCY,
            delayTestTimeoutMs: state.config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS,
            updatedAt: new Date().toISOString()
          },
          detection: null
        }));
      },
      updateConfig: (config) => {
        set((state) => ({
          config: {
            ...state.config,
            ...config,
            controllerUrl:
              config.controllerUrl === undefined
                ? state.config.controllerUrl
                : normalizeControllerUrl(config.controllerUrl),
            delayTestConcurrency: normalizeConcurrency(
              config.delayTestConcurrency ?? state.config.delayTestConcurrency ?? DEFAULT_DELAY_TEST_CONCURRENCY
            ),
            delayTestTimeoutMs: normalizeTimeout(
              config.delayTestTimeoutMs ?? state.config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS
            ),
            updatedAt: new Date().toISOString()
          },
          detection: null
        }));
      },
      detect: async () => {
        const { config } = get();
        if (!config.controllerUrl) {
          set({
            detection: {
              ok: false,
              failure: {
                kind: 'unknown',
                title: 'Controller URL missing',
                detail: 'Set a Clash API controller URL before running detection.'
              }
            },
            lastCheckedAt: new Date().toISOString()
          });
          return;
        }

        set({ detecting: true });
        const detection = await detectController({
          controllerUrl: config.controllerUrl,
          secret: config.secret
        });
        set({
          detection,
          detecting: false,
          lastCheckedAt: new Date().toISOString()
        });
      }
    }),
    {
      name: 'singdeck-controller',
      partialize: (state) => ({
        config: state.config,
        urlSecretWarning: state.urlSecretWarning
      })
    }
  )
);

function normalizeConcurrency(value: number): number {
  return Math.min(12, Math.max(1, Math.round(Number.isFinite(value) ? value : DEFAULT_DELAY_TEST_CONCURRENCY)));
}

function normalizeTimeout(value: number): number {
  return Math.min(60000, Math.max(500, Math.round(Number.isFinite(value) ? value : DEFAULT_DELAY_TEST_TIMEOUT_MS)));
}
