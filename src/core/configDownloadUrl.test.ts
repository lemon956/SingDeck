import { describe, expect, it } from 'vitest';
import { buildConfigDownloadUrl, resolveConfigDownloadUrl } from './configDownloadUrl';

describe('config download URL', () => {
  it('uses the helper-reported LAN URL before a local helper URL', () => {
    expect(
      resolveConfigDownloadUrl({
        helperUrl: 'http://127.0.0.1:9531',
        mobileConfigUrl: 'http://192.168.31.8:9531/api/v1/config/raw',
        pageHostname: 'localhost'
      })
    ).toBe('http://192.168.31.8:9531/api/v1/config/raw');
  });

  it('replaces a local helper host with the page LAN host when available', () => {
    expect(buildConfigDownloadUrl('http://127.0.0.1:9531', '192.168.31.8')).toBe(
      'http://192.168.31.8:9531/api/v1/config/raw'
    );
  });

  it('does not invent a LAN QR URL when helper only reports a loopback URL', () => {
    expect(
      resolveConfigDownloadUrl({
        helperUrl: 'http://127.0.0.1:9531',
        mobileConfigUrl: null,
        pageHostname: '192.168.31.8'
      })
    ).toBe('');
  });
});
