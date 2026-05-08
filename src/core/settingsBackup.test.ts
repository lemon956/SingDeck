import { describe, expect, it } from 'vitest';
import { createSettingsBackup, parseSettingsBackup } from './settingsBackup';

describe('settings backup', () => {
  it('creates a versioned backup with all configurable frontend sections', () => {
    const backup = createSettingsBackup({
      controller: {
        config: {
          controllerUrl: 'http://127.0.0.1:9527',
          secret: 'deck',
          note: 'local',
          defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
          delayTestConcurrency: 4,
          delayTestTimeoutMs: 5000
        },
        urlSecretWarning: false
      },
      helper: {
        helperUrl: 'http://127.0.0.1:9531',
        configPath: '/etc/sing-box/config.json',
        testingSettings: { defaultTestUrl: 'https://github.com', delayTestTimeoutMs: 5000 },
        groupConfigs: [
          {
            name: 'openai-us',
            config: {
              testUrl: 'https://api.openai.com',
              testUrlOverridden: true,
              mode: 'score',
              scheme: 'LatencyFirst',
              autoSwitch: true,
              autoProbe: true,
              probeIntervalSec: 900
            }
          }
        ]
      },
      proxies: {
        groupTestUrls: { 'openai-us': 'https://api.openai.com' },
        nodeTestUrls: {}
      },
      configWorkspace: {
        content: '{}',
        issues: [],
        snapshots: [],
        sourceEndpoint: null,
        lastLoadedAt: null
      },
      ui: { railExpanded: true, strategyGroupOrder: ['openai-us'] }
    });

    expect(backup.schema).toBe('singdeck.settings.v1');
    expect(backup.helper.groupConfigs[0].config.autoSwitch).toBe(true);
    expect(backup.proxies.groupTestUrls['openai-us']).toBe('https://api.openai.com');
    expect(backup.ui.strategyGroupOrder).toEqual(['openai-us']);
  });

  it('rejects JSON that is not a SingDeck settings backup', () => {
    expect(() => parseSettingsBackup('{"schema":"other"}')).toThrow(/Invalid SingDeck settings backup/);
  });
});
