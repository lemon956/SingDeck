export type RouteSimulation = {
  matchedRule: string;
  outbound: string;
};

export type GraphEdge = {
  from: string;
  to: string;
};

export type LinuxFinding = {
  kind: 'service' | 'permission' | 'network';
  message: string;
};

export function simulateRoute(config: unknown, target: string): RouteSimulation {
  const route = readRecord(readRecord(config, 'route'));
  const rules = Array.isArray(route?.rules) ? route.rules : [];

  for (const rule of rules) {
    const record = readRecord(rule);
    const suffixes = readStringArray(record?.domain_suffix);
    const matchedSuffix = suffixes.find((suffix) => target.endsWith(suffix));
    if (matchedSuffix) {
      return {
        matchedRule: `domain_suffix: ${matchedSuffix}`,
        outbound: readString(record?.outbound) || 'unknown'
      };
    }
  }

  return {
    matchedRule: 'final',
    outbound: readString(route?.final) || 'DIRECT'
  };
}

export function buildStrategyGraph(outbounds: Array<Record<string, unknown>>): GraphEdge[] {
  return outbounds.flatMap((outbound) => {
    const from = readString(outbound.tag);
    const members = readStringArray(outbound.outbounds);
    return members.map((to) => ({ from, to }));
  });
}

export function analyzeLinuxOutput(output: string): LinuxFinding[] {
  const lowered = output.toLowerCase();
  const findings: LinuxFinding[] = [];

  if (lowered.includes('active: failed') || lowered.includes('failed with result')) {
    findings.push({ kind: 'service', message: 'sing-box service appears to be failed.' });
  }

  if (lowered.includes('permission denied') || lowered.includes('operation not permitted')) {
    findings.push({ kind: 'permission', message: 'TUN/tproxy/capability permissions need review.' });
  }

  if (lowered.includes('network is unreachable')) {
    findings.push({ kind: 'network', message: 'Host routing or upstream connectivity is unavailable.' });
  }

  return findings;
}

export function toCompatProxyList(response: unknown): Array<{ name: string; type: string }> {
  const proxies = readRecord(readRecord(response, 'proxies'));
  return Object.entries(proxies ?? {}).map(([name, value]) => ({
    name,
    type: readString(readRecord(value)?.type) || 'Unknown'
  }));
}

function readRecord(value: unknown, key?: string): Record<string, unknown> | null {
  const target = key && typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : value;
  return typeof target === 'object' && target !== null && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
