import { normalizeConnectionsResponse, type ConnectionsResponse } from '../core/connections';
import { normalizeHelperUrl, type HelperActiveProbe, type HelperScoresResponse } from '../core/helperApi';
import { summarizeRuntime } from '../core/runtime';
import { useConnectionStore } from './connectionStore';
import { useHelperStore } from './helperStore';
import { useRuntimeStore } from './runtimeStore';

const EVENT_RECONNECT_DELAY_MS = 1500;
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
};

export function connectHelperEventStream(helperUrl: string, options: EventStreamOptions = {}): () => void {
  if (typeof WebSocket === 'undefined') {
    return () => undefined;
  }

  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: WebSocket | null = null;

  const connect = () => {
    socket = new WebSocket(buildHelperEventWebSocketUrl(helperUrl));
    socket.onopen = () => options.onOpen?.();
    socket.onmessage = (event) => {
      const helperEvent = parseHelperEvent(event.data);
      if (helperEvent) {
        applyHelperEvent(helperEvent);
      }
    };
    socket.onclose = () => {
      options.onClose?.();
      if (!closed) {
        reconnectTimer = setTimeout(connect, EVENT_RECONNECT_DELAY_MS);
      }
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

export function buildHelperEventWebSocketUrl(helperUrl: string): string {
  const url = new URL(normalizeHelperUrl(helperUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v1/events';
  url.search = '';
  url.hash = '';
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
    const sample = {
      time,
      up: event.up,
      down: event.down,
      connections: event.connectionCount
    };

    useRuntimeStore.setState((state) => ({
      summary: summarizeRuntime({
        traffic: { up: event.up, down: event.down },
        totals: { uploadTotal: event.uploadTotal, downloadTotal: event.downloadTotal },
        connectionCount: event.connectionCount,
        mode: event.mode
      }),
      history: trimRuntimeHistory([...state.history, sample], now),
      lastTraffic: { up: event.up, down: event.down },
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
