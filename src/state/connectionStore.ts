import { create } from 'zustand';
import { ClashApiClient } from '../core/clashApi';
import {
  normalizeConnectionsResponse,
  normalizeLogLine,
  parseLogChunk,
  type ConnectionRecord,
  type ConnectionsResponse,
  type LogRecord
} from '../core/connections';
import { useControllerStore } from './controllerStore';

const MAX_LOG_ROWS = 500;

let logSeq = 0;
function stampLog(record: LogRecord): LogRecord {
  return { ...record, seq: (logSeq += 1) };
}

type ConnectionState = {
  connections: ConnectionRecord[];
  logs: LogRecord[];
  droppedLogCount: number;
  query: string;
  logQuery: string;
  logLevel: LogRecord['level'] | 'all';
  loading: boolean;
  error: string | null;
  logStreaming: boolean;
  logAbortController: AbortController | null;
  setQuery: (query: string) => void;
  setLogQuery: (query: string) => void;
  setLogLevel: (level: LogRecord['level'] | 'all') => void;
  refreshConnections: () => Promise<void>;
  closeConnection: (id: string) => Promise<void>;
  closeConnections: (ids: string[]) => Promise<void>;
  closeAllConnections: () => Promise<void>;
  addLogLine: (line: unknown) => void;
  clearLogs: () => void;
  startLogs: () => Promise<void>;
  stopLogs: () => void;
};

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  logs: [],
  droppedLogCount: 0,
  query: '',
  logQuery: '',
  logLevel: 'all',
  loading: false,
  error: null,
  logStreaming: false,
  logAbortController: null,
  setQuery: (query) => set({ query }),
  setLogQuery: (logQuery) => set({ logQuery }),
  setLogLevel: (logLevel) => set({ logLevel }),
  refreshConnections: async () => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl) {
      return;
    }
    set({ loading: true, error: null });
    const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
    try {
      const response = await client.getJson<ConnectionsResponse>('/connections');
      set({ connections: normalizeConnectionsResponse(response), loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'Failed to load connections' });
    }
  },
  closeConnection: async (id) => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl) {
      return;
    }
    const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
    try {
      await client.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await get().refreshConnections();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to close connection' });
    }
  },
  closeConnections: async (ids) => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl || ids.length === 0) {
      return;
    }
    const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
    try {
      await Promise.all(
        ids.map((id) => client.request(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }))
      );
      await get().refreshConnections();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to close connections' });
    }
  },
  closeAllConnections: async () => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl) {
      return;
    }
    const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });
    try {
      await client.request('/connections', { method: 'DELETE' });
      await get().refreshConnections();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to close connections' });
    }
  },
  addLogLine: (line) =>
    set((state) => trimLogs([...state.logs, stampLog(normalizeLogLine(line))], state.droppedLogCount)),
  clearLogs: () => set({ logs: [], droppedLogCount: 0 }),
  startLogs: async () => {
    const { config } = useControllerStore.getState();
    if (!config.controllerUrl || get().logStreaming) {
      return;
    }

    const abortController = new AbortController();
    set({ logStreaming: true, error: null, logAbortController: abortController });
    const client = new ClashApiClient({ baseUrl: config.controllerUrl, secret: config.secret });

    try {
      const response = await client.request('/logs', { signal: abortController.signal });
      const reader = response.body?.getReader();
      if (!reader) {
        set({ logStreaming: false, logAbortController: null });
        return;
      }

      const decoder = new TextDecoder();
      let carry = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const text = carry + decoder.decode(value, { stream: true });
        const lines = text.split(/\r?\n/);
        carry = lines.pop() ?? '';
        const records = parseLogChunk(lines.join('\n'));
        set((state) =>
          trimLogs([...state.logs, ...records.map((record) => stampLog(normalizeLogLine(record)))], state.droppedLogCount)
        );
      }

      set({ logStreaming: false, logAbortController: null });
    } catch (error) {
      if (abortController.signal.aborted) {
        set({ logStreaming: false, logAbortController: null });
        return;
      }

      set({
        logStreaming: false,
        logAbortController: null,
        error: error instanceof Error ? error.message : 'Failed to stream logs'
      });
    }
  },
  stopLogs: () => {
    get().logAbortController?.abort();
    set({ logStreaming: false, logAbortController: null });
  }
}));

function trimLogs(logs: LogRecord[], droppedLogCount: number): Pick<ConnectionState, 'logs' | 'droppedLogCount'> {
  if (logs.length <= MAX_LOG_ROWS) {
    return { logs, droppedLogCount };
  }

  return {
    logs: logs.slice(-MAX_LOG_ROWS),
    droppedLogCount: droppedLogCount + logs.length - MAX_LOG_ROWS
  };
}
