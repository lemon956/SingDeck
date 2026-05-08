import type { HelperTrafficSnapshot } from './helperApi';
import { formatBytes } from './runtime';

export type TrafficProviderSummary = {
  used: string;
  total: string;
  remaining: string;
  ratio: string;
  expires: string;
};

export function summarizeTrafficProvider(provider: HelperTrafficSnapshot): TrafficProviderSummary {
  return {
    used: formatNullableBytes(provider.usedTotalBytes),
    total: formatNullableBytes(provider.totalBytes),
    remaining: formatNullableBytes(provider.remainingBytes),
    ratio: typeof provider.usedRatio === 'number' ? `${provider.usedRatio.toFixed(1)}%` : '--',
    expires: formatExpireDate(provider.expireAt)
  };
}

function formatNullableBytes(value: number | null): string {
  return typeof value === 'number' ? formatBytes(value) : '--';
}

function formatExpireDate(value: number | null): string {
  if (typeof value !== 'number' || value <= 0) {
    return '--';
  }

  const date = new Date(value * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
