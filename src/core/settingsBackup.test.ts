import { describe, expect, it } from 'vitest';
import {
  createSettingsBackup,
  mergeImportedSecret,
  parseSettingsBackup,
  serializeSettingsBackup
} from './settingsBackup';

function controllerInput(secret: string) {
  return {
    controller: {
      config: {
        controllerUrl: 'http://127.0.0.1:9527',
        secret,
        defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
        delayTestConcurrency: 4,
        delayTestTimeoutMs: 5000
      },
      urlSecretWarning: false
    },
    helper: { helperUrl: '', configPath: '', testingSettings: null, groupConfigs: [] },
    proxies: { groupTestUrls: {}, nodeTestUrls: {} },
    configWorkspace: { content: '{}', issues: [], snapshots: [], sourceEndpoint: null, lastLoadedAt: null },
    ui: { railExpanded: true }
  };
}

describe('settings backup secret redaction', () => {
  it('never writes the controller secret into an exported backup', () => {
    const backup = createSettingsBackup(controllerInput('super-secret'));
    expect(backup.controller.config.secret).toBe('');
  });

  it('keeps the current secret on import when the backup secret is blank', () => {
    expect(mergeImportedSecret('', 'stored-secret')).toBe('stored-secret');
    expect(mergeImportedSecret('  ', 'stored-secret')).toBe('stored-secret');
    expect(mergeImportedSecret('explicit', 'stored-secret')).toBe('explicit');
  });
});

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
        testingSettings: {
          defaultTestUrl: 'https://github.com',
          delayTestTimeoutMs: 5000,
          minProbeIntervalSec: 60,
          probeConcurrency: 4,
          geminiLocationGroup: 'openai-us'
        },
        trafficSettings: {
          enabled: true,
          browserProfile: '/home/alice/.config/google-chrome/Default'
        },
        networkUsageSettings: {
          enabled: true,
          retentionDays: 14,
          sampleIntervalSec: 30
        },
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
              probeIntervalSec: 900,
              sourceRestrictionEnabled: true,
              allowedNodeSources: ['provider-a', 'self-hosted'],
              allowUnlabeledNodes: false
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
    expect(backup.helper.groupConfigs[0].config.allowedNodeSources).toEqual([
      'provider-a',
      'self-hosted'
    ]);
    expect(backup.helper.trafficSettings?.browserProfile).toBe('/home/alice/.config/google-chrome/Default');
    expect(backup.helper.testingSettings?.geminiLocationGroup).toBe('openai-us');
    expect(backup.helper.networkUsageSettings).toEqual({
      enabled: true,
      retentionDays: 14,
      sampleIntervalSec: 30
    });
    expect(backup.proxies.groupTestUrls['openai-us']).toBe('https://api.openai.com');
    expect(backup.ui.strategyGroupOrder).toEqual(['openai-us']);
  });

  it('removes runtime configuration content and snapshots from serialized backups', () => {
    const text = serializeSettingsBackup({
      ...controllerInput('controller-secret'),
      configWorkspace: {
        content: '{"outbounds":[{"password":"node-password"}]}',
        issues: [{ severity: 'error', path: 'outbounds.0', message: 'synthetic issue' }],
        snapshots: [
          {
            id: 'snapshot-1',
            name: 'before import',
            content: '{"private_key":"private-key-value"}',
            issues: [],
            createdAt: '2026-08-28T09:00:00.000Z'
          }
        ],
        sourceEndpoint: 'helper:/api/v1/config',
        lastLoadedAt: '2026-08-28T09:00:00.000Z'
      }
    });

    expect(text).not.toContain('controller-secret');
    expect(text).not.toContain('node-password');
    expect(text).not.toContain('private-key-value');
    const backup = parseSettingsBackup(text);
    expect(backup.configWorkspace).toMatchObject({
      content: '',
      issues: [],
      snapshots: [],
      contentRedacted: true
    });
  });

  it('accepts a deeply valid legacy workspace backup without the redaction marker', () => {
    const legacy = createSettingsBackup(controllerInput(''));
    delete legacy.configWorkspace.contentRedacted;
    legacy.configWorkspace.content = '{}';
    legacy.configWorkspace.issues = [
      { severity: 'info', path: 'experimental.clash_api', message: 'legacy diagnostic' }
    ];
    legacy.configWorkspace.snapshots = [
      {
        id: 'legacy-1',
        name: 'legacy snapshot',
        content: '{}',
        issues: [],
        createdAt: '2026-08-28T09:00:00.000Z'
      }
    ];

    expect(parseSettingsBackup(JSON.stringify(legacy)).configWorkspace.content).toBe('{}');
  });

  it('rejects JSON that is not a SingDeck settings backup', () => {
    expect(() => parseSettingsBackup('{"schema":"other"}')).toThrow(/Invalid SingDeck settings backup/);
  });

  it('rejects backups with invalid nested settings before import can mutate stores', () => {
    expect(() =>
      parseSettingsBackup(
        JSON.stringify({
          schema: 'singdeck.settings.v1',
          exportedAt: new Date().toISOString(),
          controller: {
            config: {
              controllerUrl: 'http://127.0.0.1:9527',
              secret: '',
              defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
              delayTestConcurrency: 'fast',
              delayTestTimeoutMs: 5000
            },
            urlSecretWarning: false
          },
          helper: {
            helperUrl: 'http://127.0.0.1:9531',
            configPath: '',
            testingSettings: null,
            groupConfigs: []
          },
          proxies: { groupTestUrls: {}, nodeTestUrls: {} },
          configWorkspace: { content: '{}', issues: [], snapshots: [], sourceEndpoint: null, lastLoadedAt: null },
          ui: { railExpanded: true }
        })
      )
    ).toThrow(/delayTestConcurrency must be a finite number/);
  });

  it('rejects malformed workspace diagnostics and snapshots', () => {
    const malformedIssue = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    malformedIssue.configWorkspace.contentRedacted = false;
    malformedIssue.configWorkspace.issues = [{ severity: 'fatal', path: 1, message: false }];
    expect(() => parseSettingsBackup(JSON.stringify(malformedIssue))).toThrow(/severity has an unsupported value/);

    const malformedSnapshot = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    malformedSnapshot.configWorkspace.contentRedacted = false;
    malformedSnapshot.configWorkspace.snapshots = [{ id: '', name: 'snapshot' }];
    expect(() => parseSettingsBackup(JSON.stringify(malformedSnapshot))).toThrow(/snapshots\[0\]\.id must not be empty/);
  });

  it('rejects out-of-range network usage and testing settings', () => {
    const invalidNetworkUsage = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    invalidNetworkUsage.helper.networkUsageSettings = {
      enabled: true,
      retentionDays: 91,
      sampleIntervalSec: 1
    };
    expect(() => parseSettingsBackup(JSON.stringify(invalidNetworkUsage))).toThrow(
      /retentionDays must be an integer from 1 to 90/
    );

    const invalidTesting = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    invalidTesting.helper.testingSettings = {
      defaultTestUrl: 'https://example.com',
      delayTestTimeoutMs: 5000,
      minProbeIntervalSec: 60,
      probeConcurrency: 4,
      geminiLocationGroup: 42
    };
    expect(() => parseSettingsBackup(JSON.stringify(invalidTesting))).toThrow(/geminiLocationGroup must be a string/);
  });

  it('rejects incomplete node risk settings and redacted backups carrying snapshots', () => {
    const invalidRisk = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    invalidRisk.helper.groupConfigs = [
      {
        name: 'select',
        config: {
          testUrl: 'https://example.com',
          testUrlOverridden: true,
          mode: 'score',
          scheme: 'Balanced',
          autoSwitch: true,
          autoProbe: false,
          probeIntervalSec: 900,
          nodeRisk: { exitIp: true }
        }
      }
    ];
    expect(() => parseSettingsBackup(JSON.stringify(invalidRisk))).toThrow(/nodeRisk.addressScope must be a boolean/);

    const invalidRedacted = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    invalidRedacted.configWorkspace.snapshots = [
      { id: '1', name: 'unsafe', content: '{}', issues: [], createdAt: '2026-08-28T09:00:00.000Z' }
    ];
    expect(() => parseSettingsBackup(JSON.stringify(invalidRedacted))).toThrow(
      /redacted config workspace must not contain content or snapshots/
    );
  });

  it('rejects a source restriction that cannot select any nodes', () => {
    const invalidRestriction = JSON.parse(JSON.stringify(createSettingsBackup(controllerInput(''))));
    invalidRestriction.helper.groupConfigs = [
      {
        name: 'select',
        config: {
          testUrl: 'https://example.com',
          testUrlOverridden: true,
          mode: 'score',
          scheme: 'Balanced',
          autoSwitch: true,
          autoProbe: false,
          probeIntervalSec: 900,
          sourceRestrictionEnabled: true,
          allowedNodeSources: [],
          allowUnlabeledNodes: false
        }
      }
    ];

    expect(() => parseSettingsBackup(JSON.stringify(invalidRestriction))).toThrow(
      /must allow at least one node source or unlabeled nodes/
    );
  });
});
