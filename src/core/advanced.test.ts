import { describe, expect, it } from 'vitest';
import { analyzeLinuxOutput, buildStrategyGraph, simulateRoute, toCompatProxyList } from './advanced';

describe('advanced tools', () => {
  it('simulates a simple domain route against imported config', () => {
    expect(
      simulateRoute(
        {
          route: {
            rules: [{ domain_suffix: ['example.com'], outbound: 'Proxy' }],
            final: 'DIRECT'
          }
        },
        'www.example.com'
      )
    ).toEqual({ matchedRule: 'domain_suffix: example.com', outbound: 'Proxy' });
  });

  it('builds selector strategy graph edges from outbounds', () => {
    expect(
      buildStrategyGraph([
        { type: 'selector', tag: 'Manual', outbounds: ['hk-1'] },
        { type: 'vless', tag: 'hk-1' }
      ])
    ).toEqual([{ from: 'Manual', to: 'hk-1' }]);
  });

  it('extracts useful Linux diagnostics from pasted output', () => {
    expect(analyzeLinuxOutput('Active: failed\npermission denied opening tun')).toEqual([
      expect.objectContaining({ kind: 'service' }),
      expect.objectContaining({ kind: 'permission' })
    ]);
  });

  it('converts proxy maps into compatibility lists', () => {
    expect(toCompatProxyList({ proxies: { A: { type: 'Selector' } } })).toEqual([{ name: 'A', type: 'Selector' }]);
  });
});
