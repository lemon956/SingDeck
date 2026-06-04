import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '../state/connectionStore';
import { useControllerStore } from '../state/controllerStore';
import { useHelperStore } from '../state/helperStore';
import { useProxyStore } from '../state/proxyStore';
import { useRuntimeStore } from '../state/runtimeStore';
import { App } from './App';

const echartsMock = vi.hoisted(() => {
  const chart = {
    clear: vi.fn(),
    dispose: vi.fn(),
    off: vi.fn(),
    on: vi.fn(),
    resize: vi.fn(),
    setOption: vi.fn()
  };
  return {
    chart,
    init: vi.fn(() => chart),
    use: vi.fn()
  };
});

vi.mock('echarts/core', () => ({
  init: echartsMock.init,
  use: echartsMock.use
}));

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value
  });
}

describe('App page visibility behavior', () => {
  beforeEach(() => {
    window.location.hash = '#/overview';
    localStorage.clear();
    setDocumentVisibility('visible');
    echartsMock.init.mockClear();
    Object.values(echartsMock.chart).forEach((mock) => mock.mockClear());
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
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
    useRuntimeStore.setState({
      history: [],
      lastTraffic: { up: 0, down: 0 },
      lastUpdatedAt: null,
      refresh: vi.fn(async () => undefined)
    });
    useProxyStore.setState({
      proxies: [],
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
      health: null,
      loading: false,
      error: 'helper offline',
      lastCheckedAt: '2026-06-01T00:00:00.000Z',
      eventStreamConnected: false,
      groups: [],
      nodeSources: [],
      scoresByGroup: {},
      trafficSettings: null,
      networkUsageSettings: { enabled: false, retentionDays: 7 },
      networkUsageSourceTrend: null
    });
    useConnectionStore.setState({
      connections: [
        {
          id: 'conn-1',
          source: '127.0.0.1:52000',
          sourceIP: '127.0.0.1',
          sourcePort: '52000',
          sourceEndpoint: '127.0.0.1:52000',
          target: 'example.com:443',
          destinationHost: 'example.com',
          destinationIP: '93.184.216.34',
          destinationPort: '443',
          destinationEndpoint: 'example.com:443',
          network: 'tcp',
          inboundType: 'mixed',
          dnsMode: 'normal',
          processPath: '',
          upload: '1 KiB',
          uploadBytes: 1024,
          download: '2 KiB',
          downloadBytes: 2048,
          totalBytes: 3072,
          rule: 'DOMAIN example.com',
          ruleType: 'DOMAIN',
          rulePayload: 'example.com',
          outbound: 'proxy-a',
          chains: ['select', 'proxy-a'],
          startedAt: '2026-06-01T00:00:00.000Z'
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
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('does not update the overview topology chart while the page is hidden', async () => {
    setDocumentVisibility('hidden');

    render(<App />);

    await waitFor(() => expect(echartsMock.init).toHaveBeenCalled());
    expect(echartsMock.chart.setOption).not.toHaveBeenCalled();
  });
});
