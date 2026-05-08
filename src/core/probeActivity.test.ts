import { describe, expect, it } from 'vitest';
import { describeProbeActivity } from './probeActivity';

describe('probe activity presentation', () => {
  it('marks score-mode group probes as scoring', () => {
    expect(describeProbeActivity({ mode: 'score', groupProbing: true })).toEqual({
      kind: 'scoring',
      className: 'is-scoring',
      label: 'scoring'
    });
  });

  it('marks delay-mode group probes as testing', () => {
    expect(describeProbeActivity({ mode: 'delay', groupProbing: true })).toEqual({
      kind: 'testing',
      className: 'is-testing',
      label: 'testing'
    });
  });

  it('lets a direct node delay test take priority over group state', () => {
    expect(describeProbeActivity({ mode: 'score', groupProbing: true, nodeTesting: true })).toEqual({
      kind: 'testing',
      className: 'is-testing',
      label: 'testing'
    });
  });

  it('returns no activity when no probe is running', () => {
    expect(describeProbeActivity({ mode: 'delay', groupProbing: false })).toBeNull();
  });
});
