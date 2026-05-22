import type { HelperHealth } from './helperApi';

export type HelperAvailability = 'checking' | 'ready' | 'offline';

export type HelperAvailabilityInput = {
  health: HelperHealth | null | undefined;
  error?: string | null;
  lastCheckedAt?: string | null;
};

export function isHelperServiceAvailable(health: HelperHealth | null | undefined): boolean {
  return Boolean(health?.ok && health.sqlite);
}

export function getHelperAvailability(status: HelperAvailabilityInput): HelperAvailability {
  if (isHelperServiceAvailable(status.health)) {
    return 'ready';
  }

  if (status.health || status.error || status.lastCheckedAt) {
    return 'offline';
  }

  return 'checking';
}
