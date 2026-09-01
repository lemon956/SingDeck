import { describe, expect, it, vi } from 'vitest';
import { buildMobileConfigDownloadUrl, buildSingBoxRemoteProfileUri, HelperApiClient } from './helperApi';

describe('helper remote profile QR', () => {
  it('wraps a config download URL in the sing-box remote profile URI scheme', () => {
    expect(buildSingBoxRemoteProfileUri('http://192.168.1.20:9531/api/v1/config/raw', 'SingDeck')).toBe(
      'sing-box://import-remote-profile?url=http%3A%2F%2F192.168.1.20%3A9531%2Fapi%2Fv1%2Fconfig%2Fraw#SingDeck'
    );
  });

  it('adds and removes the settings marker without dropping existing query parameters', () => {
    const rawUrl = 'http://192.168.1.20:9531/api/v1/config/raw?token=secret%20token';
    const settingsUrl = buildMobileConfigDownloadUrl(rawUrl, true);

    expect(settingsUrl).toBe(
      'http://192.168.1.20:9531/api/v1/config/raw?token=secret+token&singdeck_settings=1'
    );
    expect(buildMobileConfigDownloadUrl(settingsUrl, false)).toBe(
      'http://192.168.1.20:9531/api/v1/config/raw?token=secret+token'
    );
    expect(buildMobileConfigDownloadUrl(rawUrl, false)).toBe(rawUrl);
  });
});

describe('helper auth token', () => {
  const makeFetcher = () =>
    vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200 }))
    );

  it('attaches a Bearer Authorization header when a token is configured', async () => {
    const fetcher = makeFetcher();
    const client = new HelperApiClient({ baseUrl: 'http://127.0.0.1:9531', token: 'secret-token', fetcher });
    await client.getJson('/api/v1/groups');
    const init = fetcher.mock.calls[0][1];
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('omits the Authorization header when no token is configured', async () => {
    const fetcher = makeFetcher();
    const client = new HelperApiClient({ baseUrl: 'http://127.0.0.1:9531', fetcher });
    await client.getJson('/api/v1/groups');
    const init = fetcher.mock.calls[0][1];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });
});
