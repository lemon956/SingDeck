import type { HelperGroupConfig, HelperNodeScore } from './helperApi';
import type { ProbeExecution, ProxyRecord } from './proxies';

export type ProxyInspectorModel = {
  name: string;
  type: string;
  current: string;
  membersLabel: string;
  mode: HelperGroupConfig['mode'];
  executionLabel: ProbeExecution['label'];
  metricLabel: string;
  autoSwitchLabel: string;
  scheduleLabel: string;
  runLabel: string;
  testUrl: string;
  scheme: HelperGroupConfig['scheme'];
  intervalMinutes: number;
  canEditScheme: boolean;
  canAutoSwitch: boolean;
  canSchedule: boolean;
  helperControlsAvailable: boolean;
  autoSwitchManagedBySingBox: boolean;
};

export function buildProxyInspectorModel(input: {
  group: ProxyRecord | null;
  config: HelperGroupConfig;
  execution: ProbeExecution | null;
  helperAvailable: boolean;
  selectedDelay: number | null | undefined;
  selectedScore?: HelperNodeScore;
  testUrl: string;
}): ProxyInspectorModel {
  const { group, config, execution, helperAvailable, selectedDelay, selectedScore, testUrl } = input;
  const current = group?.now || '--';
  const delayLabel = formatDelayLabel(selectedScore?.delayMs ?? selectedDelay);
  const scoreLabel = selectedScore ? String(Math.round(selectedScore.score)) : '--';
  const mode = config.mode;
  const resolvedExecution = execution ?? {
    mode: mode === 'score' ? 'helper-score' : 'helper-delay',
    label: mode === 'score' ? 'score' : 'helper',
    autoSwitchManagedBySingBox: false
  };
  const isNativeManaged = resolvedExecution.autoSwitchManagedBySingBox;
  const canAutoSwitch = helperAvailable && !isNativeManaged && group?.type.toLowerCase() === 'selector';
  const metricLabel = mode === 'score' ? `${scoreLabel} / ${delayLabel}` : delayLabel;

  return {
    name: group?.name ?? '--',
    type: group?.type ?? '--',
    current,
    membersLabel: group ? `${group.all.length} nodes` : '--',
    mode,
    executionLabel: resolvedExecution.label,
    metricLabel,
    autoSwitchLabel: isNativeManaged ? 'sing-box' : config.autoSwitch && canAutoSwitch ? 'On' : 'Manual',
    scheduleLabel: isNativeManaged ? 'sing-box interval' : `${config.autoProbe ? 'On' : 'Off'} · ${intervalMinutes(config)} min`,
    runLabel: mode === 'score' ? 'Run score' : 'Run delay',
    testUrl,
    scheme: config.scheme,
    intervalMinutes: intervalMinutes(config),
    canEditScheme: helperAvailable && mode === 'score',
    canAutoSwitch,
    canSchedule: helperAvailable && !isNativeManaged,
    helperControlsAvailable: helperAvailable,
    autoSwitchManagedBySingBox: isNativeManaged
  };
}

function formatDelayLabel(delay: number | null | undefined): string {
  if (delay === 0) {
    return 'direct';
  }

  return typeof delay === 'number' ? `${delay}ms` : '--';
}

function intervalMinutes(config: HelperGroupConfig): number {
  return Math.max(1, Math.round(config.probeIntervalSec / 60));
}
