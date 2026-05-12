import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useControllerStore } from '../state/controllerStore';
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
            error: null
          },
          {
            name: 'jp-1',
            score: 61,
            delayMs: 212,
            components: { latency: 70, availability: 100, jitter: 60, freshness: 100 },
            lastTestedAt: null,
            error: null
          }
        ]
      }
    },
    traffic: null,
    trafficLoading: false,
    trafficError: null,
    loading: false,
    probingGroups: [],
    applyingGroups: [],
    error: null,
    lastCheckedAt: null
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

    const nodeCards = Array.from(container.querySelectorAll('.strategy-node-card'));

    expect(nodeCards).toHaveLength(2);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('48ms'))).toBe(true);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('212ms'))).toBe(true);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('active'))).toBe(false);
    expect(nodeCards.some((node) => within(node as HTMLElement).queryByText('standby'))).toBe(false);
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
});
