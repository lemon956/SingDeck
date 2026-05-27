import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHelperStore } from './helperStore';
import { useToolsStore } from './toolsStore';

describe('tools store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useHelperStore.setState({ helperUrl: 'http://127.0.0.1:9531' });
    useToolsStore.setState({
      activeToolId: 'http-runner',
      httpInput: '',
      routeMode: 'direct',
      phase: 'idle',
      currentResult: null,
      error: null,
      history: []
    });
  });

  it('executes an HTTP runner request through the helper and stores a session history row', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        input: 'https://api.example.test/health',
        routeMode: 'direct'
      });
      return new Response(
        JSON.stringify({
          parsed: {
            inputKind: 'url',
            method: 'GET',
            url: 'https://api.example.test/health',
            headers: [],
            bodyBytes: 0
          },
          warnings: [],
          durationMs: 24,
          response: {
            status: 200,
            statusText: 'OK',
            headers: [{ name: 'content-type', value: 'text/plain' }],
            bodyPreview: 'ok',
            bodyBytes: 2,
            truncated: false
          },
          error: null,
          observedConnections: []
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetcher);

    useToolsStore.getState().setHttpInput('https://api.example.test/health');
    await useToolsStore.getState().executeHttpRequest();

    const state = useToolsStore.getState();
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:9531/api/v1/tools/http-execute', expect.any(Object));
    expect(state.phase).toBe('complete');
    expect(state.currentResult?.response?.status).toBe(200);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ method: 'GET', status: 200, target: 'https://api.example.test/health' });
  });
});
