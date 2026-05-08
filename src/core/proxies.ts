import type { ScoreMode } from './helperApi';

export const ZASHBOARD_SINGLE_NODE_TIMEOUT_MS = 5000;
export const ZASHBOARD_GROUP_NODE_TIMEOUT_MS = 1500;

export type ClashProxy = {
  name?: string;
  type?: string;
  now?: string;
  all?: string[];
  history?: Array<{ time?: string; delay?: number }>;
};

export type ProxiesResponse = {
  proxies?: Record<string, ClashProxy>;
};

export type ProxyRecord = {
  name: string;
  type: string;
  now: string;
  all: string[];
  delay: number | null;
};

export function normalizeProxiesResponse(response: ProxiesResponse): ProxyRecord[] {
  return Object.entries(response.proxies ?? {})
    .map(([name, proxy]) => ({
      name: proxy.name || name,
      type: proxy.type || 'Unknown',
      now: proxy.now || '',
      all: Array.isArray(proxy.all) ? proxy.all : [],
      delay: latestDelay(proxy.history)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function isSelectableProxyGroup(proxy: ProxyRecord): boolean {
  return proxy.type.toLowerCase() === 'selector' && proxy.all.length > 0;
}

export function isUrlTestProxyGroup(proxy: ProxyRecord): boolean {
  return proxy.type.toLowerCase().replace(/[^a-z0-9]/g, '').includes('urltest') && proxy.all.length > 0;
}

export function isFallbackProxyGroup(proxy: ProxyRecord): boolean {
  return proxy.type.toLowerCase().replace(/[^a-z0-9]/g, '') === 'fallback' && proxy.all.length > 0;
}

export function usesNativeGroupDelay(proxy: ProxyRecord): boolean {
  return isUrlTestProxyGroup(proxy) || isFallbackProxyGroup(proxy);
}

export type ProbeExecution =
  | {
      mode: 'native-urltest';
      label: 'native';
      autoSwitchManagedBySingBox: true;
    }
  | {
      mode: 'helper-delay';
      label: 'helper';
      autoSwitchManagedBySingBox: false;
    }
  | {
      mode: 'helper-score';
      label: 'score';
      autoSwitchManagedBySingBox: false;
    };

export function resolveProbeExecution(proxy: ProxyRecord, mode: ScoreMode): ProbeExecution {
  if (mode === 'score') {
    return { mode: 'helper-score', label: 'score', autoSwitchManagedBySingBox: false };
  }

  if (usesNativeGroupDelay(proxy)) {
    return { mode: 'native-urltest', label: 'native', autoSwitchManagedBySingBox: true };
  }

  return { mode: 'helper-delay', label: 'helper', autoSwitchManagedBySingBox: false };
}

export function displayMembersForGroup(group: ProxyRecord, proxyByName: Map<string, ProxyRecord>): string[] {
  if (group.name.toLowerCase() !== 'global') {
    return group.all;
  }

  return group.all.filter((member) => {
    const proxy = proxyByName.get(member);
    return !proxy || !isProxyGroup(proxy);
  });
}

export function buildProxyDelayPath(name: string, options: { timeout: number; url?: string }): string {
  const params = new URLSearchParams({ timeout: String(options.timeout) });
  const url = options.url?.trim();
  if (url) {
    params.set('url', url);
  }
  return `/proxies/${encodeURIComponent(name)}/delay?${params.toString()}`;
}

export function buildProxyGroupDelayPath(name: string, options: { timeout: number; url: string }): string {
  const params = new URLSearchParams({
    timeout: String(options.timeout),
    url: options.url
  });
  return `/group/${encodeURIComponent(name)}/delay?${params.toString()}`;
}

export function resolveNowProxyName(name: string, proxyByName: Map<string, ProxyRecord>): string {
  let current = proxyByName.get(name);
  if (!current) {
    return name;
  }

  const visited = new Set<string>();
  while (current.now && !visited.has(current.name)) {
    visited.add(current.name);
    const next = proxyByName.get(current.now);
    if (!next) {
      break;
    }
    current = next;
  }

  return current.name;
}

export function isProxyGroup(proxy: ProxyRecord): boolean {
  return proxy.all.length > 0;
}

export function isZashboardVisibleStrategyGroup(proxy: ProxyRecord): boolean {
  return isProxyGroup(proxy) && proxy.name.toLowerCase() !== 'global';
}

export function flattenProxyGroups(proxies: ProxyRecord[]): Array<{ group: string; member: string }> {
  return proxies
    .filter(isProxyGroup)
    .flatMap((proxy) => proxy.all.map((member) => ({ group: proxy.name, member })));
}

function latestDelay(history: ClashProxy['history']): number | null {
  if (!history?.length) {
    return null;
  }

  const latest = history.at(-1)?.delay;
  return typeof latest === 'number' ? latest : null;
}
