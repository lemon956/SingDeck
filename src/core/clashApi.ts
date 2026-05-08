import { classifyApiFailure, normalizeControllerUrl, type ApiFailure } from './controller';

export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ClashApiClientOptions = {
  baseUrl: string;
  secret: string;
  fetcher?: Fetcher;
};

export type DetectionResult =
  | { ok: true; version: string }
  | { ok: false; failure: ApiFailure };

export class ClashApiClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetcher: Fetcher;

  constructor(options: ClashApiClientOptions) {
    this.baseUrl = normalizeControllerUrl(options.baseUrl);
    this.secret = options.secret;
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
  }

  async getJson<T>(path: string): Promise<T> {
    const response = await this.request(path);
    return (await response.json()) as T;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(this.resolve(path), {
      ...init,
      headers: this.headers(init.headers)
    });

    if (!response.ok) {
      throw response;
    }

    return response;
  }

  async readStreamChunk(path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(path, { signal });
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
    }

    const { value } = await reader.read();
    await reader.cancel();
    return new TextDecoder().decode(value);
  }

  private resolve(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private headers(headers: HeadersInit | undefined): HeadersInit {
    if (!headers) {
      return this.secret ? { Authorization: `Bearer ${this.secret}` } : {};
    }

    const merged = new Headers(headers);
    if (this.secret) {
      merged.set('Authorization', `Bearer ${this.secret}`);
    }

    return Object.fromEntries(merged.entries());
  }
}

export async function detectController(options: {
  controllerUrl: string;
  secret: string;
  fetcher?: Fetcher;
}): Promise<DetectionResult> {
  const client = new ClashApiClient({
    baseUrl: options.controllerUrl,
    secret: options.secret,
    fetcher: options.fetcher
  });

  try {
    const data = await client.getJson<{ version?: string }>('/version');
    return {
      ok: true,
      version: typeof data.version === 'string' ? data.version : 'unknown'
    };
  } catch (error) {
    return {
      ok: false,
      failure: classifyApiFailure(error)
    };
  }
}
