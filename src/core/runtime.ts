export type TrafficSnapshot = {
  up: number;
  down: number;
};

export type RuntimeTotals = {
  uploadTotal: number;
  downloadTotal: number;
};

export type RuntimeInput = {
  traffic: TrafficSnapshot;
  totals: RuntimeTotals;
  connectionCount: number;
  mode: string;
};

export type RuntimeSummary = {
  uploadRate: string;
  downloadRate: string;
  uploadTotal: string;
  downloadTotal: string;
  connectionCount: string;
  mode: string;
};

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(value: number): string {
  const normalized = Number.isFinite(value) && value > 0 ? value : 0;
  if (normalized === 0) {
    return '0 B';
  }

  const unitIndex = Math.max(
    0,
    Math.min(Math.floor(Math.log(normalized) / Math.log(1024)), UNITS.length - 1)
  );
  const amount = normalized / 1024 ** unitIndex;
  return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${UNITS[unitIndex]}`;
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

export function summarizeRuntime(input: RuntimeInput): RuntimeSummary {
  return {
    uploadRate: formatRate(input.traffic.up),
    downloadRate: formatRate(input.traffic.down),
    uploadTotal: formatBytes(input.totals.uploadTotal),
    downloadTotal: formatBytes(input.totals.downloadTotal),
    connectionCount: String(input.connectionCount),
    mode: input.mode || 'unknown'
  };
}

export function parseTrafficChunk(chunk: string): TrafficSnapshot {
  const firstLine = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return { up: 0, down: 0 };
  }

  try {
    const data = JSON.parse(firstLine) as Partial<TrafficSnapshot>;
    return {
      up: typeof data.up === 'number' ? data.up : 0,
      down: typeof data.down === 'number' ? data.down : 0
    };
  } catch {
    return { up: 0, down: 0 };
  }
}
