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
});
