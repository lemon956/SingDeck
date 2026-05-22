import { describe, expect, it } from 'vitest';
import type { HelperHealth } from './helperApi';
import { getHelperAvailability, isHelperServiceAvailable } from './helperStatus';

describe('helper status', () => {
  it('keeps helper available when only the controller check failed', () => {
    const health: HelperHealth = {
      ok: true,
      version: '0.1.0',
      sqlite: true,
      controllerConfigured: true,
      controllerReachable: false,
      mobileConfigUrl: null,
      error: 'controller returned HTTP 401 Unauthorized'
    };

    expect(isHelperServiceAvailable(health)).toBe(true);
  });

  it('marks helper unavailable when sqlite health is not ready', () => {
    expect(
      isHelperServiceAvailable({
        ok: false,
        version: '0.1.0',
        sqlite: false,
        controllerConfigured: true,
        controllerReachable: false,
        mobileConfigUrl: null,
        error: 'database unavailable'
      })
    ).toBe(false);
  });

  it('reports checking before the first helper health result', () => {
    expect(getHelperAvailability({ health: null, error: null, lastCheckedAt: null })).toBe('checking');
  });

  it('reports ready when helper core dependencies are healthy', () => {
    expect(
      getHelperAvailability({
        health: {
          ok: true,
          version: '0.1.0',
          sqlite: true,
          controllerConfigured: false,
          controllerReachable: false,
          mobileConfigUrl: null,
          error: null
        },
        error: null,
        lastCheckedAt: new Date().toISOString()
      })
    ).toBe('ready');
  });

  it('reports offline after a failed helper check', () => {
    expect(getHelperAvailability({ health: null, error: 'Failed to fetch', lastCheckedAt: new Date().toISOString() }))
      .toBe('offline');
  });
});
