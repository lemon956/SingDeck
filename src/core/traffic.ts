import type { HelperTrafficSnapshot } from './helperApi';
import { formatBytes } from './runtime';

const DAY_MS = 24 * 60 * 60 * 1000;

export type TrafficProviderSummary = {
  total: string;
  used: string;
  reset: string;
  payment: string;
  stale: boolean;
};

export type SubscriptionUserInfo = {
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  usedBytes: number;
  expireAt: number | null; // seconds
};

/**
 * Parses the standard `Subscription-Userinfo` HTTP header
 * e.g., "upload=1073741824; download=21474836480; total=107374182400; expire=1767139200"
 */
export function parseSubscriptionUserInfo(headerValue: string | null | undefined): SubscriptionUserInfo | null {
  if (!headerValue || typeof headerValue !== 'string') {
    return null;
  }

  const parts = headerValue.split(';');
  let upload = 0;
  let download = 0;
  let total = 0;
  let expire: number | null = null;
  let matched = false;

  for (const part of parts) {
    const [rawKey, rawVal] = part.split('=').map((s) => s.trim().toLowerCase());
    if (!rawKey || !rawVal) continue;
    const num = Number(rawVal);
    if (Number.isNaN(num)) continue;

    if (rawKey === 'upload') {
      upload = num;
      matched = true;
    } else if (rawKey === 'download') {
      download = num;
      matched = true;
    } else if (rawKey === 'total') {
      total = num;
      matched = true;
    } else if (rawKey === 'expire') {
      expire = num > 0 ? num : null;
      matched = true;
    }
  }

  if (!matched || total <= 0) {
    return null;
  }

  return {
    uploadBytes: upload,
    downloadBytes: download,
    totalBytes: total,
    usedBytes: upload + download,
    expireAt: expire
  };
}

export function summarizeTrafficProvider(provider: HelperTrafficSnapshot): TrafficProviderSummary {
  return {
    total: formatNullableBytes(provider.totalBytes),
    used: formatNullableBytes(provider.usedTotalBytes),
    reset: formatResetTime(provider),
    payment: formatPaymentTime(provider),
    stale: provider.stale === true
  };
}

function formatNullableBytes(value: number | null): string {
  return typeof value === 'number' ? formatBytes(value) : '--';
}

function dateFromSeconds(value: number | null): Date | null {
  if (typeof value !== 'number' || value <= 0) {
    return null;
  }

  return new Date(value * 1000);
}

function formatResetTime(provider: HelperTrafficSnapshot): string {
  if (typeof provider.resetAt === 'number' && provider.resetAt > 0) {
    return formatConcreteResetDate(dateFromSeconds(provider.resetAt));
  }
  if (typeof provider.resetDay === 'number' && provider.resetDay > 0) {
    return formatConcreteResetDate(nextMonthlyResetDate(provider.resetDay, new Date()));
  }
  return '--';
}

function formatPaymentTime(provider: HelperTrafficSnapshot): string {
  return formatConcreteResetDate(dateFromSeconds(provider.expireAt));
}

function formatConcreteResetDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return '--';
  }

  const daysAway = daysBetweenLocalDates(new Date(), date);
  const relative =
    daysAway === 0 ? '今天' : daysAway === 1 ? '明天' : daysAway > 1 ? `${daysAway}天后` : `${Math.abs(daysAway)}天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日（${relative}）`;
}

function nextMonthlyResetDate(resetDay: number, now: Date): Date {
  const today = startOfLocalDay(now);
  let candidate = monthlyDate(now.getFullYear(), now.getMonth(), resetDay);
  if (startOfLocalDay(candidate).getTime() < today.getTime()) {
    candidate = monthlyDate(now.getFullYear(), now.getMonth() + 1, resetDay);
  }
  return candidate;
}

function monthlyDate(year: number, month: number, resetDay: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(Math.max(1, resetDay), lastDay));
}

function daysBetweenLocalDates(start: Date, end: Date): number {
  return Math.round((startOfLocalDay(end).getTime() - startOfLocalDay(start).getTime()) / DAY_MS);
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
