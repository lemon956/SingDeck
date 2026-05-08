import { describe, expect, it } from 'vitest';
import { createConfigSnapshot, maskSensitiveConfig } from './configWorkspace';

describe('config workspace', () => {
  it('creates named snapshots with necessary validation issues', () => {
    const snapshot = createConfigSnapshot('baseline', '{"log":{"level":"info"}}');

    expect(snapshot.name).toBe('baseline');
    expect(snapshot.issues).toEqual([
      expect.objectContaining({ path: '$.experimental.clash_api', severity: 'error' })
    ]);
  });

  it('masks sensitive fields before copying diagnostics', () => {
    expect(
      maskSensitiveConfig({
        experimental: { clash_api: { secret: 'deck' } },
        outbounds: [{ password: 'pass', private_key: 'key', token: 'token' }]
      })
    ).toEqual({
      experimental: { clash_api: { secret: '***' } },
      outbounds: [{ password: '***', private_key: '***', token: '***' }]
    });
  });
});
