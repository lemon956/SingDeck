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
};

export type HelperTrafficSettings = {
  enabled: boolean;
  browserProfile: string;
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

export type HelperActiveProbe = {
  group: string;
  startedAt: string;
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

export type HelperNodeScore = {
  name: string;
  score: number;
  delayMs: number | null;
  components: HelperScoreComponents;
  lastTestedAt: string | null;
  error: string | null;
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
