import { validateNecessaryConfig, type ValidationIssue } from './controller';

export type ConfigSnapshot = {
  id: string;
  name: string;
  content: string;
  issues: ValidationIssue[];
  createdAt: string;
};

const SENSITIVE_KEYS = new Set(['secret', 'password', 'private_key', 'token']);

export function createConfigSnapshot(name: string, content: string): ConfigSnapshot {
  return {
    id: crypto.randomUUID?.() ?? `${Date.now()}`,
    name: name.trim() || 'snapshot',
    content,
    issues: validateNecessaryConfig(content),
    createdAt: new Date().toISOString()
  };
}

export function maskSensitiveConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskSensitiveConfig);
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) ? '***' : maskSensitiveConfig(child)
      ])
    );
  }

  return value;
}

export function formatDiagnosticCopy(content: string): string {
  try {
    return JSON.stringify(maskSensitiveConfig(JSON.parse(content)), null, 2);
  } catch {
    return content;
  }
}
