export type ControllerConfig = {
  controllerUrl: string;
  secret: string;
  note?: string;
  defaultTestUrl: string;
  delayTestConcurrency: number;
  delayTestTimeoutMs: number;
  updatedAt?: string;
};

export type PartialControllerConfig = Pick<ControllerConfig, 'controllerUrl' | 'secret' | 'defaultTestUrl'>;

export type ValidationIssue = {
  severity: 'error' | 'info';
  path: string;
  message: string;
  suggestion?: string;
};

export type ApiFailureKind = 'auth' | 'not-found' | 'network' | 'server' | 'unknown';

export type ApiFailure = {
  kind: ApiFailureKind;
  title: string;
  detail: string;
};

const PANEL_DEFAULT_TEST_URL = 'https://cp.cloudflare.com/generate_204';

export function normalizeControllerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

export function parseControllerFromHash(hash: string): PartialControllerConfig | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) {
    return null;
  }

  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  const rawUrl = params.get('url') ?? params.get('host') ?? '';
  const controllerUrl = normalizeControllerUrl(rawUrl);

  if (!controllerUrl) {
    return null;
  }

  return {
    controllerUrl,
    secret: params.get('secret') ?? '',
    defaultTestUrl: params.get('testUrl') ?? params.get('test-url') ?? PANEL_DEFAULT_TEST_URL
  };
}

/**
 * Remove the `secret` parameter from a URL hash so it does not linger in the
 * address bar, history, or shared links after it has been captured into local
 * storage. Returns the hash unchanged when there is no secret to strip.
 */
export function stripSecretFromHash(hash: string): string {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) {
    return hash;
  }

  const params = new URLSearchParams(hash.slice(queryIndex + 1));
  if (!params.has('secret')) {
    return hash;
  }

  params.delete('secret');
  const query = params.toString();
  const prefix = hash.slice(0, queryIndex);
  return query ? `${prefix}?${query}` : prefix;
}

export function inferControllerFromLocation(origin: string, pathname: string): string | null {
  const normalizedPath = pathname.replace(/\/+$/, '');
  if (normalizedPath === '/ui' || normalizedPath.startsWith('/ui/')) {
    return normalizeControllerUrl(origin);
  }

  return null;
}

export function validateNecessaryConfig(input: string): ValidationIssue[] {
  let config: unknown;
  try {
    config = JSON.parse(input);
  } catch (error) {
    return [
      {
        severity: 'error',
        path: '$',
        message: error instanceof Error ? error.message : 'Invalid JSON'
      }
    ];
  }

  if (!isRecord(config)) {
    return [
      {
        severity: 'error',
        path: '$',
        message: 'Config must be a JSON object.'
      }
    ];
  }

  const clashApi = getRecord(config, 'experimental', 'clash_api');
  if (!clashApi) {
    return [
      {
        severity: 'error',
        path: '$.experimental.clash_api',
        message: 'experimental.clash_api is required for runtime dashboard control.'
      }
    ];
  }

  const externalController = readString(clashApi.external_controller);
  if (!externalController) {
    return [
      {
        severity: 'error',
        path: '$.experimental.clash_api.external_controller',
        message: 'external_controller is required to infer the Clash API endpoint.'
      }
    ];
  }

  const issues: ValidationIssue[] = [];
  const secret = readString(clashApi.secret);
  if (externalController.startsWith('0.0.0.0') && !secret) {
    issues.push({
      severity: 'info',
      path: '$.experimental.clash_api.secret',
      message: '0.0.0.0 without a secret exposes runtime control to reachable clients.',
      suggestion: 'Use a secret when the controller is reachable outside this machine.'
    });
  }

  return issues;
}

export function classifyApiFailure(error: unknown): ApiFailure {
  if (error instanceof Response) {
    if (error.status === 401 || error.status === 403) {
      return {
        kind: 'auth',
        title: 'Authentication failed',
        detail: 'The controller rejected the secret.'
      };
    }

    if (error.status === 404) {
      return {
        kind: 'not-found',
        title: 'API endpoint not found',
        detail: 'The controller responded, but the Clash API path was not found.'
      };
    }

    if (error.status >= 500) {
      return {
        kind: 'server',
        title: 'Controller error',
        detail: `The controller returned HTTP ${error.status}.`
      };
    }
  }

  if (error instanceof TypeError) {
    return {
      kind: 'network',
      title: 'Controller unreachable',
      detail:
        'The browser could not reach the controller. The fetch failed before any HTTP status, which usually means one of: the address/port is wrong or clash_api is not enabled, a TLS certificate is untrusted, CORS is blocking the panel origin, or Private Network Access is restricting a public page from reaching a private API.'
    };
  }

  return {
    kind: 'unknown',
    title: 'Unknown API failure',
    detail: error instanceof Error ? error.message : 'The controller request failed.'
  };
}

export function getDelayTestUrl(options: {
  nodeUrl?: string;
  groupUrl?: string;
  controllerUrl?: string;
  panelDefaultUrl?: string;
}): string {
  return (
    firstNonEmpty(options.nodeUrl, options.groupUrl, options.controllerUrl, options.panelDefaultUrl) ??
    PANEL_DEFAULT_TEST_URL
  );
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(source: Record<string, unknown>, firstKey: string, secondKey: string) {
  const first = source[firstKey];
  if (!isRecord(first)) {
    return null;
  }

  const second = first[secondKey];
  return isRecord(second) ? second : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
