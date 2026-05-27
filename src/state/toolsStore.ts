import { create } from 'zustand';
import {
  HelperApiClient,
  type HelperHttpExecuteResponse,
  type HelperHttpRouteMode
} from '../core/helperApi';
import { useHelperStore } from './helperStore';

export type ToolId = 'http-runner';
export type HttpRunnerPhase = 'idle' | 'parsing' | 'sending' | 'waiting' | 'complete' | 'error';

export type HttpHistoryRow = {
  id: string;
  method: string;
  target: string;
  status: number | null;
  durationMs: number;
  routeMode: HelperHttpRouteMode;
  ranAt: string;
  error: string | null;
};

type ToolsState = {
  activeToolId: ToolId;
  httpInput: string;
  routeMode: HelperHttpRouteMode;
  phase: HttpRunnerPhase;
  currentResult: HelperHttpExecuteResponse | null;
  error: string | null;
  history: HttpHistoryRow[];
  setActiveTool: (toolId: ToolId) => void;
  setHttpInput: (input: string) => void;
  setRouteMode: (mode: HelperHttpRouteMode) => void;
  clearCurrentResult: () => void;
  executeHttpRequest: () => Promise<void>;
};

const MAX_HTTP_HISTORY_ROWS = 10;

export const useToolsStore = create<ToolsState>((set, get) => ({
  activeToolId: 'http-runner',
  httpInput: '',
  routeMode: 'direct',
  phase: 'idle',
  currentResult: null,
  error: null,
  history: [],
  setActiveTool: (activeToolId) => set({ activeToolId }),
  setHttpInput: (httpInput) => set({ httpInput }),
  setRouteMode: (routeMode) => set({ routeMode }),
  clearCurrentResult: () => set({ currentResult: null, error: null, phase: 'idle' }),
  executeHttpRequest: async () => {
    const input = get().httpInput.trim();
    if (!input) {
      set({ phase: 'error', error: 'Request input cannot be empty.' });
      return;
    }

    set({ phase: 'parsing', error: null });
    const client = new HelperApiClient({ baseUrl: useHelperStore.getState().helperUrl });
    set({ phase: 'sending' });

    try {
      const result = await client.postJson<HelperHttpExecuteResponse>('/api/v1/tools/http-execute', {
        input,
        routeMode: get().routeMode
      });
      set((state) => ({
        phase: 'complete',
        currentResult: result,
        error: result.error,
        history: [historyRowFromResult(result, state.routeMode), ...state.history].slice(0, MAX_HTTP_HISTORY_ROWS)
      }));
    } catch (error) {
      set({
        phase: 'error',
        error: formatToolsError(error)
      });
    }
  }
}));

function historyRowFromResult(result: HelperHttpExecuteResponse, routeMode: HelperHttpRouteMode): HttpHistoryRow {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: result.parsed.method,
    target: result.parsed.url,
    status: result.response?.status ?? null,
    durationMs: result.durationMs,
    routeMode,
    ranAt: new Date().toISOString(),
    error: result.error
  };
}

function formatToolsError(error: unknown): string {
  if (error instanceof Response) {
    return `Helper HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : 'Tool request failed';
}
