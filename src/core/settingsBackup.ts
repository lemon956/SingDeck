import type { ControllerConfig, ValidationIssue } from './controller';
import type { ConfigSnapshot } from './configWorkspace';
import type { HelperGroupConfig, HelperTestingSettings } from './helperApi';

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
  if (!isRecord(parsed) || parsed.schema !== SETTINGS_BACKUP_SCHEMA) {
    throw new Error('Invalid SingDeck settings backup.');
  }

  return parsed as SettingsBackup;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
