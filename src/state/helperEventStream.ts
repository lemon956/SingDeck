import { normalizeConnectionsResponse, type ConnectionsResponse } from '../core/connections';
import { normalizeHelperUrl, type HelperActiveProbe, type HelperScoresResponse } from '../core/helperApi';
import { summarizeRuntime } from '../core/runtime';
import { useConnectionStore } from './connectionStore';
import { useHelperStore } from './helperStore';
import { useRuntimeStore } from './runtimeStore';

const EVENT_RECONNECT_DELAY_MS = 1500;
const EVENT_RECONNECT_MAX_DELAY_MS = 30000;
const RUNTIME_HISTORY_WINDOW_MS = 5 * 60 * 1000;
const RUNTIME_HISTORY_MAX_POINTS = 140;

export type HelperEvent =
  | { type: 'probeStatus'; groups: HelperActiveProbe[] }
  | { type: 'probeScores'; scores: HelperScoresResponse; partial?: boolean }
  | { type: 'connectionsSnapshot'; snapshot: ConnectionsResponse; sampledAt: string }
  | {
      type: 'trafficSnapshot';
      up: number;
      down: number;
      uploadTotal: number;
      downloadTotal: number;
      connectionCount: number;
      mode: string;
      sampledAt: string;
    }
  | { type: 'error'; scope: string; message: string };

type EventStreamOptions = {
  onOpen?: () => void;
  onClose?: () => void;
  token?: string;
};

export function connectHelperEventStream(helperUrl: string, options: EventStreamOptions = {}): () => void {
  if (typeof WebSocket === 'undefined') {
    return () => undefined;
  }

  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;
  let attempt = 0;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) {
      return;
    }
    // Exponential backoff capped + jittered, so an offline helper does not get
    // hammered with a fixed-interval reconnect storm.
    const ceiling = Math.min(EVENT_RECONNECT_MAX_DELAY_MS, EVENT_RECONNECT_DELAY_MS * 2 ** attempt);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    socket = new WebSocket(buildHelperEventWebSocketUrl(helperUrl, options.token));
    socket.onopen = () => {
      attempt = 0;
      options.onOpen?.();
    };
    socket.onmessage = (event) => {
      const helperEvent = parseHelperEvent(event.data);
      if (helperEvent) {
        applyHelperEvent(helperEvent);
      }
    };
    socket.onclose = () => {
      options.onClose?.();
      scheduleReconnect();
    };
    socket.onerror = () => {
      socket?.close();
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
    }
    socket?.close();
  };
}

export function buildHelperEventWebSocketUrl(helperUrl: string, token?: string): string {
  const url = new URL(normalizeHelperUrl(helperUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v1/events';
  url.search = '';
  url.hash = '';
  if (token && token.trim()) {
    url.searchParams.set('token', token.trim());
  }
  return url.toString();
}

export function applyHelperEvent(event: HelperEvent): void {
  if (event.type === 'probeStatus') {
    useHelperStore.setState({
      activeProbeGroups: event.groups.map((group) => group.group),
      activeProbeNodesByGroup: Object.fromEntries(
        event.groups.map((group) => [group.group, Array.isArray(group.activeNodes) ? group.activeNodes : []])
      )
    });
    return;
  }

  if (event.type === 'probeScores') {
    useHelperStore.setState((state) => ({
      scoresByGroup: {
        ...state.scoresByGroup,
        [event.scores.group]: event.partial
          ? mergePartialScores(state.scoresByGroup[event.scores.group], event.scores)
          : event.scores
      }
    }));
    return;
  }

  if (event.type === 'connectionsSnapshot') {
    useConnectionStore.setState({
      connections: normalizeConnectionsResponse(event.snapshot),
      loading: false,
      error: null
    });
    return;
  }

  if (event.type === 'trafficSnapshot') {
    const sampledAt = new Date(event.sampledAt);
    const now = Number.isFinite(sampledAt.getTime()) ? sampledAt.getTime() : Date.now();
    const time = Number.isFinite(sampledAt.getTime()) ? event.sampledAt : new Date(now).toISOString();
    const up = finiteNumber(event.up);
    const down = finiteNumber(event.down);
    const uploadTotal = finiteNumber(event.uploadTotal);
    const downloadTotal = finiteNumber(event.downloadTotal);
    const connectionCount = finiteNumber(event.connectionCount);
    const sample = {
      time,
      up,
      down,
      connections: connectionCount
    };

    useRuntimeStore.setState((state) => ({
      summary: summarizeRuntime({
        traffic: { up, down },
        totals: { uploadTotal, downloadTotal },
        connectionCount,
        mode: event.mode
      }),
      history: trimRuntimeHistory([...state.history, sample], now),
      lastTraffic: { up, down },
      loading: false,
      error: null,
      lastUpdatedAt: time
    }));
    return;
  }

  if (event.type === 'error') {
    if (event.scope === 'realtime') {
      useRuntimeStore.setState({ error: event.message });
      useConnectionStore.setState({ error: event.message });
    }
  }
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseHelperEvent(data: unknown): HelperEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as HelperEvent;
    return typeof parsed.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function mergePartialScores(
  previous: HelperScoresResponse | undefined,
  partial: HelperScoresResponse
): HelperScoresResponse {
  if (!previous) {
    return partial;
  }

  const updates = new Map(partial.nodes.map((node) => [node.name, node]));
  const mergedNodes = previous.nodes.map((node) => updates.get(node.name) ?? node);
  const existingNames = new Set(previous.nodes.map((node) => node.name));
  const appendedNodes = partial.nodes.filter((node) => !existingNames.has(node.name));

  return {
    ...previous,
    mode: partial.mode,
    scheme: partial.scheme,
    testUrl: partial.testUrl,
    recommended: previous.recommended,
    applyError: previous.applyError,
    nodes: [...mergedNodes, ...appendedNodes]
  };
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
