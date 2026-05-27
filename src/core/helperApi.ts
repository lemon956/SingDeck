import type { Fetcher } from './clashApi';
import { normalizeControllerUrl } from './controller';

export const DEFAULT_HELPER_URL = 'http://127.0.0.1:9531';

export type ScoreMode = 'delay' | 'score';
export type ScoreScheme = 'LatencyFirst' | 'Balanced';

export type HelperHealth = {
  ok: boolean;
  version: string;
  sqlite: boolean;
  controllerConfigured: boolean;
  controllerReachable: boolean;
  mobileConfigUrl: string | null;
  error: string | null;
};

export type HelperControllerConfig = {
  controllerUrl: string;
  secret: string;
};

export type HelperGroupConfig = {
  testUrl: string;
  testUrlOverridden: boolean;
  mode: ScoreMode;
  scheme: ScoreScheme;
  autoSwitch: boolean;
  autoProbe: boolean;
  probeIntervalSec: number;
};

export type HelperTestingSettings = {
  defaultTestUrl: string;
  delayTestTimeoutMs: number;
  minProbeIntervalSec: number;
  probeConcurrency: number;
};

export type HelperTrafficSettings = {
  enabled: boolean;
  browserProfile: string;
};

export type HelperNetworkUsageSettings = {
  enabled: boolean;
  retentionDays: number;
  sampleIntervalSec?: number;
};

export type HelperGroup = {
  name: string;
  kind: string;
  now: string;
  all: string[];
  config: HelperGroupConfig;
  recommended: string | null;
  applyError: string | null;
};

export type HelperGroupsResponse = {
  groups: HelperGroup[];
};

export type HelperNodeSource = {
  name: string;
  url: string;
  associate: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  nodeCount: number;
  nodes: string[];
};

export type HelperNodeSourcesResponse = {
  sources: HelperNodeSource[];
};

export type HelperActiveProbe = {
  group: string;
  startedAt: string;
  activeNodes?: string[];
};

export type HelperProbeStatusResponse = {
  groups: HelperActiveProbe[];
};

export type HelperScoreComponents = {
  latency: number;
  availability: number;
  jitter: number;
  freshness: number;
};

export type HelperScoreWeights = {
  latency: number;
  availability: number;
  jitter: number;
  freshness: number;
};

export type HelperNodeScoreRaw = {
  success: boolean;
  delayMs: number | null;
  error: string | null;
  testedAt: string | null;
  sampleWindowSec?: number | null;
  sampleCount?: number;
  successCount?: number;
  failureCount?: number;
  confidence?: number | null;
  latencyDelayMs?: number | null;
  latencyP50Ms?: number | null;
  latencyP90Ms?: number | null;
  jitterP50Ms?: number | null;
  jitterP95Ms?: number | null;
  jitterMs?: number | null;
  freshnessAgeMs?: number | null;
  freshnessState?: 'fresh' | 'stale' | 'expired' | null;
  gateReason?: 'none' | 'no_sample' | 'latest_failed' | 'expired' | string | null;
  mode?: ScoreMode;
  scheme?: ScoreScheme;
  weights?: HelperScoreWeights | null;
};

export type HelperNodeScore = {
  name: string;
  score: number;
  delayMs: number | null;
  components: HelperScoreComponents;
  lastTestedAt: string | null;
  error: string | null;
  raw?: HelperNodeScoreRaw;
};

export type HelperScoresResponse = {
  group: string;
  mode: ScoreMode;
  scheme: ScoreScheme;
  testUrl: string;
  recommended: string | null;
  applyError: string | null;
  nodes: HelperNodeScore[];
};

export type HelperConfigResponse = {
  source: string | null;
  format: string;
  content: string;
  loadedAt: string;
  error: string | null;
};

export type HelperConfigSource = {
  path: string;
};

export type HelperTrafficSnapshot = {
  id: string;
  name: string;
  homepage: string;
  planName: string | null;
  usedUploadBytes: number | null;
  usedDownloadBytes: number | null;
  usedTotalBytes: number | null;
  totalBytes: number | null;
  remainingBytes: number | null;
  usedRatio: number | null;
  expireAt: number | null;
  resetDay: number | null;
  fetchedAt: string;
  error: string | null;
};

export type HelperTrafficResponse = {
  providers: HelperTrafficSnapshot[];
  updatedAt: string;
  profile: string;
};

export type HelperNetworkUsageBucket = {
  bucketStartMs: number;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  connectionCount: number;
};

export type HelperNetworkUsageSummary = {
  fromMs: number;
  toMs: number;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  connectionCount: number;
  buckets: HelperNetworkUsageBucket[];
};

export type HelperNetworkUsageTopItem = {
  label: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  connectionCount: number;
};

export type HelperNetworkUsageTop = {
  groupBy: 'host' | 'outbound' | 'rule';
  items: HelperNetworkUsageTopItem[];
};

export type HelperNetworkUsageConnection = {
  id: string;
  host: string;
  network: string;
  rule: string;
  outbound: string;
  chains: string[];
  firstSeenMs: number;
  lastSeenMs: number;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
};

export type HelperNetworkUsageConnections = {
  connections: HelperNetworkUsageConnection[];
};

export type HelperNetworkUsageWindow = {
  summary: HelperNetworkUsageSummary;
  topHosts: HelperNetworkUsageTop;
  topOutbounds: HelperNetworkUsageTop;
  connections: HelperNetworkUsageConnections;
};

export type HelperNetworkUsageWindowRequest = {
  from: number;
  to: number;
  bucket?: 'minute' | 'hour';
  limit?: number;
  q?: string;
};

export type HelperToolsSettings = {
  proxyUrl: string;
  timeoutMs: number;
};

export type HelperHttpRouteMode = 'direct' | 'proxy';

export type HelperHttpHeader = {
  name: string;
  value: string;
};

export type HelperHttpExecuteRequest = {
  input: string;
  routeMode: HelperHttpRouteMode;
  proxyUrl?: string | null;
  timeoutMs?: number | null;
};

export type HelperParsedHttpRequest = {
  inputKind: 'url' | 'rawHttp' | 'curl';
  method: string;
  url: string;
  headers: HelperHttpHeader[];
  bodyBytes: number;
};

export type HelperHttpResponse = {
  status: number;
  statusText: string;
  headers: HelperHttpHeader[];
  bodyPreview: string;
  bodyBytes: number;
  truncated: boolean;
};

export type HelperObservedConnection = {
  id: string;
  target: string;
  rule: string;
  outbound: string;
  chains: string[];
};

export type HelperHttpExecuteResponse = {
  parsed: HelperParsedHttpRequest;
  warnings: string[];
  durationMs: number;
  response: HelperHttpResponse | null;
  error: string | null;
  observedConnections: HelperObservedConnection[];
};

type HelperApiClientOptions = {
  baseUrl?: string;
  fetcher?: Fetcher;
};

export class HelperApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(options: HelperApiClientOptions = {}) {
    this.baseUrl = normalizeHelperUrl(options.baseUrl ?? DEFAULT_HELPER_URL);
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return (await response.json()) as T;
  }

  async putJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' }
    });
    return (await response.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' }
    });
    return (await response.json()) as T;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(this.resolve(path), init);
    if (!response.ok) {
      throw response;
    }
    return response;
  }

  private resolve(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }
}

export function normalizeHelperUrl(value: string): string {
  return normalizeControllerUrl(value) || DEFAULT_HELPER_URL;
}

export function buildSingBoxRemoteProfileUri(downloadUrl: string, name = 'SingDeck'): string {
  const url = downloadUrl.trim();
  if (!url) {
    return '';
  }

  const profileName = name.trim() || 'SingDeck';
  return `sing-box://import-remote-profile?url=${encodeURIComponent(url)}#${encodeURIComponent(profileName)}`;
}
