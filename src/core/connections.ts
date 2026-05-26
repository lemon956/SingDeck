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
    type?: string;
    dnsMode?: string;
    processPath?: string;
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
  sourceIP: string;
  sourcePort: string;
  sourceEndpoint: string;
  target: string;
  destinationHost: string;
  destinationIP: string;
  destinationPort: string;
  destinationEndpoint: string;
  network: string;
  inboundType: string;
  dnsMode: string;
  processPath: string;
  upload: string;
  uploadBytes: number;
  download: string;
  downloadBytes: number;
  totalBytes: number;
  rule: string;
  ruleType: string;
  rulePayload: string;
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
    const sourceIP = metadata.sourceIP || 'local';
    const sourcePort = metadata.sourcePort || '';
    const sourceEndpoint = formatEndpoint(sourceIP, sourcePort);
    const destinationHost = metadata.host || '';
    const destinationIP = metadata.destinationIP || '';
    const destinationPort = metadata.destinationPort || '';
    const destinationBase = destinationHost || destinationIP || 'unknown';
    const destinationEndpoint = formatEndpoint(destinationBase, destinationPort);
    const chains = connection.chains ?? [];
    const ruleType = connection.rule || 'MATCH';
    const rulePayload = connection.rulePayload || '';
    const rule = [ruleType, rulePayload].filter(Boolean).join(' ') || 'MATCH';
    const uploadBytes = connection.upload ?? 0;
    const downloadBytes = connection.download ?? 0;

    return {
      id: connection.id || `connection-${index}`,
      source: sourceEndpoint,
      sourceIP,
      sourcePort,
      sourceEndpoint,
      target: destinationEndpoint,
      destinationHost,
      destinationIP,
      destinationPort,
      destinationEndpoint,
      network: metadata.network || 'unknown',
      inboundType: metadata.type || 'unknown',
      dnsMode: metadata.dnsMode || 'unknown',
      processPath: metadata.processPath || '',
      upload: formatBytes(uploadBytes),
      uploadBytes,
      download: formatBytes(downloadBytes),
      downloadBytes,
      totalBytes: uploadBytes + downloadBytes,
      rule,
      ruleType,
      rulePayload,
      outbound: chains[0] ?? 'unknown',
      chains,
      startedAt: connection.start ?? ''
    };
  });
}

function formatEndpoint(host: string, port: string): string {
  return port ? `${host}:${port}` : host;
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
