import { describe, expect, it } from 'vitest';
import { summarizeTrafficProvider } from './traffic';

describe('traffic provider summary', () => {
  it('formats provider usage without exposing raw bytes in the UI', () => {
    expect(
      summarizeTrafficProvider({
        id: 'haita',
        name: 'Haita',
        homepage: 'https://haita.io/dashboard',
        planName: 'Basic',
        usedUploadBytes: 1024,
        usedDownloadBytes: 2048,
        usedTotalBytes: 3072,
        totalBytes: 8192,
        remainingBytes: 5120,
        usedRatio: 37.5,
        expireAt: 1779595946,
        resetDay: 17,
        fetchedAt: '2026-05-07T16:00:00+08:00',
        error: null
      })
    ).toEqual({
      used: '3.0 KiB',
      total: '8.0 KiB',
      remaining: '5.0 KiB',
      ratio: '37.5%',
      expires: '2026-05-24'
    });
  });
});
