export type OutboundDraft = {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  method?: string;
  password?: string;
  uuid?: string;
  tls?: { enabled: boolean };
  outbounds?: string[];
};

export type RuleHint = {
  severity: 'info';
  message: string;
};

export function parseSubscriptionLines(input: string): OutboundDraft[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseProxyUrl)
    .filter((outbound): outbound is OutboundDraft => outbound !== null);
}

export function buildSelectorOutbound(tag: string, outbounds: string[]): OutboundDraft {
  return {
    type: 'selector',
    tag,
    outbounds
  };
}

export function detectRuleHints(rules: unknown[]): RuleHint[] {
  const seen = new Set<string>();
  const hints: RuleHint[] = [];

  for (const rule of rules) {
    const key = JSON.stringify(rule);
    if (seen.has(key)) {
      hints.push({ severity: 'info', message: 'Duplicate rule detected.' });
      break;
    }
    seen.add(key);
  }

  return hints;
}

function parseProxyUrl(raw: string): OutboundDraft | null {
  try {
    if (raw.startsWith('ss://')) {
      return parseShadowsocks(raw);
    }

    const url = new URL(raw);
    const tag = decodeURIComponent(url.hash.replace(/^#/, '') || `${url.protocol.slice(0, -1)}-${url.hostname}`);
    const port = Number(url.port || 443);

    if (url.protocol === 'trojan:') {
      return {
        type: 'trojan',
        tag,
        server: url.hostname,
        server_port: port,
        password: decodeURIComponent(url.username)
      };
    }

    if (url.protocol === 'vless:') {
      return {
        type: 'vless',
        tag,
        server: url.hostname,
        server_port: port,
        uuid: decodeURIComponent(url.username),
        tls: url.searchParams.get('security') === 'tls' ? { enabled: true } : undefined
      };
    }
  } catch {
    return null;
  }

  return null;
}

function parseShadowsocks(raw: string): OutboundDraft | null {
  const withoutScheme = raw.slice('ss://'.length);
  const [body, hash = ''] = withoutScheme.split('#');
  const tag = decodeURIComponent(hash || 'shadowsocks');
  const atIndex = body.lastIndexOf('@');
  if (atIndex === -1) {
    return null;
  }

  const credential = atobUrlSafe(body.slice(0, atIndex));
  const [method, password] = credential.split(':');
  const [server, portText] = body.slice(atIndex + 1).split(':');

  return {
    type: 'shadowsocks',
    tag,
    method,
    password,
    server,
    server_port: Number(portText || 8388)
  };
}

function atobUrlSafe(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return atob(padded);
}
