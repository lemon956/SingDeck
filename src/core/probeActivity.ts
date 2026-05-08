import type { ScoreMode } from './helperApi';

export type ProbeActivity = {
  kind: 'testing' | 'scoring';
  className: 'is-testing' | 'is-scoring';
  label: 'testing' | 'scoring';
};

export function describeProbeActivity(input: {
  mode: ScoreMode;
  groupProbing: boolean;
  nodeTesting?: boolean;
}): ProbeActivity | null {
  if (input.nodeTesting) {
    return { kind: 'testing', className: 'is-testing', label: 'testing' };
  }

  if (!input.groupProbing) {
    return null;
  }

  return input.mode === 'score'
    ? { kind: 'scoring', className: 'is-scoring', label: 'scoring' }
    : { kind: 'testing', className: 'is-testing', label: 'testing' };
}
