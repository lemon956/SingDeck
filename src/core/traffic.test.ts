import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSubscriptionUserInfo, summarizeTrafficProvider } from './traffic';

function localEpochSeconds(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day).getTime() / 1000;
}

describe('traffic provider summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 28));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats provider usage as total, used, reset time, and payment time', () => {
    expect(
      summarizeTrafficProvider({
        id: 'wd-gold',
        name: 'WD Gold',
        homepage: 'https://wd-gold.net/clientarea.php?action=productdetails&id=217101',
        planName: 'Basic',
        usedUploadBytes: 1024,
        usedDownloadBytes: 2048,
        usedTotalBytes: 3072,
        totalBytes: 8192,
        remainingBytes: 5120,
        usedRatio: 37.5,
        expireAt: localEpochSeconds(2026, 5, 21),
        resetDay: 17,
        resetAt: localEpochSeconds(2026, 5, 1),
        stale: false,
        lastSuccessfulAt: '2026-05-27T18:00:00+08:00',
        fetchedAt: '2026-05-07T16:00:00+08:00',
        error: null
      })
    ).toEqual({
      total: '8.0 KiB',
      used: '3.0 KiB',
      reset: '6月1日（4天后）',
      payment: '6月21日（24天后）',
      stale: false
    });
  });

  it('formats xnyun reset time and payment time separately', () => {
    expect(
      summarizeTrafficProvider({
        id: 'xnyun',
        name: 'XNYun',
        homepage: 'https://xnyun.wiki/#/dashboard',
        planName: null,
        usedUploadBytes: null,
        usedDownloadBytes: null,
        usedTotalBytes: 5368709120,
        totalBytes: 10737418240,
        remainingBytes: 5368709120,
        usedRatio: 50,
        expireAt: localEpochSeconds(2026, 6, 4),
        resetDay: 30,
        resetAt: localEpochSeconds(2026, 5, 27),
        stale: true,
        lastSuccessfulAt: '2026-05-27T18:00:00+08:00',
        fetchedAt: '2026-05-28T09:00:00+08:00',
        error: 'showing last successful traffic snapshot'
      })
    ).toEqual({
      total: '10.0 GiB',
      used: '5.0 GiB',
      reset: '6月27日（30天后）',
      payment: '7月4日（37天后）',
      stale: true
    });
  });

  it('does not use payment time as reset time fallback', () => {
    expect(
      summarizeTrafficProvider({
        id: 'xnyun',
        name: 'XNYun',
        homepage: 'https://xnyun.wiki/#/dashboard',
        planName: null,
        usedUploadBytes: null,
        usedDownloadBytes: null,
        usedTotalBytes: 5368709120,
        totalBytes: 10737418240,
        remainingBytes: 5368709120,
        usedRatio: 50,
        expireAt: localEpochSeconds(2026, 5, 21),
        resetDay: null,
        resetAt: null,
        stale: false,
        lastSuccessfulAt: '2026-05-27T18:00:00+08:00',
        fetchedAt: '2026-05-28T09:00:00+08:00',
        error: null
      })
    ).toEqual({
      total: '10.0 GiB',
      used: '5.0 GiB',
      reset: '--',
      payment: '6月21日（24天后）',
      stale: false
    });
  });

  describe('parseSubscriptionUserInfo', () => {
    it('parses standard Subscription-Userinfo header correctly', () => {
      const header = 'upload=1073741824; download=21474836480; total=107374182400; expire=1767139200';
      const result = parseSubscriptionUserInfo(header);

      expect(result).toEqual({
        uploadBytes: 1073741824,
        downloadBytes: 21474836480,
        totalBytes: 107374182400,
        usedBytes: 22548578304,
        expireAt: 1767139200
      });
    });

    it('handles header without expire field or arbitrary spacing', () => {
      const header = '  upload = 500 ; download = 1500 ; total = 10000 ';
      const result = parseSubscriptionUserInfo(header);

      expect(result).toEqual({
        uploadBytes: 500,
        downloadBytes: 1500,
        totalBytes: 10000,
        usedBytes: 2000,
        expireAt: null
      });
    });

    it('returns null for null, empty or invalid header value', () => {
      expect(parseSubscriptionUserInfo(null)).toBeNull();
      expect(parseSubscriptionUserInfo('')).toBeNull();
      expect(parseSubscriptionUserInfo('invalid-content-header')).toBeNull();
      expect(parseSubscriptionUserInfo('upload=abc; download=def')).toBeNull();
    });
  });
});
