import { Activity, ChevronRight, Play, Trash2 } from 'lucide-react';
import { getHelperAvailability } from '../core/helperStatus';
import { useHelperStore } from '../state/helperStore';
import { useToolsStore, type ToolId } from '../state/toolsStore';

type ToolDefinition = {
  id: ToolId;
  label: string;
  summary: string;
  status: string;
};

const tools: ToolDefinition[] = [
  {
    id: 'http-runner',
    label: 'HTTP Runner',
    summary: 'Run URL, Raw HTTP, or curl input through helper diagnostics.',
    status: 'ready'
  }
];

export function ToolsPage() {
  const toolsState = useToolsStore();
  const helper = useHelperStore();
  const helperAvailability = getHelperAvailability({
    health: helper.health,
    error: helper.error,
    lastCheckedAt: helper.lastCheckedAt
  });
  const helperReady = helperAvailability === 'ready';
  const activeTool = tools.find((tool) => tool.id === toolsState.activeToolId) ?? tools[0];
  const busy = toolsState.phase === 'parsing' || toolsState.phase === 'sending' || toolsState.phase === 'waiting';
  const canExecute = helperReady && toolsState.httpInput.trim().length > 0 && !busy;

  return (
    <section className="tools-workspace page-fill" id="tools" aria-label="Tools workspace">
      <aside className="tools-index">
        <div className="tools-index-head">
          <span>Toolbox</span>
          <strong>{tools.length}</strong>
        </div>
        <nav aria-label="Tools" className="tools-nav">
          {tools.map((tool) => (
            <button
              className={`tools-nav-item ${toolsState.activeToolId === tool.id ? 'active' : ''}`}
              key={tool.id}
              onClick={() => toolsState.setActiveTool(tool.id)}
              type="button"
            >
              <span className="tools-nav-icon" aria-hidden="true">
                <Activity size={15} />
              </span>
              <span>
                <strong>{tool.label}</strong>
                <small>{tool.summary}</small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
      </aside>

      <article className="tools-stage">
        <header className="tools-stage-head">
          <div>
            <span className="panel-stamp">{activeTool.status}</span>
            <h2>{activeTool.label}</h2>
          </div>
          <span className={`status-chip ${toolsState.phase === 'error' ? 'bad' : toolsState.phase === 'complete' ? 'ok' : 'neutral'}`}>
            {toolsState.phase}
          </span>
        </header>
        <div className="tool-panel">
          <form
            className="http-runner-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void toolsState.executeHttpRequest();
            }}
          >
            <section className="http-runner-compose" aria-label="HTTP request composer">
              <div className="runner-toolbar">
                <div className="segmented-control" aria-label="Route mode">
                  <button
                    className={toolsState.routeMode === 'direct' ? 'active' : ''}
                    onClick={() => toolsState.setRouteMode('direct')}
                    type="button"
                  >
                    Direct
                  </button>
                  <button
                    className={toolsState.routeMode === 'proxy' ? 'active' : ''}
                    onClick={() => toolsState.setRouteMode('proxy')}
                    type="button"
                  >
                    via sing-box
                  </button>
                </div>
                <span className={`status-chip ${helperReady ? 'ok' : helperAvailability === 'checking' ? 'neutral' : 'bad'}`}>
                  {helperReady ? 'helper ready' : helperAvailability === 'checking' ? 'helper checking' : 'helper offline'}
                </span>
              </div>

              <label className="runner-input-label">
                <span>HTTP request input</span>
                <textarea
                  aria-label="HTTP request input"
                  placeholder="https://api.example.test/health&#10;curl -X POST https://api.example.test/items -H 'content-type: application/json' -d '{&quot;ok&quot;:true}'&#10;GET /health HTTP/1.1&#10;Host: api.example.test"
                  value={toolsState.httpInput}
                  onChange={(event) => toolsState.setHttpInput(event.currentTarget.value)}
                />
              </label>

              <div className="runner-actions">
                <button className="primary-action" disabled={!canExecute} type="submit">
                  <Play size={14} />
                  Execute request
                </button>
                <button className="ghost-action" onClick={toolsState.clearCurrentResult} type="button">
                  <Trash2 size={14} />
                  Clear
                </button>
                <span className="runner-phase">{busy ? 'running' : toolsState.phase}</span>
              </div>
              {toolsState.error ? <div className="settings-inline-error">{toolsState.error}</div> : null}
            </section>

            <section className="http-runner-result" aria-label="HTTP diagnostics">
              {toolsState.currentResult ? (
                <HttpResult result={toolsState.currentResult} />
              ) : (
                <div className="tool-empty">No request has been executed in this session.</div>
              )}
            </section>
          </form>

          <section className="tool-history" aria-label="HTTP runner history">
            <div className="tool-history-head">
              <span>Session history</span>
              <strong>{toolsState.history.length}</strong>
            </div>
            <div className="tool-history-list">
              {toolsState.history.length > 0 ? (
                toolsState.history.map((row) => (
                  <button
                    className="tool-history-row"
                    key={row.id}
                    onClick={() => {
                      toolsState.setHttpInput(row.target);
                      toolsState.setRouteMode(row.routeMode);
                    }}
                    type="button"
                  >
                    <span>{row.method}</span>
                    <strong>{row.target}</strong>
                    <small>{row.status ?? row.error ?? '--'}</small>
                  </button>
                ))
              ) : (
                <div className="tool-empty compact">No history yet.</div>
              )}
            </div>
          </section>
        </div>
      </article>
    </section>
  );
}

type HttpResultProps = {
  result: NonNullable<ReturnType<typeof useToolsStore.getState>['currentResult']>;
};

function HttpResult({ result }: HttpResultProps) {
  const statusText = result.response ? `${result.response.status} ${result.response.statusText}`.trim() : 'No response';

  return (
    <div className="http-result-stack">
      <div className="http-result-summary">
        <div>
          <span>Status</span>
          <strong>{statusText}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{result.durationMs} ms</strong>
        </div>
        <div>
          <span>Body</span>
          <strong>{result.response ? `${result.response.bodyBytes} B` : '--'}</strong>
        </div>
      </div>

      <div className="http-result-grid">
        <section>
          <h3>Parsed request</h3>
          <dl className="http-kv">
            <dt>Input</dt>
            <dd>{result.parsed.inputKind}</dd>
            <dt>Method</dt>
            <dd>Method: {result.parsed.method}</dd>
            <dt>URL</dt>
            <dd>{result.parsed.url}</dd>
            <dt>Body bytes</dt>
            <dd>{result.parsed.bodyBytes}</dd>
          </dl>
        </section>

        <section>
          <h3>Response headers</h3>
          <HeaderList headers={result.response?.headers ?? []} />
        </section>
      </div>

      {result.warnings.length > 0 ? (
        <section className="http-result-section">
          <h3>Warnings</h3>
          <div className="http-warning-list">
            {result.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        </section>
      ) : null}

      <section className="http-result-section">
        <h3>Body preview</h3>
        <pre className="http-body-preview">{result.response?.bodyPreview || result.error || '--'}</pre>
      </section>

      <section className="http-result-section">
        <h3>Observed connections</h3>
        {result.observedConnections.length > 0 ? (
          <div className="observed-connection-list">
            {result.observedConnections.map((connection) => (
              <div className="observed-connection-row" key={connection.id}>
                <strong>{connection.target}</strong>
                <span>{connection.rule}</span>
                <span>{connection.outbound}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="tool-empty compact">No matching connection snapshot.</div>
        )}
      </section>
    </div>
  );
}

function HeaderList({ headers }: { headers: Array<{ name: string; value: string }> }) {
  if (headers.length === 0) {
    return <div className="tool-empty compact">No headers.</div>;
  }

  return (
    <div className="http-header-list">
      {headers.map((header) => (
        <div key={`${header.name}:${header.value}`}>
          <span>{header.name}</span>
          <strong>{header.value}</strong>
        </div>
      ))}
    </div>
  );
}
