import { describe, expect, it } from 'vitest';
import { buildSelectorOutbound, detectRuleHints, parseSubscriptionLines } from './subscriptions';

describe('subscriptions', () => {
  it('parses common proxy URLs into sing-box outbound drafts', () => {
    const outbounds = parseSubscriptionLines([
      'ss://YWVzLTEyOC1nY206cGFzcw@example.com:8388#hk-1',
      'trojan://secret@example.org:443#jp-1',
      'vless://uuid@example.net:443?security=tls#us-1'
    ].join('\n'));

    expect(outbounds.map((outbound) => outbound.type)).toEqual(['shadowsocks', 'trojan', 'vless']);
    expect(outbounds.map((outbound) => outbound.tag)).toEqual(['hk-1', 'jp-1', 'us-1']);
  });

  it('generates selector outbounds and rule hints', () => {
    expect(buildSelectorOutbound('Manual', ['hk-1', 'jp-1'])).toEqual({
      type: 'selector',
      tag: 'Manual',
      outbounds: ['hk-1', 'jp-1']
    });

    expect(
      detectRuleHints([
        { type: 'field', domain_suffix: ['example.com'], outbound: 'Proxy' },
        { type: 'field', domain_suffix: ['example.com'], outbound: 'Proxy' }
      ])
    ).toEqual([expect.objectContaining({ severity: 'info', message: expect.stringContaining('Duplicate') })]);
  });

  it('parses AnyTLS credentials and TLS query parameters', () => {
    const [outbound] = parseSubscriptionLines(
      'anytls://094a21e8-6633-4e81-9803-8c87dbde505b@9e1d7a04.hotssid.com:42101/?insecure=0&sni=d5.dirvt.com#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF%2001'
    );

    expect(outbound).toEqual({
      type: 'anytls',
      tag: '🇭🇰 香港 01',
      server: '9e1d7a04.hotssid.com',
      server_port: 42101,
      password: '094a21e8-6633-4e81-9803-8c87dbde505b',
      tls: {
        enabled: true,
        server_name: 'd5.dirvt.com',
        insecure: false
      }
    });
  });
});
