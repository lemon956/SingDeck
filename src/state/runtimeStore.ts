import { create } from 'zustand';
import { ClashApiClient } from '../core/clashApi';
import { parseTrafficChunk, summarizeRuntime, type RuntimeSummary } from '../core/runtime';
import { useControllerStore } from './controllerStore';

type ConfigsResponse = {
  mode?: string;
};

type ConnectionsResponse = {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: unknown[];
};

type RuntimeState = {
  summary: RuntimeSummary;
  history: Array<{ time: string; up: number; down: number; connections: number }>;
  loading: boolean;
  error: string | null;
  lastUpdatedAt: string | null;
  refresh: () => Promise<void>;
};

const EMPTY_SUMMARY = summarizeRuntime({
  traffic: { up: 0, down: 0 },
  totals: { uploadTotal: 0, downloadTotal: 0 },
  connectionCount: 0,
  mode: 'unknown'
});

const RUNTIME_HISTORY_WINDOW_MS = 5 * 60 * 1000;
const RUNTIME_HISTORY_MAX_POINTS = 140;

export const useRuntimeStore = create<RuntimeState>((set) => ({
  summary: EMPTY_SUMMARY,
  history: [],
  loading: false,
  error: null,
  lastUpdatedAt: null,
  refresh: async () => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl) {
      return;
    }

    set({ loading: true, error: null });
    const client = new ClashApiClient({
      baseUrl: config.controllerUrl,
      secret: config.secret
    });

    try {
      const trafficController = new AbortController();
      const [configs, connections, trafficChunk] = await Promise.all([
        client.getJson<ConfigsResponse>('/configs'),
        client.getJson<ConnectionsResponse>('/connections'),
        client.readStreamChunk('/traffic', trafficController.signal)
      ]);
      trafficController.abort();
      const traffic = parseTrafficChunk(trafficChunk);
      const connectionCount = connections.connections?.length ?? 0;

      const sampledAt = new Date();
      const sample = {
        time: sampledAt.toISOString(),
        up: traffic.up,
        down: traffic.down,
        connections: connectionCount
      };

      set((state) => ({
        summary: summarizeRuntime({
          traffic: {
            up: traffic.up,
            down: traffic.down
          },
          totals: {
            uploadTotal: connections.uploadTotal ?? 0,
            downloadTotal: connections.downloadTotal ?? 0
          },
          connectionCount,
          mode: configs.mode ?? 'unknown'
        }),
        history: trimRuntimeHistory([...state.history, sample], sampledAt.getTime()),
        loading: false,
        lastUpdatedAt: sample.time
      }));
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Runtime refresh failed'
      });
    }
  }
}));

function trimRuntimeHistory(
  history: Array<{ time: string; up: number; down: number; connections: number }>,
  now: number
) {
  const windowStart = now - RUNTIME_HISTORY_WINDOW_MS;
  return history
    .filter((item) => {
      const timestamp = Date.parse(item.time);
      return Number.isFinite(timestamp) && timestamp >= windowStart;
    })
    .slice(-RUNTIME_HISTORY_MAX_POINTS);
}
