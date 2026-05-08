import { describe, expect, it } from 'vitest';
import {
  ZASHBOARD_GROUP_NODE_TIMEOUT_MS,
  buildProxyDelayPath,
  buildProxyGroupDelayPath,
  flattenProxyGroups,
  isProxyGroup,
  isZashboardVisibleStrategyGroup,
  isSelectableProxyGroup,
  normalizeProxiesResponse,
  resolveNowProxyName,
  resolveProbeExecution
} from './proxies';

describe('proxy normalization', () => {
  it('normalizes Clash proxy response into sorted proxy records', () => {
    const proxies = normalizeProxiesResponse({
      proxies: {
        DIRECT: { type: 'Direct', name: 'DIRECT' },
        Auto: { type: 'URLTest', now: 'hk-1', all: ['hk-1', 'jp-1'], history: [{ delay: 82 }] },
        Manual: { type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'] }
      }
    });

    expect(proxies.map((proxy) => proxy.name)).toEqual(['Auto', 'DIRECT', 'Manual']);
    expect(proxies.find((proxy) => proxy.name === 'Manual')).toMatchObject({
      type: 'Selector',
      now: 'jp-1',
      all: ['hk-1', 'jp-1']
    });
  });

  it('identifies strategy groups and flattens their members', () => {
    const proxies = normalizeProxiesResponse({
      proxies: {
        Auto: { type: 'URLTest', now: 'hk-1', all: ['hk-1', 'jp-1'] },
        Manual: { type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'] },
        'hk-1': { type: 'Vless', name: 'hk-1' },
        'jp-1': { type: 'Trojan', name: 'jp-1' }
      }
    });

    expect(isProxyGroup(proxies.find((proxy) => proxy.name === 'Auto')!)).toBe(true);
    expect(isSelectableProxyGroup(proxies.find((proxy) => proxy.name === 'Manual')!)).toBe(true);
    expect(flattenProxyGroups(proxies)).toEqual([
      { group: 'Auto', member: 'hk-1' },
      { group: 'Auto', member: 'jp-1' },
      { group: 'Manual', member: 'hk-1' },
      { group: 'Manual', member: 'jp-1' }
    ]);
  });

  it('uses native group delay for URLTest and Fallback groups in delay mode', () => {
    const proxies = normalizeProxiesResponse({
      proxies: {
        Auto: { type: 'URLTest', now: 'hk-1', all: ['hk-1', 'jp-1'] },
        SpacedAuto: { type: 'URL Test', now: 'hk-1', all: ['hk-1', 'jp-1'] },
        GLOBAL: { type: 'Fallback', now: 'Manual', all: ['Manual', 'hk-1'] },
        Manual: { type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'] }
      }
    });
    const auto = proxies.find((proxy) => proxy.name === 'Auto')!;
    const spacedAuto = proxies.find((proxy) => proxy.name === 'SpacedAuto')!;
    const global = proxies.find((proxy) => proxy.name === 'GLOBAL')!;
    const manual = proxies.find((proxy) => proxy.name === 'Manual')!;

    expect(resolveProbeExecution(auto, 'delay')).toEqual({
      mode: 'native-urltest',
      label: 'native',
      autoSwitchManagedBySingBox: true
    });
    expect(resolveProbeExecution(global, 'delay')).toEqual({
      mode: 'native-urltest',
      label: 'native',
      autoSwitchManagedBySingBox: true
    });
    expect(resolveProbeExecution(manual, 'delay')).toEqual({
      mode: 'helper-delay',
      label: 'helper',
      autoSwitchManagedBySingBox: false
    });
    expect(resolveProbeExecution(spacedAuto, 'delay').mode).toBe('native-urltest');
    expect(resolveProbeExecution(auto, 'score')).toEqual({
      mode: 'helper-score',
      label: 'score',
      autoSwitchManagedBySingBox: false
    });
  });

  it('hides GLOBAL from zashboard-style strategy group lists', () => {
    const proxies = normalizeProxiesResponse({
      proxies: {
        GLOBAL: { type: 'Fallback', now: 'select', all: ['select', 'download-node', 'hk-1', 'notice'] },
        select: { type: 'Selector', now: 'hk-1', all: ['hk-1', 'jp-1'] },
        'download-node': { type: 'Selector', now: 'hk-1', all: ['hk-1'] },
        'hk-1': { type: 'Trojan', name: 'hk-1' },
        notice: { type: 'Trojan', name: 'notice' }
      }
    });

    expect(proxies.filter(isZashboardVisibleStrategyGroup).map((proxy) => proxy.name)).toEqual(['download-node', 'select']);
  });

  it('builds node delay paths with optional native URL omission', () => {
    expect(buildProxyDelayPath('Auto Group', { timeout: 5000 })).toBe('/proxies/Auto%20Group/delay?timeout=5000');
    expect(
      buildProxyDelayPath('hk-1', {
        timeout: 5000,
        url: 'https://cp.cloudflare.com/generate_204'
      })
    ).toBe('/proxies/hk-1/delay?timeout=5000&url=https%3A%2F%2Fcp.cloudflare.com%2Fgenerate_204');
  });

  it('matches zashboard delay path and now-chain resolution semantics', () => {
    const proxies = normalizeProxiesResponse({
      proxies: {
        Manual: { type: 'Selector', now: 'Auto', all: ['Auto', 'jp-1'] },
        Auto: { type: 'URLTest', now: 'hk-1', all: ['hk-1', 'jp-1'], history: [{ delay: 40 }] },
        'hk-1': { type: 'Trojan', name: 'hk-1', history: [{ delay: 61 }] },
        'jp-1': { type: 'Trojan', name: 'jp-1', history: [{ delay: 93 }] }
      }
    });
    const proxyByName = new Map(proxies.map((proxy) => [proxy.name, proxy]));

    expect(resolveNowProxyName('Manual', proxyByName)).toBe('hk-1');
    expect(ZASHBOARD_GROUP_NODE_TIMEOUT_MS).toBe(1500);
    expect(
      buildProxyGroupDelayPath('Auto Group', {
        timeout: 5000,
        url: 'https://www.gstatic.com/generate_204'
      })
    ).toBe('/group/Auto%20Group/delay?timeout=5000&url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204');
  });
});
