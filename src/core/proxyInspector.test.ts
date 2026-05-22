import { describe, expect, it } from 'vitest';
import type { HelperGroupConfig, HelperNodeScore } from './helperApi';
import { isHelperServiceAvailable } from './helperStatus';
import { buildProxyInspectorModel } from './proxyInspector';
import type { ProxyRecord } from './proxies';
import { resolveProbeExecution } from './proxies';

const baseConfig: HelperGroupConfig = {
  testUrl: 'https://github.com',
  testUrlOverridden: true,
  mode: 'score',
  scheme: 'Balanced',
  autoSwitch: true,
  autoProbe: true,
  probeIntervalSec: 15 * 60
};

const score: HelperNodeScore = {
  name: 'Hong Kong 01',
  score: 96,
  delayMs: 144,
  components: {
    latency: 99,
    availability: 94,
    jitter: 90,
    freshness: 100
  },
  lastTestedAt: '2026-05-08T08:00:00.000Z',
  error: null
};

function proxy(overrides: Partial<ProxyRecord>): ProxyRecord {
  return {
    name: 'select',
    type: 'Selector',
    now: 'Hong Kong 01',
    all: ['Hong Kong 01', 'Hong Kong 02'],
    delay: null,
    ...overrides
  };
}

describe('proxy inspector model', () => {
  it('keeps score and delay visible for score based selector groups', () => {
    const group = proxy({});
    const model = buildProxyInspectorModel({
      group,
      config: baseConfig,
      execution: resolveProbeExecution(group, baseConfig.mode),
      helperAvailable: true,
      selectedDelay: 144,
      selectedScore: score,
      testUrl: baseConfig.testUrl
    });

    expect(model.metricLabel).toBe('96 / 144ms');
    expect(model.canEditScheme).toBe(true);
    expect(model.canAutoSwitch).toBe(true);
    expect(model.autoSwitchLabel).toBe('On');
    expect(model.scheduleLabel).toBe('On · 15 min');
    expect(model.runLabel).toBe('Run score');
  });

  it('marks native delay groups as sing-box managed', () => {
    const group = proxy({
      name: 'urltest',
      type: 'URLTest'
    });
    const config: HelperGroupConfig = {
      ...baseConfig,
      mode: 'delay'
    };
    const model = buildProxyInspectorModel({
      group,
      config,
      execution: resolveProbeExecution(group, config.mode),
      helperAvailable: true,
      selectedDelay: 66,
      testUrl: config.testUrl
    });

    expect(model.metricLabel).toBe('66ms');
    expect(model.executionLabel).toBe('native');
    expect(model.canEditScheme).toBe(false);
    expect(model.canAutoSwitch).toBe(false);
    expect(model.autoSwitchLabel).toBe('sing-box');
    expect(model.runLabel).toBe('Run delay');
  });

  it('allows selector auto switch when helper is healthy but controller polling has an error', () => {
    const group = proxy({});
    const model = buildProxyInspectorModel({
      group,
      config: baseConfig,
      execution: resolveProbeExecution(group, baseConfig.mode),
      helperAvailable: isHelperServiceAvailable({
        ok: true,
        version: '0.1.0',
        sqlite: true,
        controllerConfigured: true,
        controllerReachable: false,
        mobileConfigUrl: null,
        error: 'controller returned HTTP 401 Unauthorized'
      }),
      selectedDelay: 144,
      selectedScore: score,
      testUrl: baseConfig.testUrl
    });

    expect(model.canAutoSwitch).toBe(true);
    expect(model.autoSwitchLabel).toBe('On');
  });
});
