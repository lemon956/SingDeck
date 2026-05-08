import { formatBytes } from './runtime';

type RawConnection = {
  id?: string;
  metadata?: {
    host?: string;
    destinationIP?: string;
    destinationPort?: string;
    sourceIP?: string;
    sourcePort?: string;
    network?: string;
  };
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  upload?: number;
  download?: number;
  start?: string;
};

export type ConnectionsResponse = {
  connections?: RawConnection[];
};

export type ConnectionRecord = {
  id: string;
  source: string;
  target: string;
  network: string;
  upload: string;
  download: string;
  rule: string;
  outbound: string;
  chains: string[];
  startedAt: string;
};

export type LogRecord = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
};

export function normalizeConnectionsResponse(response: ConnectionsResponse): ConnectionRecord[] {
  return (response.connections ?? []).map((connection, index) => {
    const metadata = connection.metadata ?? {};
    const host = metadata.host || metadata.destinationIP || 'unknown';
    const port = metadata.destinationPort ? `:${metadata.destinationPort}` : '';
    const chains = connection.chains ?? [];
    const rule = [connection.rule, connection.rulePayload].filter(Boolean).join(' ') || 'MATCH';

    return {
      id: connection.id || `connection-${index}`,
      source: metadata.sourceIP || 'local',
      target: `${host}${port}`,
      network: metadata.network || 'unknown',
      upload: formatBytes(connection.upload ?? 0),
      download: formatBytes(connection.download ?? 0),
      rule,
      outbound: chains[0] ?? 'unknown',
      chains,
      startedAt: connection.start ?? ''
    };
  });
}

export function parseLogChunk(chunk: string): unknown[] {
  return chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return line;
      }
    });
}

export function normalizeLogLine(input: unknown): LogRecord {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    return {
      level: normalizeLevel(record.type),
      message: typeof record.payload === 'string' ? record.payload : JSON.stringify(input)
    };
  }

  const message = String(input);
  return {
    level: normalizeLevel(message.split(':', 1)[0]),
    message
  };
}

function normalizeLevel(value: unknown): LogRecord['level'] {
  const level = typeof value === 'string' ? value.toLowerCase() : '';
  if (level.includes('error')) {
    return 'error';
  }
  if (level.includes('warn')) {
    return 'warn';
  }
  if (level.includes('debug')) {
    return 'debug';
  }
  return 'info';
}
