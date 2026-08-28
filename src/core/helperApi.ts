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
  geminiLocationProbeEnabled?: boolean;
  nodeRisk?: HelperNodeRiskChecks;
};

export type HelperTestingSettings = {
  defaultTestUrl: string;
  delayTestTimeoutMs: number;
  minProbeIntervalSec: number;
  probeConcurrency: number;
  geminiLocationGroup?: string;
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

export type HelperGeminiLocationStatus =
  | 'success'
  | 'anti_abuse_challenge'
  | 'auth_error'
  | 'routing_error'
  | 'transport_error'
  | 'http_error'
  | 'parse_error';

export type HelperGeminiAuthMode = 'anonymous' | 'chrome';

export type HelperGeminiLocationResult = {
  status: HelperGeminiLocationStatus;
  label: string | null;
  source: string | null;
  authMode: HelperGeminiAuthMode;
  testedAt: string;
  error: string | null;
};

export type HelperRiskCheckStatus = 'success' | 'not_configured' | 'unavailable' | 'error';
export type HelperAddressFamily = 'ipv4' | 'ipv6';

export type HelperNodeRiskChecks = {
  exitIp: boolean;
  addressScope: boolean;
  networkIdentity: boolean;
  networkClass: boolean;
  routeSecurity: boolean;
  tor: boolean;
  privacy: boolean;
  abuse: boolean;
};

export type HelperNodeRiskRequest = Partial<HelperNodeRiskChecks>;

export type HelperProbeRequest = {
  concurrency?: number;
};

export type HelperInspectionRequest = {
  geminiLocation?: boolean;
  nodeRisk?: HelperNodeRiskRequest;
};

export type HelperExitIpResult = {
  status: HelperRiskCheckStatus;
  ip: string | null;
  port: number | null;
  family: HelperAddressFamily | null;
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperAddressScopeKind =
  | 'global_unicast'
  | 'unspecified'
  | 'private'
  | 'shared'
  | 'loopback'
  | 'link_local'
  | 'documentation'
  | 'benchmark'
  | 'multicast'
  | 'reserved'
  | 'broadcast'
  | 'unique_local'
  | 'ipv4_mapped'
  | 'nat64'
  | 'other_special';

export type HelperAddressScopeResult = {
  status: HelperRiskCheckStatus;
  classification: HelperAddressScopeKind | null;
  globallyReachable: boolean | null;
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperNetworkIdentityResult = {
  status: HelperRiskCheckStatus;
  prefix: string | null;
  originAsns: number[];
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperRpkiValidity =
  | 'valid'
  | 'invalid_asn'
  | 'invalid_length'
  | 'unknown'
  | 'unrouted'
  | 'mixed';

export type HelperRpkiOriginResult = {
  asn: number;
  checkStatus: HelperRiskCheckStatus;
  validity: HelperRpkiValidity;
  description: string | null;
  error: string | null;
};

export type HelperRpkiResult = {
  status: HelperRiskCheckStatus;
  validity: HelperRpkiValidity | null;
  prefix: string | null;
  origins: HelperRpkiOriginResult[];
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperTorVerdict = 'exit' | 'relay' | 'not_detected' | 'unknown';

export type HelperTorRelayEvidence = {
  fingerprint: string;
  nickname: string | null;
  exitAddressMatch: boolean;
  exitFlag: boolean;
};

export type HelperTorResult = {
  status: HelperRiskCheckStatus;
  verdict: HelperTorVerdict;
  relays: HelperTorRelayEvidence[];
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperPrivacySignal =
  | 'anonymous'
  | 'vpn'
  | 'proxy'
  | 'tor'
  | 'relay'
  | 'hosting'
  | 'residential_proxy';

export type HelperIpPrivacyResult = {
  status: HelperRiskCheckStatus;
  signals: HelperPrivacySignal[];
  service: string | null;
  confidence: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperNetworkClassVerdict =
  | 'residential'
  | 'data_center'
  | 'mobile'
  | 'business'
  | 'other'
  | 'mixed'
  | 'unknown';

export type HelperNetworkClassSignal =
  | 'residential'
  | 'data_center'
  | 'mobile'
  | 'business'
  | 'other';

export type HelperNetworkClassEvidence = {
  provider: string;
  status: HelperRiskCheckStatus;
  verdict: HelperNetworkClassVerdict;
  signals: HelperNetworkClassSignal[];
  userType: string | null;
  isHostingProvider: boolean | null;
  connectionType: string | null;
  isp: string | null;
  organization: string | null;
  autonomousSystemNumber: number | null;
  network: string | null;
  error: string | null;
};

export type HelperNetworkClassResult = {
  status: HelperRiskCheckStatus;
  verdict: HelperNetworkClassVerdict;
  userType: string | null;
  isHostingProvider: boolean | null;
  connectionType: string | null;
  isp: string | null;
  organization: string | null;
  autonomousSystemNumber: number | null;
  network: string | null;
  userCount: number | null;
  evidence: HelperNetworkClassEvidence[];
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperAbuseVerdict = 'no_reports' | 'reported' | 'high_confidence' | 'unknown';

export type HelperAbuseReputationResult = {
  status: HelperRiskCheckStatus;
  verdict: HelperAbuseVerdict;
  abuseConfidenceScore: number | null;
  totalReports: number | null;
  distinctReporters: number | null;
  lastReportedAt: string | null;
  isTor: boolean | null;
  isWhitelisted: boolean | null;
  usageType: string | null;
  isp: string | null;
  countryCode: string | null;
  source: string;
  checkedAt: string;
  error: string | null;
};

export type HelperNodeRiskReport = {
  checks: HelperNodeRiskChecks;
  exitIp: HelperExitIpResult | null;
  addressScope: HelperAddressScopeResult | null;
  networkIdentity: HelperNetworkIdentityResult | null;
  networkClass: HelperNetworkClassResult | null;
  routeSecurity: HelperRpkiResult | null;
  tor: HelperTorResult | null;
  privacy: HelperIpPrivacyResult | null;
  abuse: HelperAbuseReputationResult | null;
  assessedAt: string;
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
  geminiLocation?: HelperGeminiLocationResult | null;
  nodeRisk?: HelperNodeRiskReport | null;
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
  resetAt?: number | null;
  stale?: boolean;
  lastSuccessfulAt?: string | null;
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
  groupBy: 'host' | 'outbound' | 'rule' | 'strategy';
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
  topStrategies: HelperNetworkUsageTop;
  connections: HelperNetworkUsageConnections;
};

export type HelperNetworkUsageWindowRequest = {
  from: number;
  to: number;
  bucket?: 'minute' | 'hour';
  limit?: number;
  q?: string;
};

export type HelperNetworkUsageSourceTrendBucketMode = 'hour' | 'day';

export type HelperNetworkUsageSourceTrendPoint = {
  bucketStartMs: number;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
};

export type HelperNetworkUsageSourceTrendSource = {
  name: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  buckets: HelperNetworkUsageSourceTrendPoint[];
};

export type HelperNetworkUsageUnknownNode = {
  name: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
};

export type HelperNetworkUsageSourceTrend = {
  fromMs: number;
  toMs: number;
  bucket: HelperNetworkUsageSourceTrendBucketMode;
  sources: HelperNetworkUsageSourceTrendSource[];
  unknownNodes: HelperNetworkUsageUnknownNode[];
};

export type HelperNetworkUsageSourceTrendRequest = {
  days: number;
  bucket: HelperNetworkUsageSourceTrendBucketMode;
  tzOffsetMinutes: number;
};

type HelperApiClientOptions = {
  baseUrl?: string;
  fetcher?: Fetcher;
  token?: string;
};

export class HelperApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly token: string;

  constructor(options: HelperApiClientOptions = {}) {
    this.baseUrl = normalizeHelperUrl(options.baseUrl ?? DEFAULT_HELPER_URL);
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.token = (options.token ?? '').trim();
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
    const headers = new Headers(init.headers);
    if (this.token && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.token}`);
    }
    const response = await this.fetcher(this.resolve(path), { ...init, headers });
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
