import { create } from 'zustand';
import { ClashApiClient } from '../core/clashApi';
import { parseTrafficChunk, summarizeRuntime, type RuntimeSummary, type TrafficSnapshot } from '../core/runtime';
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
  lastTraffic: TrafficSnapshot;
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
const TRAFFIC_STREAM_TIMEOUT_MS = 2000;

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  summary: EMPTY_SUMMARY,
  history: [],
  lastTraffic: { up: 0, down: 0 },
  loading: false,
  error: null,
  lastUpdatedAt: null,
  refresh: async () => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl) {
      return;
    }

    const hasExistingData = get().lastUpdatedAt !== null;
    set({ loading: !hasExistingData, error: null });
    const client = new ClashApiClient({
      baseUrl: config.controllerUrl,
      secret: config.secret
    });

    try {
      const [configs, connections, traffic] = await Promise.all([
        client.getJson<ConfigsResponse>('/configs'),
        client.getJson<ConnectionsResponse>('/connections'),
        readTrafficSnapshotWithTimeout(client).catch(() => null)
      ]);
      const effectiveTraffic = traffic ?? get().lastTraffic;
      const connectionCount = connections.connections?.length ?? 0;

      const sampledAt = new Date();
      const sample = {
        time: sampledAt.toISOString(),
        up: effectiveTraffic.up,
        down: effectiveTraffic.down,
        connections: connectionCount
      };

      set((state) => ({
        summary: summarizeRuntime({
          traffic: effectiveTraffic,
          totals: {
            uploadTotal: connections.uploadTotal ?? 0,
            downloadTotal: connections.downloadTotal ?? 0
          },
          connectionCount,
          mode: configs.mode ?? 'unknown'
        }),
        history: trimRuntimeHistory([...state.history, sample], sampledAt.getTime()),
        lastTraffic: effectiveTraffic,
        loading: false,
        error: null,
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


async function readTrafficSnapshotWithTimeout(client: ClashApiClient): Promise<TrafficSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRAFFIC_STREAM_TIMEOUT_MS);
  try {
    return parseTrafficChunk(await client.readStreamChunk('/traffic', controller.signal));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

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
