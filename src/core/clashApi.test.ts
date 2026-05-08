import { describe, expect, it, vi } from 'vitest';
import { ClashApiClient, detectController } from './clashApi';

describe('ClashApiClient', () => {
  it('sends bearer auth and normalizes endpoint paths', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '1.12.0' })));
    const client = new ClashApiClient({
      baseUrl: 'http://127.0.0.1:9090/',
      secret: 'deck',
      fetcher
    });

    await client.getJson('/version');

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9090/version', {
      headers: { Authorization: 'Bearer deck' }
    });
  });
});

describe('detectController', () => {
  it('returns online status with version when /version responds', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '1.12.0' })));

    await expect(
      detectController({ controllerUrl: 'http://127.0.0.1:9090', secret: '', fetcher })
    ).resolves.toEqual({
      ok: true,
      version: '1.12.0'
    });
  });

  it('returns classified failure when auth fails', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));

    await expect(
      detectController({ controllerUrl: 'http://127.0.0.1:9090', secret: 'wrong', fetcher })
    ).resolves.toMatchObject({
      ok: false,
      failure: { kind: 'auth' }
    });
  });
});
