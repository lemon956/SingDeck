import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertCircle,
  Cable,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  GitBranch,
  Globe,
  Layers,
  LayoutDashboard,
  Lock,
  QrCode,
  RefreshCw,
  Save,
  Search,
  Settings as SettingsIcon,
  Shield,
  Sliders,
  ScrollText,
  Wifi,
  X,
  Zap
} from 'lucide-react';
import QRCode from 'qrcode';
import { buildNodeSourceTagStyles, formatRelativeTime, sourceRestrictionAllowsNode } from '../core/nodeSources';
import { WorldRequestMap } from './WorldRequestMap';
import { isLoopbackUrl, resolveConfigDownloadUrl } from '../core/configDownloadUrl';
import { routeFromHash, type AppRoute } from '../core/navigation';
import { formatBytes } from '../core/runtime';
import { summarizeTrafficProvider } from '../core/traffic';
import { describeProbeActivity } from '../core/probeActivity';
import { buildProxyInspectorModel } from '../core/proxyInspector';
import { connectHelperEventStream } from '../state/helperEventStream';
import {
  applyStrategyWallOrder,
  buildStrategyWallGroups,
  distributeStrategyWallColumns,
  moveStrategyWallGroupOrderNearTarget,
  selectVisibleStrategyWallMembers
} from '../core/strategyWallLayout';
import {
  HelperApiClient,
  buildMobileConfigDownloadUrl,
  buildSingBoxRemoteProfileUri,
  type HelperConfigSource,
  type HelperGroupConfig,
  type HelperGroupsResponse,
  type HelperInspectionRequest,
  type HelperNetworkUsageConnection,
  type HelperNetworkUsageSettings,
  type HelperNetworkUsageSourceTrendBucketMode,
  type HelperNetworkUsageSourceTrendSource,
  type HelperNodeSourcesResponse,
  type HelperNodeRiskChecks,
  type HelperNodeScore,
  type HelperRiskCheckStatus,
  type HelperTestingSettings,
  type HelperTrafficSettings,
  type ScoreScheme
} from '../core/helperApi';
import { getHelperAvailability } from '../core/helperStatus';
import {
  isProxyGroup,
  isSelectableProxyGroup,
  isZashboardVisibleStrategyGroup,
  resolveNowProxyName,
  resolveProbeExecution,
  type ProxyRecord
} from '../core/proxies';
import { mergeImportedSecret, parseSettingsBackup, serializeSettingsBackup } from '../core/settingsBackup';
import { stripSecretFromHash, validateNecessaryConfig } from '../core/controller';
import { useControllerStore } from '../state/controllerStore';
import { useConnectionStore } from '../state/connectionStore';
import { useConfigStore } from '../state/configStore';
import { useHelperStore } from '../state/helperStore';
import { useProxyStore } from '../state/proxyStore';
import { useRuntimeStore } from '../state/runtimeStore';
import type { ConnectionRecord } from '../core/connections';
import { LineChart, SankeyChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers';

echarts.use([LineChart, SankeyChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer, SVGRenderer]);

const TRAFFIC_SPARKLINE_WINDOW_MS = 2 * 60 * 1000;
const TRAFFIC_SPARKLINE_WIDTH = 188;
const TRAFFIC_SPARKLINE_HEIGHT = 44;
const SOURCE_TREND_DAYS = 7;
const SOURCE_TREND_COLORS = ['#34d399', '#38bdf8', '#fbbf24', '#a78bfa', '#f87171', '#60a5fa'];
const NODE_SOURCE_TAG_PALETTE = [
  { color: '#38bdf8', background: 'rgba(56, 189, 248, 0.10)', border: 'rgba(56, 189, 248, 0.34)' },
  { color: '#a78bfa', background: 'rgba(167, 139, 250, 0.10)', border: 'rgba(167, 139, 250, 0.34)' },
  { color: '#34d399', background: 'rgba(52, 211, 153, 0.10)', border: 'rgba(52, 211, 153, 0.34)' },
  { color: '#fbbf24', background: 'rgba(251, 191, 36, 0.10)', border: 'rgba(251, 191, 36, 0.34)' },
  { color: '#60a5fa', background: 'rgba(96, 165, 250, 0.10)', border: 'rgba(96, 165, 250, 0.34)' },
  { color: '#f472b6', background: 'rgba(244, 114, 182, 0.10)', border: 'rgba(244, 114, 182, 0.34)' },
  { color: '#2dd4bf', background: 'rgba(45, 212, 191, 0.10)', border: 'rgba(45, 212, 191, 0.34)' },
  { color: '#fb923c', background: 'rgba(251, 146, 60, 0.10)', border: 'rgba(251, 146, 60, 0.34)' }
] as const;
const DEFAULT_DELAY_TEST_TIMEOUT_MS = 5000;
const DEFAULT_MIN_PROBE_INTERVAL_SEC = 60;
const DEFAULT_NETWORK_USAGE_SAMPLE_INTERVAL_SEC = 5;
const MIN_NETWORK_USAGE_SAMPLE_INTERVAL_SEC = 2;
const MAX_NETWORK_USAGE_SAMPLE_INTERVAL_SEC = 3600;
const STRATEGY_GROUP_ORDER_STORAGE_KEY = 'singdeck-strategy-group-order';
const NETWORK_USAGE_WINDOWS = [
  { id: '1h', label: '1h', durationMs: 60 * 60 * 1000, bucket: 'minute' as const },
  { id: '6h', label: '6h', durationMs: 6 * 60 * 60 * 1000, bucket: 'minute' as const },
  { id: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000, bucket: 'hour' as const },
  { id: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000, bucket: 'hour' as const }
] as const;
const NETWORK_USAGE_VIEWS = [
  { id: 'domains', label: 'Domains' },
  { id: 'strategies', label: '策略组' },
  { id: 'recent', label: '最近链接' }
] as const;

type NetworkUsageWindowId = (typeof NETWORK_USAGE_WINDOWS)[number]['id'];
type NetworkUsageViewId = (typeof NETWORK_USAGE_VIEWS)[number]['id'];

type InlineStatus = {
  tone: 'ok' | 'warn' | 'neutral';
  text: string;
};

type SettingsTransferStatus = {
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  text: string;
};

function formatSettingsImportError(error: unknown): string {
  if (error instanceof Response) {
    return `Helper HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : 'Import failed.';
}


const sections = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, navKey: 'O' },
  { id: 'proxies', label: 'Proxies', icon: GitBranch, navKey: 'P' },
  { id: 'connections', label: 'Connections', icon: Cable, navKey: 'C' },
  { id: 'logs', label: 'Logs', icon: ScrollText, navKey: 'L' },
  { id: 'config', label: 'Config', icon: FileJson, navKey: 'J' },
  { id: 'controller', label: 'Settings', icon: SettingsIcon, navKey: 'S' }
];

const sectionSubtitles: Record<AppRoute, string> = {
  overview: 'live status, topology, selectors',
  proxies: 'strategy groups and node latency',
  connections: 'live sessions and route decisions',
  logs: 'runtime feed with local retention',
  config: 'running config snapshot',
  controller: 'controller and local behavior'
};

function readStrategyGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(STRATEGY_GROUP_ORDER_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  } catch {
    return [];
  }
}

function readPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function usePageVisible(): boolean {
  const [pageVisible, setPageVisible] = useState(readPageVisible);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(readPageVisible());
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return pageVisible;
}

type TopologyNode = {
  id: string;
  label: string;
  level: number;
  value: number;
  x: number;
  y: number;
  height: number;
};

type TopologyLink = {
  id: string;
  from: TopologyNode;
  to: TopologyNode;
  value: number;
  width: number;
};

type ConnectionTopology = {
  nodes: TopologyNode[];
  links: TopologyLink[];
  total: number;
};

const TOPOLOGY_HEIGHT = 220;
const TOPOLOGY_COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#34d399'];

function buildConnectionTopology(connections: ConnectionRecord[]): ConnectionTopology {
  const nodeValues = new Map<string, TopologyNode>();
  const linkValues = new Map<string, { fromId: string; toId: string; value: number }>();

  const addNode = (level: number, label: string): string => {
    const normalizedLabel = label.trim() || 'unknown';
    const id = `${level}:${normalizedLabel}`;
    const existing = nodeValues.get(id);
    if (existing) {
      existing.value += 1;
    } else {
      nodeValues.set(id, {
        id,
        label: normalizedLabel,
        level,
        value: 1,
        x: 0,
        y: 0,
        height: 0
      });
    }
    return id;
  };

  const addLink = (fromId: string, toId: string) => {
    const id = `${fromId}->${toId}`;
    const existing = linkValues.get(id);
    if (existing) {
      existing.value += 1;
    } else {
      linkValues.set(id, { fromId, toId, value: 1 });
    }
  };

  connections.slice(0, 160).forEach((connection) => {
    const sourceId = addNode(0, connection.sourceIP || connection.source);
    const ruleId = addNode(1, topologyRuleLabel(connection.rule));
    const groupId = addNode(2, topologyGroupLabel(connection));
    const outboundId = addNode(3, connection.outbound);

    addLink(sourceId, ruleId);
    addLink(ruleId, groupId);
    addLink(groupId, outboundId);
  });

  const nodes = Array.from(nodeValues.values());
  const levels = [0, 1, 2, 3];
  const xPositions = [70, 330, 590, 850];

  levels.forEach((level) => {
    const levelNodes = nodes
      .filter((node) => node.level === level)
      .sort((left, right) => left.label.localeCompare(right.label))
      .slice(0, level === 1 ? 8 : 6);
    const totalValue = levelNodes.reduce((sum, node) => sum + node.value, 0) || 1;
    const gap = 10;
    const top = 34;
    const bottom = 22;
    const available = Math.max(120, TOPOLOGY_HEIGHT - top - bottom - gap * Math.max(0, levelNodes.length - 1));
    let cursor = 30;

    levelNodes.forEach((node) => {
      node.x = xPositions[level];
      node.height = Math.max(18, Math.round((node.value / totalValue) * available));
      node.y = cursor;
      cursor += node.height + gap;
    });
  });

  const visibleNodeIds = new Set(nodes.filter((node) => node.x > 0).map((node) => node.id));
  const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
  const maxLink = Math.max(...Array.from(linkValues.values()).map((link) => link.value), 1);
  const links = Array.from(linkValues.values())
    .filter((link) => visibleNodeIds.has(link.fromId) && visibleNodeIds.has(link.toId))
    .map((link) => {
      const from = nodeValues.get(link.fromId)!;
      const to = nodeValues.get(link.toId)!;
      return {
        id: `${link.fromId}->${link.toId}`,
        from,
        to,
        value: link.value,
        width: Math.max(5, Math.round(Math.log10(link.value + 1) * 14 * (1 / Math.log10(maxLink + 1))))
      };
    })
    .sort((left, right) => right.value - left.value)
    .slice(0, 34);

  return {
    nodes: visibleNodes,
    links,
    total: connections.length
  };
}

function topologyRuleLabel(rule: string): string {
  const cleaned = rule.replace(/\s*=>\s*/g, ' => ');
  const left = cleaned.split('=>')[0]?.trim() || cleaned;
  return left.length > 34 ? `${left.slice(0, 31)}...` : left;
}

function topologyGroupLabel(connection: ConnectionRecord): string {
  const route = connection.rule.match(/route\(([^)]+)\)/i)?.[1];
  return route || connection.chains.at(-1) || connection.outbound;
}

type DelayTone = 'none' | 'good' | 'warn' | 'bad';

function formatDelay(delay: number | null | undefined): string {
  if (delay === 0) {
    return 'direct';
  }

  return typeof delay === 'number' ? `${delay}ms` : '--';
}

function buildNetworkUsageRequest(windowId: NetworkUsageWindowId) {
  const windowConfig = NETWORK_USAGE_WINDOWS.find((item) => item.id === windowId) ?? NETWORK_USAGE_WINDOWS[2];
  const to = Date.now();
  return {
    from: to - windowConfig.durationMs,
    to,
    bucket: windowConfig.bucket,
    limit: 10
  };
}

function buildSourceTrendRequest(bucket: HelperNetworkUsageSourceTrendBucketMode) {
  return {
    days: SOURCE_TREND_DAYS,
    bucket,
    tzOffsetMinutes: new Date().getTimezoneOffset()
  };
}

function parseIntegerDraft(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function formatLastSeen(timestampMs: number): string {
  return timestampMs > 0 ? new Date(timestampMs).toLocaleTimeString() : '--';
}

function usageConnectionStrategyLabel(connection: HelperNetworkUsageConnection): string {
  const route = connection.rule.match(/route\(([^)]+)\)/i)?.[1]?.trim();
  return route || connection.chains.at(-1) || connection.outbound || 'unknown';
}

function delayTone(delay: number | null | undefined): DelayTone {
  if (typeof delay !== 'number') {
    return 'none';
  }

  if (delay < 150) {
    return 'good';
  }

  if (delay < 500) {
    return 'warn';
  }

  return 'bad';
}

function nodeScoreTone(score: HelperNodeScore | undefined, fallbackDelay: number | null | undefined): DelayTone {
  if (!score) {
    return delayTone(fallbackDelay);
  }

  if (score.score >= 80) {
    return 'good';
  }

  if (score.score >= 50) {
    return 'warn';
  }

  return 'bad';
}

function formatNodeScore(score: HelperNodeScore | undefined, _fallbackDelay: number | null | undefined): string {
  if (score) {
    return String(Math.round(score.score));
  }

  return '--';
}

function scoreDelayOrFallback(
  score: HelperNodeScore | undefined,
  fallbackDelay: number | null | undefined
): number | null | undefined {
  return score ? score.delayMs : fallbackDelay;
}

function formatScoreTooltip(score: HelperNodeScore): string {
  const parts = [
    `latency ${score.components.latency}`,
    `availability ${score.components.availability}`,
    `jitter ${score.components.jitter}`,
    `freshness ${score.components.freshness}`
  ];
  if (score.raw) {
    parts.push(
      `raw ${score.raw.success ? 'ok' : 'failed'}`,
      `delay ${score.raw.delayMs === null ? '--' : `${score.raw.delayMs}ms`}`
    );
  }
  return parts.join(' / ');
}

function formatRiskCheckFailure(status: HelperRiskCheckStatus, error?: string | null): string {
  const label =
    status === 'not_configured'
      ? '未配置'
      : status === 'unavailable'
        ? '暂不可用'
        : status === 'error'
          ? '检测错误'
          : '未返回有效结果';
  return error ? `${label} (${error})` : label;
}

function formatNodeCardTooltip(
  name: string,
  type: string,
  sourceName?: string | null,
  delay?: number | null,
  score?: HelperNodeScore | null,
  inspection?: {
    showGemini: boolean;
    nodeRisk: HelperNodeRiskChecks;
  }
): string {
  const lines: string[] = [`【节点信息】`, `名称: ${name}`, `协议: ${type.toUpperCase()}`];
  if (sourceName) {
    lines.push(`来源: ${sourceName}`);
  }
  if (delay !== undefined && delay !== null) {
    lines.push(`延迟: ${delay}ms`);
  }
  if (score) {
    lines.push(`评分: ${score.score}分 (${formatScoreTooltip(score)})`);
  }

  const gemini = inspection?.showGemini ? score?.raw?.geminiLocation : null;
  if (gemini) {
    lines.push(``);
    lines.push(`【Gemini 出口探测】`);
    const statusText =
      gemini.status === 'success'
        ? '✅ 解锁正常'
        : gemini.status === 'anti_abuse_challenge'
        ? '⚠️ Google Sorry 反滥用挑战'
        : gemini.status === 'auth_error'
        ? '❌ Chrome Google 登录态不可用'
        : gemini.status === 'routing_error'
        ? '❌ 路由错误'
        : gemini.status === 'transport_error'
        ? '❌ 连接传输错误'
        : `❌ 异常 (${gemini.status})`;
    lines.push(`出口归属: ${gemini.label || '未知'}`);
    lines.push(`解锁状态: ${statusText}`);
    if (gemini.status === 'anti_abuse_challenge') {
      lines.push(`触发依据: 请求被 Google 重定向到 /sorry/，上游未公开具体命中规则`);
      lines.push(`风险含义: 可能与共享出口频率、自动化特征、会话/IP 不一致或 IP 信誉有关；不等于节点已被判定为恶意`);
    }
    if (gemini.authMode === 'chrome') {
      lines.push(`认证模式: Chrome Google 登录态`);
    } else {
      lines.push(`认证模式: 旧版匿名结果（请重新巡检）`);
    }
    if (gemini.error) {
      lines.push(`探测说明: ${gemini.error}`);
    }
    if (gemini.testedAt) {
      lines.push(`探测时间: ${new Date(gemini.testedAt).toLocaleTimeString()}`);
    }
  }

  const selected = inspection?.nodeRisk ?? emptyNodeRiskChecks();
  const risk = hasSelectedNodeRiskCheck(selected) ? score?.raw?.nodeRisk : null;
  if (risk) {
    lines.push(``);
    lines.push(`【风险与网络画像检测】`);
    if (selected.exitIp) {
      const exit = risk.exitIp;
      if (!exit) {
        lines.push(`出口 IP: 未返回结果`);
      } else if (exit.status === 'success' && exit.ip) {
        lines.push(`出口 IP: ${exit.ip}${exit.port ? `:${exit.port}` : ''} (${(exit.family || 'ipv4').toUpperCase()})`);
      } else {
        lines.push(`出口 IP: ${formatRiskCheckFailure(exit.status, exit.error)}`);
      }
    }

    if (selected.addressScope) {
      const scope = risk.addressScope;
      if (!scope) {
        lines.push(`地址范围: 未返回结果`);
      } else if (scope.status === 'success') {
        const clsName = scope.classification ? scope.classification.replace(/_/g, ' ') : 'global';
        lines.push(`地址范围: ${clsName} (公网可达: ${scope.globallyReachable ? '是' : '否'})`);
      } else {
        lines.push(`地址范围: ${formatRiskCheckFailure(scope.status, scope.error)}`);
      }
    }

    if (selected.networkIdentity) {
      const ident = risk.networkIdentity;
      if (!ident) {
        lines.push(`BGP 归属: 未返回结果`);
      } else if (ident.status === 'success') {
        const asnStr = ident.originAsns && ident.originAsns.length > 0 ? ident.originAsns.map((asn) => `AS${asn}`).join(', ') : '未知';
        lines.push(`BGP 归属: ${ident.prefix || '未知前缀'} [${asnStr}]`);
      } else {
        lines.push(`BGP 归属: ${formatRiskCheckFailure(ident.status, ident.error)}`);
      }
    }

    if (selected.networkClass) {
      const networkClass = risk.networkClass;
      if (!networkClass) {
        lines.push(`网络类型: 未返回结果`);
      } else if (networkClass.status === 'success') {
        const verdictMap: Record<string, string> = {
          residential: '🏠 家宽 (Residential)',
          data_center: '🏢 机房 (Data Center)',
          mobile: '📱 移动网络 (Mobile)',
          business: '🏬 企业网络 (Business)',
          other: '其他接入类型 (Other)',
          mixed: '⚠️ 家宽与托管证据冲突 (Mixed)',
          unknown: '❓ 无法判定 (Unknown)'
        };
        const details = [networkClass.isp, networkClass.connectionType].filter(Boolean).join(' / ');
        lines.push(
          `网络类型: ${verdictMap[networkClass.verdict] || networkClass.verdict}${details ? ` / ${details}` : ''}`
        );
      } else {
        lines.push(`网络类型: ${formatRiskCheckFailure(networkClass.status, networkClass.error)}`);
      }
    }

    if (selected.routeSecurity) {
      const route = risk.routeSecurity;
      if (!route) {
        lines.push(`RPKI 路由安全: 未返回结果`);
      } else if (route.status === 'success') {
        const validityMap: Record<string, string> = {
          valid: '✅ 有效 (Valid)',
          invalid_asn: '❌ ASN 不匹配 (Invalid ASN)',
          invalid_length: '❌ 前缀长度无效 (Invalid Length)',
          unknown: '❓ 未知 (Unknown)',
          unrouted: '⚠️ 未路由 (Unrouted)',
          mixed: '⚠️ 混合状态 (Mixed)'
        };
        const validityLabel = (route.validity && validityMap[route.validity]) || route.validity || '未知';
        lines.push(`RPKI 路由安全: ${validityLabel}`);
      } else {
        lines.push(`RPKI 路由安全: ${formatRiskCheckFailure(route.status, route.error)}`);
      }
    }

    if (selected.tor) {
      const tor = risk.tor;
      if (!tor) {
        lines.push(`Tor 洋葱路由: 未返回结果`);
      } else if (tor.status === 'success') {
        const torMap: Record<string, string> = {
          exit: '⚠️ Tor 出口节点 (Tor Exit)',
          relay: '⚠️ Tor 中继节点 (Tor Relay)',
          not_detected: '✅ 未发现 Tor (Not Tor)',
          unknown: '❓ 未知 (Unknown)'
        };
        lines.push(`Tor 洋葱路由: ${torMap[tor.verdict] || tor.verdict}`);
      } else {
        lines.push(`Tor 洋葱路由: ${formatRiskCheckFailure(tor.status, tor.error)}`);
      }
    }

    if (selected.privacy) {
      const privacy = risk.privacy;
      if (!privacy) {
        lines.push(`IP 隐私特征: 未返回结果`);
      } else if (privacy.status === 'success') {
        const sigs = privacy.signals && privacy.signals.length > 0 ? privacy.signals.join(', ') : '无特殊标记';
        lines.push(`IP 隐私特征: ${sigs}${privacy.service ? ` (${privacy.service})` : ''}`);
      } else {
        lines.push(`IP 隐私特征: ${formatRiskCheckFailure(privacy.status, privacy.error)}`);
      }
    }

    if (selected.abuse) {
      const abuse = risk.abuse;
      if (!abuse) {
        lines.push(`滥用信誉: 未返回结果`);
      } else if (abuse.status === 'success') {
        const scoreStr = abuse.abuseConfidenceScore !== null ? `${abuse.abuseConfidenceScore}%` : '0%';
        const reportsStr = abuse.totalReports ? `${abuse.totalReports} 次举报` : '无举报记录';
        lines.push(`滥用信誉: 风险分 ${scoreStr} (${reportsStr})${abuse.isp ? ` / ${abuse.isp}` : ''}`);
      } else {
        lines.push(`滥用信誉: ${formatRiskCheckFailure(abuse.status, abuse.error)}`);
      }
    }

    if (risk.assessedAt) {
      lines.push(`评估时间: ${new Date(risk.assessedAt).toLocaleTimeString()}`);
    }
  }

  return lines.join('\n');
}

function latestScoreUpdateAt(scores: HelperNodeScore[] | undefined): Date | null {
  if (!Array.isArray(scores) || scores.length === 0) {
    return null;
  }
  const timestamps = scores
    .map((score) => (score.lastTestedAt ? Date.parse(score.lastTestedAt) : Number.NaN))
    .filter(Number.isFinite);
  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps));
}

function probeSnapshotTimestamp(scores: HelperNodeScore[] | undefined): Date | null {
  if (!Array.isArray(scores) || scores.length === 0) {
    return null;
  }
  const timestamps = scores
    .map((score) => score.raw?.testedAt ?? score.lastTestedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps));
}

function rawAvailabilityLabel(score: HelperNodeScore): string {
  const raw = score.raw;
  if (!raw || raw.sampleCount === undefined || raw.successCount === undefined) {
    return '--';
  }
  const confidence = raw.confidence === null || raw.confidence === undefined
    ? null
    : Math.round(raw.confidence * 100);
  return confidence === null
    ? `${raw.successCount}/${raw.sampleCount}`
    : `${raw.successCount}/${raw.sampleCount} · conf ${confidence}%`;
}

function rawLatencyLabel(score: HelperNodeScore): string {
  const raw = score.raw;
  const p50 = raw?.latencyP50Ms ?? raw?.jitterP50Ms;
  const p90 = raw?.latencyP90Ms ?? raw?.jitterP95Ms;
  if (raw && !raw.success && (p50 === null || p50 === undefined) && (p90 === null || p90 === undefined)) {
    return 'failed';
  }
  if (p50 === null || p50 === undefined || p90 === null || p90 === undefined) {
    return '--';
  }
  return `p50 ${p50} / p90 ${p90}`;
}

function rawStabilityLabel(score: HelperNodeScore): string {
  const raw = score.raw;
  if (!raw) {
    return '--';
  }
  const jitter = raw.jitterMs === null || raw.jitterMs === undefined ? '--' : String(raw.jitterMs);
  return jitter === '--' ? 'jitter --' : `jitter ${jitter}ms`;
}

function rawFreshnessLabel(score: HelperNodeScore): string {
  const raw = score.raw;
  const age = raw?.freshnessAgeMs;
  if (age === null || age === undefined) {
    return '--';
  }
  const ageLabel = age < 1000 ? '<1s' : `${Math.round(age / 1000)}s`;
  return `${raw?.freshnessState ?? 'unknown'} ${ageLabel} / ${raw?.gateReason ?? 'none'}`;
}

function rawWeightsLabel(score: HelperNodeScore): string {
  const weights = score.raw?.weights;
  if (!weights) {
    return '--';
  }
  const latency = Math.round(weights.latency * 100);
  const connectivity = Math.round(weights.availability * 100);
  const stability = Math.round(weights.jitter * 100);
  const freshness = Math.round(weights.freshness * 100);
  if (freshness > 0) {
    return `w ${latency}/${connectivity}/${stability}/${freshness}`;
  }
  return `w ${connectivity}/${latency}/${stability}`;
}

function fallbackGroupConfig(testUrl: string): HelperGroupConfig {
  return {
    testUrl,
    testUrlOverridden: false,
    mode: 'score',
    scheme: 'Balanced',
    autoSwitch: false,
    autoProbe: true,
    probeIntervalSec: 15 * 60,
    geminiLocationProbeEnabled: false,
    nodeRisk: emptyNodeRiskChecks(),
    sourceRestrictionEnabled: false,
    allowedNodeSources: [],
    allowUnlabeledNodes: false
  };
}

function emptyNodeRiskChecks(): HelperNodeRiskChecks {
  return {
    exitIp: false,
    addressScope: false,
    networkIdentity: false,
    networkClass: false,
    routeSecurity: false,
    tor: false,
    privacy: false,
    abuse: false
  };
}

function normalizeNodeRiskChecks(checks?: Partial<HelperNodeRiskChecks> | null): HelperNodeRiskChecks {
  return { ...emptyNodeRiskChecks(), ...checks };
}

function hasSelectedNodeRiskCheck(checks: HelperNodeRiskChecks): boolean {
  return (
    checks.exitIp ||
    checks.addressScope ||
    checks.networkIdentity ||
    checks.networkClass ||
    checks.routeSecurity ||
    checks.tor ||
    checks.privacy ||
    checks.abuse
  );
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function healthRow(label: string, value: string, tone: 'ok' | 'warn' | 'bad' | 'blue' | 'neutral') {
  return (
    <div className="status-line dense">
      <span>{label}</span>
      <span className={`status-chip ${tone}`}>{value}</span>
    </div>
  );
}

function buildSankeyOption(topology: ConnectionTopology) {
  const nodeNames = new Map(topology.nodes.map((node) => [node.id, node.label]));
  return {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 350,
    animationEasing: 'cubicOut' as const,
    tooltip: {
      trigger: 'item',
      triggerOn: 'mousemove',
      backgroundColor: 'rgba(13, 18, 23, 0.95)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      padding: [8, 12],
      textStyle: {
        color: '#f1f5f9',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12
      },
      formatter: (params: {
        dataType?: string;
        data?: {
          name?: string;
          source?: string;
          target?: string;
          nodeType?: string;
          originalValue?: number;
          displayName?: string;
        };
      }) => {
        if (params.dataType === 'node') {
          return `<strong>${params.data?.displayName ?? params.data?.name ?? ''}</strong><br/><span style="color:#94a3b8;font-size:11px">${params.data?.nodeType ?? ''}</span>`;
        }
        const source = params.data?.source ? nodeNames.get(params.data.source) : '';
        const target = params.data?.target ? nodeNames.get(params.data.target) : '';
        return `<div><strong style="color:#38bdf8">${source}</strong> <span style="color:#64748b">→</span> <strong style="color:#34d399">${target}</strong></div><div style="margin-top:4px;color:#94a3b8;font-size:11px">活跃会话: <strong style="color:#f1f5f9">${params.data?.originalValue ?? 0}</strong></div>`;
      }
    },
    series: [
      {
        type: 'sankey',
        left: 10,
        right: 60,
        top: 6,
        bottom: 6,
        nodeAlign: 'left',
        nodeGap: 6,
        nodeWidth: 12,
        draggable: false,
        emphasis: {
          focus: 'trajectory',
          lineStyle: {
            opacity: 0.85
          },
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(56, 189, 248, 0.4)'
          }
        },
        data: topology.nodes.map((node) => ({
          name: node.id,
          displayName: node.label,
          nodeType: ['Source', 'Rule', 'Route', 'Outbound'][node.level],
          depth: node.level,
          itemStyle: {
            color: TOPOLOGY_COLORS[node.level],
            borderRadius: 3,
            borderWidth: 0
          }
        })),
        links: topology.links.map((link) => ({
          source: link.from.id,
          target: link.to.id,
          value: Math.log10(link.value + 1) * 10,
          originalValue: link.value
        })),
        lineStyle: {
          color: 'gradient',
          curveness: 0.52,
          opacity: 0.42
        },
        itemStyle: {
          borderWidth: 0
        },
        label: {
          color: '#cbd5e1',
          fontSize: 10,
          fontWeight: 500,
          formatter: (params: { data?: { displayName?: string } }) => {
            const name = params.data?.displayName ?? '';
            return name.length > 22 ? `${name.slice(0, 19)}...` : name;
          }
        }
      }
    ]
  };
}

function buildSparklinePath(
  history: Array<{ time: string; up: number; down: number }>,
  key: 'up' | 'down',
  width: number,
  height: number,
  maxValue: number,
  now: number,
  windowMs: number
): string {
  if (history.length === 0) {
    return '';
  }

  const windowStart = now - windowMs;
  const points = history
    .map((item) => ({ ...item, timestamp: Date.parse(item.time) }))
    .filter((item) => Number.isFinite(item.timestamp) && item.timestamp >= windowStart && item.timestamp <= now)
    .map((item) => {
      const x = ((item.timestamp - windowStart) / windowMs) * width;
      const y = height - (item[key] / maxValue) * height;
      return { x, y };
    });

  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const point = points[0];
    return `M ${Math.max(0, point.x - 1.5).toFixed(1)} ${point.y.toFixed(1)} L ${Math.min(width, point.x + 1.5).toFixed(1)} ${point.y.toFixed(1)}`;
  }

  return points.reduce((path, point, index) => {
    if (index === 0) {
      return `M ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    }

    const previous = points[index - 1];
    const controlX = ((previous.x + point.x) / 2).toFixed(1);
    return `${path} C ${controlX} ${previous.y.toFixed(1)}, ${controlX} ${point.y.toFixed(1)}, ${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
  }, '');
}

function sourceTrendBucketStarts(sources: HelperNetworkUsageSourceTrendSource[]): number[] {
  const starts = new Set<number>();
  sources.forEach((source) => {
    source.buckets.forEach((bucket) => starts.add(bucket.bucketStartMs));
  });
  return Array.from(starts).sort((left, right) => left - right);
}

function sourceTrendBucketValue(source: HelperNetworkUsageSourceTrendSource, bucketStartMs: number): number {
  return source.buckets.find((bucket) => bucket.bucketStartMs === bucketStartMs)?.totalBytes ?? 0;
}

function formatSourceTrendTimestamp(value: number, bucket: HelperNetworkUsageSourceTrendBucketMode): string {
  const date = new Date(value);
  const datePart = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (bucket === 'day') {
    return datePart;
  }
  const hour = String(date.getHours()).padStart(2, '0');
  return `${datePart} ${hour}:00`;
}

function TrafficSourceTrendChart({
  sources,
  bucket,
  selectedSource,
  active
}: {
  sources: HelperNetworkUsageSourceTrendSource[];
  bucket: HelperNetworkUsageSourceTrendBucketMode;
  selectedSource: string | null;
  active: boolean;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const bucketStarts = useMemo(() => sourceTrendBucketStarts(sources), [sources]);
  const visibleSources = useMemo(
    () => (selectedSource ? sources.filter((source) => source.name === selectedSource) : sources),
    [selectedSource, sources]
  );
  const colorBySource = useMemo(() => {
    const colors = new Map<string, string>();
    sources.forEach((source, index) => {
      colors.set(source.name, SOURCE_TREND_COLORS[index % SOURCE_TREND_COLORS.length]);
    });
    return colors;
  }, [sources]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'svg' });
    chartInstanceRef.current = chart;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartRef.current);
    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart || !active) {
      return;
    }

    chart.setOption(
      {
        animation: active,
        color: visibleSources.map((source) => colorBySource.get(source.name) ?? SOURCE_TREND_COLORS[0]),
        grid: { left: 42, right: 8, top: 10, bottom: 20 },
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            type: 'line',
            lineStyle: { color: 'rgba(56,189,248,0.35)', width: 1 }
          },
          borderColor: 'rgba(255,255,255,0.12)',
          backgroundColor: 'rgba(13,18,23,0.95)',
          textStyle: {
            color: '#f1f5f9',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 11
          },
          formatter: (items: unknown) => {
            const params = Array.isArray(items) ? items : [items];
            const first = params[0] as { axisValue?: string | number } | undefined;
            const timestamp = Number(first?.axisValue ?? 0);
            const rows = params
              .map((item) => {
                const point = item as { marker?: string; seriesName?: string; value?: number };
                return `${point.marker ?? ''}${point.seriesName ?? ''}: ${formatBytes(Number(point.value ?? 0))}`;
              })
              .join('<br/>');
            return `${formatSourceTrendTimestamp(timestamp, bucket)}<br/>${rows}`;
          }
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: bucketStarts,
          axisLine: { lineStyle: { color: 'rgba(255,255,255,0.08)' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#94a3b8',
            fontSize: 10,
            formatter: (value: number) => formatSourceTrendTimestamp(Number(value), bucket)
          }
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: '#94a3b8',
            fontSize: 10,
            formatter: (value: number) => formatBytes(Number(value))
          },
          splitLine: { lineStyle: { color: 'rgba(255,255,255,0.04)' } }
        },
        series: visibleSources.map((source) => ({
          name: source.name,
          type: 'line',
          smooth: false,
          showSymbol: false,
          symbolSize: 5,
          emphasis: { focus: 'series' },
          lineStyle: {
            width: 2,
            color: colorBySource.get(source.name) ?? SOURCE_TREND_COLORS[0]
          },
          itemStyle: {
            color: colorBySource.get(source.name) ?? SOURCE_TREND_COLORS[0]
          },
          data: bucketStarts.map((bucketStartMs) => sourceTrendBucketValue(source, bucketStartMs))
        }))
      },
      true
    );
  }, [active, bucket, bucketStarts, colorBySource, visibleSources]);

  return (
    <div
      aria-label="Provider source usage trend over seven days"
      className="traffic-trend-echart"
      ref={chartRef}
      role="img"
    />
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightJsonc(content: string): string {
  const tokenPattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  let output = '';
  let lastIndex = 0;

  for (const match of content.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    output += escapeHtml(content.slice(lastIndex, index));

    if (match[1]) {
      output += `<span class="tok-comment">${escapeHtml(token)}</span>`;
    } else if (match[2]) {
      const stringToken = match[2];
      const colon = match[3] ?? '';
      output += `<span class="${colon ? 'tok-key' : 'tok-string'}">${escapeHtml(stringToken)}</span>`;
      if (colon) {
        output += `<span class="tok-punc">${escapeHtml(colon)}</span>`;
      }
    } else if (token === 'true' || token === 'false') {
      output += `<span class="tok-bool">${token}</span>`;
    } else if (token === 'null') {
      output += `<span class="tok-null">${token}</span>`;
    } else if (/^-?\d/.test(token)) {
      output += `<span class="tok-number">${token}</span>`;
    } else {
      output += `<span class="tok-punc">${escapeHtml(token)}</span>`;
    }

    lastIndex = index + token.length;
  }

  output += escapeHtml(content.slice(lastIndex));
  return output;
}

export function App() {
  const pageVisible = usePageVisible();
  const { config, detection, detecting, lastCheckedAt, urlSecretWarning, applyBrowserStartup, updateConfig, detect } =
    useControllerStore();
  const runtime = useRuntimeStore();
  const proxies = useProxyStore();
  const connections = useConnectionStore();
  const configWorkspace = useConfigStore();
  const helper = useHelperStore();
  const helperAvailability = getHelperAvailability({
    health: helper.health,
    error: helper.error,
    lastCheckedAt: helper.lastCheckedAt
  });
  const helperServiceAvailable = helperAvailability === 'ready';
  const helperStatusLabel =
    helperAvailability === 'ready'
      ? 'Helper ready'
      : helperAvailability === 'checking'
        ? 'Helper checking'
        : 'Helper offline';
  const helperStatusTone = helperAvailability === 'ready' ? 'ok' : helperAvailability === 'checking' ? 'neutral' : 'bad';
  const [form, setForm] = useState(config);
  const [testingDefaultUrlDraft, setTestingDefaultUrlDraft] = useState(config.defaultTestUrl);
  const [delayConcurrencyDraft, setDelayConcurrencyDraft] = useState(String(config.delayTestConcurrency ?? 4));
  const [delayTimeoutDraft, setDelayTimeoutDraft] = useState(
    String(config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS)
  );
  const [minProbeIntervalDraft, setMinProbeIntervalDraft] = useState('1');
  const [activeProbeIntervalDraft, setActiveProbeIntervalDraft] = useState('');
  const [trafficProfileDraft, setTrafficProfileDraft] = useState('');
  const [networkUsageSampleIntervalDraft, setNetworkUsageSampleIntervalDraft] = useState(
    String(DEFAULT_NETWORK_USAGE_SAMPLE_INTERVAL_SEC)
  );
  const [networkUsageWindow, setNetworkUsageWindow] = useState<NetworkUsageWindowId>('24h');
  const [networkUsageView, setNetworkUsageView] = useState<NetworkUsageViewId>('domains');
  const [trafficTrendBucket, setTrafficTrendBucket] =
    useState<HelperNetworkUsageSourceTrendBucketMode>('hour');
  const [trafficTrendSourceFilter, setTrafficTrendSourceFilter] = useState<string | null>(null);
  const [nodeScoreSearch, setNodeScoreSearch] = useState('');
  const [selectedNodeScoreGroup, setSelectedNodeScoreGroup] = useState('');
  const [nodeScoreDropdownOpen, setNodeScoreDropdownOpen] = useState(false);
  const [selectedNodeSourceName, setSelectedNodeSourceName] = useState('');
  const [sourceRestrictionDropdownOpen, setSourceRestrictionDropdownOpen] = useState(false);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [groupConfigSaveStatus, setGroupConfigSaveStatus] = useState<{
    groupName: string;
    tone: 'saving' | 'ok' | 'bad';
    text: string;
  } | null>(null);
  const [activeRoute, setActiveRoute] = useState<AppRoute>(() => routeFromHash(window.location.hash));
  const [activeStrategyGroupName, setActiveStrategyGroupName] = useState<string | null>(null);
  const [railExpanded, setRailExpanded] = useState(() => localStorage.getItem('singdeck-rail-expanded') !== 'false');
  const [topologyPaused, setTopologyPaused] = useState(false);
  const [configQrOpen, setConfigQrOpen] = useState(false);
  const [configQrOpening, setConfigQrOpening] = useState(false);
  const [configQrUrl, setConfigQrUrl] = useState('');
  const [configQrDataUrl, setConfigQrDataUrl] = useState('');
  const [configQrCopied, setConfigQrCopied] = useState(false);
  const [configQrIncludeSettings, setConfigQrIncludeSettings] = useState(false);
  const [helperActionStatus, setHelperActionStatus] = useState<InlineStatus | null>(null);
  const [helperPendingAction, setHelperPendingAction] = useState<string | null>(null);
  const [helperStatusAction, setHelperStatusAction] = useState<string | null>(null);
  const [localBehaviorStatus, setLocalBehaviorStatus] = useState<InlineStatus | null>(null);
  const [settingsTransferStatus, setSettingsTransferStatus] = useState<SettingsTransferStatus | null>(null);
  const [logScrollPaused, setLogScrollPaused] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    detail: string;
    confirmLabel: string;
    onConfirm: () => void;
  } | null>(null);
  const [collapsedStrategyGroups, setCollapsedStrategyGroups] = useState<Set<string>>(() => new Set());
  const [strategyGroupOrder, setStrategyGroupOrder] = useState<string[]>(readStrategyGroupOrder);
   const [draggingStrategyGroupName, setDraggingStrategyGroupName] = useState<string | null>(null);
  const [groupConfigDrafts, setGroupConfigDrafts] = useState<Record<string, HelperGroupConfig>>({});
  const [overviewVizMode, setOverviewVizMode] = useState<'worldMap' | 'topology'>('topology');
  const [connectionsViewMode, setConnectionsViewMode] = useState<'list' | 'map'>('list');
  const [dismissedErrorKeys, setDismissedErrorKeys] = useState<Set<string>>(() => new Set());
  const topologyChartRef = useRef<HTMLDivElement | null>(null);
  const topologyChartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const settingsImportInputRef = useRef<HTMLInputElement | null>(null);
  const previousHelperActiveProbeGroupsRef = useRef<Set<string>>(new Set());
  const strategyGroupsAutoCollapsedRef = useRef(false);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const sourceRestrictionMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sourceRestrictionDropdownOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (
        sourceRestrictionMenuRef.current &&
        !sourceRestrictionMenuRef.current.contains(event.target as Node)
      ) {
        setSourceRestrictionDropdownOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSourceRestrictionDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sourceRestrictionDropdownOpen]);

  const filteredLogs = useMemo(() => {
    const needle = connections.logQuery.trim().toLowerCase();
    return connections.logs
      .filter((log) => connections.logLevel === 'all' || log.level === connections.logLevel)
      .filter((log) => (needle ? log.message.toLowerCase().includes(needle) : true));
  }, [connections.logs, connections.logLevel, connections.logQuery]);

  const filteredConnections = useMemo(() => {
    const needle = connections.query.trim().toLowerCase();
    if (!needle) {
      return connections.connections;
    }
    return connections.connections.filter((connection) =>
      `${connection.target} ${connection.rule} ${connection.outbound}`.toLowerCase().includes(needle)
    );
  }, [connections.connections, connections.query]);

  useEffect(() => {
    applyBrowserStartup(window.location.hash, window.location.origin, window.location.pathname);
    const strippedHash = stripSecretFromHash(window.location.hash);
    if (strippedHash !== window.location.hash) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${strippedHash}`
      );
    }
  }, [applyBrowserStartup]);

  useEffect(() => {
    const handleHashChange = () => setActiveRoute(routeFromHash(window.location.hash));
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    setForm(config);
  }, [config]);

  useEffect(() => {
    setTestingDefaultUrlDraft(helper.testingSettings?.defaultTestUrl ?? config.defaultTestUrl);
  }, [config.defaultTestUrl, helper.testingSettings?.defaultTestUrl]);

  useEffect(() => {
    setTrafficProfileDraft(helper.trafficSettings?.browserProfile ?? '');
  }, [helper.trafficSettings?.browserProfile]);

  useEffect(() => {
    if (!helper.testingSettings) {
      return;
    }

    const patch: Partial<typeof config> = {};
    if (helper.testingSettings.defaultTestUrl && helper.testingSettings.defaultTestUrl !== config.defaultTestUrl) {
      patch.defaultTestUrl = helper.testingSettings.defaultTestUrl;
    }
    if (
      helper.testingSettings.delayTestTimeoutMs &&
      helper.testingSettings.delayTestTimeoutMs !== config.delayTestTimeoutMs
    ) {
      patch.delayTestTimeoutMs = helper.testingSettings.delayTestTimeoutMs;
    }
    if (
      helper.testingSettings.probeConcurrency &&
      helper.testingSettings.probeConcurrency !== config.delayTestConcurrency
    ) {
      patch.delayTestConcurrency = helper.testingSettings.probeConcurrency;
    }
    if (Object.keys(patch).length > 0) {
      updateConfig(patch);
    }
  }, [
    config.defaultTestUrl,
    config.delayTestConcurrency,
    config.delayTestTimeoutMs,
    helper.testingSettings?.defaultTestUrl,
    helper.testingSettings?.delayTestTimeoutMs,
    helper.testingSettings?.probeConcurrency,
    updateConfig
  ]);

  useEffect(() => {
    helper.groups.forEach((group) => {
      proxies.setGroupTestUrl(group.name, group.config.testUrl);
    });
  }, [helper.groups, proxies.setGroupTestUrl]);

  useEffect(() => {
    const knownGroups = new Set(helper.groups.map((group) => group.name));
    setGroupConfigDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([group]) => knownGroups.has(group)))
    );
  }, [helper.groups]);

  useEffect(() => {
    localStorage.setItem('singdeck-rail-expanded', String(railExpanded));
  }, [railExpanded]);

  useEffect(() => {
    localStorage.setItem(STRATEGY_GROUP_ORDER_STORAGE_KEY, JSON.stringify(strategyGroupOrder));
  }, [strategyGroupOrder]);

  useEffect(() => {
    if (config.controllerUrl && !detection && !detecting) {
      void detect();
    }
  }, [config.controllerUrl, detect, detection, detecting]);

  useEffect(() => {
    if (!pageVisible || helper.health || helper.loading || helper.lastCheckedAt) {
      return;
    }

    void useHelperStore.getState().checkHealth();
  }, [helper.health, helper.helperUrl, helper.lastCheckedAt, helper.loading, pageVisible]);

  useEffect(() => {
    if (
      !pageVisible ||
      helperAvailability !== 'ready' ||
      (activeRoute !== 'overview' && activeRoute !== 'controller' && activeRoute !== 'proxies')
    ) {
      return;
    }

    void useHelperStore.getState().loadGroups();
    void useHelperStore.getState().loadNodeSources();
  }, [activeRoute, helper.helperUrl, helperAvailability, pageVisible]);

  useEffect(() => {
    if (!pageVisible || !detection?.ok) {
      return;
    }

    void useHelperStore
      .getState()
      .syncController()
      .then(() => {
        if (activeRoute === 'overview' || activeRoute === 'controller' || activeRoute === 'proxies') {
          void useHelperStore.getState().loadGroups();
        }
      });
  }, [activeRoute, config.controllerUrl, config.secret, detection?.ok, pageVisible]);

  useEffect(() => {
    if (!pageVisible || !detection?.ok) {
      return;
    }

    void runtime.refresh();

    if (activeRoute === 'overview' || activeRoute === 'controller' || activeRoute === 'proxies') {
      void proxies.refresh();
    }

    if (activeRoute === 'overview' || activeRoute === 'controller' || activeRoute === 'proxies') {
      void useHelperStore.getState().loadGroups();
    }

    if (activeRoute === 'overview' || activeRoute === 'connections') {
      void connections.refreshConnections();
    }

    if (activeRoute === 'config') {
      void configWorkspace.loadRuntimeConfig();
    }

    if (activeRoute === 'logs' && pageVisible) {
      void connections.startLogs();
    }
  }, [activeRoute, detection?.ok, pageVisible]);

  useEffect(() => {
    if ((!pageVisible || activeRoute !== 'logs') && connections.logStreaming) {
      connections.stopLogs();
    }
  }, [activeRoute, connections.logStreaming, connections.stopLogs, pageVisible]);

  useEffect(() => {
    if (activeRoute !== 'logs' || logScrollPaused) {
      return;
    }
    const list = logListRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [activeRoute, logScrollPaused, filteredLogs]);

  useEffect(() => {
    if (!pageVisible || !helperServiceAvailable) {
      useHelperStore.getState().setEventStreamConnected(false);
      return;
    }

    return connectHelperEventStream(helper.helperUrl, {
      token: helper.helperToken,
      onOpen: () => {
        useHelperStore.getState().setEventStreamConnected(true);
        void useHelperStore.getState().loadActiveProbes();
        void useHelperStore.getState().loadGroups();
      },
      onClose: () => useHelperStore.getState().setEventStreamConnected(false)
    });
  }, [helper.helperUrl, helper.helperToken, helperServiceAvailable, pageVisible]);

  useEffect(() => {
    if (!pageVisible || !detection?.ok || helper.eventStreamConnected) {
      return;
    }

    const timer = window.setInterval(() => {
      void runtime.refresh();
      if (activeRoute === 'overview' && !topologyPaused) {
        void connections.refreshConnections();
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [
    activeRoute,
    detection?.ok,
    helper.eventStreamConnected,
    pageVisible,
    topologyPaused,
    runtime.refresh,
    connections.refreshConnections
  ]);

  const connectionLabel = detection?.ok
    ? `sing-box ${detection.version}`
    : detection
      ? detection.failure.title
      : config.controllerUrl
        ? 'Ready to check'
        : 'Awaiting controller';

  const proxyQuery = proxies.query.toLowerCase();
  const allStrategyGroups = useMemo(() => proxies.proxies.filter(isZashboardVisibleStrategyGroup), [proxies.proxies]);
  const strategyGroups = allStrategyGroups;
  useEffect(() => {
    if (strategyGroupsAutoCollapsedRef.current || allStrategyGroups.length === 0) {
      return;
    }

    strategyGroupsAutoCollapsedRef.current = true;
    setCollapsedStrategyGroups(new Set(allStrategyGroups.map((group) => group.name)));
  }, [allStrategyGroups]);
  const orderedStrategyGroups = useMemo(
    () => applyStrategyWallOrder(strategyGroups, strategyGroupOrder),
    [strategyGroupOrder, strategyGroups]
  );
  const selectedNodeSource = useMemo(
    () => helper.nodeSources.find((source) => source.name === selectedNodeSourceName) ?? null,
    [helper.nodeSources, selectedNodeSourceName]
  );
  const selectedNodeSourceNodes = useMemo(
    () => new Set(selectedNodeSource?.nodes ?? []),
    [selectedNodeSource]
  );
  const nodeSourceByNodeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of helper.nodeSources) {
      for (const nodeName of source.nodes) {
        if (!map.has(nodeName)) {
          map.set(nodeName, source.name);
        }
      }
    }
    return map;
  }, [helper.nodeSources]);
  const nodeSourceTagStyleByName = useMemo(
    () => buildNodeSourceTagStyles(helper.nodeSources.map((source) => source.name)),
    [helper.nodeSources]
  );
  const sourceFilteredStrategyGroups = useMemo(() => {
    if (!selectedNodeSource) {
      return orderedStrategyGroups;
    }

    return orderedStrategyGroups
      .map((group) => ({
        ...group,
        all: group.all.filter((member) => selectedNodeSourceNodes.has(member))
      }))
      .filter((group) => group.all.length > 0);
  }, [orderedStrategyGroups, selectedNodeSource, selectedNodeSourceNodes]);
  const allProxyNodes = useMemo(() => proxies.proxies.filter((proxy) => !isProxyGroup(proxy)), [proxies.proxies]);
  const proxyNodes = allProxyNodes;
  const proxyByName = useMemo(() => new Map(proxies.proxies.map((proxy) => [proxy.name, proxy])), [proxies.proxies]);
  const proxyDelayByName = useMemo(() => {
    const byName = new Map(proxies.proxies.map((proxy) => [proxy.name, proxy]));
    return new Map(
      proxies.proxies.map((proxy) => {
        const target = byName.get(resolveNowProxyName(proxy.name, byName));
        return [proxy.name, target?.delay ?? proxy.delay] as const;
      })
    );
  }, [proxies.proxies]);
  const defaultStrategyGroup = allStrategyGroups[0] ?? null;
  const geminiLocationGroups = allStrategyGroups.filter(isSelectableProxyGroup);
  const activeStrategyGroup = activeStrategyGroupName
    ? allStrategyGroups.find((group) => group.name === activeStrategyGroupName) ?? defaultStrategyGroup
    : defaultStrategyGroup;
  const activeStrategyMembers = useMemo<ProxyRecord[]>(() => {
    if (!activeStrategyGroup) {
      return [];
    }

    return activeStrategyGroup.all.map(
      (member) =>
        proxyByName.get(member) ?? {
          name: member,
          type: 'Unknown',
          now: '',
          all: [],
          delay: null
        }
    );
  }, [activeStrategyGroup, proxyByName]);
  const filteredStrategyMembers = useMemo(
    () =>
      activeStrategyMembers.filter((proxy) =>
        `${proxy.name} ${proxy.type} ${proxy.now}`.toLowerCase().includes(proxyQuery)
      ),
    [activeStrategyMembers, proxyQuery]
  );
  const activeProbeGroupNames = useMemo(
    () => new Set([...helper.probingGroups, ...helper.activeProbeGroups]),
    [helper.probingGroups, helper.activeProbeGroups]
  );

  useEffect(() => {
    if (
      !pageVisible ||
      !helperServiceAvailable ||
      (activeRoute !== 'proxies' && activeRoute !== 'overview') ||
      helper.eventStreamConnected
    ) {
      previousHelperActiveProbeGroupsRef.current = new Set();
      return;
    }

    let cancelled = false;
    const refreshActiveProbes = async () => {
      await useHelperStore.getState().loadActiveProbes();
      if (cancelled) {
        return;
      }

      const nextGroups = new Set(useHelperStore.getState().activeProbeGroups);
      const endedGroups = Array.from(previousHelperActiveProbeGroupsRef.current).filter(
        (group) => !nextGroups.has(group)
      );
      previousHelperActiveProbeGroupsRef.current = nextGroups;
      if (endedGroups.length > 0) {
        await Promise.all(endedGroups.map((group) => useHelperStore.getState().loadScores(group)));
      }
    };

    void refreshActiveProbes();
    const timer = window.setInterval(() => {
      void refreshActiveProbes();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRoute, helper.eventStreamConnected, helperServiceAvailable, pageVisible]);

  const helperActionBusy = Boolean(helperPendingAction) || helper.loading;
  const trafficModuleEnabled = Boolean(helper.trafficSettings?.enabled);
  const networkUsageModuleEnabled = Boolean(helper.networkUsageSettings?.enabled);
  const networkUsageRetentionDays = helper.networkUsageSettings?.retentionDays ?? 7;
  const networkUsageSampleIntervalSec =
    helper.networkUsageSettings?.sampleIntervalSec ?? DEFAULT_NETWORK_USAGE_SAMPLE_INTERVAL_SEC;
  const nodeSourceNodeCount = helper.nodeSources.reduce((total, source) => total + source.nodeCount, 0);
  const nodeSourceIssueCount = helper.nodeSources.filter((source) => Boolean(source.lastError)).length;
  const helperDefaultTestUrl = helper.testingSettings?.defaultTestUrl ?? config.defaultTestUrl;
  const helperDelayTestTimeoutMs =
    helper.testingSettings?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS;
  const helperMinProbeIntervalSec =
    helper.testingSettings?.minProbeIntervalSec ?? DEFAULT_MIN_PROBE_INTERVAL_SEC;
  const helperMinProbeIntervalMinutes = Math.max(1, Math.ceil(helperMinProbeIntervalSec / 60));
  useEffect(() => {
    setDelayConcurrencyDraft(String(config.delayTestConcurrency ?? 4));
  }, [config.delayTestConcurrency]);
  useEffect(() => {
    setDelayTimeoutDraft(String(helperDelayTestTimeoutMs));
  }, [helperDelayTestTimeoutMs]);
  useEffect(() => {
    setMinProbeIntervalDraft(String(helperMinProbeIntervalMinutes));
  }, [helperMinProbeIntervalMinutes]);
  useEffect(() => {
    setNetworkUsageSampleIntervalDraft(String(networkUsageSampleIntervalSec));
  }, [networkUsageSampleIntervalSec]);
  const localBehaviorButtonLabel = detecting
    ? 'Saving...'
    : localBehaviorStatus?.tone === 'ok'
      ? 'Saved'
      : localBehaviorStatus?.tone === 'warn'
        ? 'Save issue'
        : 'Save controller settings';
  const localBehaviorButtonTone = localBehaviorStatus?.tone ?? 'neutral';
  const helperButtonLabel = (action: string, idle: string, busy: string, success = 'Saved') => {
    if (helperPendingAction === action) {
      return busy;
    }
    if (helperStatusAction !== action || !helperActionStatus) {
      return idle;
    }
    return helperActionStatus.tone === 'ok' ? success : helperActionStatus.tone === 'warn' ? 'Issue' : busy;
  };
  const helperButtonTitle = (action: string) =>
    helperStatusAction === action && helperActionStatus ? helperActionStatus.text : undefined;
  const configQrDownloadUrl = buildMobileConfigDownloadUrl(configQrUrl, configQrIncludeSettings);
  const singBoxRemoteProfileUri = buildSingBoxRemoteProfileUri(configQrDownloadUrl, 'SingDeck');
  const configQrResolving = configQrOpening && !configQrUrl.trim();
  const configQrUrlNeedsLan = !configQrResolving && (!configQrUrl.trim() || isLoopbackUrl(configQrUrl));
  const helperGroupByName = useMemo(() => new Map(helper.groups.map((group) => [group.name, group])), [helper.groups]);
  const nodeScoreGroups = useMemo(() => {
    const helperGroupNames = new Set(helper.groups.map((group) => group.name));
    const fromHelperGroups = helper.groups.map((group) => {
      const scores =
        helper.scoresByGroup[group.name] ?? {
          group: group.name,
          mode: group.config.mode,
          scheme: group.config.scheme,
          testUrl: group.config.testUrl,
          recommended: null,
          applyError: null,
          nodes: []
        };
      const nodes = scores.nodes ?? [];
      return {
        scores,
        updatedAt: probeSnapshotTimestamp(nodes),
        failedCount: nodes.filter((node) => node.raw?.success === false || Boolean(node.error)).length
      };
    });
    const fromScoresOnly = Object.values(helper.scoresByGroup)
      .filter((scores) => !helperGroupNames.has(scores.group))
      .map((scores) => {
        const nodes = scores.nodes ?? [];
        return {
          scores,
          updatedAt: probeSnapshotTimestamp(nodes),
          failedCount: nodes.filter((node) => node.raw?.success === false || Boolean(node.error)).length
        };
      });
    return [...fromHelperGroups, ...fromScoresOnly].sort(
      (left, right) => (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0)
    );
  }, [helper.groups, helper.scoresByGroup]);
  const filteredNodeScoreGroups = useMemo(() => {
    const query = nodeScoreSearch.trim().toLowerCase();
    return query
      ? nodeScoreGroups.filter((item) => item.scores.group.toLowerCase().includes(query))
      : nodeScoreGroups;
  }, [nodeScoreGroups, nodeScoreSearch]);
  const selectedNodeScoreSnapshot = selectedNodeScoreGroup
    ? nodeScoreGroups.find((item) => item.scores.group === selectedNodeScoreGroup) ?? null
    : null;

  useEffect(() => {
    if (selectedNodeScoreGroup && !nodeScoreGroups.some((item) => item.scores.group === selectedNodeScoreGroup)) {
      setSelectedNodeScoreGroup('');
    }
  }, [nodeScoreGroups, selectedNodeScoreGroup]);

  useEffect(() => {
    if (selectedNodeSourceName && !helper.nodeSources.some((source) => source.name === selectedNodeSourceName)) {
      setSelectedNodeSourceName('');
    }
  }, [helper.nodeSources, selectedNodeSourceName]);

  useEffect(() => {
    if (activeRoute !== 'connections') {
      setSelectedConnectionId(null);
      return;
    }
    if (selectedConnectionId && !connections.connections.some((connection) => connection.id === selectedConnectionId)) {
      setSelectedConnectionId(null);
    }
  }, [activeRoute, connections.connections, selectedConnectionId]);

  const activeHelperGroup = activeStrategyGroup ? helperGroupByName.get(activeStrategyGroup.name) : undefined;
  const activeHelperScores = activeStrategyGroup ? helper.scoresByGroup[activeStrategyGroup.name] : undefined;
  const activeHelperScoreByName = useMemo(
    () => new Map((activeHelperScores?.nodes ?? []).map((score) => [score.name, score])),
    [activeHelperScores]
  );
  const activeGroupTestUrl =
    activeStrategyGroup
      ? activeHelperGroup?.config.testUrl || proxies.groupTestUrls[activeStrategyGroup.name] || helperDefaultTestUrl
      : helperDefaultTestUrl;
  const activeGroupConfig =
    activeStrategyGroup && groupConfigDrafts[activeStrategyGroup.name]
      ? groupConfigDrafts[activeStrategyGroup.name]
      : activeHelperGroup?.config ?? fallbackGroupConfig(activeGroupTestUrl);
  const activeSourceRestrictionEnabled = Boolean(activeGroupConfig.sourceRestrictionEnabled);
  const activeAllowedNodeSources = activeGroupConfig.allowedNodeSources ?? [];
  const activeAllowedSourcesSet = useMemo(
    () => new Set(activeAllowedNodeSources),
    [activeAllowedNodeSources]
  );
  const activeNodeSourceNames = useMemo(
    () => new Set(helper.nodeSources.map((source) => source.name)),
    [helper.nodeSources]
  );
  const activeMissingAllowedSources = useMemo(
    () => activeAllowedNodeSources.filter((source) => !activeNodeSourceNames.has(source)),
    [activeAllowedNodeSources, activeNodeSourceNames]
  );
  const activeCanRestrictSources = Boolean(
    activeStrategyGroup && isSelectableProxyGroup(activeStrategyGroup)
  );
  const activeSourceEligibleCount = useMemo(() => {
    if (!activeStrategyGroup) {
      return 0;
    }
    return activeStrategyGroup.all.filter((memberName) => {
      const member = proxyByName.get(memberName);
      return sourceRestrictionAllowsNode(
        memberName,
        Boolean(member && isProxyGroup(member)),
        activeAllowedSourcesSet,
        activeGroupConfig.allowUnlabeledNodes,
        nodeSourceByNodeName,
        activeSourceRestrictionEnabled
      );
    }).length;
  }, [
    activeStrategyGroup,
    proxyByName,
    activeAllowedSourcesSet,
    activeGroupConfig.allowUnlabeledNodes,
    nodeSourceByNodeName,
    activeSourceRestrictionEnabled
  ]);
  const activeCurrentSourceAllowed = useMemo(() => {
    if (!activeStrategyGroup) {
      return true;
    }
    return sourceRestrictionAllowsNode(
      activeStrategyGroup.now,
      Boolean(proxyByName.get(activeStrategyGroup.now)?.all.length),
      activeAllowedSourcesSet,
      activeGroupConfig.allowUnlabeledNodes,
      nodeSourceByNodeName,
      activeSourceRestrictionEnabled
    );
  }, [
    activeStrategyGroup,
    proxyByName,
    activeAllowedSourcesSet,
    activeGroupConfig.allowUnlabeledNodes,
    nodeSourceByNodeName,
    activeSourceRestrictionEnabled
  ]);
  const activeSourceSelectionCount = useMemo(
    () => activeAllowedNodeSources.length + (activeGroupConfig.allowUnlabeledNodes ? 1 : 0),
    [activeAllowedNodeSources.length, activeGroupConfig.allowUnlabeledNodes]
  );
  const activeSourceSelectionLabel = useMemo(
    () =>
      activeSourceSelectionCount === 0
        ? '未选择来源'
        : `${activeAllowedNodeSources.length} 个来源${
            activeGroupConfig.allowUnlabeledNodes ? ' + 未标记' : ''
          }`,
    [activeAllowedNodeSources.length, activeGroupConfig.allowUnlabeledNodes, activeSourceSelectionCount]
  );
  const activeNodeRisk = normalizeNodeRiskChecks(activeGroupConfig.nodeRisk);
  const activeIsGeminiLocationGroup = Boolean(
    activeStrategyGroup &&
      isSelectableProxyGroup(activeStrategyGroup) &&
      helper.testingSettings?.geminiLocationGroup === activeStrategyGroup.name
  );
  const activeSupportsNodeInspection = Boolean(activeStrategyGroup && activeStrategyMembers.length > 0);
  const activeAdvancedRiskEnabled =
    activeNodeRisk.addressScope ||
    activeNodeRisk.networkIdentity ||
    activeNodeRisk.routeSecurity ||
    activeNodeRisk.tor ||
    activeNodeRisk.privacy ||
    activeNodeRisk.abuse;
  const activeProbeExecution = activeStrategyGroup
    ? resolveProbeExecution(activeStrategyGroup, activeGroupConfig.mode)
    : null;
  const activeNativeGroupTesting = Boolean(
    activeStrategyGroup &&
      activeProbeExecution?.mode === 'native-urltest' &&
      proxies.testingProxies.includes(activeStrategyGroup.name)
  );
  const activeSelectedScore =
    activeProbeExecution?.mode !== 'native-urltest' && activeStrategyGroup
      ? activeHelperScoreByName.get(activeStrategyGroup.now)
      : undefined;
  const activeSelectedDelay = activeStrategyGroup
    ? activeProbeExecution?.mode === 'helper-score'
      ? activeSelectedScore?.delayMs ?? null
      : proxies.groupDelayResults[activeStrategyGroup.name] ??
        proxyDelayByName.get(activeStrategyGroup.now) ??
        activeStrategyGroup.delay
    : null;
  const activeInspectorModel = buildProxyInspectorModel({
    group: activeStrategyGroup,
    config: activeGroupConfig,
    execution: activeProbeExecution,
    helperAvailable: helperServiceAvailable,
    selectedDelay: activeSelectedDelay,
    selectedScore: activeSelectedScore,
    testUrl: activeProbeExecution?.mode === 'native-urltest' ? 'sing-box urltest.url' : activeGroupTestUrl
  });
  const activeGroupConfigSaveStatus =
    activeStrategyGroup && groupConfigSaveStatus?.groupName === activeStrategyGroup.name ? groupConfigSaveStatus : null;
  useEffect(() => {
    setActiveProbeIntervalDraft(String(activeInspectorModel.intervalMinutes));
  }, [activeInspectorModel.intervalMinutes, activeStrategyGroup?.name]);
  useEffect(() => {
    setGroupConfigSaveStatus(null);
    setSourceRestrictionDropdownOpen(false);
  }, [activeStrategyGroup?.name]);
  const activeGroupBusy = Boolean(
    activeStrategyGroup && (activeProbeGroupNames.has(activeStrategyGroup.name) || activeNativeGroupTesting)
  );
  const activeGroupInspecting = Boolean(
    activeStrategyGroup && helper.inspectingGroups.includes(activeStrategyGroup.name)
  );
  const activeHasInspectionSelection = Boolean(
    (activeIsGeminiLocationGroup && activeGroupConfig.geminiLocationProbeEnabled) ||
      hasSelectedNodeRiskCheck(activeNodeRisk)
  );
  const activeGroupActivity = describeProbeActivity({
    mode: activeGroupConfig.mode,
    groupProbing: activeGroupBusy
  });
  const activeCanRunProbe = Boolean(
    activeStrategyGroup &&
      activeStrategyMembers.length > 0 &&
      (helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest') &&
      !activeGroupBusy &&
      !activeGroupInspecting &&
      !proxies.testingAllNodes
  );
  const activeCanRunInspection = Boolean(
    activeStrategyGroup &&
      activeStrategyMembers.length > 0 &&
      helperServiceAvailable &&
      activeSupportsNodeInspection &&
      activeHasInspectionSelection &&
      !activeGroupBusy &&
      !activeGroupInspecting &&
      !proxies.testingAllNodes
  );
  const strategyWallGroups = useMemo(() => {
    return buildStrategyWallGroups({
      groups: sourceFilteredStrategyGroups,
      activeName: activeStrategyGroup?.name ?? null,
      proxyByName,
      query: proxyQuery
    });
  }, [activeStrategyGroup?.name, proxyByName, proxyQuery, sourceFilteredStrategyGroups]);
  const strategyWallColumns = useMemo(() => {
    const groupByName = new Map(strategyWallGroups.map((group) => [group.name, group]));
    return distributeStrategyWallColumns(
      strategyWallGroups.map((group) => ({
        name: group.name,
        memberCount: group.all.length,
        expanded: activeStrategyGroup?.name === group.name,
        collapsed: collapsedStrategyGroups.has(group.name)
      })),
      2
    ).map((column) => column.map((name) => groupByName.get(name)).filter((group): group is ProxyRecord => Boolean(group)));
  }, [activeStrategyGroup?.name, collapsedStrategyGroups, strategyWallGroups]);
  const selectableGroups = allStrategyGroups.filter(isSelectableProxyGroup);
  const activeSelectors = selectableGroups
    .filter((group) => group.now)
    .slice(0, 5)
    .map((group) => `${group.name}: ${group.now}`);
  const protocolSummary = useMemo(() => {
    const counts = allProxyNodes.reduce<Record<string, number>>((accumulator, proxy) => {
      accumulator[proxy.type] = (accumulator[proxy.type] ?? 0) + 1;
      return accumulator;
    }, {});
    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6);
  }, [allProxyNodes]);
  const topology = useMemo(() => buildConnectionTopology(connections.connections), [connections.connections]);
  const selectedConnection = useMemo(
    () => connections.connections.find((connection) => connection.id === selectedConnectionId) ?? null,
    [connections.connections, selectedConnectionId]
  );
  const ruleHitSummary = useMemo(() => {
    const counts = connections.connections.reduce<Record<string, number>>((accumulator, connection) => {
      const rule = topologyRuleLabel(connection.rule || 'unknown');
      accumulator[rule] = (accumulator[rule] ?? 0) + 1;
      return accumulator;
    }, {});
    return Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 4);
  }, [connections.connections]);
  const dnsLogCount = useMemo(
    () => connections.logs.filter((log) => log.message.toLowerCase().includes('dns')).length,
    [connections.logs]
  );
  const failedProxyCount = useMemo(
    () => allProxyNodes.filter((proxy) => delayTone(proxy.delay) === 'bad').length,
    [allProxyNodes]
  );
  const healthyProxyCount = useMemo(
    () => allProxyNodes.filter((proxy) => delayTone(proxy.delay) === 'good').length,
    [allProxyNodes]
  );
  const railTrendMax = useMemo(
    () => {
      const now = runtime.lastUpdatedAt ? Date.parse(runtime.lastUpdatedAt) : Date.now();
      const windowStart = now - TRAFFIC_SPARKLINE_WINDOW_MS;
      const windowed = runtime.history.filter((item) => {
        const timestamp = Date.parse(item.time);
        return Number.isFinite(timestamp) && timestamp >= windowStart && timestamp <= now;
      });
      const source = windowed.length > 0 ? windowed : runtime.history.slice(-24);
      return Math.max(1, ...source.flatMap((item) => [item.up, item.down]));
    },
    [runtime.history, runtime.lastUpdatedAt]
  );
  const sparklineNow = useMemo(
    () => (runtime.lastUpdatedAt ? Date.parse(runtime.lastUpdatedAt) : Date.now()),
    [runtime.lastUpdatedAt]
  );
  const railDownPath = useMemo(
    () =>
      buildSparklinePath(
        runtime.history,
        'down',
        TRAFFIC_SPARKLINE_WIDTH,
        TRAFFIC_SPARKLINE_HEIGHT,
        railTrendMax,
        sparklineNow,
        TRAFFIC_SPARKLINE_WINDOW_MS
      ),
    [railTrendMax, runtime.history, sparklineNow]
  );
  const railUpPath = useMemo(
    () =>
      buildSparklinePath(
        runtime.history,
        'up',
        TRAFFIC_SPARKLINE_WIDTH,
        TRAFFIC_SPARKLINE_HEIGHT,
        railTrendMax,
        sparklineNow,
        TRAFFIC_SPARKLINE_WINDOW_MS
    ),
    [railTrendMax, runtime.history, sparklineNow]
  );
  const sourceTrendSources = helper.networkUsageSourceTrend?.sources ?? [];
  const sourceTrendHasSamples = sourceTrendSources.some((source) => source.totalBytes > 0);
  const highlightedConfig = useMemo(() => highlightJsonc(configWorkspace.content), [configWorkspace.content]);
  const activeSection = sections.find((section) => section.id === activeRoute) ?? sections[0];
  const activeSubtitle = sectionSubtitles[activeRoute];
  const runtimeClock = runtime.lastUpdatedAt ? new Date(runtime.lastUpdatedAt).toLocaleTimeString() : 'idle';
  const apiLabel = connectionLabel;
  const navCounts: Record<AppRoute, string> = {
    overview: String(connections.connections.length),
    proxies: String(allProxyNodes.length || allStrategyGroups.length),
    connections: String(connections.connections.length),
    logs: String(connections.logs.length),
    config: configWorkspace.snapshots.length ? String(configWorkspace.snapshots.length) : '',
    controller: ''
  };

  useEffect(() => {
    if (!pageVisible || activeRoute !== 'overview' || !helperServiceAvailable || !trafficModuleEnabled) {
      return;
    }

    // Silent: only sync if the cached snapshot is missing or older than 5 min.
    // Switching tabs / refocusing no longer triggers a full reload-and-flash-empty.
    const TRAFFIC_MAX_AGE_MS = 5 * 60 * 1000;
    void useHelperStore.getState().refreshTrafficIfStale(TRAFFIC_MAX_AGE_MS);
    const timer = window.setInterval(() => {
      void useHelperStore.getState().refreshTrafficIfStale(TRAFFIC_MAX_AGE_MS);
    }, TRAFFIC_MAX_AGE_MS);

    return () => window.clearInterval(timer);
  }, [activeRoute, helperServiceAvailable, pageVisible, trafficModuleEnabled]);

  useEffect(() => {
    if (trafficTrendSourceFilter && !sourceTrendSources.some((source) => source.name === trafficTrendSourceFilter)) {
      setTrafficTrendSourceFilter(null);
    }
  }, [sourceTrendSources, trafficTrendSourceFilter]);

  useEffect(() => {
    if (!pageVisible || activeRoute !== 'overview' || !helperServiceAvailable || !networkUsageModuleEnabled) {
      return;
    }

    const loadSourceTrend = () => {
      void useHelperStore.getState().loadNetworkUsageSourceTrend(buildSourceTrendRequest(trafficTrendBucket));
    };
    loadSourceTrend();
    const timer = window.setInterval(loadSourceTrend, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [activeRoute, helperServiceAvailable, networkUsageModuleEnabled, pageVisible, trafficTrendBucket]);

  useEffect(() => {
    if (!pageVisible || activeRoute !== 'overview' || !helperServiceAvailable || !networkUsageModuleEnabled) {
      return;
    }

    const loadUsage = () => {
      void useHelperStore.getState().loadNetworkUsageWindow(buildNetworkUsageRequest(networkUsageWindow));
    };
    loadUsage();
    const timer = window.setInterval(loadUsage, 60 * 1000);

    return () => window.clearInterval(timer);
  }, [activeRoute, helperServiceAvailable, networkUsageModuleEnabled, networkUsageWindow, pageVisible]);

  useEffect(() => {
    if (!pageVisible || (activeRoute !== 'proxies' && activeRoute !== 'overview') || !activeStrategyGroup?.name) {
      return;
    }

    void useHelperStore.getState().loadScores(activeStrategyGroup.name);
  }, [activeRoute, activeStrategyGroup?.name, pageVisible]);

  useEffect(() => {
    if (!configQrOpen || !configQrUrl.trim() || isLoopbackUrl(configQrUrl)) {
      setConfigQrDataUrl('');
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(singBoxRemoteProfileUri, {
      width: 224,
      margin: 1,
      color: {
        dark: '#07100d',
        light: '#f4fff9'
      }
    })
      .then((value) => {
        if (!cancelled) {
          setConfigQrDataUrl(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfigQrDataUrl('');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [configQrOpen, configQrUrl, singBoxRemoteProfileUri]);

  useEffect(() => {
    setConfigQrCopied(false);
  }, [configQrUrl]);

  useEffect(() => {
    if (activeRoute !== 'overview' || overviewVizMode !== 'topology' || !topologyChartRef.current) {
      return;
    }

    const chart = echarts.init(topologyChartRef.current);
    topologyChartInstanceRef.current = chart;
    const pause = () => setTopologyPaused(true);
    const resume = () => setTopologyPaused(false);
    chart.on('showTip', pause);
    chart.on('hideTip', resume);

    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(topologyChartRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.off('showTip', pause);
      chart.off('hideTip', resume);
      chart.dispose();
      topologyChartInstanceRef.current = null;
      setTopologyPaused(false);
    };
  }, [activeRoute, overviewVizMode]);

  useEffect(() => {
    const chart = topologyChartInstanceRef.current;
    if (activeRoute !== 'overview' || overviewVizMode !== 'topology' || !pageVisible || !chart) {
      return;
    }

    if (topology.nodes.length === 0) {
      chart.clear();
      return;
    }

    chart.setOption(buildSankeyOption(topology), true);
  }, [activeRoute, overviewVizMode, pageVisible, topology]);

  const runHelperAction = async (action: string, pendingText: string, work: () => Promise<InlineStatus>) => {
    setHelperPendingAction(action);
    setHelperStatusAction(action);
    setHelperActionStatus({ tone: 'neutral', text: pendingText });
    try {
      setHelperActionStatus(await work());
    } catch (error) {
      setHelperActionStatus({
        tone: 'warn',
        text: error instanceof Error ? error.message : 'Helper action failed.'
      });
    } finally {
      setHelperPendingAction(null);
    }
  };

  const checkHelperWithFeedback = () =>
    runHelperAction('check', 'Checking helper...', async () => {
      await useHelperStore.getState().checkHealth();
      const state = useHelperStore.getState();
      if (state.error) {
        return { tone: 'warn', text: state.error };
      }
      if (state.health?.mobileConfigUrl) {
        return { tone: 'ok', text: `Helper ready. QR URL ${state.health.mobileConfigUrl}` };
      }
      return { tone: 'warn', text: 'Helper ready, but LAN QR URL is unavailable. Set SINGDECK_HELPER_PUBLIC_URL.' };
    });

  const syncControllerWithFeedback = () =>
    runHelperAction('sync', 'Syncing controller...', async () => {
      await useHelperStore.getState().syncController({ force: true });
      const state = useHelperStore.getState();
      return state.error
        ? { tone: 'warn', text: state.error }
        : { tone: 'ok', text: 'Controller URL and secret saved to helper.' };
    });

  const saveConfigPathWithFeedback = () =>
    runHelperAction('config', 'Saving config source...', async () => {
      await useHelperStore.getState().saveConfigPath();
      const state = useHelperStore.getState();
      if (state.error) {
        return { tone: 'warn', text: state.error };
      }
      return {
        tone: 'ok',
        text: state.configPath
          ? `Config source saved: ${state.configPath}`
          : 'Config source cleared. Set Config path before loading config.'
      };
    });

  const refreshNodeSourcesWithFeedback = () =>
    runHelperAction('node-sources', 'Refreshing subscription sources...', async () => {
      await useHelperStore.getState().refreshNodeSources();
      const state = useHelperStore.getState();
      if (state.nodeSourcesRefreshError) {
        return { tone: 'warn', text: state.nodeSourcesRefreshError };
      }
      const subscriptionSources = state.nodeSources.filter(
        (source) => source.associate && source.url.trim().length > 0
      );
      const failedSources = state.nodeSources.filter((source) => Boolean(source.lastError));
      if (failedSources.length > 0) {
        return {
          tone: 'warn',
          text: `${failedSources.length} source(s) reported issues. Cached subscription associations were kept where available.`
        };
      }
      return subscriptionSources.length > 0
        ? { tone: 'ok', text: `Refreshed ${subscriptionSources.length} subscription source(s).` }
        : { tone: 'ok', text: 'Node sources refreshed. No associated subscription URLs are configured.' };
    });

  const saveTrafficWithFeedback = (enabled: boolean, browserProfile: string) =>
    runHelperAction('traffic', enabled ? 'Saving and syncing traffic...' : 'Disabling provider traffic...', async () => {
      await useHelperStore.getState().saveTrafficSettings({ enabled, browserProfile });
      const state = useHelperStore.getState();
      if (state.error) {
        return { tone: 'warn', text: state.error };
      }
      if (!enabled) {
        return { tone: 'ok', text: 'Provider traffic disabled.' };
      }
      if (state.trafficError) {
        return { tone: 'warn', text: `Traffic profile saved, sync failed: ${state.trafficError}` };
      }
      return { tone: 'ok', text: 'Traffic profile saved and synced.' };
    });

  const saveNetworkUsageWithFeedback = (
    enabled: boolean,
    sampleIntervalSec = networkUsageSampleIntervalSec
  ) =>
    runHelperAction('network-usage', enabled ? 'Enabling usage capture...' : 'Disabling usage capture...', async () => {
      await useHelperStore.getState().saveNetworkUsageSettings({
        enabled,
        retentionDays: networkUsageRetentionDays,
        sampleIntervalSec
      });
      const state = useHelperStore.getState();
      if (state.error) {
        return { tone: 'warn', text: state.error };
      }
      return enabled
        ? { tone: 'ok', text: `Network usage capture enabled for ${networkUsageRetentionDays} days.` }
        : { tone: 'ok', text: 'Network usage capture disabled.' };
    });

  const commitNetworkUsageSampleInterval = () => {
    const sampleIntervalSec = parseIntegerDraft(
      networkUsageSampleIntervalDraft,
      networkUsageSampleIntervalSec,
      MIN_NETWORK_USAGE_SAMPLE_INTERVAL_SEC,
      MAX_NETWORK_USAGE_SAMPLE_INTERVAL_SEC
    );
    setNetworkUsageSampleIntervalDraft(String(sampleIntervalSec));
    void saveNetworkUsageWithFeedback(networkUsageModuleEnabled, sampleIntervalSec);
  };

  const saveLocalBehavior = async () => {
    setLocalBehaviorStatus({ tone: 'neutral', text: 'Saving controller and test defaults...' });
    updateConfig(form);
    if (helperServiceAvailable) {
      await useHelperStore.getState().saveDelayTestTimeout(form.delayTestTimeoutMs ?? helperDelayTestTimeoutMs);
    }
    await detect();
    await runtime.refresh();
    const latestDetection = useControllerStore.getState().detection;
    setLocalBehaviorStatus(
      latestDetection?.ok
        ? { tone: 'ok', text: 'Saved browser settings. Controller check passed.' }
        : { tone: 'warn', text: latestDetection?.failure.detail ?? 'Saved browser settings. Controller check did not pass.' }
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void saveLocalBehavior();
  };

  const commitDelayTestTimeout = async (timeout: number) => {
    setForm((current) => ({ ...current, delayTestTimeoutMs: timeout }));
    setDelayTimeoutDraft(String(timeout));
    if (!helperServiceAvailable) {
      updateConfig({ delayTestTimeoutMs: timeout });
      return;
    }

    await useHelperStore.getState().saveDelayTestTimeout(timeout);
    const savedTimeout = useHelperStore.getState().testingSettings?.delayTestTimeoutMs ?? timeout;
    updateConfig({ delayTestTimeoutMs: savedTimeout });
    setDelayTimeoutDraft(String(savedTimeout));
  };

  const commitDelayConcurrency = (fallback = config.delayTestConcurrency ?? 4) => {
    const concurrency = parseIntegerDraft(delayConcurrencyDraft, fallback, 1, 64);
    setDelayConcurrencyDraft(String(concurrency));
    setForm((current) => ({ ...current, delayTestConcurrency: concurrency }));
    updateConfig({ delayTestConcurrency: concurrency });
  };

  const commitMinimumProbeInterval = async () => {
    const minutes = parseIntegerDraft(minProbeIntervalDraft, helperMinProbeIntervalMinutes, 1, 1440);
    setMinProbeIntervalDraft(String(minutes));
    await helper.saveMinProbeInterval(minutes * 60);
  };

  const draftActiveProbeInterval = () => {
    if (!activeStrategyGroup) {
      return;
    }
    const minutes = parseIntegerDraft(
      activeProbeIntervalDraft,
      activeInspectorModel.intervalMinutes,
      helperMinProbeIntervalMinutes,
      1440
    );
    setActiveProbeIntervalDraft(String(minutes));
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
      probeIntervalSec: minutes * 60
    });
  };

  const handleConfigFileLoad = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file) {
      return;
    }

    void file.text().then((content) => configWorkspace.loadConfigFile(content, `file:${file.name}`));
  };

  const buildNextGroupConfig = (
    currentConfig: HelperGroupConfig,
    patch: Partial<HelperGroupConfig>
  ): HelperGroupConfig => {
    const hasTestUrlPatch = Object.prototype.hasOwnProperty.call(patch, 'testUrl');
    const nextProbeIntervalSec =
      patch.probeIntervalSec === undefined
        ? currentConfig.probeIntervalSec
        : Math.max(patch.probeIntervalSec, helperMinProbeIntervalSec);
    const nextConfig: HelperGroupConfig = {
      ...currentConfig,
      ...patch,
      probeIntervalSec: nextProbeIntervalSec,
      testUrl: ((patch.testUrl ?? currentConfig.testUrl) || helperDefaultTestUrl).trim() || helperDefaultTestUrl,
      testUrlOverridden: patch.testUrlOverridden ?? (hasTestUrlPatch ? true : currentConfig.testUrlOverridden),
      geminiLocationProbeEnabled:
        patch.geminiLocationProbeEnabled ?? currentConfig.geminiLocationProbeEnabled ?? false,
      nodeRisk: normalizeNodeRiskChecks(patch.nodeRisk ?? currentConfig.nodeRisk),
      sourceRestrictionEnabled:
        patch.sourceRestrictionEnabled ?? currentConfig.sourceRestrictionEnabled ?? false,
      allowedNodeSources: [
        ...(patch.allowedNodeSources ?? currentConfig.allowedNodeSources ?? [])
      ],
      allowUnlabeledNodes:
        patch.allowUnlabeledNodes ?? currentConfig.allowUnlabeledNodes ?? false
    };
    return nextConfig;
  };

  const draftGroupConfigFor = (groupName: string, currentConfig: HelperGroupConfig, patch: Partial<HelperGroupConfig>) => {
    const nextConfig = buildNextGroupConfig(currentConfig, patch);
    setGroupConfigDrafts((current) => ({ ...current, [groupName]: nextConfig }));
    proxies.setGroupTestUrl(groupName, nextConfig.testUrl);
    return nextConfig;
  };

  const toggleActiveSourceRestriction = (enabled: boolean) => {
    if (!activeStrategyGroup || !activeCanRestrictSources) {
      return;
    }
    const hasSavedSelection =
      activeAllowedNodeSources.length > 0 || Boolean(activeGroupConfig.allowUnlabeledNodes);
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
      sourceRestrictionEnabled: enabled,
      allowedNodeSources:
        enabled && !hasSavedSelection
          ? helper.nodeSources.map((source) => source.name)
          : activeAllowedNodeSources,
      allowUnlabeledNodes:
        enabled && !hasSavedSelection ? true : Boolean(activeGroupConfig.allowUnlabeledNodes)
    });
    setSourceRestrictionDropdownOpen(enabled);
  };

  const toggleActiveAllowedNodeSource = (sourceName: string, enabled: boolean) => {
    if (!activeStrategyGroup) {
      return;
    }
    const next = enabled
      ? Array.from(new Set([...activeAllowedNodeSources, sourceName]))
      : activeAllowedNodeSources.filter((source) => source !== sourceName);
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
      allowedNodeSources: next
    });
  };

  const selectAllActiveNodeSources = () => {
    if (!activeStrategyGroup) {
      return;
    }
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
      allowedNodeSources: helper.nodeSources.map((source) => source.name),
      allowUnlabeledNodes: true
    });
  };

  const clearActiveNodeSources = () => {
    if (!activeStrategyGroup) {
      return;
    }
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
      allowedNodeSources: [],
      allowUnlabeledNodes: false
    });
  };

  const fixActiveSourceViolation = async (groupToFix = activeStrategyGroup) => {
    if (!groupToFix || !isSelectableProxyGroup(groupToFix)) {
      return;
    }
    const targetConfig =
      groupConfigDrafts[groupToFix.name] ??
      helperGroupByName.get(groupToFix.name)?.config ??
      fallbackGroupConfig(helperDefaultTestUrl);
    const allowedSet = new Set(targetConfig.allowedNodeSources ?? []);

    const allowedMembers = groupToFix.all.filter((memberName) => {
      const member = proxyByName.get(memberName);
      return sourceRestrictionAllowsNode(
        memberName,
        Boolean(member && isProxyGroup(member)),
        allowedSet,
        targetConfig.allowUnlabeledNodes,
        nodeSourceByNodeName,
        true
      );
    });

    if (allowedMembers.length === 0) {
      return;
    }

    const sorted = [...allowedMembers].sort((a, b) => {
      const scoreA = activeHelperScoreByName.get(a)?.score ?? -1;
      const scoreB = activeHelperScoreByName.get(b)?.score ?? -1;
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      const delayA = proxies.proxies.find((p) => p.name === a)?.delay ?? 99999;
      const delayB = proxies.proxies.find((p) => p.name === b)?.delay ?? 99999;
      return delayA - delayB;
    });

    const bestNode = sorted[0];
    if (bestNode) {
      if (helperServiceAvailable) {
        await helper.applyNode(groupToFix.name, bestNode).then(() => proxies.refresh());
      } else {
        await proxies.switchProxy(groupToFix.name, bestNode);
      }
    }
  };

  const saveGroupConfigFor = (groupName: string, currentConfig: HelperGroupConfig, patch: Partial<HelperGroupConfig>) => {
    const nextConfig = draftGroupConfigFor(groupName, currentConfig, patch);
    void helper.saveGroupConfig(groupName, nextConfig);
  };

  const draftActiveNodeRiskCheck = (key: keyof HelperNodeRiskChecks, enabled: boolean) => {
    if (!activeStrategyGroup) {
      return;
    }
    const next = { ...activeNodeRisk, [key]: enabled };
    draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { nodeRisk: next });
  };

  const saveActiveGroupConfig = async () => {
    if (!activeStrategyGroup || !helperServiceAvailable) {
      return;
    }
    if (
      activeSourceRestrictionEnabled &&
      activeAllowedNodeSources.length === 0 &&
      !activeGroupConfig.allowUnlabeledNodes
    ) {
      setGroupConfigSaveStatus({
        groupName: activeStrategyGroup.name,
        tone: 'bad',
        text: 'Select a source'
      });
      return;
    }

    const intervalMinutes = parseIntegerDraft(
      activeProbeIntervalDraft,
      activeInspectorModel.intervalMinutes,
      helperMinProbeIntervalMinutes,
      1440
    );
    const nextConfig = buildNextGroupConfig(activeGroupConfig, {
      probeIntervalSec: intervalMinutes * 60
    });
    setActiveProbeIntervalDraft(String(intervalMinutes));
    setGroupConfigDrafts((current) => ({ ...current, [activeStrategyGroup.name]: nextConfig }));
    proxies.setGroupTestUrl(activeStrategyGroup.name, nextConfig.testUrl);
    commitDelayConcurrency(4);

    setGroupConfigSaveStatus({
      groupName: activeStrategyGroup.name,
      tone: 'saving',
      text: 'Saving...'
    });
    await helper.saveGroupConfig(activeStrategyGroup.name, nextConfig);
    const saveError = useHelperStore.getState().error;
    if (saveError) {
      setGroupConfigSaveStatus({
        groupName: activeStrategyGroup.name,
        tone: 'bad',
        text: 'Save failed'
      });
      return;
    }

    setGroupConfigSaveStatus({
      groupName: activeStrategyGroup.name,
      tone: 'ok',
      text: 'Saved'
    });
    setSourceRestrictionDropdownOpen(false);
    await Promise.all([proxies.refresh(), useHelperStore.getState().loadGroups()]);
  };

  const runGroupProbe = async (group: ProxyRecord | null) => {
    if (!group || !helperServiceAvailable) {
      return;
    }

    const helperGroup = helperGroupByName.get(group.name);
    const rowConfig =
      groupConfigDrafts[group.name] ??
      helperGroup?.config ??
      fallbackGroupConfig(proxies.groupTestUrls[group.name] || helperDefaultTestUrl);
    await useHelperStore.getState().probeGroup(group.name, config.delayTestConcurrency ?? 4);
    const probeResult = useHelperStore.getState().scoresByGroup[group.name];
    if (rowConfig.autoSwitch && isSelectableProxyGroup(group) && probeResult?.applyError === null) {
      await useProxyStore.getState().refresh();
      await useHelperStore.getState().loadGroups();
    }
  };

  const runGroupDelayOrProbe = async (group: ProxyRecord | null) => {
    if (!group) {
      return;
    }

    const helperGroup = helperGroupByName.get(group.name);
    const rowConfig =
      groupConfigDrafts[group.name] ??
      helperGroup?.config ??
      fallbackGroupConfig(proxies.groupTestUrls[group.name] || helperDefaultTestUrl);
    const execution = resolveProbeExecution(group, rowConfig.mode);
    if (execution.mode === 'native-urltest') {
      await proxies.testNativeGroupDelay(group.name, rowConfig.testUrl);
      return;
    }

    await runGroupProbe(group);
  };

  const runActiveGroupProbe = () => {
    void runGroupDelayOrProbe(activeStrategyGroup);
  };

  const runActiveGroupInspection = () => {
    if (!activeStrategyGroup || !helperServiceAvailable) {
      return;
    }
    const inspection: HelperInspectionRequest = {};
    if (activeIsGeminiLocationGroup && activeGroupConfig.geminiLocationProbeEnabled) {
      inspection.geminiLocation = true;
    }
    if (hasSelectedNodeRiskCheck(activeNodeRisk)) {
      inspection.nodeRisk = { ...activeNodeRisk };
    }
    if (inspection.geminiLocation === undefined && inspection.nodeRisk === undefined) {
      return;
    }
    void useHelperStore.getState().inspectGroup(activeStrategyGroup.name, inspection);
  };

  const openConfigQr = async () => {
    setConfigQrOpening(true);
    setConfigQrOpen(true);
    setConfigQrUrl('');
    setConfigQrCopied(false);
    setConfigQrIncludeSettings(false);
    try {
      await helper.saveConfigPath();
      await helper.checkHealth();
      const liveHelper = useHelperStore.getState();
      const nextUrl = resolveConfigDownloadUrl({
        helperUrl: liveHelper.helperUrl,
        mobileConfigUrl: liveHelper.health?.mobileConfigUrl,
        pageHostname: window.location.hostname
      });
      setConfigQrUrl(nextUrl && !isLoopbackUrl(nextUrl) ? nextUrl : '');
      setConfigQrOpen(true);
    } finally {
      setConfigQrOpening(false);
    }
  };

  const copyConfigQrUrl = async () => {
    if (!configQrDownloadUrl.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(configQrDownloadUrl);
      setConfigQrCopied(true);
      window.setTimeout(() => setConfigQrCopied(false), 1400);
    } catch {
      setConfigQrCopied(false);
    }
  };

  const copyVisibleLogs = async () => {
    const text = filteredLogs.map((log) => `[${log.level}] ${log.message}`).join('\n');
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setLogsCopied(true);
      window.setTimeout(() => setLogsCopied(false), 1400);
    } catch {
      setLogsCopied(false);
    }
  };

  const exportSettings = () => {
    const content = serializeSettingsBackup({
      controller: {
        config,
        urlSecretWarning
      },
      helper: {
        helperUrl: helper.helperUrl,
        configPath: helper.configPath,
        testingSettings: helper.testingSettings,
        trafficSettings: helper.trafficSettings,
        networkUsageSettings: helper.networkUsageSettings,
        groupConfigs: helper.groups.map((group) => ({ name: group.name, config: group.config }))
      },
      proxies: {
        groupTestUrls: proxies.groupTestUrls,
        nodeTestUrls: proxies.nodeTestUrls
      },
      configWorkspace: {
        content: configWorkspace.content,
        issues: configWorkspace.issues,
        snapshots: configWorkspace.snapshots,
        sourceEndpoint: configWorkspace.sourceEndpoint,
        lastLoadedAt: configWorkspace.lastLoadedAt
      },
      ui: {
        railExpanded,
        strategyGroupOrder
      }
    });
    downloadTextFile(`singdeck-settings-${new Date().toISOString().slice(0, 10)}.json`, content);
    setSettingsTransferStatus({
      tone: 'ok',
      text: 'Exported settings without credentials or runtime configuration content.'
    });
  };

  const importSettingsFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file) {
      return;
    }

    setSettingsTransferStatus({ tone: 'neutral', text: 'Validating and importing settings...' });
    try {
      const backup = parseSettingsBackup(await file.text());
      const helperStateBeforeImport = useHelperStore.getState();
      const requiresHelperWrite = Boolean(
        backup.helper.configPath.trim() ||
          backup.helper.testingSettings ||
          backup.helper.trafficSettings ||
          backup.helper.networkUsageSettings ||
          backup.helper.groupConfigs.length > 0
      );

      if (requiresHelperWrite) {
        const importedGeminiGroup = backup.helper.testingSettings?.geminiLocationGroup?.trim() ?? '';
        const targetClient = new HelperApiClient({
          baseUrl: backup.helper.helperUrl,
          token: helperStateBeforeImport.helperToken
        });
        let targetConfigSource: HelperConfigSource;
        let targetTestingSettings: HelperTestingSettings | null;
        let targetTrafficSettings: HelperTrafficSettings | null;
        let targetNetworkUsageSettings: HelperNetworkUsageSettings | null;
        let targetGroups: HelperGroupsResponse | null;
        let targetNodeSources: HelperNodeSourcesResponse | null;

        try {
          [
            targetConfigSource,
            targetTestingSettings,
            targetTrafficSettings,
            targetNetworkUsageSettings,
            targetGroups,
            targetNodeSources
          ] = await Promise.all([
            targetClient.getJson<HelperConfigSource>('/api/v1/config/source'),
            backup.helper.testingSettings
              ? targetClient.getJson<HelperTestingSettings>('/api/v1/settings/testing')
              : Promise.resolve(null),
            backup.helper.trafficSettings
              ? targetClient.getJson<HelperTrafficSettings>('/api/v1/settings/traffic')
              : Promise.resolve(null),
            backup.helper.networkUsageSettings
              ? targetClient.getJson<HelperNetworkUsageSettings>('/api/v1/settings/network-usage')
              : Promise.resolve(null),
            backup.helper.groupConfigs.length > 0 || importedGeminiGroup
              ? targetClient.getJson<HelperGroupsResponse>('/api/v1/groups')
              : Promise.resolve(null),
            backup.helper.groupConfigs.some((group) => group.config.sourceRestrictionEnabled)
              ? targetClient.getJson<HelperNodeSourcesResponse>('/api/v1/node-sources')
              : Promise.resolve(null)
          ]);
        } catch (error) {
          throw new Error(`Could not read target Helper settings: ${formatSettingsImportError(error)}`);
        }

        const targetGroupsByName = new Map((targetGroups?.groups ?? []).map((group) => [group.name, group]));
        const missingGroups = backup.helper.groupConfigs
          .map((group) => group.name)
          .filter((name) => !targetGroupsByName.has(name));
        if (missingGroups.length > 0) {
          throw new Error(`Target Helper is missing strategy groups: ${missingGroups.join(', ')}.`);
        }
        if (importedGeminiGroup && !targetGroupsByName.has(importedGeminiGroup)) {
          throw new Error(`Target Helper is missing Gemini strategy group: ${importedGeminiGroup}.`);
        }

        const targetSourceNames = new Set((targetNodeSources?.sources ?? []).map((source) => source.name));
        const unknownSources = Array.from(
          new Set(
            backup.helper.groupConfigs.flatMap((group) =>
              group.config.sourceRestrictionEnabled
                ? (group.config.allowedNodeSources ?? []).filter((source) => !targetSourceNames.has(source))
                : []
            )
          )
        );
        if (unknownSources.length > 0) {
          throw new Error(`Target Helper is missing node sources: ${unknownSources.join(', ')}.`);
        }

        const invalidSourceRestrictionGroups = backup.helper.groupConfigs
          .filter((group) => group.config.sourceRestrictionEnabled)
          .filter((group) => targetGroupsByName.get(group.name)?.kind.toLowerCase() !== 'selector')
          .map((group) => group.name);
        if (invalidSourceRestrictionGroups.length > 0) {
          throw new Error(
            `Source restrictions require Selector groups: ${invalidSourceRestrictionGroups.join(', ')}.`
          );
        }

        const rollbackSteps: Array<{ label: string; run: () => Promise<boolean> }> = [];
        const saveOrThrow = async (label: string, save: () => Promise<boolean>) => {
          if (!(await save())) {
            throw new Error(`${label}: ${useHelperStore.getState().error ?? 'Helper rejected the setting.'}`);
          }
        };

        try {
          useHelperStore.getState().updateSettings({
            helperUrl: backup.helper.helperUrl,
            configPath: backup.helper.configPath
          });
          await saveOrThrow('Config path import failed', () => useHelperStore.getState().saveConfigPath());
          rollbackSteps.push({
            label: 'config path',
            run: async () => {
              useHelperStore.getState().updateSettings({ configPath: targetConfigSource.path });
              return useHelperStore.getState().saveConfigPath();
            }
          });

          if (backup.helper.testingSettings && targetTestingSettings) {
            await saveOrThrow('Testing settings import failed', () =>
              useHelperStore.getState().saveTestingSettings(backup.helper.testingSettings ?? {})
            );
            rollbackSteps.push({
              label: 'testing settings',
              run: () => useHelperStore.getState().saveTestingSettings(targetTestingSettings)
            });
          }
          if (backup.helper.trafficSettings && targetTrafficSettings) {
            await saveOrThrow('Traffic settings import failed', () =>
              useHelperStore.getState().saveTrafficSettings(backup.helper.trafficSettings as HelperTrafficSettings)
            );
            rollbackSteps.push({
              label: 'traffic settings',
              run: () => useHelperStore.getState().saveTrafficSettings(targetTrafficSettings)
            });
          }
          if (backup.helper.networkUsageSettings && targetNetworkUsageSettings) {
            await saveOrThrow('Network usage settings import failed', () =>
              useHelperStore
                .getState()
                .saveNetworkUsageSettings(backup.helper.networkUsageSettings as HelperNetworkUsageSettings)
            );
            rollbackSteps.push({
              label: 'network usage settings',
              run: () => useHelperStore.getState().saveNetworkUsageSettings(targetNetworkUsageSettings)
            });
          }
          for (const group of backup.helper.groupConfigs) {
            const targetGroup = targetGroupsByName.get(group.name);
            if (!targetGroup) {
              throw new Error(`Target Helper is missing strategy group ${group.name}.`);
            }
            await saveOrThrow(`Group ${group.name} import failed`, () =>
              useHelperStore.getState().saveGroupConfig(group.name, group.config)
            );
            rollbackSteps.push({
              label: `group ${group.name}`,
              run: () => useHelperStore.getState().saveGroupConfig(group.name, targetGroup.config)
            });
          }
        } catch (error) {
          const rollbackFailures: string[] = [];
          for (const step of [...rollbackSteps].reverse()) {
            if (!(await step.run())) {
              rollbackFailures.push(step.label);
            }
          }
          useHelperStore.setState(helperStateBeforeImport);
          const rollbackDetail =
            rollbackFailures.length > 0
              ? ` Rollback also failed for: ${rollbackFailures.join(', ')}.`
              : rollbackSteps.length > 0
                ? ' Previous Helper settings were restored.'
                : '';
          throw new Error(`${formatSettingsImportError(error)}${rollbackDetail}`);
        }
      } else {
        useHelperStore.getState().updateSettings({
          helperUrl: backup.helper.helperUrl,
          configPath: backup.helper.configPath
        });
      }

      const importedControllerConfig = {
        ...backup.controller.config,
        secret: mergeImportedSecret(backup.controller.config.secret, config.secret),
        delayTestConcurrency:
          backup.helper.testingSettings?.probeConcurrency ?? backup.controller.config.delayTestConcurrency,
        delayTestTimeoutMs:
          backup.helper.testingSettings?.delayTestTimeoutMs ?? backup.controller.config.delayTestTimeoutMs
      };
      updateConfig(importedControllerConfig);
      useControllerStore.setState({
        urlSecretWarning: backup.controller.config.secret.trim() ? backup.controller.urlSecretWarning : urlSecretWarning
      });
      if (backup.helper.testingSettings) {
        setTestingDefaultUrlDraft(backup.helper.testingSettings.defaultTestUrl);
        setDelayConcurrencyDraft(String(backup.helper.testingSettings.probeConcurrency));
        setDelayTimeoutDraft(String(backup.helper.testingSettings.delayTestTimeoutMs));
        setMinProbeIntervalDraft(String(Math.round(backup.helper.testingSettings.minProbeIntervalSec / 60)));
      }
      if (backup.helper.trafficSettings) {
        setTrafficProfileDraft(backup.helper.trafficSettings.browserProfile);
      }
      if (backup.helper.networkUsageSettings?.sampleIntervalSec) {
        setNetworkUsageSampleIntervalDraft(String(backup.helper.networkUsageSettings.sampleIntervalSec));
      }
      useProxyStore
        .getState()
        .replaceTestUrls(backup.proxies.groupTestUrls, backup.proxies.nodeTestUrls);
      if (backup.configWorkspace.contentRedacted !== true) {
        useConfigStore.setState({
          content: backup.configWorkspace.content,
          issues: validateNecessaryConfig(backup.configWorkspace.content),
          snapshots: backup.configWorkspace.snapshots.map((snapshot) => ({
            ...snapshot,
            issues: validateNecessaryConfig(snapshot.content)
          })),
          sourceEndpoint: backup.configWorkspace.sourceEndpoint,
          lastLoadedAt: backup.configWorkspace.lastLoadedAt,
          error: null
        });
      }
      setRailExpanded(backup.ui.railExpanded);
      setStrategyGroupOrder(backup.ui.strategyGroupOrder ?? []);
      setSettingsTransferStatus({
        tone: 'ok',
        text: `Imported settings and ${backup.helper.groupConfigs.length} group configs. ${
          backup.configWorkspace.contentRedacted === true
            ? 'Credentials and current runtime workspace were kept.'
            : 'Legacy runtime workspace data was restored.'
        }`
      });
      if (requiresHelperWrite) {
        void useHelperStore.getState().loadGroups();
        void useHelperStore.getState().loadNodeSources();
      }
      void useProxyStore.getState().refresh();
    } catch (error) {
      setSettingsTransferStatus({ tone: 'bad', text: formatSettingsImportError(error) });
    }
  };

  const toggleStrategyGroupCollapse = (groupName: string) => {
    setCollapsedStrategyGroups((current) => {
      const next = new Set(current);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  };
  const collapseAllStrategyGroups = () => {
    setCollapsedStrategyGroups(new Set(strategyWallGroups.map((group) => group.name)));
  };
  const expandAllStrategyGroups = () => {
    setCollapsedStrategyGroups(new Set());
  };

  const moveStrategyGroupNearTarget = (
    sourceName: string,
    targetName: string,
    placement: 'before' | 'after'
  ) => {
    setStrategyGroupOrder((current) =>
      moveStrategyWallGroupOrderNearTarget(
        current,
        sourceName,
        targetName,
        placement,
        strategyGroups.map((group) => group.name)
      )
    );
  };

  const handleStrategyGroupDragStart = (event: DragEvent<HTMLElement>, groupName: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', groupName);
    setDraggingStrategyGroupName(groupName);
  };

  const handleStrategyGroupDragOver = (event: DragEvent<HTMLElement>, targetName: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const sourceName = event.dataTransfer.getData('text/plain') || draggingStrategyGroupName;
    if (!sourceName || sourceName === targetName) {
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
    moveStrategyGroupNearTarget(sourceName, targetName, placement);
  };

  const handleStrategyGroupDrop = (event: DragEvent<HTMLElement>, targetName: string) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceName = event.dataTransfer.getData('text/plain') || draggingStrategyGroupName;
    if (sourceName && sourceName !== targetName) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const placement = event.clientY > bounds.top + bounds.height / 2 ? 'after' : 'before';
      moveStrategyGroupNearTarget(sourceName, targetName, placement);
    }
    setDraggingStrategyGroupName(null);
  };

  return (
    <main className={`app-shell ${railExpanded ? 'rail-expanded' : ''}`}>
      <aside className="rail" aria-label="Primary">
        <button
          aria-label={railExpanded ? 'Collapse navigation' : 'Expand navigation'}
          className="brand-mark"
          onClick={() => setRailExpanded((expanded) => !expanded)}
          type="button"
        >
          <img alt="" className="brand-symbol" src="./pwa-icon.svg" />
          <span>
            <strong>SingDeck</strong>
            <small>local sing-box console</small>
          </span>
        </button>
        <div className="controller-card">
          <div className="controller-row">
            <span>Controller</span>
            <span className={`status-chip ${detection?.ok ? 'ok' : detection ? 'warn' : 'neutral'}`}>
              {detection?.ok ? 'ready' : detection ? 'issue' : 'idle'}
            </span>
          </div>
          <div className="controller-url">{config.controllerUrl || 'not configured'}</div>
        </div>
        <nav className="rail-nav">
          {sections.map((section) => {
            const Icon = section.icon;
            const count = navCounts[section.id as AppRoute];
            return (
              <a
                className={`rail-link ${activeRoute === section.id ? 'active' : ''}`}
                href={`#/${section.id}`}
                key={section.id}
                title={section.label}
              >
                <span className="nav-kbd" aria-hidden="true">
                  <Icon size={14} />
                </span>
                <span className="nav-title">{section.label}</span>
                <span className="nav-count">{count}</span>
              </a>
            );
          })}
        </nav>
        <div className="rail-bottom">
          <article className="rail-runtime-card">
            <div className="rail-runtime-head">
              <span>Runtime</span>
              <strong>{runtimeClock}</strong>
            </div>
            <div className="rail-runtime-api">
              <span>API</span>
              <strong>{apiLabel}</strong>
            </div>
            <div className="rail-runtime-grid">
              <span>Mode</span>
              <strong>{runtime.summary.mode}</strong>
              <span>Connections</span>
              <strong>{runtime.summary.connectionCount}</strong>
              <span>Total down</span>
              <strong>{runtime.summary.downloadTotal}</strong>
              <span>Total up</span>
              <strong>{runtime.summary.uploadTotal}</strong>
            </div>
          </article>
          <article className="rail-traffic-card">
            <div className="rail-side-head">
              <span>Downlink</span>
              <strong>{runtime.summary.downloadRate}</strong>
            </div>
            <svg
              className="rail-sparkline"
              viewBox={`0 0 ${TRAFFIC_SPARKLINE_WIDTH} 48`}
              role="img"
              aria-label="Downlink trend over two minutes"
            >
              <path className="spark-down" d={railDownPath} />
            </svg>
            <div className="rail-sparkline-axis"><span>2m</span><span>now</span></div>
            <div className="rail-side-head">
              <span>Uplink</span>
              <strong>{runtime.summary.uploadRate}</strong>
            </div>
            <svg
              className="rail-sparkline"
              viewBox={`0 0 ${TRAFFIC_SPARKLINE_WIDTH} 48`}
              role="img"
              aria-label="Uplink trend over two minutes"
            >
              <path className="spark-up" d={railUpPath} />
            </svg>
            <div className="rail-sparkline-axis"><span>2m</span><span>now</span></div>
          </article>
        </div>
      </aside>

      <section className="deck">
        <header className="top-strip">
          <div className="top-title">
            <strong>{activeSection.label}</strong>
            <span>{activeSubtitle}</span>
          </div>
          <div className="quick-stats">
            <button
              className={`ghost-action qr-action ${configQrOpening ? 'loading' : ''}`}
              disabled={!helperServiceAvailable || configQrOpening}
              onClick={() => void openConfigQr()}
              type="button"
            >
              <QrCode size={14} />
              {configQrOpening ? 'Opening QR' : 'Config QR'}
            </button>
            <span className={`status-chip ${detection?.ok ? 'ok' : 'warn'}`}>
              <Wifi size={14} />
              {detection?.ok ? 'API authenticated' : 'API pending'}
            </span>
            <span className={`status-chip ${helperStatusTone}`}>
              <Wifi size={14} />
              {helperStatusLabel}
            </span>
          </div>
        </header>

        {pendingConfirm ? (
          <div className="qr-backdrop" onClick={() => setPendingConfirm(null)}>
            <section
              className="qr-panel confirm-panel"
              onClick={(event) => event.stopPropagation()}
              aria-label={pendingConfirm.title}
              aria-modal="true"
              role="alertdialog"
            >
              <div className="qr-head">
                <div className="qr-title">
                  <strong>{pendingConfirm.title}</strong>
                  <span>{pendingConfirm.detail}</span>
                </div>
              </div>
              <div className="confirm-actions">
                <button className="ghost-action" type="button" onClick={() => setPendingConfirm(null)}>
                  Cancel
                </button>
                <button
                  className="ghost-action danger"
                  type="button"
                  onClick={() => {
                    const action = pendingConfirm.onConfirm;
                    setPendingConfirm(null);
                    action();
                  }}
                >
                  {pendingConfirm.confirmLabel}
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {configQrOpen ? (
          <div className="qr-backdrop" onClick={() => setConfigQrOpen(false)}>
            <section
              className="qr-panel"
              onClick={(event) => event.stopPropagation()}
              aria-label="Config QR code"
              aria-modal="true"
              role="dialog"
            >
              <div className="qr-head">
                <div className="qr-title">
                  <strong>Config QR</strong>
                  <span>
                    {configQrResolving
                      ? 'Preparing remote profile'
                      : configQrUrlNeedsLan
                        ? 'LAN helper URL required'
                        : 'Remote profile import'}
                  </span>
                </div>
                <button
                  aria-label="Close config QR"
                  className="ghost-action compact-icon-action qr-close"
                  onClick={() => setConfigQrOpen(false)}
                  type="button"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="qr-body">
                <label className="qr-import-mode">
                  <span className="qr-import-mode-copy">
                    <strong>Include settings</strong>
                    <small>
                      {configQrIncludeSettings
                        ? 'Config, strategy settings, and node source associations'
                        : 'Config content only'}
                    </small>
                  </span>
                  <span className="qr-switch-control">
                    <input
                      aria-label="Include settings"
                      checked={configQrIncludeSettings}
                      onChange={(event) => setConfigQrIncludeSettings(event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                    <span aria-hidden="true" className="qr-switch-track">
                      <span />
                    </span>
                  </span>
                </label>
                <div className={`qr-code-box ${configQrUrlNeedsLan ? 'blocked' : ''}`}>
                  {configQrResolving ? (
                    <span className="qr-code-hint">Preparing URL</span>
                  ) : configQrUrlNeedsLan ? (
                    <span className="qr-code-hint">LAN helper URL required</span>
                  ) : configQrDataUrl ? (
                    <img
                      src={configQrDataUrl}
                      alt={configQrIncludeSettings ? 'sing-box config and settings download QR' : 'sing-box config download QR'}
                    />
                  ) : (
                    <span className="qr-code-hint">Generating...</span>
                  )}
                </div>
                <div className="qr-meta">
                  <div className={`qr-state ${configQrUrlNeedsLan ? 'warn' : 'ok'}`}>
                    <span aria-hidden="true" />
                    {configQrResolving
                      ? 'Preparing URL'
                      : configQrUrlNeedsLan
                        ? 'Needs LAN URL'
                        : configQrIncludeSettings
                          ? 'Ready · Config + settings'
                          : 'Ready · Config only'}
                  </div>
                  <label className="qr-url-field">
                    <span>Download URL</span>
                    <div className="qr-url-input-wrap">
                      <input
                        value={configQrUrl}
                        onChange={(event) => setConfigQrUrl(event.target.value)}
                        spellCheck={false}
                      />
                      <button
                        className="ghost-action compact-icon-action qr-copy"
                        disabled={!configQrDownloadUrl.trim()}
                        onClick={() => void copyConfigQrUrl()}
                        type="button"
                      >
                        <Copy size={14} />
                        {configQrCopied ? 'Copied' : 'Copy URL'}
                      </button>
                    </div>
                    <small>
                      {configQrUrlNeedsLan
                        ? 'No reachable LAN URL. Start helper on 0.0.0.0:9531 or set SINGDECK_HELPER_PUBLIC_URL.'
                        : 'If the phone reports connection refused, allow TCP 9531 through the helper machine firewall.'}
                    </small>
                  </label>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {/* ==========================================================================
            Modern Floating Error Toast Dialog
            ========================================================================== */}
        <aside aria-label="Error alerts" className="error-toast-portal" role="region">
          {detection && !detection.ok && !dismissedErrorKeys.has('controller-detection') ? (
            <div className="error-toast-card" role="alert">
              <div className="error-toast-header">
                <div className="error-toast-title-row">
                  <AlertCircle className="error-toast-icon" size={15} />
                  <strong className="error-toast-title">{detection.failure.title}</strong>
                </div>
                <button
                  aria-label="关闭提示"
                  className="error-toast-close"
                  onClick={() =>
                    setDismissedErrorKeys((prev) => new Set([...prev, 'controller-detection']))
                  }
                  type="button"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="error-toast-body">{detection.failure.detail}</div>
              <div className="error-toast-actions">
                {activeRoute !== 'controller' ? (
                  <button
                    className="error-toast-btn primary"
                    onClick={() => {
                      setActiveRoute('controller');
                      setDismissedErrorKeys((prev) => new Set([...prev, 'controller-detection']));
                    }}
                    type="button"
                  >
                    前往设置
                  </button>
                ) : null}
                <button
                  className="error-toast-btn secondary"
                  onClick={() => void detect()}
                  type="button"
                >
                  重试检测
                </button>
              </div>
            </div>
          ) : null}

          {proxies.error && !dismissedErrorKeys.has(`proxy-error-${proxies.error}`) ? (
            <div className="error-toast-card" role="alert">
              <div className="error-toast-header">
                <div className="error-toast-title-row">
                  <AlertCircle className="error-toast-icon" size={15} />
                  <strong className="error-toast-title">节点代理同步异常</strong>
                </div>
                <button
                  aria-label="关闭提示"
                  className="error-toast-close"
                  onClick={() =>
                    setDismissedErrorKeys((prev) => new Set([...prev, `proxy-error-${proxies.error}`]))
                  }
                  type="button"
                >
                  <X size={13} />
                </button>
              </div>
              <div className="error-toast-body">{proxies.error}</div>
              <div className="error-toast-actions">
                <button
                  className="error-toast-btn primary"
                  onClick={() => void proxies.refresh()}
                  type="button"
                >
                  重试刷新
                </button>
              </div>
            </div>
          ) : null}
        </aside>

        {activeRoute === 'overview' ? (
          <>
        <section className="topology-panel" aria-label="Connection topology">
          <div className="panel-heading compact">
            <div className="overview-viz-heading">
              <h2>{overviewVizMode === 'worldMap' ? '全球请求地图' : '连接拓扑'}</h2>
              <div className="policy-segment">
                <button
                  className={overviewVizMode === 'worldMap' ? 'active' : ''}
                  onClick={() => setOverviewVizMode('worldMap')}
                  type="button"
                >
                  <Globe size={12} />
                  <span>全球地图</span>
                </button>
                <button
                  className={overviewVizMode === 'topology' ? 'active' : ''}
                  onClick={() => setOverviewVizMode('topology')}
                  type="button"
                >
                  <GitBranch size={12} />
                  <span>链路拓扑</span>
                </button>
              </div>
            </div>
            <span className="panel-stamp">{topology.total} active connections</span>
          </div>
          {overviewVizMode === 'worldMap' ? (
            <WorldRequestMap
              embedded
              connections={connections.connections}
              onSelectHost={(host) => {
                connections.setQuery(host);
                setActiveRoute('connections');
              }}
            />
          ) : (
            <div className="topology-stage">
              {topology.links.length === 0 ? (
                <div className="topology-empty">No active topology.</div>
              ) : null}
              <div className="topology-chart" ref={topologyChartRef} />
            </div>
          )}
        </section>

        <section className="overview-widgets" aria-label="Runtime widgets">
          {trafficModuleEnabled ? (
          <article className="overview-widget traffic-widget">
            <div className="widget-head traffic-widget-head">
              <span>Provider traffic</span>
              <button
                className="ghost-action compact-icon-action"
                disabled={!helperServiceAvailable || helper.trafficLoading}
                onClick={() => void saveTrafficWithFeedback(trafficModuleEnabled, trafficProfileDraft)}
                type="button"
              >
                <RefreshCw size={13} />
                {helper.trafficLoading ? 'Syncing' : 'Sync'}
              </button>
            </div>
            {!helperServiceAvailable ? (
              <div className="traffic-provider-empty">
                {helperAvailability === 'checking'
                  ? 'Checking helper. Browser-backed provider traffic will load when ready.'
                  : 'Helper offline. Browser-backed provider traffic is unavailable.'}
              </div>
            ) : helper.traffic?.providers.length ? (
              <>
                <div className="traffic-provider-list">
                  {helper.traffic.providers.map((provider) => {
                    const summary = summarizeTrafficProvider(provider);
                    const ratio = Math.min(100, Math.max(0, provider.usedRatio ?? 0));
                    const rowState = provider.error && !summary.stale ? 'error' : summary.stale ? 'stale' : '';
                    return (
                      <div className={`traffic-provider-row ${rowState}`} key={provider.id}>
                        <div className="traffic-provider-title">
                          <strong>{provider.name}</strong>
                          <span>{provider.error ?? provider.planName ?? 'plan pending'}</span>
                        </div>
                        <div className="traffic-provider-meter" aria-label={`${provider.name} traffic usage`}>
                          <span style={{ width: `${ratio}%` }} />
                        </div>
                        <div className="traffic-provider-meta traffic-provider-fields">
                          <span>
                            <small>总流量</small>
                            <strong>{summary.total}</strong>
                          </span>
                          <span>
                            <small>已使用流量</small>
                            <strong>{summary.used}</strong>
                          </span>
                          <span>
                            <small>重置日期</small>
                            <strong>{summary.reset}</strong>
                          </span>
                          <span>
                            <small>付费时间</small>
                            <strong>{summary.payment}</strong>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="traffic-source-trend">
                  <div className="traffic-trend-head">
                    <div>
                      <span>最近 7 天使用量</span>
                      <small>按策略组统计</small>
                    </div>
                    <div className="traffic-trend-actions">
                      <button
                        aria-label="Refresh strategy group trend"
                        className="ghost-action compact-icon-action"
                        disabled={helper.networkUsageSourceTrendRefreshing}
                        onClick={() =>
                          void useHelperStore
                            .getState()
                            .refreshNetworkUsageSourceTrend(buildSourceTrendRequest(trafficTrendBucket))
                        }
                        type="button"
                      >
                        <RefreshCw size={13} />
                        {helper.networkUsageSourceTrendRefreshing ? 'Refreshing' : 'Refresh'}
                      </button>
                      <div className="traffic-trend-tabs" aria-label="Strategy group traffic trend bucket">
                        {(['hour', 'day'] as const).map((bucket) => (
                          <button
                            className={trafficTrendBucket === bucket ? 'active' : ''}
                            key={bucket}
                            onClick={() => {
                              setTrafficTrendBucket(bucket);
                              void useHelperStore.getState().loadNetworkUsageSourceTrend(buildSourceTrendRequest(bucket));
                            }}
                            type="button"
                          >
                            {bucket === 'hour' ? 'Hour' : 'Day'}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {helper.networkUsageSourceTrendRefreshError ? (
                    <div className="traffic-trend-inline-error">{helper.networkUsageSourceTrendRefreshError}</div>
                  ) : null}
                  {!networkUsageModuleEnabled ? (
                    <div className="traffic-provider-empty compact">Enable Network usage to build strategy group trends.</div>
                  ) : helper.networkUsageSourceTrendError && !helper.networkUsageSourceTrend ? (
                    <div className="traffic-provider-empty compact">{helper.networkUsageSourceTrendError}</div>
                  ) : helper.networkUsageSourceTrendLoading && !helper.networkUsageSourceTrend ? (
                    <div className="traffic-provider-empty compact">Loading strategy group trend...</div>
                  ) : !sourceTrendHasSamples ? (
                    <div className="traffic-provider-empty compact">No strategy group usage samples in the last 7 days.</div>
                  ) : (
                    <>
                      <div className="traffic-trend-legend">
                        {sourceTrendSources.map((source, index) => (
                          <button
                            aria-label={`Filter strategy group ${source.name}`}
                            aria-pressed={trafficTrendSourceFilter === source.name}
                            className={trafficTrendSourceFilter === source.name ? 'active' : ''}
                            key={source.name}
                            onClick={() =>
                              setTrafficTrendSourceFilter((current) => (current === source.name ? null : source.name))
                            }
                            type="button"
                          >
                            <i style={{ background: SOURCE_TREND_COLORS[index % SOURCE_TREND_COLORS.length] }} />
                            <strong>{source.name}</strong>
                            <em>{formatBytes(source.totalBytes)}</em>
                          </button>
                        ))}
                      </div>
                      <TrafficSourceTrendChart
                        active={pageVisible}
                        bucket={trafficTrendBucket}
                        selectedSource={trafficTrendSourceFilter}
                        sources={sourceTrendSources}
                      />
                      <div className="traffic-trend-axis">
                        <span>7d ago</span>
                        <span>{trafficTrendBucket === 'hour' ? 'hourly' : 'daily'}</span>
                        <span>now</span>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="traffic-provider-empty">
                {helper.trafficError ??
                  (helper.trafficLoading
                    ? 'Syncing provider traffic…'
                    : 'Provider traffic has not been synced yet.')}
              </div>
            )}
          </article>
          ) : null}
          <article className={`overview-widget usage-widget ${networkUsageModuleEnabled ? '' : 'disabled'}`}>
            <div className="widget-head usage-widget-head">
              <span>Usage window</span>
              <div className="usage-window-tabs" aria-label="Network usage window">
                {NETWORK_USAGE_WINDOWS.map((item) => (
                  <button
                    className={networkUsageWindow === item.id ? 'active' : ''}
                    key={item.id}
                    onClick={() => setNetworkUsageWindow(item.id)}
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            {!helperServiceAvailable ? (
              <div className="usage-empty">
                {helperAvailability === 'checking'
                  ? 'Checking helper. Usage capture will load when ready.'
                  : 'Helper offline. Usage capture is unavailable.'}
              </div>
            ) : !networkUsageModuleEnabled ? (
              <div className="usage-empty">Enable Network usage in Settings to store domain and strategy traffic.</div>
            ) : helper.networkUsageSummary ? (
              <>
                <div className="usage-total-grid">
                  <span>
                    <small>Down</small>
                    <strong>{formatBytes(helper.networkUsageSummary.downloadBytes)}</strong>
                  </span>
                  <span>
                    <small>Up</small>
                    <strong>{formatBytes(helper.networkUsageSummary.uploadBytes)}</strong>
                  </span>
                  <span>
                    <small>Total</small>
                    <strong>{formatBytes(helper.networkUsageSummary.totalBytes)}</strong>
                  </span>
                  <span>
                    <small>Rows</small>
                    <strong>{helper.networkUsageSummary.connectionCount} connections</strong>
                  </span>
                </div>
                <div className="usage-view-tabs" aria-label="Network usage content">
                  {NETWORK_USAGE_VIEWS.map((item) => (
                    <button
                      aria-pressed={networkUsageView === item.id}
                      className={networkUsageView === item.id ? 'active' : ''}
                      key={item.id}
                      onClick={() => setNetworkUsageView(item.id)}
                      type="button"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="usage-view-panel">
                  {networkUsageView === 'domains' ? (
                    <div className="usage-rank-list">
                      <span className="usage-list-title">Top domains</span>
                      {(helper.networkUsageTopHosts?.items ?? []).slice(0, 10).map((item) => (
                        <div className="usage-rank-row" key={item.label}>
                          <span>{item.label}</span>
                          <em>{item.connectionCount} conns</em>
                          <strong>{formatBytes(item.totalBytes)}</strong>
                        </div>
                      ))}
                      {helper.networkUsageTopHosts?.items.length === 0 ? (
                        <div className="usage-empty compact">No domain usage in this window.</div>
                      ) : null}
                    </div>
                  ) : null}
                  {networkUsageView === 'strategies' ? (
                    <div className="usage-rank-list">
                      <span className="usage-list-title">策略组排行</span>
                      {(helper.networkUsageTopStrategies?.items ?? []).slice(0, 10).map((item) => (
                        <div className="usage-rank-row" key={item.label}>
                          <span>{item.label}</span>
                          <em>{item.connectionCount} conns</em>
                          <strong>{formatBytes(item.totalBytes)}</strong>
                        </div>
                      ))}
                      {helper.networkUsageTopStrategies?.items.length === 0 ? (
                        <div className="usage-empty compact">No strategy group usage in this window.</div>
                      ) : null}
                    </div>
                  ) : null}
                  {networkUsageView === 'recent' ? (
                    <div className="usage-connection-window">
                      <div className="usage-connection-list">
                        {(helper.networkUsageConnections?.connections ?? []).slice(0, 10).map((connection) => (
                          <div className="usage-connection-row" key={connection.id}>
                            <div>
                              <strong>{connection.host}</strong>
                              <span>{connection.rule}</span>
                            </div>
                            <span>{usageConnectionStrategyLabel(connection)}</span>
                            <span>{formatBytes(connection.totalBytes)}</span>
                            <span>{formatLastSeen(connection.lastSeenMs)}</span>
                          </div>
                        ))}
                        {helper.networkUsageConnections?.connections.length === 0 ? (
                          <div className="usage-empty compact">No sampled connection traffic in this window.</div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="usage-empty">
                {helper.networkUsageLoading ? 'Loading usage window...' : helper.networkUsageError ?? 'No usage samples yet.'}
              </div>
            )}
          </article>
          <article className="overview-widget">
            <div className="widget-head">
              <span>Rule hit ranking</span>
              <strong>{connections.connections.length}</strong>
            </div>
            <div className="widget-bars">
              {ruleHitSummary.length === 0 ? <span>No rule hits yet.</span> : null}
              {ruleHitSummary.map(([rule, count]) => (
                <div className="widget-bar-row" key={rule}>
                  <span>{rule}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </article>
          <article className="overview-widget">
            <div className="widget-head">
              <span>DNS activity</span>
              <strong>{dnsLogCount}</strong>
            </div>
            <div className="metric-lines">
              {healthRow('DNS log lines', String(dnsLogCount), dnsLogCount > 0 ? 'blue' : 'neutral')}
              {healthRow('FakeIP mapped', 'runtime API pending', 'neutral')}
              {healthRow('Fallback hints', connections.logs.some((log) => log.message.toLowerCase().includes('fallback')) ? 'seen' : 'none', 'warn')}
            </div>
          </article>
          <article className="overview-widget">
            <div className="widget-head">
              <span>Node health</span>
              <strong>{proxyNodes.length}</strong>
            </div>
            <div className="protocol-chips">
              {protocolSummary.length === 0 ? <span>No proxy nodes loaded.</span> : null}
              {protocolSummary.map(([type, count]) => (
                <span key={type}>{type} {count}</span>
              ))}
            </div>
          </article>
          <article className="overview-widget">
            <div className="widget-head">
              <span>Runtime guardrails</span>
              <strong>{failedProxyCount}</strong>
            </div>
            <div className="metric-lines">
              {healthRow('API', detection?.ok ? 'authenticated' : 'not ready', detection?.ok ? 'ok' : 'warn')}
              {healthRow('Logs', `${connections.logs.length}/500`, 'blue')}
              {healthRow('Failed nodes', String(failedProxyCount), failedProxyCount > 0 ? 'bad' : 'ok')}
              {healthRow('Config source', configWorkspace.sourceEndpoint ?? 'not loaded', configWorkspace.sourceEndpoint ? 'blue' : 'warn')}
            </div>
          </article>
        </section>
        <article className="node-score-desc-panel" aria-label="node score desc">
          <div className="node-score-desc-head">
            <div className="node-score-desc-title">
              <h2>node score desc</h2>
              <span>
                {selectedNodeScoreSnapshot?.updatedAt
                  ? `updated ${selectedNodeScoreSnapshot.updatedAt.toLocaleTimeString()}`
                  : 'choose a strategy group'}
              </span>
            </div>
            <div className="node-score-desc-controls">
              <div className="node-score-select">
                <button
                  aria-expanded={nodeScoreDropdownOpen}
                  aria-haspopup="listbox"
                  aria-label="Select score strategy group"
                  className="node-score-select-trigger"
                  onClick={() => setNodeScoreDropdownOpen((open) => !open)}
                  type="button"
                >
                  <span>Strategy group</span>
                  <strong>{selectedNodeScoreGroup || 'Select group'}</strong>
                </button>
                {nodeScoreDropdownOpen ? (
                  <div className="node-score-menu" role="listbox">
                    <input
                      aria-label="Search score strategy group"
                      autoFocus
                      placeholder="search strategy group..."
                      value={nodeScoreSearch}
                      onChange={(event) => setNodeScoreSearch(event.target.value)}
                    />
                    <div className="node-score-options">
                      {filteredNodeScoreGroups.map(({ scores, failedCount }) => (
                        <button
                          aria-label={`${scores.group} ${scores.nodes.length} nodes`}
                          className={selectedNodeScoreGroup === scores.group ? 'active' : ''}
                          key={scores.group}
                          onClick={() => {
                            setSelectedNodeScoreGroup(scores.group);
                            setNodeScoreDropdownOpen(false);
                          }}
                          role="option"
                          type="button"
                        >
                          <span>{scores.group}</span>
                          <small>
                            {scores.nodes.length} nodes{failedCount > 0 ? ` / ${failedCount} failed` : ''}
                          </small>
                        </button>
                      ))}
                      {filteredNodeScoreGroups.length === 0 ? (
                        <div className="node-score-menu-empty">No matching strategy groups.</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          {selectedNodeScoreSnapshot && selectedNodeScoreSnapshot.scores.nodes.length > 0 ? (
            <div className="node-score-window" aria-label={`${selectedNodeScoreSnapshot.scores.group} node score details`}>
              <div className="node-score-row node-score-row-head">
                <span>node</span>
                <span>score</span>
                <span>real latency</span>
                <span>connectivity</span>
                <span>stability</span>
                <span>freshness gate</span>
                <span>latency raw</span>
                <span>conn raw</span>
                <span>stability raw</span>
                <span>fresh raw</span>
                <span>weights</span>
                <span>state</span>
                <span>error</span>
              </div>
              {selectedNodeScoreSnapshot.scores.nodes.map((node) => (
                <div className="node-score-row" key={node.name}>
                  <strong title={node.name}>{node.name}</strong>
                  <span>{Math.round(node.score)}</span>
                  <span>{node.components.latency}</span>
                  <span>{node.components.availability}</span>
                  <span>{node.components.jitter}</span>
                  <span>{node.components.freshness}</span>
                  <span>{rawLatencyLabel(node)}</span>
                  <span>{rawAvailabilityLabel(node)}</span>
                  <span>{rawStabilityLabel(node)}</span>
                  <span>{rawFreshnessLabel(node)}</span>
                  <span>{rawWeightsLabel(node)}</span>
                  <span className={node.raw?.success === false || node.error ? 'bad' : 'good'}>
                    {node.raw?.success === false || node.error ? 'error' : 'ok'}
                  </span>
                  <span title={node.error ?? undefined}>{node.error ?? '--'}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="node-score-empty">
              {selectedNodeScoreGroup
                ? 'No score snapshot for this group yet.'
                : nodeScoreGroups.length === 0
                ? 'No helper probe snapshot yet.'
                : 'Select a strategy group to inspect node score details.'}
            </div>
          )}
        </article>
        <div className="overview-scroll-buffer" aria-hidden="true" />
          </>
        ) : null}

        {activeRoute === 'controller' ? (
        <section className="controller-panel" id="settings" aria-labelledby="controller-title">
          <div className="panel-heading">
            <div>
              <h2 id="controller-title">Controller</h2>
              <span className="panel-stamp">only needed for secret, test URL, or non-/ui/ deployments</span>
            </div>
            {lastCheckedAt ? (
              <span className="panel-stamp">checked {new Date(lastCheckedAt).toLocaleTimeString()}</span>
            ) : null}
          </div>

          {urlSecretWarning ? (
            <div className="warning-strip">
              URL 参数中包含 secret。它可能进入浏览器历史、书签或分享链接。
            </div>
          ) : null}

          <form className="settings-board" onSubmit={handleSubmit}>
            {/* Column 1: Controller, Diagnostics, Local Buffers & Settings Transfer */}
            <div className="settings-column">
              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Controller</h3>
                  <span>local only</span>
                </div>
                <div className="compact-form">
                  <label>
                    <span>URL</span>
                    <input
                      placeholder="http://127.0.0.1:9090"
                      value={form.controllerUrl}
                      onChange={(event) => setForm({ ...form, controllerUrl: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Secret</span>
                    <input
                      placeholder="optional"
                      type="password"
                      value={form.secret}
                      onChange={(event) => setForm({ ...form, secret: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Note</span>
                    <input
                      placeholder="local desktop, router, lab..."
                      value={form.note ?? ''}
                      onChange={(event) => setForm({ ...form, note: event.target.value })}
                    />
                  </label>
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Diagnostics</h3>
                  <span>{lastCheckedAt ? new Date(lastCheckedAt).toLocaleTimeString() : 'not checked'}</span>
                </div>
                <div className="settings-note-grid">
                  {healthRow('API', detection?.ok ? 'authenticated' : detection ? 'failed' : 'idle', detection?.ok ? 'ok' : 'warn')}
                  {healthRow('Version', detection?.ok ? detection.version : '--', detection?.ok ? 'blue' : 'warn')}
                  {healthRow('Config source', configWorkspace.sourceEndpoint ?? '/ui/config.json', 'blue')}
                  {healthRow('Runtime', runtime.lastUpdatedAt ? new Date(runtime.lastUpdatedAt).toLocaleTimeString() : 'idle', runtime.error ? 'warn' : 'ok')}
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Local buffers</h3>
                  <span>browser memory</span>
                </div>
                <div className="settings-note-grid">
                  {healthRow('Logs', `${connections.logs.length}/500`, 'blue')}
                  {healthRow('Trimmed', String(connections.droppedLogCount), connections.droppedLogCount > 0 ? 'warn' : 'ok')}
                  {healthRow('Connections', String(connections.connections.length), 'blue')}
                  {healthRow('History', `${runtime.history.length} points`, 'ok')}
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Settings transfer</h3>
                  <span>json backup</span>
                </div>
                <div className="helper-actions">
                  <button className="ghost-action" onClick={exportSettings} type="button">
                    Export settings
                  </button>
                  <button className="ghost-action" onClick={() => settingsImportInputRef.current?.click()} type="button">
                    Import settings
                  </button>
                </div>
                <div className="settings-scope-note">
                  Controller/helper credentials and runtime configuration content are excluded. Existing credentials stay in
                  this browser when importing.
                </div>
                <input
                  accept="application/json,.json"
                  hidden
                  onChange={importSettingsFile}
                  ref={settingsImportInputRef}
                  type="file"
                />
                {settingsTransferStatus ? (
                  <div className={`settings-inline-status ${settingsTransferStatus.tone}`}>
                    {settingsTransferStatus.text}
                  </div>
                ) : null}
              </article>
            </div>

            {/* Column 2: Helper Service & Background Sync */}
            <div className="settings-column">
              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Helper</h3>
                  <span>{helper.lastCheckedAt ? new Date(helper.lastCheckedAt).toLocaleTimeString() : 'local service'}</span>
                </div>
                <div className="compact-form">
                  <label>
                    <span>URL</span>
                    <input
                      placeholder="http://127.0.0.1:9531"
                      value={helper.helperUrl}
                      onChange={(event) => helper.updateSettings({ helperUrl: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>Token</span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="paste helper auth token"
                      value={helper.helperToken}
                      onChange={(event) => helper.updateSettings({ helperToken: event.target.value })}
                    />
                    <small>Required when the helper binds beyond loopback. Printed in the helper logs on startup.</small>
                  </label>
                  <label>
                    <span>Config path</span>
                    <input
                      placeholder="/etc/sing-box/config.json"
                      value={helper.configPath}
                      onBlur={() => void saveConfigPathWithFeedback()}
                      onChange={(event) => helper.updateSettings({ configPath: event.target.value })}
                    />
                  </label>
                  <label className={`automation-option settings-toggle ${trafficModuleEnabled ? 'on' : ''}`}>
                    <input
                      checked={trafficModuleEnabled}
                      type="checkbox"
                      onChange={(event) =>
                        void saveTrafficWithFeedback(event.target.checked, trafficProfileDraft)
                      }
                    />
                    <span className="automation-switch" aria-hidden="true" />
                    <span>
                      <strong>Provider traffic</strong>
                      <small>Show browser-backed usage cards on Overview</small>
                    </span>
                  </label>
                  <label className={`automation-option settings-toggle ${networkUsageModuleEnabled ? 'on' : ''}`}>
                    <input
                      checked={networkUsageModuleEnabled}
                      type="checkbox"
                      onChange={(event) => void saveNetworkUsageWithFeedback(event.target.checked)}
                    />
                    <span className="automation-switch" aria-hidden="true" />
                    <span>
                      <strong>Network usage</strong>
                      <small>Store sampled domains and strategy groups for the Overview usage window</small>
                    </span>
                  </label>
                  <label>
                    <span>Usage sample interval sec</span>
                    <input
                      disabled={!helperServiceAvailable}
                      max={MAX_NETWORK_USAGE_SAMPLE_INTERVAL_SEC}
                      min={MIN_NETWORK_USAGE_SAMPLE_INTERVAL_SEC}
                      type="number"
                      value={networkUsageSampleIntervalDraft}
                      onBlur={commitNetworkUsageSampleInterval}
                      onChange={(event) => setNetworkUsageSampleIntervalDraft(event.target.value)}
                    />
                    <small>Higher values reduce helper database writes while keeping Overview usage data current.</small>
                  </label>
                  <label>
                    <span>Chrome profile (Gemini / Provider)</span>
                    <input
                      placeholder="/home/user/.config/google-chrome/Default"
                      value={trafficProfileDraft}
                      onChange={(event) => setTrafficProfileDraft(event.target.value)}
                    />
                    <small>
                      Required for authenticated Gemini location probes and optional Provider Traffic; saved even when Provider Traffic is disabled.
                    </small>
                  </label>
                  <div className="helper-actions">
                    <button
                      className={`ghost-action status-${helperStatusAction === 'check' ? helperActionStatus?.tone ?? 'neutral' : 'neutral'}`}
                      disabled={helperActionBusy}
                      onClick={() => void checkHelperWithFeedback()}
                      title={helperButtonTitle('check')}
                      type="button"
                    >
                      {helperButtonLabel('check', 'Check helper', 'Checking...')}
                    </button>
                    <button
                      className={`ghost-action status-${helperStatusAction === 'sync' ? helperActionStatus?.tone ?? 'neutral' : 'neutral'}`}
                      disabled={helperActionBusy}
                      onClick={() => void syncControllerWithFeedback()}
                      title={helperButtonTitle('sync')}
                      type="button"
                    >
                      {helperButtonLabel('sync', 'Sync controller', 'Syncing...')}
                    </button>
                    <button
                      className={`ghost-action status-${helperStatusAction === 'config' ? helperActionStatus?.tone ?? 'neutral' : 'neutral'}`}
                      disabled={helperActionBusy}
                      onClick={() => void saveConfigPathWithFeedback()}
                      title={helperButtonTitle('config')}
                      type="button"
                    >
                      {helperButtonLabel('config', 'Save config', 'Saving...')}
                    </button>
                    <button
                      className={`ghost-action status-${helperStatusAction === 'traffic' ? helperActionStatus?.tone ?? 'neutral' : 'neutral'}`}
                      disabled={helperActionBusy}
                      onClick={() => void saveTrafficWithFeedback(trafficModuleEnabled, trafficProfileDraft)}
                      title={helperButtonTitle('traffic')}
                      type="button"
                    >
                      {helperButtonLabel('traffic', 'Save traffic', 'Saving...')}
                    </button>
                    <button
                      aria-label="Refresh node sources"
                      className={`ghost-action status-${helperStatusAction === 'node-sources' ? helperActionStatus?.tone ?? 'neutral' : 'neutral'}`}
                      disabled={helperActionBusy}
                      onClick={() => void refreshNodeSourcesWithFeedback()}
                      title={helperButtonTitle('node-sources')}
                      type="button"
                    >
                      {helperButtonLabel('node-sources', 'Refresh sources', 'Refreshing...', 'Refreshed')}
                    </button>
                  </div>
                  <div className="settings-scope-note">
                    Subscription URLs refresh only on this button. Restart restores saved links and rematches configured nodes.
                  </div>
                </div>
                <div className="settings-note-grid compact-health">
                  {healthRow('SQLite', helper.health?.sqlite ? 'ready' : helper.error ? 'issue' : 'idle', helper.health?.sqlite ? 'ok' : helper.error ? 'warn' : 'neutral')}
                  {healthRow(
                    'Controller',
                    helper.health?.controllerReachable ? 'reachable' : helper.health?.controllerConfigured ? 'configured' : 'empty',
                    helper.health?.controllerReachable ? 'ok' : 'warn'
                  )}
                  {healthRow(
                    'Usage capture',
                    networkUsageModuleEnabled
                      ? `${networkUsageRetentionDays} days / ${networkUsageSampleIntervalSec}s`
                      : 'off',
                    networkUsageModuleEnabled ? 'blue' : 'neutral'
                  )}
                  {healthRow(
                    'Node sources',
                    `${helper.nodeSources.length} sources / ${nodeSourceNodeCount} linked`,
                    nodeSourceIssueCount > 0 ? 'warn' : helper.nodeSources.length > 0 ? 'blue' : 'neutral'
                  )}
                </div>
                {helper.nodeSources.length > 0 ? (
                  <div className="settings-node-source-list" aria-label="Loaded node sources">
                    {helper.nodeSources.map((source) => (
                      <div className="settings-node-source-item" key={source.name}>
                        <div className="source-item-title">
                          <span
                            className="source-option-dot"
                            style={nodeSourceTagStyleByName.get(source.name)}
                            aria-hidden="true"
                          />
                          <strong title={source.name}>{source.name}</strong>
                        </div>
                        <div className="source-item-meta">
                          <span>{source.nodeCount} 节点</span>
                          <span title={source.lastSyncedAt ?? undefined}>
                            {formatRelativeTime(source.lastSyncedAt)}
                          </span>
                          {source.lastError ? (
                            <span className="source-item-error" title={source.lastError}>
                              异常
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {helper.error ? <div className="settings-inline-error">{helper.error}</div> : null}
              </article>
            </div>

            {/* Column 3: Testing Defaults, Per-group URLs & Local Behavior */}
            <div className="settings-column">
              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Testing</h3>
                  <span>persisted</span>
                </div>
                <div className="compact-form">
                  <label>
                    <span>Default URL</span>
                    <input
                      disabled={!helperServiceAvailable}
                      value={testingDefaultUrlDraft}
                      onBlur={(event) => {
                        const nextUrl = event.currentTarget.value.trim() || helperDefaultTestUrl;
                        updateConfig({ defaultTestUrl: nextUrl });
                        void helper.saveDefaultTestUrl(nextUrl);
                      }}
                      onChange={(event) => {
                        setTestingDefaultUrlDraft(event.target.value);
                        setForm({ ...form, defaultTestUrl: event.target.value });
                      }}
                    />
                  </label>
                  <label>
                    <span>Parallel</span>
                    <input
                      max={12}
                      min={1}
                      type="number"
                      value={delayConcurrencyDraft}
                      onBlur={() => commitDelayConcurrency(4)}
                      onChange={(event) => setDelayConcurrencyDraft(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Timeout ms</span>
                    <input
                      max={60000}
                      min={500}
                      step={500}
                      type="number"
                      value={delayTimeoutDraft}
                      onBlur={(event) => {
                        const timeout = parseIntegerDraft(
                          event.currentTarget.value,
                          helperDelayTestTimeoutMs,
                          500,
                          60000
                        );
                        void commitDelayTestTimeout(timeout);
                      }}
                      onChange={(event) => setDelayTimeoutDraft(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Minimum interval</span>
                    <input
                      disabled={!helperServiceAvailable}
                      max={1440}
                      min={1}
                      type="number"
                      value={minProbeIntervalDraft}
                      onBlur={() => void commitMinimumProbeInterval()}
                      onChange={(event) => setMinProbeIntervalDraft(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Gemini 检测策略组</span>
                    <select
                      aria-label="Gemini 检测策略组"
                      disabled={!helperServiceAvailable}
                      value={helper.testingSettings?.geminiLocationGroup ?? ''}
                      onChange={(event) => void helper.saveGeminiLocationGroup(event.target.value)}
                    >
                      <option value="">未指定（关闭）</option>
                      {geminiLocationGroups.map((group) => (
                        <option key={group.name} value={group.name}>
                          {group.name}
                        </option>
                      ))}
                    </select>
                    <small>仅指定组的侧边栏会显示 Gemini 出口开关与检测结果。</small>
                  </label>
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Per-group test URLs</h3>
                  <span>not per node</span>
                </div>
                <div className="compact-form per-group-urls-list">
                  {allStrategyGroups.map((group) => {
                    const existing = helperGroupByName.get(group.name)?.config;
                    const groupConfig = existing ?? fallbackGroupConfig(proxies.groupTestUrls[group.name] || helperDefaultTestUrl);
                    const execution = resolveProbeExecution(group, groupConfig.mode);
                    const nativeUrlTest = execution.mode === 'native-urltest';

                    return (
                      <label className={nativeUrlTest ? 'native-url-row' : ''} key={group.name}>
                        <span>{group.name}</span>
                        <input
                          disabled={!helperServiceAvailable || nativeUrlTest}
                          placeholder={nativeUrlTest ? 'sing-box urltest.url' : helperDefaultTestUrl}
                          value={nativeUrlTest ? '' : proxies.groupTestUrls[group.name] ?? existing?.testUrl ?? ''}
                          onBlur={(event) => {
                            if (nativeUrlTest) {
                              return;
                            }
                            void helper.saveGroupConfig(group.name, {
                              testUrl: event.currentTarget.value.trim() || helperDefaultTestUrl,
                              testUrlOverridden: true,
                              mode: existing?.mode ?? 'score',
                              scheme: existing?.scheme ?? 'Balanced',
                              autoSwitch: existing?.autoSwitch ?? false,
                              autoProbe: existing?.autoProbe ?? true,
                              probeIntervalSec: existing?.probeIntervalSec ?? 15 * 60,
                              geminiLocationProbeEnabled: existing?.geminiLocationProbeEnabled ?? false,
                              nodeRisk: normalizeNodeRiskChecks(existing?.nodeRisk)
                            });
                          }}
                          onChange={(event) => {
                            if (!nativeUrlTest) {
                              proxies.setGroupTestUrl(group.name, event.target.value);
                            }
                          }}
                        />
                        {nativeUrlTest ? <small>Native URLTest uses sing-box config.</small> : null}
                      </label>
                    );
                  })}
                </div>
              </article>

              <article className="settings-card">
                <div className="settings-card-head">
                  <h3>Local behavior</h3>
                  <span>browser settings</span>
                </div>
                <div className="settings-note-grid">
                  {healthRow('Security mode', 'local relaxed', 'blue')}
                  {healthRow('Config validation', 'necessary only', 'blue')}
                  {healthRow('External UI', 'relative path', 'ok')}
                  {healthRow('Test workers', String(form.delayTestConcurrency ?? 4), 'ok')}
                  {healthRow('Test timeout', `${form.delayTestTimeoutMs ?? helperDelayTestTimeoutMs} ms`, 'ok')}
                  {healthRow('Min probe interval', `${helperMinProbeIntervalMinutes} min`, 'ok')}
                </div>
                <div className="settings-scope-note">
                  Saves controller URL, secret, note, test worker count, and test timeout in browser storage.
                </div>
                <div className="settings-save-row">
                  <button
                    className={`primary-action form-action status-${localBehaviorButtonTone}`}
                    disabled={detecting}
                    title={localBehaviorStatus?.text}
                    type="submit"
                  >
                    {localBehaviorButtonLabel}
                  </button>
                </div>
              </article>
            </div>
          </form>
        </section>
        ) : null}

        {activeRoute === 'proxies' ? (
        <section className="proxy-panel proxy-workspace proxy-control-workspace" id="proxies" aria-label="Proxies">
          <section className="proxy-summary-grid proxy-overview-strip" aria-label="Proxy summary">
            <article><span>Current group</span><strong>{activeStrategyGroup?.name ?? '--'}</strong></article>
            <article><span>Selected node</span><strong>{activeStrategyGroup?.now || '--'}</strong></article>
            <article><span>Healthy nodes</span><strong>{healthyProxyCount} / {allProxyNodes.length}</strong></article>
            <article><span>Default test URL</span><strong>{helperDefaultTestUrl}</strong></article>
          </section>

          <section className="proxy-control-layout" aria-label="Proxy strategy workspace">
            <div className="proxy-board">
              <div className="proxy-board-toolbar">
                <div className="proxy-board-title">
                  <span>Strategy wall</span>
                  <strong>{strategyWallGroups.length} / {strategyGroups.length} groups</strong>
                </div>
                <div className="proxy-board-bulk-actions" aria-label="Strategy wall display controls">
                  <button
                    aria-label="Collapse all strategy groups"
                    className="quiet-action"
                    disabled={strategyWallGroups.length === 0}
                    onClick={collapseAllStrategyGroups}
                    type="button"
                  >
                    Collapse all
                  </button>
                  <button
                    aria-label="Expand all strategy groups"
                    className="quiet-action"
                    disabled={strategyWallGroups.length === 0}
                    onClick={expandAllStrategyGroups}
                    type="button"
                  >
                    Expand all
                  </button>
                </div>
                <label className="proxy-source-filter">
                  <span>Source</span>
                  <select
                    aria-label="Filter nodes by source"
                    value={selectedNodeSourceName}
                    onChange={(event) => setSelectedNodeSourceName(event.currentTarget.value)}
                  >
                    <option value="">All sources</option>
                    {helper.nodeSources.map((source) => (
                      <option key={source.name} value={source.name}>
                        {source.name} · {source.nodeCount}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="proxy-search-box">
                  <Search size={14} />
                  <input
                    aria-label="Search proxy group or node"
                    placeholder="Search proxy group or node..."
                    value={proxies.query}
                    onChange={(event) => proxies.setQuery(event.target.value)}
                  />
                </label>
                <div className="proxy-board-status">
                  <span className={`status-chip ${helperStatusTone}`}>
                    {helperStatusLabel}
                  </span>
                  <span className="status-chip neutral">parallel {config.delayTestConcurrency ?? 4}</span>
                </div>
              </div>

              <div className="strategy-wall" aria-label="Strategy groups">
                {strategyWallGroups.length === 0 ? (
                  <span className="selector-empty">
                    {selectedNodeSource
                      ? 'No strategy groups match the selected source and search.'
                      : 'No strategy groups match the current search.'}
                  </span>
                ) : null}
                {strategyWallColumns.map((column, columnIndex) => (
                  <div className="strategy-wall-column" key={`strategy-column-${columnIndex}`}>
                    {column.map((proxy) => {
                  const selectedProxy = proxyByName.get(proxy.now);
                  const selectedDelay = proxyDelayByName.get(proxy.now) ?? proxy.delay;
                  const helperGroup = helperGroupByName.get(proxy.name);
                  const rowConfig =
                    groupConfigDrafts[proxy.name] ??
                    helperGroup?.config ??
                    fallbackGroupConfig(proxies.groupTestUrls[proxy.name] || helperDefaultTestUrl);
                  const execution = resolveProbeExecution(proxy, rowConfig.mode);
                  const groupScores = helper.scoresByGroup[proxy.name]?.nodes ?? [];
                  const latestGroupUpdate = latestScoreUpdateAt(groupScores);
                  const groupScoreByName = new Map(groupScores.map((score) => [score.name, score]));
                  const selectedScore = execution.mode !== 'native-urltest' ? groupScoreByName.get(proxy.now) : undefined;
                  const selectedDelayValue =
                    execution.mode === 'helper-score'
                      ? scoreDelayOrFallback(selectedScore, selectedDelay)
                      : proxies.groupDelayResults[proxy.name] ?? selectedDelay;
                  const selectedScoreTone = selectedScore ? nodeScoreTone(selectedScore, selectedDelay) : 'none';
                  const selectedDelayTone = delayTone(selectedDelayValue);
                  const isProbing = activeProbeGroupNames.has(proxy.name);
                  const isNativeTesting = execution.mode === 'native-urltest' && proxies.testingProxies.includes(proxy.name);
                  const activeProbeNodeNames = new Set(helper.activeProbeNodesByGroup[proxy.name] ?? []);
                  const isActive = activeStrategyGroup?.name === proxy.name;
                  const isCollapsed = collapsedStrategyGroups.has(proxy.name);
                  const canAutoSwitch = isSelectableProxyGroup(proxy) && !execution.autoSwitchManagedBySingBox;
                  const fullStrategyGroup = proxyByName.get(proxy.name) ?? proxy;
                  const rowSourceRestrictionEnabled = Boolean(
                    rowConfig.sourceRestrictionEnabled && isSelectableProxyGroup(fullStrategyGroup)
                  );
                  const rowAllowedSourcesSet = new Set(rowConfig.allowedNodeSources ?? []);
                  const rowSourceEligibleCount = fullStrategyGroup.all.filter((memberName) => {
                    const member = proxyByName.get(memberName);
                    return sourceRestrictionAllowsNode(
                      memberName,
                      Boolean(member && isProxyGroup(member)),
                      rowAllowedSourcesSet,
                      rowConfig.allowUnlabeledNodes,
                      nodeSourceByNodeName,
                      rowSourceRestrictionEnabled
                    );
                  }).length;
                  const rowCurrentSourceAllowed = sourceRestrictionAllowsNode(
                    fullStrategyGroup.now,
                    Boolean(proxyByName.get(fullStrategyGroup.now)?.all.length),
                    rowAllowedSourcesSet,
                    rowConfig.allowUnlabeledNodes,
                    nodeSourceByNodeName,
                    rowSourceRestrictionEnabled
                  );
                  const rowActivity = describeProbeActivity({ mode: rowConfig.mode, groupProbing: isProbing || isNativeTesting });
                  const groupMembers = proxy.all
                    .map(
                      (member) =>
                        proxyByName.get(member) ?? {
                          name: member,
                          type: 'Unknown',
                          now: '',
                          all: [],
                          delay: null
                        }
                    )
                    .filter((member) =>
                      `${member.name} ${member.type} ${member.now}`.toLowerCase().includes(proxyQuery)
                    );
                  const visibleMembers = selectVisibleStrategyWallMembers(groupMembers, { collapsed: isCollapsed });
                  const hiddenCount = Math.max(0, groupMembers.length - visibleMembers.length);
                  const testUrlLabel =
                    execution.mode === 'native-urltest'
                      ? 'sing-box urltest.url'
                      : helperGroup?.config.testUrl || proxies.groupTestUrls[proxy.name] || helperDefaultTestUrl;

                  return (
                    <article
                      aria-busy={rowActivity ? true : undefined}
                      className={`strategy-group-card ${isActive ? 'selected' : ''} ${isActive ? 'featured' : ''} ${isCollapsed ? 'collapsed' : ''} ${draggingStrategyGroupName === proxy.name ? 'dragging' : ''}`}
                      draggable
                      key={proxy.name}
                      onDragEnd={() => setDraggingStrategyGroupName(null)}
                      onDragOver={(event) => handleStrategyGroupDragOver(event, proxy.name)}
                      onDragStart={(event) => handleStrategyGroupDragStart(event, proxy.name)}
                      onDrop={(event) => handleStrategyGroupDrop(event, proxy.name)}
                      onClick={() => setActiveStrategyGroupName(proxy.name)}
                    >
                      <div
                        className={`strategy-card-head ${rowActivity?.className ?? ''}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveStrategyGroupName(proxy.name);
                          toggleStrategyGroupCollapse(proxy.name);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') {
                            return;
                          }
                          event.preventDefault();
                          event.stopPropagation();
                          setActiveStrategyGroupName(proxy.name);
                          toggleStrategyGroupCollapse(proxy.name);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="strategy-card-title">
                          <strong>{proxy.name}</strong>
                          <span title={latestGroupUpdate ? `Updated ${latestGroupUpdate.toLocaleString()}` : undefined}>
                            {proxy.type} · {proxy.all.length} nodes
                            {latestGroupUpdate ? ` · updated ${latestGroupUpdate.toLocaleTimeString()}` : ''}
                          </span>
                        </div>
                        <div className="strategy-card-current">
                          <span className="current-label">Current</span>
                          <span className={`node-status-dot current-status-dot ${selectedDelayTone}`} aria-hidden="true" />
                          <strong
                            className={`current-name ${rowSourceRestrictionEnabled && !rowCurrentSourceAllowed ? 'source-violation' : ''}`}
                            title={
                              rowSourceRestrictionEnabled && !rowCurrentSourceAllowed
                                ? '当前节点不在允许来源内'
                                : proxy.now || undefined
                            }
                          >
                            {proxy.now || '--'}
                          </strong>
                          <span className="current-type">{selectedProxy?.type ?? 'unknown'}</span>
                          {rowSourceRestrictionEnabled && !rowCurrentSourceAllowed ? (
                            <button
                              className="current-violation-badge"
                              onClick={(event) => {
                                event.stopPropagation();
                                void fixActiveSourceViolation(fullStrategyGroup);
                              }}
                              title="当前节点不在允许来源内，点击一键切回允许来源的最佳节点"
                              type="button"
                            >
                              <Zap size={9} />
                              <span>修复</span>
                            </button>
                          ) : null}
                        </div>
                        <div className="strategy-card-meta">
                          <span className={`mode-chip ${rowConfig.mode === 'delay' ? 'delay' : ''}`}>{rowConfig.mode}</span>
                          <span className={`execution-chip ${execution.mode}`}>{execution.label}</span>
                          {rowConfig.mode === 'score' ? (
                            <button
                              className={`delay-pill score-pill ${selectedScoreTone} ${isProbing ? 'testing' : ''}`}
                              disabled={!helperServiceAvailable || isProbing}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runGroupDelayOrProbe(proxy);
                              }}
                              type="button"
                            >
                              {formatNodeScore(selectedScore, selectedDelay)}
                            </button>
                          ) : null}
                          <button
                            className={`delay-pill ${selectedDelayTone} ${rowConfig.mode === 'delay' && (isProbing || isNativeTesting) ? 'testing' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (rowConfig.mode === 'delay' && (helperServiceAvailable || execution.mode === 'native-urltest')) {
                                void runGroupDelayOrProbe(proxy);
                                return;
                              }
                              void proxies.testProxy(proxy.now || proxy.name, proxy.name, rowConfig.testUrl);
                            }}
                            type="button"
                          >
                            {rowConfig.mode === 'delay' && (isProbing || isNativeTesting) ? '...' : formatDelay(selectedDelayValue)}
                          </button>
                          <span className={`status-chip ${rowConfig.autoSwitch && canAutoSwitch ? 'ok' : 'neutral'}`}>
                            {execution.autoSwitchManagedBySingBox
                              ? 'native switch'
                              : rowConfig.autoSwitch && canAutoSwitch
                                ? 'auto switch'
                                : 'manual'}
                          </span>
                          {rowSourceRestrictionEnabled ? (
                            <span
                              className={`status-chip source-limit ${rowCurrentSourceAllowed ? 'blue' : 'bad'}`}
                              title={`${rowSourceEligibleCount} / ${fullStrategyGroup.all.length} 个节点符合来源限制`}
                            >
                              {rowCurrentSourceAllowed ? 'sources' : 'source violation'} {rowSourceEligibleCount}/{fullStrategyGroup.all.length}
                            </span>
                          ) : null}
                          <span className="status-chip neutral">{Math.round(rowConfig.probeIntervalSec / 60)} min</span>
                        </div>
                        <div className="strategy-card-actions">
                          <button
                            aria-label={isCollapsed ? `Expand ${proxy.name}` : `Collapse ${proxy.name}`}
                            className="quiet-action icon"
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleStrategyGroupCollapse(proxy.name);
                            }}
                            type="button"
                          >
                            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          </button>
                          <button
                            className="quiet-action"
                            disabled={
                              !(helperServiceAvailable || execution.mode === 'native-urltest') ||
                              proxy.all.length === 0 ||
                              isProbing ||
                              isNativeTesting
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void runGroupDelayOrProbe(proxy);
                            }}
                            type="button"
                          >
                            {rowActivity
                              ? rowConfig.mode === 'score'
                                ? 'Scoring'
                                : 'Testing'
                              : rowConfig.mode === 'score'
                                ? 'Score'
                                : 'Delay'}
                          </button>
                          <button
                            className="quiet-action icon"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveStrategyGroupName(proxy.name);
                            }}
                            type="button"
                          >
                            <SettingsIcon size={13} />
                          </button>
                        </div>
                      </div>

                      {!isCollapsed ? (
                        <>
                          <div className={`strategy-card-nodes ${isActive ? 'expanded' : ''}`}>
                            {visibleMembers.map((member) => {
                          const isCurrent = member.name === proxy.now;
                          const isSwitchingGroup = proxies.switchingGroups.includes(proxy.name);
                          const isApplyingGroup = helper.applyingGroups.includes(proxy.name);
                          const isTesting = proxies.testingProxies.includes(member.name);
                          const isHelperNodeProbing = activeProbeNodeNames.has(member.name);
                          const nodeSourceName = nodeSourceByNodeName.get(member.name);
                          const isAllowedBySource = sourceRestrictionAllowsNode(
                            member.name,
                            isProxyGroup(member),
                            rowAllowedSourcesSet,
                            rowConfig.allowUnlabeledNodes,
                            nodeSourceByNodeName,
                            rowSourceRestrictionEnabled
                          );
                          const canSelect =
                            isSelectableProxyGroup(proxy) &&
                            !isSwitchingGroup &&
                            !isApplyingGroup &&
                            isAllowedBySource &&
                            (!rowSourceRestrictionEnabled || helperServiceAvailable);
                          const score = execution.mode === 'helper-score' ? groupScoreByName.get(member.name) : undefined;
                          const displayDelay = proxyDelayByName.get(member.name) ?? member.delay;
                          const nodeDelay = execution.mode === 'helper-score' ? scoreDelayOrFallback(score, displayDelay) : displayDelay;
                          const scoreTone = score ? nodeScoreTone(score, displayDelay) : 'none';
                          const nodeDelayTone = delayTone(nodeDelay);
                          const cardTone = rowConfig.mode === 'score' && score ? scoreTone : nodeDelayTone;
                          const nodeActivity = describeProbeActivity({
                            mode: rowConfig.mode,
                            groupProbing: isHelperNodeProbing,
                            nodeTesting: isTesting
                          });
                          const isScoring = nodeActivity?.kind === 'scoring';
                          const baseTooltip = formatNodeCardTooltip(
                            member.name,
                            member.type,
                            nodeSourceName,
                            nodeDelay,
                            score,
                            {
                              showGemini:
                                helper.testingSettings?.geminiLocationGroup === proxy.name &&
                                Boolean(rowConfig.geminiLocationProbeEnabled),
                              nodeRisk: normalizeNodeRiskChecks(rowConfig.nodeRisk)
                            }
                          );
                          const sourceRestrictionReason = !isAllowedBySource
                            ? isProxyGroup(member)
                              ? '来源限制：嵌套策略组无法保证唯一来源'
                              : nodeSourceName
                                ? `来源限制：${nodeSourceName} 不在允许范围内`
                                : '来源限制：未标记节点不在允许范围内'
                            : null;

                          return (
                            <article
                              aria-busy={nodeActivity ? true : undefined}
                              aria-disabled={!canSelect || isCurrent}
                              className={`strategy-node-card ${cardTone} ${isCurrent ? 'active' : ''} ${!isAllowedBySource ? 'source-locked' : ''} ${nodeActivity?.className ?? ''}`}
                              key={member.name}
                              title={sourceRestrictionReason ? `${baseTooltip}\n${sourceRestrictionReason}` : baseTooltip}
                              onClick={() => {
                                setActiveStrategyGroupName(proxy.name);
                                if (canSelect && !isCurrent) {
                                  if (rowSourceRestrictionEnabled) {
                                    void helper.applyNode(proxy.name, member.name).then(() => proxies.refresh());
                                  } else {
                                    void proxies.switchProxy(proxy.name, member.name);
                                  }
                                }
                              }}
                            >
                              <div className="node-head">
                                <div className="node-title-group">
                                  <span className={`node-status-dot ${nodeDelayTone} ${isTesting ? 'testing' : ''}`} />
                                  <strong className="node-name">{member.name}</strong>
                                </div>
                                <span className="node-type-tag">{member.type}</span>
                              </div>
                              <div className="node-foot">
                                <div className="node-meta">
                                  {nodeSourceName ? (
                                    <span
                                      className="node-source-tag"
                                      style={nodeSourceTagStyleByName.get(nodeSourceName)}
                                      title={`来源: ${nodeSourceName}`}
                                    >
                                      {nodeSourceName}
                                    </span>
                                  ) : rowSourceRestrictionEnabled ? (
                                    <span className="node-source-tag unlabeled" title="来源: 未标记">
                                      未标记
                                    </span>
                                  ) : null}
                                  {!isAllowedBySource ? (
                                    <span className="node-source-lock" title={sourceRestrictionReason ?? undefined}>
                                      <Lock size={8} aria-hidden="true" />
                                      锁定
                                    </span>
                                  ) : null}
                                  {rowConfig.mode === 'score' ? (
                                    <span
                                      className={`score-mark ${scoreTone} ${isScoring ? 'testing' : ''}`}
                                      title={
                                        score
                                          ? `${formatScoreTooltip(score)}${score.delayMs !== null ? ` / ${score.delayMs}ms` : ''}`
                                          : undefined
                                      }
                                    >
                                      {isScoring ? (
                                        <span className="testing-spinner-wrapper">
                                          <Zap className="spin-fast" size={8} />
                                          <em>...</em>
                                        </span>
                                      ) : (
                                        formatNodeScore(score, displayDelay)
                                      )}
                                    </span>
                                  ) : isCurrent ? (
                                    <span className="node-active-pill">ACTIVE</span>
                                  ) : !nodeSourceName ? (
                                    <span className="node-type-sub">{proxy.name}</span>
                                  ) : null}
                                </div>
                                <button
                                  aria-label={`Test ${member.name} delay`}
                                  className={`delay-pill ${nodeDelayTone} ${isTesting ? 'testing' : ''}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void proxies.testProxy(member.name, proxy.name, rowConfig.testUrl);
                                  }}
                                  type="button"
                                >
                                  {isTesting ? (
                                    <span className="testing-spinner-wrapper">
                                      <RefreshCw className="spin-fast" size={8} />
                                      <em>...</em>
                                    </span>
                                  ) : (
                                    formatDelay(nodeDelay)
                                  )}
                                </button>
                              </div>
                            </article>
                          );
                        })}
                          </div>

                          <div className="strategy-card-footer">
                            <span>{testUrlLabel}</span>
                            <span>
                              {visibleMembers.length}
                              {hiddenCount > 0 ? ` / ${groupMembers.length}` : ''} shown
                            </span>
                          </div>
                        </>
                      ) : null}
                    </article>
                  );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <aside className="strategy-inspector" aria-label="Selected strategy group settings">
              {activeStrategyGroup ? (
                <>
                  <div className="inspector-head">
                    <div className="inspector-title">
                      <div className="inspector-name-block">
                        <div className="inspector-title-row">
                          <Layers size={14} className="inspector-icon" />
                          <strong title={activeInspectorModel.name}>{activeInspectorModel.name}</strong>
                        </div>
                        <div className="inspector-badge-row">
                          <span className={`inspector-type-pill ${activeInspectorModel.type.toLowerCase()}`}>
                            {activeInspectorModel.type}
                          </span>
                          <span className="inspector-members-count">{activeInspectorModel.membersLabel}</span>
                          {activeSourceRestrictionEnabled ? (
                            <span className="source-restriction-count">
                              来源 {activeSourceEligibleCount}/{activeStrategyGroup.all.length}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className={`mode-chip ${activeGroupConfig.mode === 'score' ? 'score' : 'delay'}`}>
                        {activeGroupConfig.mode === 'score' ? '🏆 综合评分' : '⚡ 真实延迟'}
                      </span>
                    </div>
                  </div>

                  <div className="inspector-summary">
                    <div className="mini-stat">
                      <span>当前选中节点</span>
                      <strong title={activeInspectorModel.current}>{activeInspectorModel.current}</strong>
                    </div>
                    <div className="mini-stat">
                      <span>评测指标</span>
                      <strong>{activeInspectorModel.metricLabel}</strong>
                    </div>
                    <div className="mini-stat">
                      <span>自动优选切换</span>
                      <strong className={activeInspectorModel.autoSwitchLabel === 'On' ? 'status-text-ok' : ''}>
                        {activeInspectorModel.autoSwitchLabel}
                      </strong>
                    </div>
                    <div className="mini-stat">
                      <span>定时测速调度</span>
                      <strong>{activeInspectorModel.scheduleLabel}</strong>
                    </div>
                  </div>

                  {helperAvailability === 'offline' ? (
                    <div className="inspector-warning">
                      Helper 辅助调度服务未连接。评分模式、自动调度与测试 URL 配置不可用。
                    </div>
                  ) : null}
                  {activeHelperScores?.applyError ? (
                    <div className="inspector-warning bad">{activeHelperScores.applyError}</div>
                  ) : null}
                  {activeSourceRestrictionEnabled && !activeCurrentSourceAllowed ? (
                    <div className="inspector-warning bad">
                      <div>当前节点不在允许来源内；这是外部切换或来源配置变化造成的越界状态。</div>
                      <button
                        className="source-violation-action"
                        onClick={() => void fixActiveSourceViolation()}
                        type="button"
                      >
                        <Zap size={11} />
                        <span>一键切回允许来源的最佳节点</span>
                      </button>
                    </div>
                  ) : null}

                  <form className="inspector-form" onSubmit={(event) => event.preventDefault()}>
                    <div className="inspector-group-card">
                      <div className="inspector-card-header">
                        <Sliders size={12} />
                        <span>策略参数 / Parameters</span>
                      </div>

                      <div className="inspector-field">
                        <label className="field-title">优选依据</label>
                        <div className="policy-segment large" aria-label={`${activeStrategyGroup.name} selection basis`}>
                          <button
                            className={activeGroupConfig.mode === 'score' ? 'active' : ''}
                            disabled={!helperServiceAvailable}
                            onClick={() => draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { mode: 'score' })}
                            type="button"
                            title="综合评分优选"
                          >
                            Score
                          </button>
                          <button
                            className={activeGroupConfig.mode === 'delay' ? 'active' : ''}
                            disabled={!helperServiceAvailable}
                            onClick={() => draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { mode: 'delay' })}
                            type="button"
                            title="真实延迟优选"
                          >
                            Delay
                          </button>
                        </div>
                      </div>

                      {activeGroupConfig.mode === 'score' ? (
                        <label className="inspector-field">
                          <span className="field-title">Score scheme</span>
                          <select
                            aria-label="Score scheme"
                            disabled={!activeInspectorModel.canEditScheme}
                            value={activeGroupConfig.scheme}
                            onChange={(event) =>
                              draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                scheme: event.target.value as ScoreScheme
                              })
                            }
                          >
                            <option value="Balanced">Balanced (综合平衡)</option>
                            <option value="LatencyFirst">Latency (低延迟优先)</option>
                          </select>
                        </label>
                      ) : null}

                      <div className="inspector-field">
                        <div className="field-title-row">
                          <label htmlFor="inspector-test-url" className="field-title">Test URL</label>
                          <div className="test-url-presets">
                            <button
                              type="button"
                              className="url-chip"
                              disabled={!helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest'}
                              onClick={() => draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { testUrl: 'https://cp.cloudflare.com/generate_204' })}
                            >
                              Cloudflare
                            </button>
                            <button
                              type="button"
                              className="url-chip"
                              disabled={!helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest'}
                              onClick={() => draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { testUrl: 'http://www.gstatic.com/generate_204' })}
                            >
                              Google
                            </button>
                            <button
                              type="button"
                              className="url-chip"
                              disabled={!helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest'}
                              onClick={() => draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { testUrl: 'https://www.bilibili.com' })}
                            >
                              Bilibili
                            </button>
                          </div>
                        </div>
                        <input
                          id="inspector-test-url"
                          aria-label="Test URL"
                          disabled={!helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest'}
                          value={
                            activeProbeExecution?.mode === 'native-urltest'
                              ? 'sing-box urltest.url'
                              : activeGroupConfig.testUrl
                          }
                          onChange={(event) =>
                            draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                              testUrl: event.target.value
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className={`inspector-group-card source-restriction-card ${activeSourceRestrictionEnabled ? 'on' : ''}`}>
                      <div className="inspector-card-header">
                        <GitBranch size={12} />
                        <span>节点来源范围 / Sources</span>
                      </div>

                      {activeCanRestrictSources ? (
                        <>
                          <label className={`automation-option ${activeSourceRestrictionEnabled ? 'on' : ''}`}>
                            <input
                              aria-label="限制可选节点来源"
                              checked={activeSourceRestrictionEnabled}
                              disabled={!helperServiceAvailable}
                              type="checkbox"
                              onChange={(event) => toggleActiveSourceRestriction(event.target.checked)}
                            />
                            <span
                              className={`automation-switch ${activeSourceRestrictionEnabled ? 'on' : ''}`}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>限制可选节点来源</strong>
                              <small>手选、测速、推荐与自动切换共用此范围</small>
                            </span>
                          </label>

                          {activeSourceRestrictionEnabled ? (
                            <div className="source-restriction-select" ref={sourceRestrictionMenuRef}>
                              <button
                                aria-expanded={sourceRestrictionDropdownOpen}
                                aria-haspopup="true"
                                aria-label="选择允许的节点来源"
                                className="source-restriction-trigger"
                                disabled={!helperServiceAvailable}
                                onClick={() => setSourceRestrictionDropdownOpen((open) => !open)}
                                type="button"
                              >
                                <span>{activeSourceSelectionLabel}</span>
                                <ChevronDown size={12} aria-hidden="true" />
                              </button>

                              {sourceRestrictionDropdownOpen ? (
                                <div
                                  aria-label="允许的节点来源"
                                  className="source-restriction-menu"
                                  role="group"
                                >
                                  <div className="source-restriction-menu-head">
                                    <span>允许来源</span>
                                    <div>
                                      <button onClick={selectAllActiveNodeSources} type="button">全选</button>
                                      <button onClick={clearActiveNodeSources} type="button">清空</button>
                                    </div>
                                  </div>
                                  <div className="source-restriction-options">
                                    {helper.nodeSources.map((source) => (
                                      <label className="source-restriction-option" key={source.name}>
                                        <input
                                          aria-label={`允许来源 ${source.name}`}
                                          checked={activeAllowedNodeSources.includes(source.name)}
                                          type="checkbox"
                                          onChange={(event) =>
                                            toggleActiveAllowedNodeSource(source.name, event.target.checked)
                                          }
                                        />
                                        <span
                                          className="source-option-dot"
                                          style={nodeSourceTagStyleByName.get(source.name)}
                                          aria-hidden="true"
                                        />
                                        <span title={source.name}>{source.name}</span>
                                        <small>{source.nodeCount}</small>
                                      </label>
                                    ))}
                                    {activeMissingAllowedSources.map((sourceName) => (
                                      <label className="source-restriction-option missing" key={`missing-${sourceName}`}>
                                        <input
                                          aria-label={`移除失效来源 ${sourceName}`}
                                          checked
                                          type="checkbox"
                                          onChange={() => toggleActiveAllowedNodeSource(sourceName, false)}
                                        />
                                        <span className="source-option-dot" aria-hidden="true" />
                                        <span title={sourceName}>{sourceName}</span>
                                        <small>已失效</small>
                                      </label>
                                    ))}
                                    <label className="source-restriction-option unlabeled">
                                      <input
                                        aria-label="允许未标记节点"
                                        checked={Boolean(activeGroupConfig.allowUnlabeledNodes)}
                                        type="checkbox"
                                        onChange={(event) =>
                                          draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                            allowUnlabeledNodes: event.target.checked
                                          })
                                        }
                                      />
                                      <span className="source-option-dot" aria-hidden="true" />
                                      <span>未标记</span>
                                      <small>无来源标签</small>
                                    </label>
                                  </div>
                                </div>
                              ) : null}
                              {activeSourceSelectionCount === 0 ? (
                                <div className="source-restriction-warning">
                                  至少选择一个来源或“未标记”后才能保存。
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="automation-option disabled">
                          <span className="automation-switch" aria-hidden="true" />
                          <span>
                            <strong>仅 Selector 支持来源限制</strong>
                            <small>URLTest / Fallback 由 sing-box 原生管理节点选择</small>
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="inspector-group-card">
                      <div className="inspector-card-header">
                        <Zap size={12} />
                        <span>自动化调度 / Automation</span>
                      </div>

                      <div className="inspector-automation-grid">
                        {activeInspectorModel.autoSwitchManagedBySingBox ? (
                          <div className="automation-option disabled on">
                            <span className="automation-switch on" aria-hidden="true" />
                            <span>
                              <strong>sing-box 原生优选</strong>
                              <small>由 sing-box URLTest 自动管理切换</small>
                            </span>
                          </div>
                        ) : (
                          <label className={`automation-option ${activeGroupConfig.autoSwitch && activeInspectorModel.canAutoSwitch ? 'on' : ''}`}>
                            <input
                              checked={activeGroupConfig.autoSwitch && activeInspectorModel.canAutoSwitch}
                              disabled={!activeInspectorModel.canAutoSwitch}
                              type="checkbox"
                              onChange={(event) =>
                                draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                  autoSwitch: event.target.checked
                                })
                              }
                            />
                            <span
                              className={`automation-switch ${activeGroupConfig.autoSwitch && activeInspectorModel.canAutoSwitch ? 'on' : ''}`}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>自动切换最佳节点</strong>
                              <small>测速评分完成后自动应用最佳节点</small>
                            </span>
                          </label>
                        )}
                        <label className={`automation-option ${activeGroupConfig.autoProbe && activeInspectorModel.canSchedule ? 'on' : ''}`}>
                          <input
                            checked={activeGroupConfig.autoProbe && activeInspectorModel.canSchedule}
                            disabled={!activeInspectorModel.canSchedule}
                            type="checkbox"
                            onChange={(event) =>
                              draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                autoProbe: event.target.checked
                              })
                            }
                          />
                          <span
                            className={`automation-switch ${activeGroupConfig.autoProbe && activeInspectorModel.canSchedule ? 'on' : ''}`}
                            aria-hidden="true"
                          />
                          <span>
                              <strong>定时后台测速</strong>
                              <small>按设定周期自动测速与评分，不运行出口或网络类型判定</small>
                          </span>
                        </label>
                      </div>

                      <div className="inspector-field-inline">
                        <label className="inspector-field">
                          <span className="field-title">Probe interval minutes</span>
                          <input
                            aria-label="Probe interval minutes"
                            disabled={!activeInspectorModel.canSchedule || !activeGroupConfig.autoProbe}
                            max={1440}
                            min={helperMinProbeIntervalMinutes}
                            type="number"
                            value={activeProbeIntervalDraft}
                            onBlur={draftActiveProbeInterval}
                            onChange={(event) => setActiveProbeIntervalDraft(event.target.value)}
                          />
                        </label>

                        <label className="inspector-field">
                          <span className="field-title">Parallel requests</span>
                          <input
                            aria-label="Parallel requests"
                            disabled={!helperServiceAvailable}
                            max={64}
                            min={1}
                            type="number"
                            value={delayConcurrencyDraft}
                            onBlur={() => commitDelayConcurrency(4)}
                            onChange={(event) => setDelayConcurrencyDraft(event.target.value)}
                          />
                        </label>
                      </div>
                    </div>

                    <div className="inspector-group-card">
                      <div className="inspector-card-header">
                        <Shield size={12} />
                        <span>出口与网络类型 / Egress & Network</span>
                      </div>

                      <div className="inspector-automation-grid">
                        {activeIsGeminiLocationGroup ? (
                          <label className={`automation-option ${activeGroupConfig.geminiLocationProbeEnabled ? 'on' : ''}`}>
                            <input
                              aria-label="Gemini 出口与解锁检测"
                              checked={activeGroupConfig.geminiLocationProbeEnabled ?? false}
                              disabled={!helperServiceAvailable}
                              type="checkbox"
                              onChange={(event) =>
                                draftGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                  geminiLocationProbeEnabled: event.target.checked
                                })
                              }
                            />
                            <span
                              className={`automation-switch ${activeGroupConfig.geminiLocationProbeEnabled ? 'on' : ''}`}
                              aria-hidden="true"
                            />
                            <span>
                              <strong>Gemini 出口与解锁检测</strong>
                              <small>由独立巡检按钮执行；使用 Settings 中 Chrome profile 的 Google 登录态</small>
                            </span>
                          </label>
                        ) : null}

                        <label className={`automation-option ${activeNodeRisk.exitIp ? 'on' : ''}`}>
                          <input
                            aria-label="出口 IP 检测"
                            checked={activeNodeRisk.exitIp}
                            disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                            type="checkbox"
                            onChange={(event) => draftActiveNodeRiskCheck('exitIp', event.target.checked)}
                          />
                          <span
                            className={`automation-switch ${activeNodeRisk.exitIp ? 'on' : ''}`}
                            aria-hidden="true"
                          />
                          <span>
                            <strong>出口 IP 检测</strong>
                            <small>由独立巡检按钮执行；通过目标节点直接观测 IPv4 / IPv6 出口</small>
                          </span>
                        </label>

                        <label className={`automation-option ${activeNodeRisk.networkClass ? 'on' : ''}`}>
                          <input
                            aria-label="家宽 / 机房检测"
                            checked={activeNodeRisk.networkClass}
                            disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                            type="checkbox"
                            onChange={(event) => draftActiveNodeRiskCheck('networkClass', event.target.checked)}
                          />
                          <span
                            className={`automation-switch ${activeNodeRisk.networkClass ? 'on' : ''}`}
                            aria-hidden="true"
                          />
                          <span>
                            <strong>家宽 / 机房检测</strong>
                            <small>由独立巡检按钮执行；获取出口后判断家宽、机房、移动或商业网络</small>
                          </span>
                        </label>

                        {!activeSupportsNodeInspection ? (
                          <div className="settings-scope-note">
                            当前组没有可检测的具体节点，因此出口与网络类型检测不可用。
                          </div>
                        ) : null}

                        <details
                          className="risk-cluster-container"
                          key={`advanced-risk-${activeStrategyGroup.name}`}
                          open={activeAdvancedRiskEnabled || undefined}
                        >
                          <summary className="risk-cluster-title">高级网络检查（可选，默认不调用）</summary>
                          <div className="risk-cluster-options">
                            <label className={`risk-sub-option ${activeNodeRisk.addressScope ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.addressScope}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('addressScope', event.target.checked)}
                              />
                              <span>公网地址检查 — 排除私网、保留地址和特殊用途地址</span>
                            </label>
                            <label className={`risk-sub-option ${activeNodeRisk.networkIdentity ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.networkIdentity}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('networkIdentity', event.target.checked)}
                              />
                              <span>BGP / ASN 归属 — 查看出口所属网络运营方</span>
                            </label>
                            <label className={`risk-sub-option ${activeNodeRisk.routeSecurity ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.routeSecurity}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('routeSecurity', event.target.checked)}
                              />
                              <span>RPKI — 验证该 BGP 路由是否获得前缀持有者授权</span>
                            </label>
                            <label className={`risk-sub-option ${activeNodeRisk.tor ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.tor}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('tor', event.target.checked)}
                              />
                              <span>Tor 出口 — 判断 IP 是否出现在公开 Tor 出口目录</span>
                            </label>
                            <label className={`risk-sub-option ${activeNodeRisk.privacy ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.privacy}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('privacy', event.target.checked)}
                              />
                              <span>代理特征 — 查询 VPN、代理、托管或匿名网络标签</span>
                            </label>
                            <label className={`risk-sub-option ${activeNodeRisk.abuse ? 'on' : ''}`}>
                              <input
                                checked={activeNodeRisk.abuse}
                                disabled={!helperServiceAvailable || !activeSupportsNodeInspection}
                                type="checkbox"
                                onChange={(event) => draftActiveNodeRiskCheck('abuse', event.target.checked)}
                              />
                              <span>滥用信誉 — 查询垃圾邮件、扫描和攻击举报记录</span>
                            </label>
                          </div>
                        </details>
                      </div>
                    </div>
                  </form>

                  <div className="inspector-actions">
                    <button
                      className="ghost-action inspector-inspection-action"
                      disabled={!activeCanRunInspection}
                      onClick={runActiveGroupInspection}
                      title={
                        activeHasInspectionSelection
                          ? '独立运行已勾选的出口与网络类型检测，不执行测速'
                          : '请先勾选 Gemini、出口 IP 或网络类型检测项'
                      }
                      type="button"
                    >
                      <Shield size={14} />
                      {activeGroupInspecting ? 'Inspecting...' : 'Run egress inspection'}
                    </button>
                    <button
                      className="primary-action inspector-primary-action"
                      disabled={!activeCanRunProbe}
                      onClick={runActiveGroupProbe}
                      type="button"
                    >
                      <Zap size={14} />
                      {activeGroupActivity
                        ? activeGroupConfig.mode === 'score'
                          ? 'Scoring...'
                          : 'Testing...'
                        : activeInspectorModel.runLabel}
                    </button>
                    <div className="inspector-secondary-actions">
                      <button
                        aria-label="Save settings"
                        className={`ghost-action ${
                          activeGroupConfigSaveStatus?.tone === 'ok'
                            ? 'status-ok'
                            : activeGroupConfigSaveStatus?.tone === 'bad'
                              ? 'status-warn'
                              : ''
                        }`}
                        disabled={!helperServiceAvailable || activeGroupConfigSaveStatus?.tone === 'saving'}
                        onClick={() => void saveActiveGroupConfig()}
                        type="button"
                      >
                        <Save size={13} />
                        {activeGroupConfigSaveStatus?.text ?? 'Save settings'}
                      </button>
                      <button
                        className="ghost-action"
                        onClick={() => {
                          void proxies.refresh();
                          void useHelperStore.getState().loadGroups();
                        }}
                        type="button"
                      >
                        <RefreshCw size={13} />
                        Refresh data
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="inspector-empty">请在左侧选择一个策略组查看与配置详细规则</div>
              )}
            </aside>
          </section>
        </section>
        ) : null}

        {activeRoute === 'connections' ? (
        <section className="page-fill">
          <article className="connections-panel fill-panel" id="connections">
            <div className="panel-heading compact">
              <div className="overview-viz-heading">
                <h2>Live sessions</h2>
                <div className="policy-segment">
                  <button
                    className={connectionsViewMode === 'list' ? 'active' : ''}
                    onClick={() => setConnectionsViewMode('list')}
                    type="button"
                  >
                    <span>列表视图</span>
                  </button>
                  <button
                    className={connectionsViewMode === 'map' ? 'active' : ''}
                    onClick={() => setConnectionsViewMode('map')}
                    type="button"
                  >
                    <Globe size={12} />
                    <span>全球地图</span>
                  </button>
                </div>
                <span className="panel-stamp">{connections.connections.length} active rows</span>
              </div>
              <div className="compact-actions">
                <button className="ghost-action" onClick={connections.refreshConnections}>
                  Refresh
                </button>
                {connections.query.trim() && filteredConnections.length > 0 ? (
                  <button
                    className="ghost-action danger"
                    onClick={() =>
                      setPendingConfirm({
                        title: 'Drop filtered connections',
                        detail: `Disconnect the ${filteredConnections.length} session(s) matching "${connections.query.trim()}". Other sessions stay connected.`,
                        confirmLabel: 'Drop filtered',
                        onConfirm: () =>
                          void connections.closeConnections(filteredConnections.map((item) => item.id))
                      })
                    }
                  >
                    Drop filtered
                  </button>
                ) : null}
                <button
                  className="ghost-action danger"
                  onClick={() =>
                    setPendingConfirm({
                      title: 'Close all connections',
                      detail: `Disconnect all ${connections.connections.length} active session(s). This affects every current connection.`,
                      confirmLabel: 'Close all',
                      onConfirm: () => void connections.closeAllConnections()
                    })
                  }
                >
                  Close all
                </button>
              </div>
            </div>
            <input
              className="wide-input"
              placeholder="filter target, rule, outbound..."
              value={connections.query}
              onChange={(event) => connections.setQuery(event.target.value)}
            />
            {connectionsViewMode === 'map' ? (
              <WorldRequestMap
                embedded
                connections={filteredConnections}
                onSelectHost={(host) => {
                  connections.setQuery(host);
                  setConnectionsViewMode('list');
                }}
              />
            ) : (
            <div className="connection-list">
              {filteredConnections.map((connection) => (
                  <div
                    className={`connection-row ${selectedConnectionId === connection.id ? 'selected' : ''}`}
                    key={connection.id}
                    onClick={() => setSelectedConnectionId(connection.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') {
                        return;
                      }
                      event.preventDefault();
                      setSelectedConnectionId(connection.id);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <strong>{connection.target}</strong>
                      <span>{connection.rule}</span>
                    </div>
                    <div>
                      <span>{connection.outbound}</span>
                      <span>
                        {connection.download} / {connection.upload}
                      </span>
                    </div>
                    <button
                      className="ghost-action danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingConfirm({
                          title: 'Drop connection',
                          detail: `Disconnect ${connection.target}.`,
                          confirmLabel: 'Drop',
                          onConfirm: () => void connections.closeConnection(connection.id)
                        });
                      }}
                    >
                      Drop
                    </button>
                  </div>
                ))}
            </div>
            )}
          </article>
          {selectedConnection ? (
            <aside className="connection-detail-drawer" aria-label="Connection details">
              <div className="connection-detail-head">
                <div>
                  <span>Connection</span>
                  <strong>{selectedConnection.target}</strong>
                  <div className="connection-detail-chips">
                    <span>{selectedConnection.network}</span>
                    <span>{selectedConnection.inboundType || '--'}</span>
                    <span>{selectedConnection.outbound}</span>
                  </div>
                </div>
                <button
                  aria-label="Close connection details"
                  className="quiet-action icon"
                  onClick={() => setSelectedConnectionId(null)}
                  type="button"
                >
                  <X size={15} />
                </button>
              </div>
              <div className="connection-detail-scroll">
                <section className="connection-detail-section">
                  <h3>Endpoint</h3>
                  <div className="connection-detail-grid">
                    <span>ID</span>
                    <strong>{selectedConnection.id}</strong>
                    <span>Source</span>
                    <strong>{selectedConnection.sourceEndpoint}</strong>
                    <span>Source IP</span>
                    <strong>{selectedConnection.sourceIP || '--'}</strong>
                    <span>Source port</span>
                    <strong>{selectedConnection.sourcePort || '--'}</strong>
                    <span>Target</span>
                    <strong>{selectedConnection.destinationEndpoint}</strong>
                    <span>Host</span>
                    <strong>{selectedConnection.destinationHost || '--'}</strong>
                    <span>Destination IP</span>
                    <strong>{selectedConnection.destinationIP || '--'}</strong>
                    <span>Destination port</span>
                    <strong>{selectedConnection.destinationPort || '--'}</strong>
                  </div>
                </section>
                <section className="connection-detail-section">
                  <h3>Route</h3>
                  <div className="connection-detail-grid">
                    <span>Rule</span>
                    <strong>{selectedConnection.rule}</strong>
                    <span>Rule type</span>
                    <strong>{selectedConnection.ruleType}</strong>
                    <span>Payload</span>
                    <strong>{selectedConnection.rulePayload || '--'}</strong>
                    <span>Outbound</span>
                    <strong>{selectedConnection.outbound}</strong>
                    <span>Chains</span>
                    <strong>{selectedConnection.chains.length > 0 ? selectedConnection.chains.join(' -> ') : '--'}</strong>
                  </div>
                  {selectedConnection.chains.length > 0 ? (
                    <div className="connection-chain-path" aria-label="Connection chain">
                      {selectedConnection.chains.map((chain) => (
                        <span key={chain}>{chain}</span>
                      ))}
                    </div>
                  ) : null}
                </section>
                <section className="connection-detail-section">
                  <h3>Process</h3>
                  <div className="connection-detail-grid">
                    <span>Network</span>
                    <strong>{selectedConnection.network}</strong>
                    <span>Inbound</span>
                    <strong>{selectedConnection.inboundType || '--'}</strong>
                    <span>DNS mode</span>
                    <strong>{selectedConnection.dnsMode || '--'}</strong>
                    <span>Process path</span>
                    <strong>{selectedConnection.processPath || '--'}</strong>
                  </div>
                </section>
                <section className="connection-detail-section">
                  <h3>Traffic</h3>
                  <div className="connection-traffic-stats">
                    <div>
                      <span>Down</span>
                      <strong>{selectedConnection.download}</strong>
                    </div>
                    <div>
                      <span>Up</span>
                      <strong>{selectedConnection.upload}</strong>
                    </div>
                    <div>
                      <span>Total</span>
                      <strong>{formatBytes(selectedConnection.totalBytes)}</strong>
                    </div>
                  </div>
                  <div className="connection-detail-grid">
                    <span>Download bytes</span>
                    <strong>{selectedConnection.downloadBytes}</strong>
                    <span>Upload bytes</span>
                    <strong>{selectedConnection.uploadBytes}</strong>
                    <span>Started</span>
                    <strong>{selectedConnection.startedAt || '--'}</strong>
                  </div>
                </section>
              </div>
              <button
                className="ghost-action danger"
                onClick={() =>
                  setPendingConfirm({
                    title: 'Drop connection',
                    detail: `Disconnect ${selectedConnection.target}.`,
                    confirmLabel: 'Drop',
                    onConfirm: () => void connections.closeConnection(selectedConnection.id)
                  })
                }
                type="button"
              >
                Drop connection
              </button>
            </aside>
          ) : null}
        </section>
        ) : null}

        {activeRoute === 'logs' ? (
        <section className="page-fill">
          <article className="logs-panel fill-panel" id="logs">
            <div className="panel-heading compact">
              <div>
                <h2>Runtime feed</h2>
                <span className="panel-stamp">
                  {connections.logs.length} kept / {connections.droppedLogCount} trimmed
                </span>
              </div>
              <div className="compact-actions">
                <button className="ghost-action" onClick={connections.startLogs}>
                  {connections.logStreaming ? 'Streaming' : 'Start stream'}
                </button>
                <button className="ghost-action" disabled={!connections.logStreaming} onClick={connections.stopLogs}>
                  Stop
                </button>
                <button
                  className={`ghost-action ${logScrollPaused ? 'active' : ''}`}
                  onClick={() => setLogScrollPaused((paused) => !paused)}
                >
                  {logScrollPaused ? 'Resume scroll' : 'Pause scroll'}
                </button>
                <button
                  className="ghost-action"
                  disabled={filteredLogs.length === 0}
                  onClick={() => void copyVisibleLogs()}
                >
                  {logsCopied ? 'Copied' : 'Copy'}
                </button>
                <button className="ghost-action danger" onClick={connections.clearLogs}>
                  Clear
                </button>
              </div>
            </div>
            <div className="log-controls">
              <select value={connections.logLevel} onChange={(event) => connections.setLogLevel(event.target.value as never)}>
                <option value="all">all</option>
                <option value="debug">debug</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
              <input
                placeholder="filter logs"
                value={connections.logQuery}
                onChange={(event) => connections.setLogQuery(event.target.value)}
              />
            </div>
            <div className="log-list" ref={logListRef}>
              {filteredLogs.map((log, index) => (
                <div className={`log-row ${log.level}`} key={log.seq ?? index}>
                  <span>{log.level}</span>
                  <code>{log.message}</code>
                </div>
              ))}
            </div>
          </article>
        </section>
        ) : null}

        {activeRoute === 'config' ? (
        <section className="config-panel" id="config" aria-labelledby="config-title">
          <div className="panel-heading compact">
            <div>
              <h2 id="config-title">Runtime config</h2>
              <span className="panel-stamp">
                {configWorkspace.sourceEndpoint
                  ? `loaded from ${configWorkspace.sourceEndpoint}`
                  : 'load the running API config snapshot'}
              </span>
            </div>
            <div className="compact-actions">
              <button className="ghost-action" disabled={configWorkspace.loading} onClick={configWorkspace.loadRuntimeConfig}>
                {configWorkspace.loading ? 'Loading...' : 'Reload'}
              </button>
              <label className="ghost-action file-action">
                Import file
                <input accept="application/json,.json,.jsonc" type="file" onChange={handleConfigFileLoad} />
              </label>
              <button className="ghost-action" onClick={() => configWorkspace.saveSnapshot('runtime snapshot')}>
                Snapshot
              </button>
            </div>
          </div>
          <div className="config-grid">
            <pre className="config-code jsonc-code" aria-label="running sing-box config jsonc">
              <code dangerouslySetInnerHTML={{ __html: highlightedConfig }} />
            </pre>
            <aside className="issue-panel">
              <h3>Source</h3>
              <div className="issue-card info">
                <strong>{configWorkspace.sourceEndpoint ?? 'not loaded'}</strong>
                <span>
                  {configWorkspace.sourceEndpoint === '/configs'
                    ? 'sing-box Clash API only exposes this runtime summary. Put config.json under /ui/config.json or import the file to view the full config.'
                    : configWorkspace.lastLoadedAt
                      ? new Date(configWorkspace.lastLoadedAt).toLocaleString()
                      : 'Reload tries /config, /config.json, /ui/config.json, then /configs.'}
                </span>
              </div>
              {configWorkspace.error ? (
                <div className="issue-card error">
                  <strong>Load failed</strong>
                  <span>{configWorkspace.error}</span>
                </div>
              ) : null}
              <h3>Validation</h3>
              {configWorkspace.issues.length === 0 ? (
                <div className="issue-card ok">
                  <strong>No blocking issues</strong>
                  <span>JSON parses and a Clash API controller can be derived.</span>
                </div>
              ) : (
                configWorkspace.issues.map((issue, index) => (
                  <div
                    key={`${issue.severity}-${issue.path}-${index}`}
                    className={`issue-card ${issue.severity === 'error' ? 'error' : 'info'}`}
                  >
                    <strong>
                      {issue.severity === 'error' ? 'Error' : 'Notice'}
                      {issue.path ? ` · ${issue.path}` : ''}
                    </strong>
                    <span>{issue.message}</span>
                    {issue.suggestion ? <small>{issue.suggestion}</small> : null}
                  </div>
                ))
              )}
              <h3>Snapshots</h3>
              <div className="snapshot-list">
                {configWorkspace.snapshots.map((snapshot) => (
                  <button key={snapshot.id} onClick={() => configWorkspace.restoreSnapshot(snapshot.id)}>
                    {snapshot.name} / {new Date(snapshot.createdAt).toLocaleTimeString()}
                  </button>
                ))}
              </div>
              <textarea className="diagnostic-copy" readOnly value={configWorkspace.diagnosticCopy()} />
            </aside>
          </div>
        </section>
        ) : null}

      </section>
    </main>
  );
}
