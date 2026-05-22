import type { ControllerConfig, ValidationIssue } from './controller';
import type { ConfigSnapshot } from './configWorkspace';
import type { HelperGroupConfig, HelperTestingSettings, HelperTrafficSettings } from './helperApi';

export const SETTINGS_BACKUP_SCHEMA = 'singdeck.settings.v1';

export type SettingsBackup = {
  schema: typeof SETTINGS_BACKUP_SCHEMA;
  exportedAt: string;
  controller: {
    config: ControllerConfig;
    urlSecretWarning: boolean;
  };
  helper: {
    helperUrl: string;
    configPath: string;
    testingSettings: HelperTestingSettings | null;
    trafficSettings?: HelperTrafficSettings | null;
    groupConfigs: Array<{ name: string; config: HelperGroupConfig }>;
  };
  proxies: {
    groupTestUrls: Record<string, string>;
    nodeTestUrls: Record<string, string>;
  };
  configWorkspace: {
    content: string;
    issues: ValidationIssue[];
    snapshots: ConfigSnapshot[];
    sourceEndpoint: string | null;
    lastLoadedAt: string | null;
  };
  ui: {
    railExpanded: boolean;
    strategyGroupOrder?: string[];
  };
};

export type SettingsBackupInput = Omit<SettingsBackup, 'schema' | 'exportedAt'>;

export function createSettingsBackup(input: SettingsBackupInput): SettingsBackup {
  return {
    schema: SETTINGS_BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    ...input,
    helper: {
      ...input.helper,
      groupConfigs: input.helper.groupConfigs
        .filter((item) => item.name.trim())
        .sort((left, right) => left.name.localeCompare(right.name))
    }
  };
}

export function serializeSettingsBackup(input: SettingsBackupInput): string {
  return JSON.stringify(createSettingsBackup(input), null, 2);
}

export function parseSettingsBackup(text: string): SettingsBackup {
  const parsed = JSON.parse(text) as unknown;
  assertSettingsBackup(parsed);
  return parsed;
}

function assertSettingsBackup(value: unknown): asserts value is SettingsBackup {
  const backup = requireRecord(value, 'backup');
  if (backup.schema !== SETTINGS_BACKUP_SCHEMA) {
    throw new Error('Invalid SingDeck settings backup.');
  }
  requireString(backup.exportedAt, 'exportedAt');

  const controller = requireRecord(backup.controller, 'controller');
  validateControllerConfig(controller.config, 'controller.config');
  requireBoolean(controller.urlSecretWarning, 'controller.urlSecretWarning');

  const helper = requireRecord(backup.helper, 'helper');
  requireString(helper.helperUrl, 'helper.helperUrl');
  requireString(helper.configPath, 'helper.configPath');
  if (helper.testingSettings !== null) {
    validateTestingSettings(helper.testingSettings, 'helper.testingSettings');
  }
  if (helper.trafficSettings !== undefined && helper.trafficSettings !== null) {
    validateTrafficSettings(helper.trafficSettings, 'helper.trafficSettings');
  }
  const groupConfigs = requireArray(helper.groupConfigs, 'helper.groupConfigs');
  groupConfigs.forEach((item, index) => {
    const group = requireRecord(item, `helper.groupConfigs[${index}]`);
    requireString(group.name, `helper.groupConfigs[${index}].name`);
    validateGroupConfig(group.config, `helper.groupConfigs[${index}].config`);
  });

  const proxies = requireRecord(backup.proxies, 'proxies');
  validateStringRecord(proxies.groupTestUrls, 'proxies.groupTestUrls');
  validateStringRecord(proxies.nodeTestUrls, 'proxies.nodeTestUrls');

  const configWorkspace = requireRecord(backup.configWorkspace, 'configWorkspace');
  requireString(configWorkspace.content, 'configWorkspace.content');
  requireArray(configWorkspace.issues, 'configWorkspace.issues');
  requireArray(configWorkspace.snapshots, 'configWorkspace.snapshots');
  requireNullableString(configWorkspace.sourceEndpoint, 'configWorkspace.sourceEndpoint');
  requireNullableString(configWorkspace.lastLoadedAt, 'configWorkspace.lastLoadedAt');

  const ui = requireRecord(backup.ui, 'ui');
  requireBoolean(ui.railExpanded, 'ui.railExpanded');
  if (ui.strategyGroupOrder !== undefined) {
    requireArray(ui.strategyGroupOrder, 'ui.strategyGroupOrder').forEach((item, index) =>
      requireString(item, `ui.strategyGroupOrder[${index}]`)
    );
  }
}

function validateControllerConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  requireString(config.controllerUrl, `${path}.controllerUrl`);
  requireString(config.secret, `${path}.secret`);
  if (config.note !== undefined) requireString(config.note, `${path}.note`);
  requireString(config.defaultTestUrl, `${path}.defaultTestUrl`);
  requireNumber(config.delayTestConcurrency, `${path}.delayTestConcurrency`);
  requireNumber(config.delayTestTimeoutMs, `${path}.delayTestTimeoutMs`);
  if (config.updatedAt !== undefined) requireString(config.updatedAt, `${path}.updatedAt`);
}

function validateTestingSettings(value: unknown, path: string): void {
  const settings = requireRecord(value, path);
  requireString(settings.defaultTestUrl, `${path}.defaultTestUrl`);
  requireNumber(settings.delayTestTimeoutMs, `${path}.delayTestTimeoutMs`);
  requireNumber(settings.minProbeIntervalSec, `${path}.minProbeIntervalSec`);
  requireNumber(settings.probeConcurrency, `${path}.probeConcurrency`);
}

function validateTrafficSettings(value: unknown, path: string): void {
  const settings = requireRecord(value, path);
  requireBoolean(settings.enabled, `${path}.enabled`);
  requireString(settings.browserProfile, `${path}.browserProfile`);
}

function validateGroupConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  requireString(config.testUrl, `${path}.testUrl`);
  requireBoolean(config.testUrlOverridden, `${path}.testUrlOverridden`);
  requireEnum(config.mode, ['delay', 'score'], `${path}.mode`);
  requireEnum(config.scheme, ['LatencyFirst', 'Balanced'], `${path}.scheme`);
  requireBoolean(config.autoSwitch, `${path}.autoSwitch`);
  requireBoolean(config.autoProbe, `${path}.autoProbe`);
  requireNumber(config.probeIntervalSec, `${path}.probeIntervalSec`);
}

function validateStringRecord(value: unknown, path: string): void {
  const record = requireRecord(value, path);
  Object.entries(record).forEach(([key, item]) => requireString(item, `${path}.${key}`));
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, path: string): void {
  if (typeof value !== 'string') {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be a string.`);
  }
}

function requireNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be a string or null.`);
  }
}

function requireNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be a finite number.`);
  }
}

function requireBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be a boolean.`);
  }
}

function requireEnum(value: unknown, allowed: string[], path: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Invalid SingDeck settings backup: ${path} has an unsupported value.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
