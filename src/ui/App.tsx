import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cable,
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  GitBranch,
  LayoutDashboard,
  QrCode,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ScrollText,
  Wifi,
  X
} from 'lucide-react';
import QRCode from 'qrcode';
import { isLoopbackUrl, resolveConfigDownloadUrl } from '../core/configDownloadUrl';
import { routeFromHash, type AppRoute } from '../core/navigation';
import { summarizeTrafficProvider } from '../core/traffic';
import { describeProbeActivity } from '../core/probeActivity';
import { buildProxyInspectorModel } from '../core/proxyInspector';
import {
  applyStrategyWallOrder,
  buildStrategyWallGroups,
  distributeStrategyWallColumns,
  moveStrategyWallGroupOrder,
  selectVisibleStrategyWallMembers
} from '../core/strategyWallLayout';
import {
  buildSingBoxRemoteProfileUri,
  type HelperGroupConfig,
  type HelperNodeScore,
  type ScoreScheme
} from '../core/helperApi';
import {
  isProxyGroup,
  isSelectableProxyGroup,
  isZashboardVisibleStrategyGroup,
  resolveNowProxyName,
  resolveProbeExecution,
  type ProxyRecord
} from '../core/proxies';
import { parseSettingsBackup, serializeSettingsBackup } from '../core/settingsBackup';
import { useControllerStore } from '../state/controllerStore';
import { useConnectionStore } from '../state/connectionStore';
import { useConfigStore } from '../state/configStore';
import { useHelperStore } from '../state/helperStore';
import { useProxyStore } from '../state/proxyStore';
import { useRuntimeStore } from '../state/runtimeStore';
import type { ConnectionRecord } from '../core/connections';
import { SankeyChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([SankeyChart, TooltipComponent, CanvasRenderer]);

const TRAFFIC_SPARKLINE_WINDOW_MS = 2 * 60 * 1000;
const TRAFFIC_SPARKLINE_WIDTH = 188;
const TRAFFIC_SPARKLINE_HEIGHT = 44;
const DEFAULT_DELAY_TEST_TIMEOUT_MS = 5000;
const STRATEGY_GROUP_ORDER_STORAGE_KEY = 'singdeck-strategy-group-order';

type InlineStatus = {
  tone: 'ok' | 'warn' | 'neutral';
  text: string;
};

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
const TOPOLOGY_COLORS = ['#6a6fc5', '#a8d4a0', '#fddb8a', '#f2a0a0'];

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
    const sourceId = addNode(0, connection.source);
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

function formatScoreTooltip(score: HelperNodeScore): string {
  const parts = [
    `latency ${score.components.latency}`,
    `availability ${score.components.availability}`,
    `jitter ${score.components.jitter}`,
    `freshness ${score.components.freshness}`
  ];
  return parts.join(' / ');
}

function fallbackGroupConfig(testUrl: string): HelperGroupConfig {
  return {
    testUrl,
    testUrlOverridden: false,
    mode: 'score',
    scheme: 'Balanced',
    autoSwitch: false,
    autoProbe: true,
    probeIntervalSec: 15 * 60
  };
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
    tooltip: {
      trigger: 'item',
      triggerOn: 'mousemove',
      backgroundColor: 'rgba(7, 10, 11, 0.92)',
      borderColor: 'rgba(114, 242, 180, 0.32)',
      textStyle: {
        color: '#e8f2ef',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
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
          return `${params.data?.displayName ?? params.data?.name ?? ''}<br/>${params.data?.nodeType ?? ''}`;
        }
        const source = params.data?.source ? nodeNames.get(params.data.source) : '';
        const target = params.data?.target ? nodeNames.get(params.data.target) : '';
        return `${source} -> ${target}<br/>连接数: ${params.data?.originalValue ?? 0}`;
      }
    },
    series: [
      {
        type: 'sankey',
        left: 8,
        right: 60,
        top: 8,
        bottom: 8,
        nodeAlign: 'left',
        nodeGap: 3,
        nodeWidth: 10,
        draggable: false,
        emphasis: {
          focus: 'trajectory'
        },
        data: topology.nodes.map((node) => ({
          name: node.id,
          displayName: node.label,
          nodeType: ['Source', 'Rule', 'Route', 'Outbound'][node.level],
          depth: node.level,
          itemStyle: {
            color: TOPOLOGY_COLORS[node.level]
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
          curveness: 0.5,
          opacity: 0.38
        },
        itemStyle: {
          borderWidth: 0
        },
        label: {
          color: '#e8f2ef',
          fontSize: 10,
          formatter: (params: { data?: { displayName?: string } }) => {
            const name = params.data?.displayName ?? '';
            return name.length > 22 ? `${name.slice(0, 19)}...` : name;
          }
        },
        animation: true,
        animationDuration: 900,
        animationEasing: 'cubicOut',
        animationDelay: (index: number) => index * 45
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
  const { config, detection, detecting, lastCheckedAt, urlSecretWarning, applyBrowserStartup, updateConfig, detect } =
    useControllerStore();
  const runtime = useRuntimeStore();
  const proxies = useProxyStore();
  const connections = useConnectionStore();
  const configWorkspace = useConfigStore();
  const helper = useHelperStore();
  const [form, setForm] = useState(config);
  const [testingDefaultUrlDraft, setTestingDefaultUrlDraft] = useState(config.defaultTestUrl);
  const [trafficProfileDraft, setTrafficProfileDraft] = useState('');
  const [activeRoute, setActiveRoute] = useState<AppRoute>(() => routeFromHash(window.location.hash));
  const [activeStrategyGroupName, setActiveStrategyGroupName] = useState<string | null>(null);
  const [railExpanded, setRailExpanded] = useState(() => localStorage.getItem('singdeck-rail-expanded') !== 'false');
  const [topologyPaused, setTopologyPaused] = useState(false);
  const [configQrOpen, setConfigQrOpen] = useState(false);
  const [configQrUrl, setConfigQrUrl] = useState('');
  const [configQrDataUrl, setConfigQrDataUrl] = useState('');
  const [configQrCopied, setConfigQrCopied] = useState(false);
  const [helperActionStatus, setHelperActionStatus] = useState<InlineStatus | null>(null);
  const [helperPendingAction, setHelperPendingAction] = useState<string | null>(null);
  const [localBehaviorStatus, setLocalBehaviorStatus] = useState<InlineStatus | null>(null);
  const [settingsTransferMessage, setSettingsTransferMessage] = useState('');
  const [collapsedStrategyGroups, setCollapsedStrategyGroups] = useState<Set<string>>(() => new Set());
  const [strategyGroupOrder, setStrategyGroupOrder] = useState<string[]>(readStrategyGroupOrder);
  const [draggingStrategyGroupName, setDraggingStrategyGroupName] = useState<string | null>(null);
  const topologyChartRef = useRef<HTMLDivElement | null>(null);
  const topologyChartInstanceRef = useRef<echarts.EChartsType | null>(null);
  const settingsImportInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    applyBrowserStartup(window.location.hash, window.location.origin, window.location.pathname);
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
    if (Object.keys(patch).length > 0) {
      updateConfig(patch);
    }
  }, [
    config.defaultTestUrl,
    config.delayTestTimeoutMs,
    helper.testingSettings?.defaultTestUrl,
    helper.testingSettings?.delayTestTimeoutMs,
    updateConfig
  ]);

  useEffect(() => {
    helper.groups.forEach((group) => {
      proxies.setGroupTestUrl(group.name, group.config.testUrl);
    });
  }, [helper.groups, proxies.setGroupTestUrl]);

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
    if (!detection?.ok) {
      return;
    }

    void useHelperStore.getState().syncController();
  }, [config.controllerUrl, config.secret, detection?.ok]);

  useEffect(() => {
    if (!detection?.ok) {
      return;
    }

    void runtime.refresh();

    if (activeRoute === 'overview' || activeRoute === 'controller' || activeRoute === 'proxies') {
      void proxies.refresh();
    }

    if (activeRoute === 'controller' || activeRoute === 'proxies') {
      void useHelperStore
        .getState()
        .syncController()
        .then(() => useHelperStore.getState().loadGroups());
    }

    if (activeRoute === 'overview' || activeRoute === 'connections') {
      void connections.refreshConnections();
    }

    if (activeRoute === 'config') {
      void configWorkspace.loadRuntimeConfig();
    }

    if (activeRoute === 'logs') {
      void connections.startLogs();
    }
  }, [activeRoute, detection?.ok]);

  useEffect(() => {
    if (activeRoute !== 'logs' && connections.logStreaming) {
      connections.stopLogs();
    }
  }, [activeRoute, connections.logStreaming, connections.stopLogs]);

  useEffect(() => {
    if (!detection?.ok) {
      return;
    }

    const timer = window.setInterval(() => {
      void runtime.refresh();
      if (activeRoute === 'overview' && !topologyPaused) {
        void connections.refreshConnections();
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [activeRoute, detection?.ok, topologyPaused, runtime.refresh, connections.refreshConnections]);

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
  const orderedStrategyGroups = useMemo(
    () => applyStrategyWallOrder(strategyGroups, strategyGroupOrder),
    [strategyGroupOrder, strategyGroups]
  );
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
  const helperServiceAvailable = Boolean(helper.health?.sqlite && !helper.error);
  const helperActionBusy = Boolean(helperPendingAction) || helper.loading;
  const trafficModuleEnabled = Boolean(helper.trafficSettings?.enabled);
  const helperDefaultTestUrl = helper.testingSettings?.defaultTestUrl ?? config.defaultTestUrl;
  const helperDelayTestTimeoutMs =
    helper.testingSettings?.delayTestTimeoutMs ?? config.delayTestTimeoutMs ?? DEFAULT_DELAY_TEST_TIMEOUT_MS;
  const singBoxRemoteProfileUri = buildSingBoxRemoteProfileUri(configQrUrl, 'SingDeck');
  const configQrUrlNeedsLan = !configQrUrl.trim() || isLoopbackUrl(configQrUrl);
  const helperGroupByName = useMemo(() => new Map(helper.groups.map((group) => [group.name, group])), [helper.groups]);
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
  const activeGroupConfig = activeHelperGroup?.config ?? fallbackGroupConfig(activeGroupTestUrl);
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
    ? activeSelectedScore?.delayMs ??
      proxies.groupDelayResults[activeStrategyGroup.name] ??
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
  const activeGroupBusy = Boolean(
    activeStrategyGroup && (helper.probingGroups.includes(activeStrategyGroup.name) || activeNativeGroupTesting)
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
      !proxies.testingAllNodes
  );
  const strategyWallGroups = useMemo(() => {
    return buildStrategyWallGroups({
      groups: orderedStrategyGroups,
      activeName: activeStrategyGroup?.name ?? null,
      proxyByName,
      query: proxyQuery
    });
  }, [activeStrategyGroup?.name, orderedStrategyGroups, proxyByName, proxyQuery]);
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
    if (activeRoute !== 'overview' || !helperServiceAvailable || !trafficModuleEnabled) {
      return;
    }

    void useHelperStore.getState().loadTraffic();
    const timer = window.setInterval(() => {
      void useHelperStore.getState().loadTraffic();
    }, 5 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, [activeRoute, helperServiceAvailable, trafficModuleEnabled]);

  useEffect(() => {
    if (activeRoute !== 'proxies' || !activeStrategyGroup?.name) {
      return;
    }

    void useHelperStore.getState().loadScores(activeStrategyGroup.name);
  }, [activeRoute, activeStrategyGroup?.name]);

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
    if (activeRoute !== 'overview' || !topologyChartRef.current) {
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
  }, [activeRoute]);

  useEffect(() => {
    const chart = topologyChartInstanceRef.current;
    if (activeRoute !== 'overview' || !chart) {
      return;
    }

    if (topology.nodes.length === 0) {
      chart.clear();
      return;
    }

    chart.setOption(buildSankeyOption(topology), true);
  }, [activeRoute, topology]);

  const runHelperAction = async (action: string, pendingText: string, work: () => Promise<InlineStatus>) => {
    setHelperPendingAction(action);
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
      await useHelperStore.getState().syncController();
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

  const handleConfigFileLoad = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file) {
      return;
    }

    void file.text().then((content) => configWorkspace.loadConfigFile(content, `file:${file.name}`));
  };

  const saveGroupConfigFor = (groupName: string, currentConfig: HelperGroupConfig, patch: Partial<HelperGroupConfig>) => {
    const hasTestUrlPatch = Object.prototype.hasOwnProperty.call(patch, 'testUrl');
    const nextConfig: HelperGroupConfig = {
      ...currentConfig,
      ...patch,
      testUrl: ((patch.testUrl ?? currentConfig.testUrl) || helperDefaultTestUrl).trim() || helperDefaultTestUrl,
      testUrlOverridden: patch.testUrlOverridden ?? (hasTestUrlPatch ? true : currentConfig.testUrlOverridden)
    };
    proxies.setGroupTestUrl(groupName, nextConfig.testUrl);
    void helper.saveGroupConfig(groupName, nextConfig);
  };

  const runGroupProbe = async (group: ProxyRecord | null) => {
    if (!group || !helperServiceAvailable) {
      return;
    }

    await useHelperStore.getState().probeGroup(group.name, config.delayTestConcurrency ?? 4);
  };

  const runGroupDelayOrProbe = async (group: ProxyRecord | null) => {
    if (!group) {
      return;
    }

    const helperGroup = helperGroupByName.get(group.name);
    const rowConfig = helperGroup?.config ?? fallbackGroupConfig(proxies.groupTestUrls[group.name] || helperDefaultTestUrl);
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

  const openConfigQr = async () => {
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
  };

  const copyConfigQrUrl = async () => {
    if (!configQrUrl.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(configQrUrl);
      setConfigQrCopied(true);
      window.setTimeout(() => setConfigQrCopied(false), 1400);
    } catch {
      setConfigQrCopied(false);
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
    setSettingsTransferMessage('Exported current settings.');
  };

  const importSettingsFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';

    if (!file) {
      return;
    }

    try {
      const backup = parseSettingsBackup(await file.text());
      updateConfig(backup.controller.config);
      useControllerStore.setState({ urlSecretWarning: backup.controller.urlSecretWarning });
      helper.updateSettings({
        helperUrl: backup.helper.helperUrl,
        configPath: backup.helper.configPath
      });
      if (backup.helper.testingSettings?.defaultTestUrl) {
        setTestingDefaultUrlDraft(backup.helper.testingSettings.defaultTestUrl);
        await helper.saveDefaultTestUrl(backup.helper.testingSettings.defaultTestUrl);
      }
      if (backup.helper.trafficSettings) {
        setTrafficProfileDraft(backup.helper.trafficSettings.browserProfile);
        await helper.saveTrafficSettings(backup.helper.trafficSettings);
      }
      for (const [group, url] of Object.entries(backup.proxies.groupTestUrls)) {
        proxies.setGroupTestUrl(group, url);
      }
      for (const [node, url] of Object.entries(backup.proxies.nodeTestUrls)) {
        proxies.setNodeTestUrl(node, url);
      }
      for (const group of backup.helper.groupConfigs) {
        await helper.saveGroupConfig(group.name, group.config);
      }
      useConfigStore.setState({
        content: backup.configWorkspace.content,
        issues: backup.configWorkspace.issues,
        snapshots: backup.configWorkspace.snapshots,
        sourceEndpoint: backup.configWorkspace.sourceEndpoint,
        lastLoadedAt: backup.configWorkspace.lastLoadedAt,
        error: null
      });
      setRailExpanded(backup.ui.railExpanded);
      setStrategyGroupOrder(backup.ui.strategyGroupOrder ?? []);
      setSettingsTransferMessage(`Imported ${backup.helper.groupConfigs.length} group configs.`);
      void helper.loadGroups();
      void proxies.refresh();
    } catch (error) {
      setSettingsTransferMessage(error instanceof Error ? error.message : 'Import failed.');
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

  const moveStrategyGroupBefore = (sourceName: string, targetName: string) => {
    setStrategyGroupOrder((current) =>
      moveStrategyWallGroupOrder(
        current,
        sourceName,
        targetName,
        strategyGroups.map((group) => group.name)
      )
    );
  };

  const handleStrategyGroupDragStart = (event: DragEvent<HTMLElement>, groupName: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', groupName);
    setDraggingStrategyGroupName(groupName);
  };

  const handleStrategyGroupDrop = (event: DragEvent<HTMLElement>, targetName: string) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceName = event.dataTransfer.getData('text/plain') || draggingStrategyGroupName;
    if (sourceName && sourceName !== targetName) {
      moveStrategyGroupBefore(sourceName, targetName);
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
              className="ghost-action qr-action"
              disabled={!helperServiceAvailable}
              onClick={() => void openConfigQr()}
              type="button"
            >
              <QrCode size={14} />
              Config QR
            </button>
            <span className={`status-chip ${detection?.ok ? 'ok' : 'warn'}`}>
              <Wifi size={14} />
              {detection?.ok ? 'API authenticated' : 'API pending'}
            </span>
            <span className={`status-chip ${helperServiceAvailable ? 'ok' : 'warn'}`}>
              <Wifi size={14} />
              {helperServiceAvailable ? 'Helper ready' : 'Helper offline'}
            </span>
          </div>
        </header>

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
                  <span>{configQrUrlNeedsLan ? 'LAN helper URL required' : 'Remote profile import'}</span>
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
                <div className={`qr-code-box ${configQrUrlNeedsLan ? 'blocked' : ''}`}>
                  {configQrUrlNeedsLan ? (
                    <span className="qr-code-hint">LAN helper URL required</span>
                  ) : configQrDataUrl ? (
                    <img src={configQrDataUrl} alt="sing-box config download QR" />
                  ) : (
                    <span className="qr-code-hint">Generating...</span>
                  )}
                </div>
                <div className="qr-meta">
                  <div className={`qr-state ${configQrUrlNeedsLan ? 'warn' : 'ok'}`}>
                    <span aria-hidden="true" />
                    {configQrUrlNeedsLan ? 'Needs LAN URL' : 'Ready to scan'}
                  </div>
                  <label className="qr-url-field">
                    <span>Download URL</span>
                    <input value={configQrUrl} onChange={(event) => setConfigQrUrl(event.target.value)} />
                    {configQrUrlNeedsLan ? <small>Use the helper machine LAN address or SINGDECK_HELPER_PUBLIC_URL.</small> : null}
                  </label>
                  <button
                    className="ghost-action compact-icon-action qr-copy"
                    disabled={!configQrUrl.trim()}
                    onClick={() => void copyConfigQrUrl()}
                    type="button"
                  >
                    <Copy size={14} />
                    {configQrCopied ? 'Copied' : 'Copy URL'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        {activeRoute === 'overview' ? (
          <>
        <section className="topology-panel" aria-label="Connection topology">
          <div className="panel-heading compact">
            <div>
              <h2>连接拓扑</h2>
              <span className="panel-stamp">source {'->'} rule {'->'} route/group {'->'} outbound</span>
            </div>
            <span className="panel-stamp">{topology.total} active connections</span>
          </div>
          <div className="topology-stage">
            {topology.links.length === 0 ? (
              <div className="topology-empty">No active topology.</div>
            ) : null}
            <div className="topology-chart" ref={topologyChartRef} />
          </div>
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
              <div className="traffic-provider-empty">Helper offline. Browser-backed provider traffic is unavailable.</div>
            ) : helper.traffic?.providers.length ? (
              <div className="traffic-provider-list">
                {helper.traffic.providers.map((provider) => {
                  const summary = summarizeTrafficProvider(provider);
                  const ratio = Math.min(100, Math.max(0, provider.usedRatio ?? 0));
                  return (
                    <div className={`traffic-provider-row ${provider.error ? 'error' : ''}`} key={provider.id}>
                      <div className="traffic-provider-title">
                        <strong>{provider.name}</strong>
                        <span>{provider.error ?? provider.planName ?? 'plan pending'}</span>
                      </div>
                      <div className="traffic-provider-meter" aria-label={`${provider.name} traffic usage`}>
                        <span style={{ width: `${ratio}%` }} />
                      </div>
                      <div className="traffic-provider-meta">
                        <span>{summary.used} / {summary.total}</span>
                        <span>{summary.remaining} left</span>
                        <span>{summary.expires}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="traffic-provider-empty">
                {helper.trafficError ?? 'Provider traffic has not been synced yet.'}
              </div>
            )}
          </article>
          ) : null}
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
            <div className="settings-stack">
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
                  <label>
                    <span>Chrome profile</span>
                    <input
                      placeholder="/home/user/.config/google-chrome/Default"
                      value={trafficProfileDraft}
                      onChange={(event) => setTrafficProfileDraft(event.target.value)}
                    />
                    <small>Use the desktop Chrome profile that contains Cookies and Local Storage.</small>
                  </label>
                  <div className="helper-actions">
                    <button
                      className="ghost-action"
                      disabled={helperActionBusy}
                      onClick={() => void checkHelperWithFeedback()}
                      type="button"
                    >
                      {helperPendingAction === 'check' ? 'Checking...' : 'Check helper'}
                    </button>
                    <button
                      className="ghost-action"
                      disabled={helperActionBusy}
                      onClick={() => void syncControllerWithFeedback()}
                      type="button"
                    >
                      {helperPendingAction === 'sync' ? 'Syncing...' : 'Sync controller'}
                    </button>
                    <button
                      className="ghost-action"
                      disabled={helperActionBusy}
                      onClick={() => void saveConfigPathWithFeedback()}
                      type="button"
                    >
                      {helperPendingAction === 'config' ? 'Saving...' : 'Save config'}
                    </button>
                    <button
                      className="ghost-action"
                      disabled={helperActionBusy}
                      onClick={() => void saveTrafficWithFeedback(trafficModuleEnabled, trafficProfileDraft)}
                      type="button"
                    >
                      {helperPendingAction === 'traffic' ? 'Saving...' : 'Save traffic'}
                    </button>
                  </div>
                </div>
                {helperActionStatus ? (
                  <div className={`settings-inline-status ${helperActionStatus.tone}`}>
                    {helperActionStatus.text}
                  </div>
                ) : null}
                <div className="settings-note-grid compact-health">
                  {healthRow('SQLite', helper.health?.sqlite ? 'ready' : helper.error ? 'issue' : 'idle', helper.health?.sqlite ? 'ok' : helper.error ? 'warn' : 'neutral')}
                  {healthRow(
                    'Controller',
                    helper.health?.controllerReachable ? 'reachable' : helper.health?.controllerConfigured ? 'configured' : 'empty',
                    helper.health?.controllerReachable ? 'ok' : 'warn'
                  )}
                </div>
                {helper.error ? <div className="settings-inline-error">{helper.error}</div> : null}
              </article>
            </div>

            <div className="settings-stack">
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
                      value={form.delayTestConcurrency ?? 4}
                      onChange={(event) =>
                        setForm({ ...form, delayTestConcurrency: Number.parseInt(event.target.value, 10) || 1 })
                      }
                    />
                  </label>
                  <label>
                    <span>Timeout ms</span>
                    <input
                      max={60000}
                      min={500}
                      step={500}
                      type="number"
                      value={form.delayTestTimeoutMs ?? helperDelayTestTimeoutMs}
                      onBlur={(event) => {
                        const timeout = Number.parseInt(event.currentTarget.value, 10) || DEFAULT_DELAY_TEST_TIMEOUT_MS;
                        updateConfig({ delayTestTimeoutMs: timeout });
                        if (helperServiceAvailable) {
                          void helper.saveDelayTestTimeout(timeout);
                        }
                      }}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          delayTestTimeoutMs: Number.parseInt(event.target.value, 10) || DEFAULT_DELAY_TEST_TIMEOUT_MS
                        })
                      }
                    />
                  </label>
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
                <input
                  accept="application/json,.json"
                  hidden
                  onChange={importSettingsFile}
                  ref={settingsImportInputRef}
                  type="file"
                />
                {settingsTransferMessage ? (
                  <div className="settings-inline-status ok">{settingsTransferMessage}</div>
                ) : null}
              </article>
            </div>

            <article className="settings-card">
              <div className="settings-card-head">
                <h3>Per-group test URLs</h3>
                <span>not per node</span>
              </div>
              <div className="compact-form">
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
                            probeIntervalSec: existing?.probeIntervalSec ?? 15 * 60
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

            <article className="settings-card settings-wide">
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
              </div>
              <div className="settings-scope-note">
                Saves controller URL, secret, note, test worker count, and test timeout in browser storage. If helper is ready, the timeout is mirrored to helper.
              </div>
              <div className="settings-save-row">
                {localBehaviorStatus ? (
                  <div className={`settings-inline-status ${localBehaviorStatus.tone}`}>
                    {localBehaviorStatus.text}
                  </div>
                ) : null}
                <button className="primary-action form-action" disabled={detecting} type="submit">
                  {detecting ? 'Saving...' : 'Save controller settings'}
                </button>
              </div>
            </article>
          </form>

          {detection && !detection.ok ? (
            <div className="diagnostic-card">
              <strong>{detection.failure.title}</strong>
              <span>{detection.failure.detail}</span>
            </div>
          ) : null}
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

          {proxies.error ? <div className="proxy-error" title={proxies.error}>{proxies.error}</div> : null}

          <section className="proxy-control-layout" aria-label="Proxy strategy workspace">
            <div className="proxy-board">
              <div className="proxy-board-toolbar">
                <div className="proxy-board-title">
                  <span>Strategy wall</span>
                  <strong>{strategyWallGroups.length} / {strategyGroups.length} groups</strong>
                </div>
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
                  <span className={`status-chip ${helperServiceAvailable ? 'ok' : 'bad'}`}>
                    Helper {helperServiceAvailable ? 'ready' : 'offline'}
                  </span>
                  <span className="status-chip neutral">parallel {config.delayTestConcurrency ?? 4}</span>
                </div>
              </div>

              <div className="strategy-wall" aria-label="Strategy groups">
                {strategyWallGroups.length === 0 ? <span className="selector-empty">No strategy groups match the current search.</span> : null}
                {strategyWallColumns.map((column, columnIndex) => (
                  <div className="strategy-wall-column" key={`strategy-column-${columnIndex}`}>
                    {column.map((proxy) => {
                  const selectedProxy = proxyByName.get(proxy.now);
                  const selectedDelay = proxyDelayByName.get(proxy.now) ?? proxy.delay;
                  const helperGroup = helperGroupByName.get(proxy.name);
                  const rowConfig = helperGroup?.config ?? fallbackGroupConfig(proxies.groupTestUrls[proxy.name] || helperDefaultTestUrl);
                  const execution = resolveProbeExecution(proxy, rowConfig.mode);
                  const groupScores = helper.scoresByGroup[proxy.name]?.nodes ?? [];
                  const groupScoreByName = new Map(groupScores.map((score) => [score.name, score]));
                  const selectedScore = execution.mode !== 'native-urltest' ? groupScoreByName.get(proxy.now) : undefined;
                  const selectedDelayValue = selectedScore?.delayMs ?? proxies.groupDelayResults[proxy.name] ?? selectedDelay;
                  const selectedScoreTone = selectedScore ? nodeScoreTone(selectedScore, selectedDelay) : 'none';
                  const selectedDelayTone = delayTone(selectedDelayValue);
                  const isProbing = helper.probingGroups.includes(proxy.name);
                  const isNativeTesting = execution.mode === 'native-urltest' && proxies.testingProxies.includes(proxy.name);
                  const isActive = activeStrategyGroup?.name === proxy.name;
                  const isCollapsed = collapsedStrategyGroups.has(proxy.name);
                  const canAutoSwitch = isSelectableProxyGroup(proxy) && !execution.autoSwitchManagedBySingBox;
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
                      className={`strategy-group-card ${isActive ? 'selected' : ''} ${isActive ? 'featured' : ''} ${isCollapsed ? 'collapsed' : ''} ${draggingStrategyGroupName === proxy.name ? 'dragging' : ''} ${rowActivity?.className ?? ''}`}
                      draggable
                      key={proxy.name}
                      onDragEnd={() => setDraggingStrategyGroupName(null)}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                      }}
                      onDragStart={(event) => handleStrategyGroupDragStart(event, proxy.name)}
                      onDrop={(event) => handleStrategyGroupDrop(event, proxy.name)}
                      onClick={() => setActiveStrategyGroupName(proxy.name)}
                    >
                      <div
                        className="strategy-card-head"
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
                          <span>{proxy.type} · {proxy.all.length} nodes</span>
                        </div>
                        <div className="strategy-card-current">
                          <span>Current</span>
                          <strong>{proxy.now || '--'}</strong>
                          <small>{selectedProxy?.type ?? 'unknown'}</small>
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
                              {isProbing ? '...' : formatNodeScore(selectedScore, selectedDelay)}
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
                          const isTesting = proxies.testingProxies.includes(member.name);
                          const canSelect = isSelectableProxyGroup(proxy);
                          const score = execution.mode === 'helper-score' ? groupScoreByName.get(member.name) : undefined;
                          const displayDelay = proxyDelayByName.get(member.name) ?? member.delay;
                          const nodeDelay = score?.delayMs ?? displayDelay;
                          const scoreTone = score ? nodeScoreTone(score, displayDelay) : 'none';
                          const nodeDelayTone = delayTone(nodeDelay);
                          const cardTone = rowConfig.mode === 'score' && score ? scoreTone : nodeDelayTone;
                          const nodeActivity = describeProbeActivity({
                            mode: rowConfig.mode,
                            groupProbing: isProbing || isNativeTesting,
                            nodeTesting: isTesting
                          });
                          const isScoring = nodeActivity?.kind === 'scoring';

                          return (
                            <article
                              aria-busy={nodeActivity ? true : undefined}
                              aria-disabled={!canSelect || isCurrent}
                              className={`strategy-node-card strategy-node-tile ${cardTone} ${isCurrent ? 'active' : ''} ${nodeActivity?.className ?? ''}`}
                              key={member.name}
                              onClick={() => {
                                if (canSelect && !isCurrent) {
                                  void proxies.switchProxy(proxy.name, member.name);
                                }
                              }}
                            >
                              <div className="node-line">
                                <div className="node-name">
                                  <strong>{member.name}</strong>
                                  <span>{member.type} / {proxy.name}</span>
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
                                  {isTesting ? '...' : formatDelay(nodeDelay)}
                                </button>
                              </div>
                              <div className="node-foot">
                                <span className="node-meta">
                                  {rowConfig.mode === 'score' ? (
                                    <span
                                      className={`score-mark ${scoreTone} ${isScoring ? 'testing' : ''}`}
                                      title={
                                        score
                                          ? `${formatScoreTooltip(score)}${score.delayMs !== null ? ` / ${score.delayMs}ms` : ''}`
                                          : undefined
                                      }
                                    >
                                      {isScoring ? '...' : formatNodeScore(score, displayDelay)}
                                    </span>
                                  ) : (
                                    <span className={`node-status-dot ${nodeDelayTone}`} />
                                  )}
                                  <span>{score?.lastTestedAt ? new Date(score.lastTestedAt).toLocaleTimeString() : member.type}</span>
                                </span>
                                <span className={`tag ${isCurrent ? 'ok' : ''}`}>{isCurrent ? 'active' : 'standby'}</span>
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
                      <div>
                        <strong>{activeInspectorModel.name}</strong>
                        <span>{activeInspectorModel.type} · {activeInspectorModel.membersLabel}</span>
                      </div>
                      <span className={`mode-chip ${activeGroupConfig.mode === 'delay' ? 'delay' : ''}`}>
                        {activeGroupConfig.mode}
                      </span>
                    </div>
                    <div className="inspector-subtitle">Selected strategy group configuration</div>
                  </div>

                  <div className="inspector-summary">
                    <div className="mini-stat"><span>Current</span><strong>{activeInspectorModel.current}</strong></div>
                    <div className="mini-stat"><span>Metric</span><strong>{activeInspectorModel.metricLabel}</strong></div>
                    <div className="mini-stat"><span>Switch</span><strong>{activeInspectorModel.autoSwitchLabel}</strong></div>
                    <div className="mini-stat"><span>Schedule</span><strong>{activeInspectorModel.scheduleLabel}</strong></div>
                  </div>

                  {!helperServiceAvailable ? (
                    <div className="inspector-warning">
                      Helper service is offline. Score, helper delay, schedule, and URL settings are disabled.
                    </div>
                  ) : null}
                  {activeHelperScores?.applyError ? (
                    <div className="inspector-warning bad">{activeHelperScores.applyError}</div>
                  ) : null}

                  <form className="inspector-form" onSubmit={(event) => event.preventDefault()}>
                    <label className="inspector-field">
                      <span>Selection basis</span>
                      <div className="policy-segment large" aria-label={`${activeStrategyGroup.name} selection basis`}>
                        <button
                          className={activeGroupConfig.mode === 'score' ? 'active' : ''}
                          disabled={!helperServiceAvailable}
                          onClick={() => saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { mode: 'score' })}
                          type="button"
                        >
                          Score
                        </button>
                        <button
                          className={activeGroupConfig.mode === 'delay' ? 'active' : ''}
                          disabled={!helperServiceAvailable}
                          onClick={() => saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, { mode: 'delay' })}
                          type="button"
                        >
                          Delay
                        </button>
                      </div>
                    </label>

                    <label className="inspector-field">
                      <span>Score scheme</span>
                      <select
                        disabled={!activeInspectorModel.canEditScheme}
                        value={activeGroupConfig.scheme}
                        onChange={(event) =>
                          saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                            scheme: event.target.value as ScoreScheme
                          })
                        }
                      >
                        <option value="Balanced">Balanced</option>
                        <option value="LatencyFirst">Latency</option>
                      </select>
                    </label>

                    <label className="inspector-field">
                      <span>Test URL</span>
                      <input
                        disabled={!helperServiceAvailable || activeProbeExecution?.mode === 'native-urltest'}
                        value={
                          activeProbeExecution?.mode === 'native-urltest'
                            ? 'sing-box urltest.url'
                            : activeGroupConfig.testUrl
                        }
                        onChange={(event) =>
                          saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                            testUrl: event.target.value
                          })
                        }
                      />
                    </label>

                    <div className="inspector-field">
                      <span>Automation</span>
                      <div className="inspector-automation-grid">
                        {activeInspectorModel.autoSwitchManagedBySingBox ? (
                          <div className="automation-option disabled">
                            <span className="automation-switch on" aria-hidden="true" />
                            <span>
                              <strong>sing-box switch</strong>
                              <small>Managed by native URLTest</small>
                            </span>
                          </div>
                        ) : (
                          <label className={`automation-option ${activeGroupConfig.autoSwitch && activeInspectorModel.canAutoSwitch ? 'on' : ''}`}>
                            <input
                              checked={activeGroupConfig.autoSwitch && activeInspectorModel.canAutoSwitch}
                              disabled={!activeInspectorModel.canAutoSwitch}
                              type="checkbox"
                              onChange={(event) =>
                                saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                  autoSwitch: event.target.checked
                                })
                              }
                            />
                            <span className="automation-switch" aria-hidden="true" />
                            <span>
                              <strong>Auto switch</strong>
                              <small>Apply the best node after probing</small>
                            </span>
                          </label>
                        )}
                        <label className={`automation-option ${activeGroupConfig.autoProbe && activeInspectorModel.canSchedule ? 'on' : ''}`}>
                          <input
                            checked={activeGroupConfig.autoProbe && activeInspectorModel.canSchedule}
                            disabled={!activeInspectorModel.canSchedule}
                            type="checkbox"
                            onChange={(event) =>
                              saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                                autoProbe: event.target.checked
                              })
                            }
                          />
                          <span className="automation-switch" aria-hidden="true" />
                          <span>
                            <strong>Schedule</strong>
                            <small>Run this group by interval</small>
                          </span>
                        </label>
                      </div>
                    </div>

                    <label className="inspector-field">
                      <span>Probe interval minutes</span>
                      <input
                        disabled={!activeInspectorModel.canSchedule || !activeGroupConfig.autoProbe}
                        max={1440}
                        min={1}
                        type="number"
                        value={activeInspectorModel.intervalMinutes}
                        onChange={(event) =>
                          saveGroupConfigFor(activeStrategyGroup.name, activeGroupConfig, {
                            probeIntervalSec: (Number.parseInt(event.target.value, 10) || 1) * 60
                          })
                        }
                      />
                    </label>

                    <label className="inspector-field">
                      <span>Parallel requests</span>
                      <input
                        disabled={!helperServiceAvailable}
                        max={64}
                        min={1}
                        type="number"
                        value={config.delayTestConcurrency ?? 4}
                        onChange={(event) =>
                          updateConfig({
                            delayTestConcurrency: Number.parseInt(event.target.value, 10) || 1
                          })
                        }
                      />
                    </label>
                  </form>

                  <div className="inspector-actions">
                    <button className="primary-action" disabled={!activeCanRunProbe} onClick={runActiveGroupProbe} type="button">
                      {activeGroupActivity
                        ? activeGroupConfig.mode === 'score'
                          ? 'Scoring...'
                          : 'Testing...'
                        : activeInspectorModel.runLabel}
                    </button>
                    <button
                      className="ghost-action"
                      onClick={() => {
                        void proxies.refresh();
                        void useHelperStore.getState().loadGroups();
                      }}
                      type="button"
                    >
                      Refresh data
                    </button>
                  </div>
                </>
              ) : (
                <div className="inspector-empty">No strategy group is available.</div>
              )}
            </aside>
          </section>
        </section>
        ) : null}

        {activeRoute === 'connections' ? (
        <section className="page-fill">
          <article className="connections-panel fill-panel" id="connections">
            <div className="panel-heading compact">
              <div>
                <h2>Live sessions</h2>
                <span className="panel-stamp">{connections.connections.length} active rows</span>
              </div>
              <div className="compact-actions">
                <button className="ghost-action" onClick={connections.refreshConnections}>
                  Refresh
                </button>
                <button className="ghost-action danger" onClick={connections.closeAllConnections}>
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
            <div className="connection-list">
              {connections.connections
                .filter((connection) =>
                  `${connection.target} ${connection.rule} ${connection.outbound}`
                    .toLowerCase()
                    .includes(connections.query.toLowerCase())
                )
                .map((connection) => (
                  <div className="connection-row" key={connection.id}>
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
                    <button className="ghost-action danger" onClick={() => void connections.closeConnection(connection.id)}>
                      Drop
                    </button>
                  </div>
                ))}
            </div>
          </article>
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
            <div className="log-list">
              {connections.logs
                .filter((log) => connections.logLevel === 'all' || log.level === connections.logLevel)
                .filter((log) => log.message.toLowerCase().includes(connections.logQuery.toLowerCase()))
                .map((log, index) => (
                  <div className={`log-row ${log.level}`} key={`${log.message}-${index}`}>
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
