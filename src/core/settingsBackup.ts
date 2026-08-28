import type { ControllerConfig, ValidationIssue } from './controller';
import type { ConfigSnapshot } from './configWorkspace';
import type {
  HelperGroupConfig,
  HelperNetworkUsageSettings,
  HelperNodeRiskChecks,
  HelperTestingSettings,
  HelperTrafficSettings
} from './helperApi';

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
    networkUsageSettings?: HelperNetworkUsageSettings | null;
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
    contentRedacted?: boolean;
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
    controller: {
      ...input.controller,
      // The Clash API secret is a credential: never write it to an exported
      // file. Import restores it from the current browser (see mergeImportedSecret).
      config: { ...input.controller.config, secret: '' }
    },
    helper: {
      ...input.helper,
      groupConfigs: input.helper.groupConfigs
        .filter((item) => item.name.trim())
        .sort((left, right) => left.name.localeCompare(right.name))
    },
    // Runtime configuration content can carry outbound passwords, UUIDs,
    // private keys, and tokens. Settings backups intentionally keep only its
    // non-sensitive source metadata; importing this backup leaves the current
    // workspace untouched.
    configWorkspace: {
      ...input.configWorkspace,
      content: '',
      issues: [],
      snapshots: [],
      contentRedacted: true
    }
  };
}

/**
 * Resolve the controller secret to apply when importing a backup. Exported
 * backups carry a blank secret (redacted), so a blank imported value keeps the
 * secret already stored in this browser; a non-blank value overrides it.
 */
export function mergeImportedSecret(importedSecret: string, currentSecret: string): string {
  return importedSecret.trim() ? importedSecret : currentSecret;
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
  if (helper.networkUsageSettings !== undefined && helper.networkUsageSettings !== null) {
    validateNetworkUsageSettings(helper.networkUsageSettings, 'helper.networkUsageSettings');
  }
  const groupConfigs = requireArray(helper.groupConfigs, 'helper.groupConfigs');
  groupConfigs.forEach((item, index) => {
    const group = requireRecord(item, `helper.groupConfigs[${index}]`);
    requireNonEmptyString(group.name, `helper.groupConfigs[${index}].name`);
    validateGroupConfig(group.config, `helper.groupConfigs[${index}].config`);
  });

  const proxies = requireRecord(backup.proxies, 'proxies');
  validateStringRecord(proxies.groupTestUrls, 'proxies.groupTestUrls');
  validateStringRecord(proxies.nodeTestUrls, 'proxies.nodeTestUrls');

  const configWorkspace = requireRecord(backup.configWorkspace, 'configWorkspace');
  requireString(configWorkspace.content, 'configWorkspace.content');
  validateIssues(configWorkspace.issues, 'configWorkspace.issues');
  validateSnapshots(configWorkspace.snapshots, 'configWorkspace.snapshots');
  requireNullableString(configWorkspace.sourceEndpoint, 'configWorkspace.sourceEndpoint');
  requireNullableString(configWorkspace.lastLoadedAt, 'configWorkspace.lastLoadedAt');
  if (configWorkspace.contentRedacted !== undefined) {
    requireBoolean(configWorkspace.contentRedacted, 'configWorkspace.contentRedacted');
  }
  if (configWorkspace.contentRedacted === true) {
    if (configWorkspace.content !== '' || requireArray(configWorkspace.snapshots, 'configWorkspace.snapshots').length > 0) {
      throw new Error('Invalid SingDeck settings backup: redacted config workspace must not contain content or snapshots.');
    }
  }

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
  requireNonEmptyString(config.defaultTestUrl, `${path}.defaultTestUrl`);
  requireIntegerInRange(config.delayTestConcurrency, 1, 64, `${path}.delayTestConcurrency`);
  requireIntegerInRange(config.delayTestTimeoutMs, 500, 60_000, `${path}.delayTestTimeoutMs`);
  if (config.updatedAt !== undefined) requireString(config.updatedAt, `${path}.updatedAt`);
}

function validateTestingSettings(value: unknown, path: string): void {
  const settings = requireRecord(value, path);
  requireNonEmptyString(settings.defaultTestUrl, `${path}.defaultTestUrl`);
  requireIntegerInRange(settings.delayTestTimeoutMs, 500, 60_000, `${path}.delayTestTimeoutMs`);
  requireIntegerInRange(settings.minProbeIntervalSec, 60, 86_400, `${path}.minProbeIntervalSec`);
  requireIntegerInRange(settings.probeConcurrency, 1, 64, `${path}.probeConcurrency`);
  if (settings.geminiLocationGroup !== undefined) {
    requireString(settings.geminiLocationGroup, `${path}.geminiLocationGroup`);
  }
}

function validateTrafficSettings(value: unknown, path: string): void {
  const settings = requireRecord(value, path);
  requireBoolean(settings.enabled, `${path}.enabled`);
  requireString(settings.browserProfile, `${path}.browserProfile`);
}

function validateNetworkUsageSettings(value: unknown, path: string): void {
  const settings = requireRecord(value, path);
  requireBoolean(settings.enabled, `${path}.enabled`);
  requireIntegerInRange(settings.retentionDays, 1, 90, `${path}.retentionDays`);
  if (settings.sampleIntervalSec !== undefined) {
    requireIntegerInRange(settings.sampleIntervalSec, 2, 3600, `${path}.sampleIntervalSec`);
  }
}

function validateGroupConfig(value: unknown, path: string): void {
  const config = requireRecord(value, path);
  requireString(config.testUrl, `${path}.testUrl`);
  requireBoolean(config.testUrlOverridden, `${path}.testUrlOverridden`);
  requireEnum(config.mode, ['delay', 'score'], `${path}.mode`);
  requireEnum(config.scheme, ['LatencyFirst', 'Balanced'], `${path}.scheme`);
  requireBoolean(config.autoSwitch, `${path}.autoSwitch`);
  requireBoolean(config.autoProbe, `${path}.autoProbe`);
  requireIntegerInRange(config.probeIntervalSec, 1, 86_400, `${path}.probeIntervalSec`);
  if (config.geminiLocationProbeEnabled !== undefined) {
    requireBoolean(config.geminiLocationProbeEnabled, `${path}.geminiLocationProbeEnabled`);
  }
  if (config.nodeRisk !== undefined) {
    validateNodeRiskChecks(config.nodeRisk, `${path}.nodeRisk`);
  }
  if (config.sourceRestrictionEnabled !== undefined) {
    requireBoolean(config.sourceRestrictionEnabled, `${path}.sourceRestrictionEnabled`);
  }
  if (config.allowedNodeSources !== undefined) {
    requireArray(config.allowedNodeSources, `${path}.allowedNodeSources`).forEach((source, index) =>
      requireNonEmptyString(source, `${path}.allowedNodeSources[${index}]`)
    );
  }
  if (config.allowUnlabeledNodes !== undefined) {
    requireBoolean(config.allowUnlabeledNodes, `${path}.allowUnlabeledNodes`);
  }
  if (
    config.sourceRestrictionEnabled === true &&
    (!Array.isArray(config.allowedNodeSources) || config.allowedNodeSources.length === 0) &&
    config.allowUnlabeledNodes !== true
  ) {
    throw new Error(
      `Invalid SingDeck settings backup: ${path} must allow at least one node source or unlabeled nodes when source restriction is enabled.`
    );
  }
}

function validateNodeRiskChecks(value: unknown, path: string): asserts value is HelperNodeRiskChecks {
  const checks = requireRecord(value, path);
  (['exitIp', 'addressScope', 'networkIdentity', 'networkClass', 'routeSecurity', 'tor', 'privacy', 'abuse'] as const)
    .forEach((key) => requireBoolean(checks[key], `${path}.${key}`));
}

function validateIssues(value: unknown, path: string): void {
  requireArray(value, path).forEach((item, index) => {
    const issue = requireRecord(item, `${path}[${index}]`);
    requireEnum(issue.severity, ['error', 'info'], `${path}[${index}].severity`);
    requireString(issue.path, `${path}[${index}].path`);
    requireString(issue.message, `${path}[${index}].message`);
    if (issue.suggestion !== undefined) {
      requireString(issue.suggestion, `${path}[${index}].suggestion`);
    }
  });
}

function validateSnapshots(value: unknown, path: string): void {
  requireArray(value, path).forEach((item, index) => {
    const snapshot = requireRecord(item, `${path}[${index}]`);
    requireNonEmptyString(snapshot.id, `${path}[${index}].id`);
    requireNonEmptyString(snapshot.name, `${path}[${index}].name`);
    requireString(snapshot.content, `${path}[${index}].content`);
    validateIssues(snapshot.issues, `${path}[${index}].issues`);
    requireString(snapshot.createdAt, `${path}[${index}].createdAt`);
  });
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

function requireNonEmptyString(value: unknown, path: string): void {
  requireString(value, path);
  if (!(value as string).trim()) {
    throw new Error(`Invalid SingDeck settings backup: ${path} must not be empty.`);
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

function requireIntegerInRange(value: unknown, min: number, max: number, path: string): void {
  requireNumber(value, path);
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`Invalid SingDeck settings backup: ${path} must be an integer from ${min} to ${max}.`);
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
