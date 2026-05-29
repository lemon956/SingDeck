import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeTrafficProvider } from './traffic';

describe('traffic provider summary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
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
        expireAt: 1781971200,
        resetDay: 17,
        resetAt: 1780272000,
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
        expireAt: 1783094400,
        resetDay: 30,
        resetAt: 1782489600,
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
        expireAt: 1781971200,
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
});
