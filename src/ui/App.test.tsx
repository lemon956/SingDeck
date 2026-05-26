import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useControllerStore } from '../state/controllerStore';
import { useConnectionStore } from '../state/connectionStore';
import { useHelperStore } from '../state/helperStore';
import { useProxyStore } from '../state/proxyStore';
import { App } from './App';

const groupConfig = {
  testUrl: 'https://latency.example.test/generate_204',
  testUrlOverridden: false,
  mode: 'score' as const,
  scheme: 'Balanced' as const,
  autoSwitch: false,
  autoProbe: false,
  probeIntervalSec: 600
};

function setupProxyWorkspace() {
  window.location.hash = '#/proxies';
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ nodes: [] }), { status: 200 }))
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  useControllerStore.setState({
    config: {
      controllerUrl: '',
      secret: '',
      defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
      delayTestConcurrency: 4,
      delayTestTimeoutMs: 5000
    },
    detection: null,
    detecting: false,
    lastCheckedAt: null,
    urlSecretWarning: false
  });
  useProxyStore.setState({
    proxies: [
      { name: 'select', type: 'Selector', now: 'hk-1', all: ['hk-1', 'jp-1'], delay: 88 },
      { name: 'hk-1', type: 'Trojan', now: '', all: [], delay: 48 },
      { name: 'jp-1', type: 'Trojan', now: '', all: [], delay: 212 }
    ],
    query: '',
    groupTestUrls: {},
    nodeTestUrls: {},
    groupDelayResults: {},
    optimisticSelections: {},
    switchingGroups: [],
    testingProxies: [],
    testingAllNodes: false,
    loading: false,
    error: null,
    lastUpdatedAt: null
  });
  useHelperStore.setState({
    helperUrl: 'http://127.0.0.1:9531',
    configPath: '',
    health: { ok: true, version: '0.1.0', sqlite: true, controllerConfigured: true, controllerReachable: true, mobileConfigUrl: null, error: null },
    testingSettings: null,
    trafficSettings: null,
    groups: [
      {
        name: 'select',
        kind: 'Selector',
        now: 'hk-1',
        all: ['hk-1', 'jp-1'],
        config: groupConfig,
        recommended: null,
        applyError: null
      }
    ],
    nodeSources: [],
    scoresByGroup: {
      select: {
        group: 'select',
        mode: 'score',
        scheme: 'Balanced',
        testUrl: groupConfig.testUrl,
        recommended: null,
        applyError: null,
        nodes: [
          {
            name: 'hk-1',
            score: 92,
            delayMs: 48,
            components: { latency: 100, availability: 100, jitter: 100, freshness: 100 },
            lastTestedAt: null,
            error: null,
            raw: {
              success: true,
              delayMs: 48,
              error: null,
              testedAt: null,
              sampleCount: 3,
              successCount: 3,
              failureCount: 0,
              sampleWindowSec: 5400,
              confidence: 0.6,
              latencyDelayMs: 48,
              latencyP50Ms: 48,
              latencyP90Ms: 52,
              jitterP50Ms: 48,
              jitterP95Ms: 52,
              jitterMs: 4,
              freshnessAgeMs: 1200,
              freshnessState: 'fresh',
              gateReason: 'none',
              mode: 'score',
              scheme: 'Balanced',
              weights: { latency: 0.3, availability: 0.6, jitter: 0.1, freshness: 0 }
            }
          },
          {
            name: 'jp-1',
            score: 61,
            delayMs: 212,
            components: { latency: 70, availability: 100, jitter: 60, freshness: 100 },
            lastTestedAt: null,
            error: null,
            raw: {
              success: true,
              delayMs: 212,
              error: null,
              testedAt: null,
              sampleCount: 2,
              successCount: 2,
              failureCount: 0,
              sampleWindowSec: 5400,
              confidence: 0.4,
              latencyDelayMs: 212,
              latencyP50Ms: 180,
              latencyP90Ms: 212,
              jitterP50Ms: 180,
              jitterP95Ms: 212,
              jitterMs: 32,
              freshnessAgeMs: 2400,
              freshnessState: 'fresh',
              gateReason: 'none',
              mode: 'score',
              scheme: 'Balanced',
              weights: { latency: 0.3, availability: 0.6, jitter: 0.1, freshness: 0 }
            }
          }
        ]
      }
    },
    traffic: null,
    trafficLoading: false,
    trafficError: null,
    networkUsageSettings: { enabled: false, retentionDays: 7 },
    networkUsageSummary: null,
    networkUsageTopHosts: null,
    networkUsageTopOutbounds: null,
    networkUsageConnections: null,
    networkUsageLoading: false,
    networkUsageError: null,
    loading: false,
    activeProbeGroups: [],
    activeProbeNodesByGroup: {},
    eventStreamConnected: false,
    probingGroups: [],
    applyingGroups: [],
    error: null,
    lastCheckedAt: null,
    lastSyncedControllerKey: null
  });
}

function setScoreTimes(times: { hk?: string | null; jp?: string | null }) {
  useHelperStore.setState((state) => ({
    scoresByGroup: {
      ...state.scoresByGroup,
      select: {
        ...state.scoresByGroup.select,
        nodes: state.scoresByGroup.select.nodes.map((node) =>
          node.name === 'hk-1'
            ? { ...node, lastTestedAt: times.hk ?? null }
            : node.name === 'jp-1'
              ? { ...node, lastTestedAt: times.jp ?? null }
              : node
        )
      }
    }
  }));
}

function expandStrategyWall() {
  fireEvent.click(screen.getByRole('button', { name: /Expand all strategy groups/i }));
}

describe('App proxy workspace', () => {
  beforeEach(() => {
    setupProxyWorkspace();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows node delay without active or standby status labels', () => {
    const { container } = render(<App />);
    expandStrategyWall();

    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card'));

    expect(nodeCards).toHaveLength(2);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('48ms'))).toBe(true);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('212ms'))).toBe(true);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('active'))).toBe(false);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('standby'))).toBe(false);
  });

  it('starts with strategy groups collapsed and supports expanding or collapsing all groups', () => {
    const { container } = render(<App />);

    expect(container.querySelectorAll('.strategy-node-card')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Expand all strategy groups/i }));
    expect(container.querySelectorAll('.strategy-node-card')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Collapse all strategy groups/i }));
    expect(container.querySelectorAll('.strategy-node-card')).toHaveLength(0);
  });

  it('updates the inspector mode immediately while helper config save is pending', () => {
    useHelperStore.setState({
      saveGroupConfig: vi.fn(() => new Promise<void>(() => {}))
    });

    render(<App />);

    const delayModeButton = screen.getByRole('button', { name: 'Delay' });
    fireEvent.click(delayModeButton);

    expect(delayModeButton).toHaveClass('active');
  });

  it('saves the current inspector draft when the save settings button is clicked', async () => {
    const saveGroupConfig = vi.fn(async () => {});
    useHelperStore.setState({ saveGroupConfig });

    render(<App />);

    fireEvent.change(screen.getByLabelText('Test URL'), {
      target: { value: 'https://api.example.test/generate_204' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() =>
      expect(saveGroupConfig).toHaveBeenCalledWith(
        'select',
        expect.objectContaining({
          testUrl: 'https://api.example.test/generate_204',
          probeIntervalSec: 600
        })
      )
    );
  });

  it('opens the config QR dialog immediately while helper refresh is pending', () => {
    useHelperStore.setState({
      saveConfigPath: vi.fn(() => new Promise<void>(() => {})),
      checkHealth: vi.fn(async () => {})
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Config QR' }));

    expect(screen.getByRole('dialog', { name: 'Config QR code' })).toBeInTheDocument();
    expect(screen.getAllByText('Preparing URL').length).toBeGreaterThan(0);
  });

  it('shows helper checking before the first helper health result', () => {
    useHelperStore.setState({
      health: null,
      error: null,
      lastCheckedAt: null,
      loading: false
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/v1/health')) {
          return new Promise<Response>(() => {});
        }
        return new Response('not found', { status: 404 });
      })
    );

    render(<App />);

    expect(screen.getAllByText('Helper checking').length).toBeGreaterThan(0);
    expect(screen.queryByText('Helper offline')).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking helper service/i)).not.toBeInTheDocument();
  });

  it('loads helper groups and scores after a refresh starts with unknown helper health', async () => {
    const requests: string[] = [];
    useHelperStore.setState({
      health: null,
      testingSettings: null,
      trafficSettings: null,
      networkUsageSettings: null,
      groups: [],
      scoresByGroup: {},
      error: null,
      lastCheckedAt: null,
      loading: false
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/api/v1/health')) {
          return new Response(
            JSON.stringify({
              ok: true,
              version: '0.1.0',
              sqlite: true,
              controllerConfigured: true,
              controllerReachable: true,
              mobileConfigUrl: null,
              error: null
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/settings/testing')) {
          return new Response(
            JSON.stringify({
              defaultTestUrl: groupConfig.testUrl,
              delayTestTimeoutMs: 5000,
              minProbeIntervalSec: 60,
              probeConcurrency: 4
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/settings/traffic')) {
          return new Response(JSON.stringify({ enabled: false, browserProfile: '' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.endsWith('/api/v1/settings/network-usage')) {
          return new Response(JSON.stringify({ enabled: false, retentionDays: 7 }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.endsWith('/api/v1/groups')) {
          return new Response(
            JSON.stringify({
              groups: [
                {
                  name: 'select',
                  kind: 'Selector',
                  now: 'hk-1',
                  all: ['hk-1', 'jp-1'],
                  config: groupConfig,
                  recommended: 'hk-1',
                  applyError: null
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/groups/select/scores')) {
          return new Response(
            JSON.stringify({
              group: 'select',
              mode: 'score',
              scheme: 'Balanced',
              testUrl: groupConfig.testUrl,
              recommended: 'hk-1',
              applyError: null,
              nodes: [
                {
                  name: 'hk-1',
                  score: 93,
                  delayMs: 44,
                  components: { latency: 100, availability: 100, jitter: 100, freshness: 100 },
                  lastTestedAt: '2026-05-22T08:00:00.000Z',
                  error: null
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('not found', { status: 404 });
      })
    );

    render(<App />);

    await waitFor(() => expect(requests.some((url) => url.endsWith('/api/v1/groups/select/scores'))).toBe(true));
    await waitFor(() => expect(screen.getAllByText('93').length).toBeGreaterThan(0));
  });

  it('falls back to controller delay while helper scores are not loaded yet', () => {
    useHelperStore.setState({ scoresByGroup: {} });

    const { container } = render(<App />);
    expandStrategyWall();
    const scoreMarks = Array.from(container.querySelectorAll('.score-mark'));
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card')) as HTMLElement[];
    const hkNode = nodeCards.find((node) => within(node).queryByText('hk-1')) as HTMLElement;
    const jpNode = nodeCards.find((node) => within(node).queryByText('jp-1')) as HTMLElement;

    expect(scoreMarks.map((mark) => mark.textContent)).toEqual(['--', '--']);
    expect(within(hkNode).getByRole('button', { name: /Test hk-1 delay/i })).toHaveTextContent('48ms');
    expect(within(jpNode).getByRole('button', { name: /Test jp-1 delay/i })).toHaveTextContent('212ms');
  });

  it('filters strategy wall node display by selected node source', () => {
    useHelperStore.setState({
      nodeSources: [
        {
          name: 'provider-hk',
          url: 'https://example.com/sub',
          associate: true,
          lastSyncedAt: '2026-05-25T10:00:00+08:00',
          lastError: null,
          nodeCount: 1,
          nodes: ['hk-1']
        }
      ]
    });

    const { container } = render(<App />);
    const sourceSelect = screen.getByLabelText('Filter nodes by source');
    fireEvent.change(sourceSelect, { target: { value: 'provider-hk' } });

    const wall = screen.getByLabelText('Strategy groups');
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card')) as HTMLElement[];

    expect(within(wall).getAllByText('hk-1').length).toBeGreaterThan(0);
    expect(nodeCards.some((node) => within(node).queryByText('jp-1'))).toBe(false);
  });

  it('keeps source filtering out of group probe requests', async () => {
    const requestBodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/groups/select/probe')) {
          requestBodies.push(init?.body ? JSON.parse(String(init.body)) : null);
          return new Response(
            JSON.stringify({
              group: 'select',
              mode: 'score',
              scheme: 'Balanced',
              testUrl: groupConfig.testUrl,
              recommended: 'hk-1',
              applyError: null,
              nodes: []
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/probes')) {
          return new Response(JSON.stringify({ groups: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ nodes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );
    useHelperStore.setState({
      nodeSources: [
        {
          name: 'provider-hk',
          url: 'https://example.com/sub',
          associate: true,
          lastSyncedAt: null,
          lastError: null,
          nodeCount: 1,
          nodes: ['hk-1']
        }
      ]
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText('Filter nodes by source'), { target: { value: 'provider-hk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run score' }));

    await waitFor(() => expect(requestBodies).toEqual([{ concurrency: 4 }]));
  });

  it('uses the latest score delay without falling back to controller delay in score mode', () => {
    useProxyStore.setState((state) => ({
      proxies: state.proxies.map((proxy) =>
        proxy.name === 'select'
          ? { ...proxy, now: 'jp-1', delay: 999 }
          : proxy.name === 'jp-1'
            ? { ...proxy, delay: 212 }
            : proxy
      ),
      groupDelayResults: { select: 777 }
    }));
    useHelperStore.setState((state) => ({
      scoresByGroup: {
        ...state.scoresByGroup,
        select: {
          ...state.scoresByGroup.select,
          nodes: state.scoresByGroup.select.nodes.map((node) =>
            node.name === 'jp-1'
              ? {
                  ...node,
                  score: 0,
                  delayMs: null,
                  error: 'timeout',
                  raw: {
                    ...node.raw,
                    success: false,
                    delayMs: null,
                    error: 'timeout',
                    testedAt: node.raw?.testedAt ?? null,
                    gateReason: 'latest_failed'
                  }
                }
              : node
          )
        }
      }
    }));

    const { container } = render(<App />);
    expandStrategyWall();
    const groupMeta = container.querySelector('.strategy-card-meta') as HTMLElement;
    const groupDelayPills = Array.from(groupMeta.querySelectorAll('.delay-pill:not(.score-pill)'));
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card')) as HTMLElement[];
    const jpNode = nodeCards.find((node) => within(node).queryByText('jp-1')) as HTMLElement;

    expect(groupDelayPills[0]).toHaveTextContent('--');
    expect(within(jpNode).getByRole('button', { name: /Test jp-1 delay/i })).toHaveTextContent('--');
    expect(within(jpNode).queryByText('212ms')).not.toBeInTheDocument();
    expect(within(jpNode).queryByText('777ms')).not.toBeInTheDocument();
  });

  it('shows latest score update in the group header instead of node cards', () => {
    const latest = '2026-05-12T06:30:15.000Z';
    const latestLabel = new Date(latest).toLocaleTimeString();
    setScoreTimes({
      hk: '2026-05-12T06:29:00.000Z',
      jp: latest
    });

    const { container } = render(<App />);
    const groupTitle = container.querySelector('.strategy-card-title');
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card'));

    expect(groupTitle).not.toBeNull();
    expect(within(groupTitle as HTMLElement).getByText(new RegExp(`updated ${latestLabel}`))).toBeInTheDocument();
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText(latestLabel))).toBe(false);
  });

  it('keeps the previous score visible while a score probe is running', () => {
    useHelperStore.setState({ probingGroups: ['select'] });

    const { container } = render(<App />);
    expandStrategyWall();
    const scorePill = container.querySelector('.strategy-card-meta .score-pill') as HTMLElement;
    const scoreMarks = Array.from(container.querySelectorAll('.score-mark'));

    expect(scorePill).toHaveTextContent('92');
    expect(scorePill).toHaveClass('testing');
    expect(scoreMarks.map((mark) => mark.textContent)).toEqual(expect.arrayContaining(['92', '61']));
    expect(scoreMarks.some((mark) => mark.textContent === '...')).toBe(false);
  });

  it('uses the scoring flash state for helper background probes', () => {
    useHelperStore.setState({ activeProbeGroups: ['select'] });

    const { container } = render(<App />);
    expandStrategyWall();
    const groupCard = container.querySelector('.strategy-group-card') as HTMLElement;
    const groupHead = container.querySelector('.strategy-card-head') as HTMLElement;
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card'));
    const scorePill = container.querySelector('.strategy-card-meta .score-pill') as HTMLElement;

    expect(groupCard).not.toHaveClass('is-scoring');
    expect(groupHead).toHaveClass('is-scoring');
    expect(nodeCards).toHaveLength(2);
    expect(nodeCards.some((node) => node.classList.contains('is-scoring'))).toBe(false);
    expect(scorePill).toHaveTextContent('92');
  });

  it('limits helper background probe animation to the group head and active nodes', () => {
    useHelperStore.setState({
      activeProbeGroups: ['select'],
      activeProbeNodesByGroup: { select: ['jp-1'] }
    });

    const { container } = render(<App />);
    expandStrategyWall();
    const groupCard = container.querySelector('.strategy-group-card') as HTMLElement;
    const groupHead = container.querySelector('.strategy-card-head') as HTMLElement;
    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card')) as HTMLElement[];
    const hkNode = nodeCards.find((node) => within(node).queryByText('hk-1')) as HTMLElement;
    const jpNode = nodeCards.find((node) => within(node).queryByText('jp-1')) as HTMLElement;

    expect(groupCard).not.toHaveClass('is-scoring');
    expect(groupHead).toHaveClass('is-scoring');
    expect(hkNode).not.toHaveClass('is-scoring');
    expect(jpNode).toHaveClass('is-scoring');
  });

  it('shows node score desc at the overview bottom after selecting a strategy group', () => {
    window.location.hash = '#/overview';
    useHelperStore.setState((state) => ({
      scoresByGroup: {
        ...state.scoresByGroup,
        select: {
          ...state.scoresByGroup.select,
          recommended: 'hk-1',
          nodes: state.scoresByGroup.select.nodes.map((node) =>
            node.name === 'jp-1'
              ? {
                  ...node,
                  score: 0,
                  delayMs: null,
                  error: 'timeout',
                  lastTestedAt: '2026-05-22T08:00:00.000Z',
                  raw: {
                    success: false,
                    delayMs: null,
                    error: 'timeout',
                    testedAt: '2026-05-22T08:00:00.000Z',
                    sampleCount: 1,
                    successCount: 0,
                    failureCount: 1,
                    sampleWindowSec: 5400,
                    confidence: 0.2,
                    latencyDelayMs: null,
                    latencyP50Ms: null,
                    latencyP90Ms: null,
                    jitterP50Ms: null,
                    jitterP95Ms: null,
                    jitterMs: null,
                    freshnessAgeMs: 0,
                    freshnessState: 'fresh',
                    gateReason: 'latest_failed',
                    mode: 'score',
                    scheme: 'Balanced',
                    weights: { latency: 0.3, availability: 0.6, jitter: 0.1, freshness: 0 }
                  }
                }
              : {
                  ...node,
                  lastTestedAt: '2026-05-22T08:00:00.000Z',
                  raw: {
                    success: true,
                    delayMs: node.delayMs,
                    error: null,
                    testedAt: '2026-05-22T08:00:00.000Z',
                    sampleCount: 3,
                    successCount: 3,
                    failureCount: 0,
                    sampleWindowSec: 5400,
                    confidence: 0.6,
                    latencyDelayMs: node.delayMs,
                    latencyP50Ms: 48,
                    latencyP90Ms: 52,
                    jitterP50Ms: 48,
                    jitterP95Ms: 52,
                    jitterMs: 4,
                    freshnessAgeMs: 1200,
                    freshnessState: 'fresh',
                    gateReason: 'none',
                    mode: 'score',
                    scheme: 'Balanced',
                    weights: { latency: 0.3, availability: 0.6, jitter: 0.1, freshness: 0 }
                  }
                }
          )
        }
      }
    }));

    const { container } = render(<App />);
    const panel = screen.getByLabelText('node score desc');

    expect(panel).toHaveClass('node-score-desc-panel');
    expect(container.querySelector('.overview-widgets + .node-score-desc-panel')).not.toBeNull();
    expect(within(panel).getByText('node score desc')).toBeInTheDocument();
    expect(within(panel).getByText('Select a strategy group to inspect node score details.')).toBeInTheDocument();
    expect(within(panel).queryByText('hk-1')).not.toBeInTheDocument();

    expect(within(panel).queryByLabelText('Search score strategy group')).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /Select score strategy group/i }));
    fireEvent.change(within(panel).getByLabelText('Search score strategy group'), {
      target: { value: 'sel' }
    });
    fireEvent.click(within(panel).getByRole('option', { name: /select 2 nodes/i }));

    expect(within(panel).getByText('hk-1')).toBeInTheDocument();
    expect(within(panel).getByText('jp-1')).toBeInTheDocument();
    expect(within(panel).getByText('failed')).toBeInTheDocument();
    expect(within(panel).getByText('real latency')).toBeInTheDocument();
    expect(within(panel).getByText('connectivity')).toBeInTheDocument();
    expect(within(panel).getByText('stability')).toBeInTheDocument();
    expect(within(panel).getByText('freshness gate')).toBeInTheDocument();
    expect(within(panel).getByText('3/3 · conf 60%')).toBeInTheDocument();
    expect(within(panel).getByText('p50 48 / p90 52')).toBeInTheDocument();
    expect(within(panel).getByText('jitter 4ms')).toBeInTheDocument();
    expect(within(panel).getByText('fresh 1s / none')).toBeInTheDocument();
    expect(within(panel).getAllByText('w 60/30/10')[0]).toBeInTheDocument();
  });

  it('refreshes proxy state after helper auto switch applies a probe result', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/api/v1/groups/select/probe')) {
          return new Response(
            JSON.stringify({
              group: 'select',
              mode: 'score',
              scheme: 'Balanced',
              testUrl: groupConfig.testUrl,
              recommended: 'jp-1',
              applyError: null,
              nodes: [
                {
                  name: 'jp-1',
                  score: 95,
                  delayMs: 42,
                  components: { latency: 100, availability: 100, jitter: 100, freshness: 100 },
                  lastTestedAt: '2026-05-13T08:00:00.000Z',
                  error: null
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.endsWith('/proxies')) {
          return new Response(
            JSON.stringify({
              proxies: {
                select: { type: 'Selector', now: 'jp-1', all: ['hk-1', 'jp-1'], history: [{ delay: 42 }] },
                'hk-1': { type: 'Trojan', history: [{ delay: 48 }] },
                'jp-1': { type: 'Trojan', history: [{ delay: 42 }] }
              }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('not found', { status: 404 });
      })
    );
    useControllerStore.setState({
      config: {
        controllerUrl: 'http://controller.local',
        secret: '',
        defaultTestUrl: 'https://cp.cloudflare.com/generate_204',
        delayTestConcurrency: 4,
        delayTestTimeoutMs: 5000
      },
      detection: {
        ok: false,
        failure: { kind: 'network', title: 'offline', detail: 'test keeps automatic effects idle' }
      },
      detecting: false,
      lastCheckedAt: null,
      urlSecretWarning: false
    });
    useHelperStore.setState((state) => ({
      groups: state.groups.map((group) =>
        group.name === 'select'
          ? { ...group, config: { ...group.config, autoSwitch: true } }
          : group
      )
    }));

    const { container } = render(<App />);
    const currentNode = container.querySelector('.strategy-card-current strong');

    expect(currentNode?.textContent).toBe('hk-1');

    fireEvent.click(screen.getByRole('button', { name: 'Run score' }));

    await waitFor(() => expect(currentNode?.textContent).toBe('jp-1'));
    expect(requests.some((url) => url.endsWith('/proxies'))).toBe(true);
  });

  it('shows network usage as an overview submodule', () => {
    window.location.hash = '#/overview';
    const recentConnections = Array.from({ length: 12 }, (_, index) => ({
      id: `conn-${index + 1}`,
      host: `host-${index + 1}.example.com`,
      network: 'tcp',
      rule: `DOMAIN host-${index + 1}.example.com`,
      outbound: 'proxy-a',
      chains: ['proxy-a'],
      firstSeenMs: 1000,
      lastSeenMs: 2000 + index,
      uploadBytes: 128,
      downloadBytes: 1024,
      totalBytes: 1152
    }));
    useHelperStore.setState({
      networkUsageSettings: { enabled: true, retentionDays: 7 },
      networkUsageSummary: {
        fromMs: 1000,
        toMs: 2000,
        uploadBytes: 512,
        downloadBytes: 2048,
        totalBytes: 2560,
        connectionCount: 2,
        buckets: []
      },
      networkUsageTopHosts: {
        groupBy: 'host',
        items: [{ label: 'example.com', uploadBytes: 128, downloadBytes: 1024, totalBytes: 1152, connectionCount: 1 }]
      },
      networkUsageTopOutbounds: {
        groupBy: 'outbound',
        items: [{ label: 'proxy-a', uploadBytes: 384, downloadBytes: 1024, totalBytes: 1408, connectionCount: 1 }]
      },
      networkUsageConnections: {
        connections: recentConnections
      }
    });

    const { container } = render(<App />);

    expect(screen.getByText('Usage window')).toBeInTheDocument();
    expect(screen.getAllByText('example.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('proxy-a').length).toBeGreaterThan(0);
    expect(screen.getByText('2 connections')).toBeInTheDocument();
    expect(container.querySelector('.usage-connection-window')).not.toBeNull();
    expect(container.querySelectorAll('.usage-connection-row')).toHaveLength(10);
    expect(container.querySelector('.overview-scroll-buffer')).not.toBeNull();
  });

  it('opens a right side connection detail drawer over the connections list', () => {
    window.location.hash = '#/connections';
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          source: '127.0.0.1',
          target: 'example.com:443',
          network: 'tcp',
          upload: '1 KiB',
          download: '2 KiB',
          rule: 'DOMAIN example.com',
          outbound: 'proxy-a',
          chains: ['proxy-a', 'direct'],
          startedAt: '2026-05-25T09:00:00Z'
        }
      ],
      logs: [],
      droppedLogCount: 0,
      query: '',
      logQuery: '',
      logLevel: 'all',
      loading: false,
      error: null,
      logStreaming: false,
      logAbortController: null
    });

    render(<App />);

    fireEvent.click(screen.getByText('example.com:443'));

    const drawer = screen.getByLabelText('Connection details');
    expect(drawer).toHaveClass('connection-detail-drawer');
    expect(within(drawer).getByText('conn-1')).toBeInTheDocument();
    expect(within(drawer).getByText('proxy-a -> direct')).toBeInTheDocument();
    expect(screen.getByText('Live sessions')).toBeInTheDocument();
  });

  it('exposes the network usage capture toggle in settings', () => {
    window.location.hash = '#/controller';
    const saveNetworkUsageSettings = vi.fn(async (settings) => {
      useHelperStore.setState({ networkUsageSettings: settings });
    });
    useHelperStore.setState({
      networkUsageSettings: { enabled: false, retentionDays: 7 },
      saveNetworkUsageSettings
    });

    render(<App />);

    const label = screen.getByText('Network usage').closest('label') as HTMLLabelElement;
    const checkbox = within(label).getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(saveNetworkUsageSettings).toHaveBeenCalledWith({ enabled: true, retentionDays: 7 });
  });

  it('keeps edited timeout visible while helper timeout save is pending', async () => {
    window.location.hash = '#/controller';
    let resolveSave!: () => void;
    const requests: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/settings/testing') && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body));
          requests.push(body);
          return new Promise<Response>((resolve) => {
            resolveSave = () =>
              resolve(
                new Response(JSON.stringify(body), {
                  status: 200,
                  headers: { 'content-type': 'application/json' }
                })
              );
          });
        }
        return new Response(JSON.stringify({ nodes: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );
    useControllerStore.setState((state) => ({
      config: {
        ...state.config,
        delayTestTimeoutMs: 5000
      }
    }));
    useHelperStore.setState({
      testingSettings: {
        defaultTestUrl: groupConfig.testUrl,
        delayTestTimeoutMs: 5000,
        minProbeIntervalSec: 60,
        probeConcurrency: 4
      }
    });

    render(<App />);

    const timeoutInput = screen.getByLabelText('Timeout ms') as HTMLInputElement;
    fireEvent.change(timeoutInput, { target: { value: '2000' } });
    fireEvent.blur(timeoutInput);

    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ delayTestTimeoutMs: 2000 })));
    await waitFor(() => expect(timeoutInput.value).toBe('2000'));

    resolveSave();
    await waitFor(() => expect(useControllerStore.getState().config.delayTestTimeoutMs).toBe(2000));
  });

  it('allows numeric settings inputs to be cleared while editing', () => {
    window.location.hash = '#/controller';

    render(<App />);

    const timeoutInput = screen.getByLabelText('Timeout ms') as HTMLInputElement;
    fireEvent.change(timeoutInput, { target: { value: '' } });

    expect(timeoutInput.value).toBe('');
  });

  it('shows local behavior save status on the save button without inserting a status block', async () => {
    window.location.hash = '#/controller';
    useControllerStore.setState({
      detect: vi.fn(
        () =>
          new Promise<void>(() => {
            useControllerStore.setState({ detecting: true });
          })
      )
    });

    const { container } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Save controller settings' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument());
    expect(container.querySelector('.settings-save-row .settings-inline-status')).toBeNull();
  });
});
