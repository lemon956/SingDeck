use std::{
    collections::{BTreeSet, HashMap},
    env, fs,
    net::{IpAddr, SocketAddr, UdpSocket},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine as _,
};
use chrono::{DateTime, Local, TimeZone};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};

mod network_usage;
mod traffic;

const DEFAULT_BIND: &str = "0.0.0.0:9531";
const DEFAULT_TEST_URL: &str = "https://cp.cloudflare.com/generate_204";
const DEFAULT_DELAY_TEST_TIMEOUT_MS: i64 = 5000;
const MIN_DELAY_TEST_TIMEOUT_MS: i64 = 500;
const MAX_DELAY_TEST_TIMEOUT_MS: i64 = 60_000;
const DEFAULT_PROBE_INTERVAL_SEC: i64 = 15 * 60;
const MIN_PROBE_INTERVAL_SEC: i64 = 60;
const DEFAULT_MIN_PROBE_INTERVAL_SEC: i64 = MIN_PROBE_INTERVAL_SEC;
const MAX_PROBE_INTERVAL_SEC: i64 = 24 * 60 * 60;
const DEFAULT_PROBE_CONCURRENCY: usize = 4;
const MIN_PROBE_CONCURRENCY: usize = 1;
const MAX_PROBE_CONCURRENCY: usize = 12;
const FAILURE_PROBE_COOLDOWN_MS: i64 = 30 * 1000;
const REALTIME_EVENT_INTERVAL_MS: u64 = 1000;
const NETWORK_USAGE_SAMPLE_INTERVAL_MS: u64 = 1000;
const MIN_SCORE_SAMPLE_WINDOW_MS: i64 = 30 * 60 * 1000;
const SCORE_SAMPLE_WINDOW_INTERVAL_MULTIPLIER: i64 = 6;
const MAX_SCORE_SAMPLE_COUNT: i64 = 10;
const CONNECTIVITY_CONFIDENCE_SAMPLE_TARGET: f64 = 5.0;
const SINGDECK_CONFIG_FILE: &str = "singdeck.json";
const SINGDECK_CONFIG_JSONC_FILE: &str = "singdeck.jsonc";
const NODE_SOURCE_STARTUP_SYNC_ATTEMPTS: usize = 30;
const NODE_SOURCE_STARTUP_SYNC_RETRY_MS: u64 = 2_000;
const NODE_SOURCE_FETCH_USER_AGENT: &str = "SingDeck-helper/0.1.0";

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    http: Client,
    mobile_config_url: Option<String>,
    active_probes: Arc<Mutex<HashMap<String, ActiveProbeState>>>,
    probe_limiter: ProbeLimiter,
    events: broadcast::Sender<HelperEvent>,
}

#[derive(Debug, Clone)]
struct ActiveProbeState {
    started_at_ms: i64,
    count: usize,
    active_nodes: HashMap<String, usize>,
}

#[derive(Clone)]
struct ProbeLimiter {
    state: Arc<Mutex<ProbeLimiterState>>,
    notify: Arc<tokio::sync::Notify>,
}

#[derive(Debug, Default)]
struct ProbeLimiterState {
    active: usize,
}

struct ProbePermit {
    limiter: ProbeLimiter,
}

impl ProbeLimiter {
    fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(ProbeLimiterState::default())),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn acquire(&self, limit: usize) -> ProbePermit {
        let limit = normalize_probe_concurrency(limit);
        loop {
            {
                let mut state = self.state.lock().expect("probe limiter lock poisoned");
                if state.active < limit {
                    state.active += 1;
                    return ProbePermit {
                        limiter: self.clone(),
                    };
                }
            }
            self.notify.notified().await;
        }
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.state
            .lock()
            .expect("probe limiter lock poisoned")
            .active
    }
}

impl Drop for ProbePermit {
    fn drop(&mut self) {
        {
            let mut state = self
                .limiter
                .state
                .lock()
                .expect("probe limiter lock poisoned");
            state.active = state.active.saturating_sub(1);
        }
        self.limiter.notify.notify_waiters();
    }
}

struct ActiveProbeGuard {
    state: AppState,
    group: String,
    active: bool,
}

struct ActiveProbeNodeGuard {
    state: AppState,
    group: String,
    node: String,
}

#[derive(Clone)]
struct ProbeProgressContext {
    config: GroupConfig,
}

impl Drop for ActiveProbeGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        {
            let Ok(mut active_probes) = self.state.active_probes.lock() else {
                return;
            };
            let Some(active_probe) = active_probes.get_mut(&self.group) else {
                return;
            };
            if active_probe.count > 1 {
                active_probe.count -= 1;
            } else {
                active_probe.count = 0;
                remove_idle_active_probe(&mut active_probes, &self.group);
            }
        }
        publish_probe_status(&self.state);
    }
}

impl ActiveProbeGuard {
    fn is_active(&self) -> bool {
        self.active
    }
}

impl Drop for ActiveProbeNodeGuard {
    fn drop(&mut self) {
        {
            let Ok(mut active_probes) = self.state.active_probes.lock() else {
                return;
            };
            let Some(active_probe) = active_probes.get_mut(&self.group) else {
                return;
            };
            let Some(node_count) = active_probe.active_nodes.get_mut(&self.node) else {
                return;
            };
            if *node_count > 1 {
                *node_count -= 1;
            } else {
                active_probe.active_nodes.remove(&self.node);
                remove_idle_active_probe(&mut active_probes, &self.group);
            }
        }
        publish_probe_status(&self.state);
    }
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }

    fn bad_request(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: error.to_string(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::internal(value)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ControllerConfig {
    controller_url: String,
    secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroupConfig {
    test_url: String,
    test_url_overridden: bool,
    mode: ScoreMode,
    scheme: ScoreScheme,
    auto_switch: bool,
    auto_probe: bool,
    probe_interval_sec: i64,
}

impl Default for GroupConfig {
    fn default() -> Self {
        Self {
            test_url: DEFAULT_TEST_URL.to_string(),
            test_url_overridden: false,
            mode: ScoreMode::Score,
            scheme: ScoreScheme::Balanced,
            auto_switch: false,
            auto_probe: true,
            probe_interval_sec: DEFAULT_PROBE_INTERVAL_SEC,
        }
    }
}

impl GroupConfig {
    fn with_default_test_url(default_test_url: String) -> Self {
        Self {
            test_url: default_test_url,
            test_url_overridden: false,
            mode: ScoreMode::Score,
            scheme: ScoreScheme::Balanced,
            auto_switch: false,
            auto_probe: true,
            probe_interval_sec: DEFAULT_PROBE_INTERVAL_SEC,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ScoreMode {
    Delay,
    Score,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum ScoreScheme {
    LatencyFirst,
    Balanced,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeRequest {
    concurrency: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyRequest {
    node: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestingSettings {
    default_test_url: String,
    #[serde(default = "default_delay_test_timeout_ms")]
    delay_test_timeout_ms: i64,
    #[serde(default = "default_min_probe_interval_sec")]
    min_probe_interval_sec: i64,
    #[serde(default = "default_probe_concurrency")]
    probe_concurrency: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestingSettingsInput {
    default_test_url: String,
    delay_test_timeout_ms: Option<i64>,
    min_probe_interval_sec: Option<i64>,
    probe_concurrency: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrafficSettings {
    enabled: bool,
    browser_profile: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigSourceRequest {
    path: String,
}

#[derive(Debug, Clone, Default)]
struct NodeSourceConfig {
    sources: Vec<NodeSourceConfigEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NodeSourceConfigEntry {
    name: String,
    url: String,
    associate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SingDeckSidecarConfig {
    #[serde(default)]
    node_sources: Vec<NodeSourceConfigEntry>,
}

#[derive(Debug, Deserialize)]
struct ClashProxiesResponse {
    proxies: Option<HashMap<String, ClashProxy>>,
}

#[derive(Debug, Deserialize)]
struct ClashProxy {
    name: Option<String>,
    #[serde(rename = "type")]
    proxy_type: Option<String>,
    now: Option<String>,
    all: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HelperHealth {
    ok: bool,
    version: &'static str,
    sqlite: bool,
    controller_configured: bool,
    controller_reachable: bool,
    mobile_config_url: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupView {
    name: String,
    kind: String,
    now: String,
    all: Vec<String>,
    config: GroupConfig,
    recommended: Option<String>,
    apply_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupsResponse {
    groups: Vec<GroupView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NodeSourcesResponse {
    sources: Vec<NodeSourceView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct NodeSourceView {
    name: String,
    url: String,
    associate: bool,
    last_synced_at: Option<String>,
    last_error: Option<String>,
    node_count: usize,
    nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveProbeView {
    group: String,
    started_at: String,
    active_nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeStatusResponse {
    groups: Vec<ActiveProbeView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum HelperEvent {
    ProbeStatus {
        groups: Vec<ActiveProbeView>,
    },
    ProbeScores {
        scores: ScoresResponse,
        partial: bool,
    },
    ConnectionsSnapshot {
        snapshot: serde_json::Value,
        sampled_at: String,
    },
    TrafficSnapshot {
        up: i64,
        down: i64,
        upload_total: i64,
        download_total: i64,
        connection_count: usize,
        mode: String,
        sampled_at: String,
    },
    Error {
        scope: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScoresResponse {
    group: String,
    mode: ScoreMode,
    scheme: ScoreScheme,
    test_url: String,
    recommended: Option<String>,
    apply_error: Option<String>,
    nodes: Vec<NodeScore>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeScore {
    name: String,
    score: f64,
    delay_ms: Option<i64>,
    components: ScoreComponents,
    last_tested_at: Option<String>,
    error: Option<String>,
    #[serde(default = "default_node_score_raw")]
    raw: NodeScoreRaw,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ScoreComponents {
    latency: f64,
    availability: f64,
    jitter: f64,
    freshness: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct NodeScoreRaw {
    success: bool,
    delay_ms: Option<i64>,
    error: Option<String>,
    tested_at: Option<String>,
    #[serde(default)]
    sample_window_sec: Option<i64>,
    #[serde(default)]
    sample_count: usize,
    #[serde(default)]
    success_count: usize,
    #[serde(default)]
    failure_count: usize,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    latency_delay_ms: Option<i64>,
    #[serde(default)]
    latency_p50_ms: Option<i64>,
    #[serde(default)]
    latency_p90_ms: Option<i64>,
    #[serde(default)]
    jitter_p50_ms: Option<i64>,
    #[serde(default)]
    jitter_p95_ms: Option<i64>,
    #[serde(default)]
    jitter_ms: Option<i64>,
    #[serde(default)]
    freshness_age_ms: Option<i64>,
    #[serde(default)]
    freshness_state: Option<String>,
    #[serde(default)]
    gate_reason: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    scheme: Option<String>,
    #[serde(default)]
    weights: Option<ScoreWeights>,
}

fn default_node_score_raw() -> NodeScoreRaw {
    NodeScoreRaw::default()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScoreWeights {
    latency: f64,
    availability: f64,
    jitter: f64,
    freshness: f64,
}

#[derive(Debug, Clone)]
struct Sample {
    delay_ms: Option<i64>,
    success: bool,
    error: Option<String>,
    tested_at_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigResponse {
    source: Option<String>,
    format: String,
    content: String,
    loaded_at: String,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkUsageSummaryQuery {
    from: Option<i64>,
    to: Option<i64>,
    bucket: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkUsageTopQuery {
    from: Option<i64>,
    to: Option<i64>,
    group_by: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkUsageConnectionsQuery {
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<i64>,
    q: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkUsageWindowQuery {
    from: Option<i64>,
    to: Option<i64>,
    bucket: Option<String>,
    limit: Option<i64>,
    q: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let bind = env::var("SINGDECK_HELPER_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_string());
    let db_path =
        env::var("SINGDECK_HELPER_DB").unwrap_or_else(|_| "singdeck-helper.db".to_string());
    let conn = Connection::open(db_path)?;
    init_db(&conn)?;

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        http: Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()?,
        mobile_config_url: public_config_url()
            .or_else(|| mobile_config_url_for_bind(&bind, detect_lan_ip())),
        active_probes: Arc::new(Mutex::new(HashMap::new())),
        probe_limiter: ProbeLimiter::new(),
        events: helper_event_channel(),
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin(Any);

    spawn_probe_scheduler(state.clone());
    spawn_node_source_startup_sync(state.clone());
    spawn_realtime_event_publisher(state.clone());
    spawn_network_usage_sampler(state.clone());

    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/controller", put(save_controller))
        .route(
            "/api/v1/settings/testing",
            get(testing_settings).put(save_testing_settings),
        )
        .route(
            "/api/v1/settings/traffic",
            get(traffic_settings).put(save_traffic_settings),
        )
        .route(
            "/api/v1/settings/network-usage",
            get(network_usage_settings).put(save_network_usage_settings),
        )
        .route("/api/v1/groups", get(groups))
        .route("/api/v1/node-sources", get(node_sources))
        .route("/api/v1/events", get(helper_events))
        .route("/api/v1/probes", get(active_probes))
        .route("/api/v1/groups/:group/config", put(save_group_config))
        .route("/api/v1/groups/:group/probe", post(probe_group))
        .route("/api/v1/groups/:group/scores", get(group_scores))
        .route("/api/v1/groups/:group/apply", post(apply_group))
        .route("/api/v1/config", get(read_config))
        .route("/api/v1/config/raw", get(read_config_raw))
        .route("/api/v1/config/source", put(save_config_source))
        .route("/api/v1/traffic", get(read_traffic))
        .route("/api/v1/network-usage/summary", get(network_usage_summary))
        .route("/api/v1/network-usage/window", get(network_usage_window))
        .route("/api/v1/network-usage/top", get(network_usage_top))
        .route(
            "/api/v1/network-usage/connections",
            get(network_usage_connections),
        )
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind.parse::<SocketAddr>()?).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS group_configs (
          group_name TEXT PRIMARY KEY,
          test_url TEXT NOT NULL,
          mode TEXT NOT NULL,
          scheme TEXT NOT NULL,
          auto_switch INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS probe_samples (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_name TEXT NOT NULL,
          node_name TEXT NOT NULL,
          test_url TEXT NOT NULL,
          delay_ms INTEGER,
          success INTEGER NOT NULL,
          error TEXT,
          tested_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_probe_group_node_time
          ON probe_samples(group_name, node_name, tested_at_ms);
        CREATE TABLE IF NOT EXISTS node_sources (
          name TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          associate INTEGER NOT NULL,
          last_synced_ms INTEGER,
          last_error TEXT,
          node_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS node_source_nodes (
          source_name TEXT NOT NULL,
          node_name TEXT NOT NULL,
          PRIMARY KEY (source_name, node_name)
        );
        "#,
    )?;
    network_usage::init_db(conn)?;
    add_column_if_missing(
        conn,
        "group_configs",
        "test_url_overridden",
        "ALTER TABLE group_configs ADD COLUMN test_url_overridden INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "group_configs",
        "auto_probe",
        "ALTER TABLE group_configs ADD COLUMN auto_probe INTEGER NOT NULL DEFAULT 1",
    )?;
    add_column_if_missing(
        conn,
        "group_configs",
        "probe_interval_sec",
        "ALTER TABLE group_configs ADD COLUMN probe_interval_sec INTEGER NOT NULL DEFAULT 900",
    )?;
    Ok(())
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, sql: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(sql, [])?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Result<Json<HelperHealth>, AppError> {
    let controller = load_controller(&state)?;
    let sqlite = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?
        .query_row("SELECT 1", [], |_| Ok(()))
        .is_ok();

    let mut reachable = false;
    let mut error = None;
    if !controller.controller_url.is_empty() {
        match controller_get::<serde_json::Value>(&state, &controller, "/version").await {
            Ok(_) => reachable = true,
            Err(err) => error = Some(err.to_string()),
        }
    }

    Ok(Json(HelperHealth {
        ok: sqlite,
        version: env!("CARGO_PKG_VERSION"),
        sqlite,
        controller_configured: !controller.controller_url.is_empty(),
        controller_reachable: reachable,
        mobile_config_url: state.mobile_config_url.clone(),
        error,
    }))
}

async fn save_controller(
    State(state): State<AppState>,
    Json(input): Json<ControllerConfig>,
) -> Result<Json<ControllerConfig>, AppError> {
    let normalized = ControllerConfig {
        controller_url: input
            .controller_url
            .trim()
            .trim_end_matches('/')
            .to_string(),
        secret: input.secret,
    };
    save_json_kv(&state, "controller", &normalized)?;
    Ok(Json(normalized))
}

async fn testing_settings(
    State(state): State<AppState>,
) -> Result<Json<TestingSettings>, AppError> {
    Ok(Json(TestingSettings {
        default_test_url: load_default_test_url(&state)?,
        delay_test_timeout_ms: load_delay_test_timeout_ms(&state)?,
        min_probe_interval_sec: load_min_probe_interval_sec(&state)?,
        probe_concurrency: load_probe_concurrency(&state)?,
    }))
}

async fn save_testing_settings(
    State(state): State<AppState>,
    Json(input): Json<TestingSettingsInput>,
) -> Result<Json<TestingSettings>, AppError> {
    let default_test_url = input.default_test_url.trim();
    if default_test_url.is_empty() {
        return Err(AppError::bad_request("default test URL cannot be empty"));
    }
    let delay_test_timeout_ms =
        normalize_delay_test_timeout(input.delay_test_timeout_ms.unwrap_or_else(|| {
            load_delay_test_timeout_ms(&state).unwrap_or(DEFAULT_DELAY_TEST_TIMEOUT_MS)
        }));
    let min_probe_interval_sec =
        normalize_min_probe_interval(input.min_probe_interval_sec.unwrap_or_else(|| {
            load_min_probe_interval_sec(&state).unwrap_or(DEFAULT_MIN_PROBE_INTERVAL_SEC)
        }));
    let probe_concurrency = normalize_probe_concurrency(
        input
            .probe_concurrency
            .unwrap_or_else(|| load_probe_concurrency(&state).unwrap_or(DEFAULT_PROBE_CONCURRENCY)),
    );
    save_string_kv(&state, "default_test_url", default_test_url)?;
    save_string_kv(
        &state,
        "delay_test_timeout_ms",
        &delay_test_timeout_ms.to_string(),
    )?;
    save_string_kv(
        &state,
        "min_probe_interval_sec",
        &min_probe_interval_sec.to_string(),
    )?;
    save_string_kv(
        &state,
        "probe_concurrency",
        &probe_concurrency.to_string(),
    )?;
    Ok(Json(TestingSettings {
        default_test_url: default_test_url.to_string(),
        delay_test_timeout_ms,
        min_probe_interval_sec,
        probe_concurrency,
    }))
}

async fn traffic_settings(
    State(state): State<AppState>,
) -> Result<Json<TrafficSettings>, AppError> {
    Ok(Json(load_traffic_settings(&state)?))
}

async fn save_traffic_settings(
    State(state): State<AppState>,
    Json(input): Json<TrafficSettings>,
) -> Result<Json<TrafficSettings>, AppError> {
    let settings = normalize_traffic_settings(input);
    save_traffic_settings_row(&state, &settings)?;
    Ok(Json(settings))
}

async fn network_usage_settings(
    State(state): State<AppState>,
) -> Result<Json<network_usage::NetworkUsageSettings>, AppError> {
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::load_settings(&db)?))
}

async fn save_network_usage_settings(
    State(state): State<AppState>,
    Json(input): Json<network_usage::NetworkUsageSettings>,
) -> Result<Json<network_usage::NetworkUsageSettings>, AppError> {
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::save_settings(&db, &input)?))
}

async fn network_usage_summary(
    State(state): State<AppState>,
    Query(query): Query<NetworkUsageSummaryQuery>,
) -> Result<Json<network_usage::UsageSummaryResponse>, AppError> {
    let (from_ms, to_ms) = resolve_usage_window(query.from, query.to);
    let bucket = network_usage::UsageBucket::parse(query.bucket.as_deref());
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::query_summary(
        &db, from_ms, to_ms, bucket,
    )?))
}

async fn network_usage_top(
    State(state): State<AppState>,
    Query(query): Query<NetworkUsageTopQuery>,
) -> Result<Json<network_usage::UsageTopResponse>, AppError> {
    let (from_ms, to_ms) = resolve_usage_window(query.from, query.to);
    let group_by = network_usage::UsageGroupBy::parse(query.group_by.as_deref());
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::query_top(
        &db,
        from_ms,
        to_ms,
        group_by,
        query.limit.unwrap_or(10),
    )?))
}

async fn network_usage_connections(
    State(state): State<AppState>,
    Query(query): Query<NetworkUsageConnectionsQuery>,
) -> Result<Json<network_usage::UsageConnectionsResponse>, AppError> {
    let (from_ms, to_ms) = resolve_usage_window(query.from, query.to);
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::query_connections(
        &db,
        from_ms,
        to_ms,
        query.limit.unwrap_or(20),
        query.q.as_deref(),
    )?))
}

async fn network_usage_window(
    State(state): State<AppState>,
    Query(query): Query<NetworkUsageWindowQuery>,
) -> Result<Json<network_usage::UsageWindowResponse>, AppError> {
    let (from_ms, to_ms) = resolve_usage_window(query.from, query.to);
    let bucket = network_usage::UsageBucket::parse(query.bucket.as_deref());
    let db = state
        .db
        .lock()
        .map_err(|_| AppError::internal("database lock poisoned"))?;
    Ok(Json(network_usage::query_window(
        &db,
        from_ms,
        to_ms,
        bucket,
        query.limit.unwrap_or(10),
        query.q.as_deref(),
    )?))
}

async fn groups(State(state): State<AppState>) -> Result<Json<GroupsResponse>, AppError> {
    let controller = load_controller(&state)?;
    let proxies = fetch_proxies(&state, &controller).await?;
    let groups = proxy_groups(&proxies)
        .into_iter()
        .map(|proxy| {
            let config = load_group_config(&state, &proxy.name)?;
            let scores = compute_scores_for_group(&state, &proxy.name, &proxy.all, &config)?;
            let recommended = recommended_node(&scores);
            Ok(GroupView {
                name: proxy.name,
                kind: proxy.kind,
                now: proxy.now,
                all: proxy.all,
                config,
                recommended,
                apply_error: None,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(GroupsResponse { groups }))
}

async fn node_sources(State(state): State<AppState>) -> Result<Json<NodeSourcesResponse>, AppError> {
    Ok(Json(load_node_sources_response(&state)?))
}

async fn active_probes(
    State(state): State<AppState>,
) -> Result<Json<ProbeStatusResponse>, AppError> {
    Ok(Json(ProbeStatusResponse {
        groups: active_probe_groups(&state),
    }))
}

async fn helper_events(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|socket| async move {
        stream_helper_events(state, socket).await;
    })
}

async fn stream_helper_events(state: AppState, mut socket: WebSocket) {
    let mut receiver = state.events.subscribe();
    let initial = HelperEvent::ProbeStatus {
        groups: active_probe_groups(&state),
    };
    if send_helper_event(&mut socket, &initial).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        if send_helper_event(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let event = HelperEvent::ProbeStatus {
                            groups: active_probe_groups(&state),
                        };
                        if send_helper_event(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

async fn send_helper_event(socket: &mut WebSocket, event: &HelperEvent) -> Result<()> {
    socket
        .send(Message::Text(serde_json::to_string(event)?))
        .await
        .map_err(|error| anyhow!("websocket send failed: {error}"))
}

async fn save_group_config(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(config): Json<GroupConfig>,
) -> Result<Json<GroupConfig>, AppError> {
    let mut normalized = config;
    normalized.probe_interval_sec = normalize_probe_interval_with_min(
        normalized.probe_interval_sec,
        load_min_probe_interval_sec(&state)?,
    );
    save_group_config_row(&state, &group, &normalized)?;
    Ok(Json(normalized))
}

async fn probe_group(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(request): Json<ProbeRequest>,
) -> Result<Json<ScoresResponse>, AppError> {
    let concurrency = normalize_probe_concurrency(request.concurrency.unwrap_or(DEFAULT_PROBE_CONCURRENCY));
    Ok(Json(
        probe_group_internal(&state, &group, concurrency, true).await?,
    ))
}

async fn group_scores(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
) -> Result<Json<ScoresResponse>, AppError> {
    let controller = load_controller(&state)?;
    let proxies = fetch_proxies(&state, &controller).await?;
    let proxy_map = proxy_map(&proxies);
    let group_proxy = proxy_map
        .get(&group)
        .ok_or_else(|| AppError::bad_request(format!("group not found: {group}")))?;
    let config = load_group_config(&state, &group)?;
    let scores = compute_scores_for_group(&state, &group, &group_proxy.all, &config)?;
    Ok(Json(ScoresResponse {
        group,
        mode: config.mode,
        scheme: config.scheme,
        test_url: config.test_url,
        recommended: recommended_node(&scores),
        apply_error: None,
        nodes: scores,
    }))
}

async fn apply_group(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(request): Json<ApplyRequest>,
) -> Result<Json<GroupView>, AppError> {
    let controller = load_controller(&state)?;
    let proxies = fetch_proxies(&state, &controller).await?;
    let proxy_map = proxy_map(&proxies);
    let group_proxy = proxy_map
        .get(&group)
        .ok_or_else(|| AppError::bad_request(format!("group not found: {group}")))?;
    let config = load_group_config(&state, &group)?;
    let scores = compute_scores_for_group(&state, &group, &group_proxy.all, &config)?;
    let target = request
        .node
        .or_else(|| recommended_node(&scores))
        .ok_or_else(|| AppError::bad_request("no recommended node available"))?;

    let apply_error = apply_recommended_node(&state, &controller, group_proxy, &target).await;

    Ok(Json(GroupView {
        name: group_proxy.name.clone(),
        kind: group_proxy.kind.clone(),
        now: if apply_error.is_none() {
            target
        } else {
            group_proxy.now.clone()
        },
        all: group_proxy.all.clone(),
        config,
        recommended: recommended_node(&scores),
        apply_error,
    }))
}

async fn read_config(State(state): State<AppState>) -> Result<Json<ConfigResponse>, AppError> {
    let loaded_at = Local::now().to_rfc3339();
    let configured = load_string_kv(&state, "config_path")?;
    let candidates = config_path_candidates(configured);

    let mut last_error = None;
    for path in candidates {
        match fs::read_to_string(&path) {
            Ok(content) => {
                let format = Path::new(&path)
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("json")
                    .to_string();
                return Ok(Json(ConfigResponse {
                    source: Some(path),
                    format,
                    content,
                    loaded_at,
                    error: None,
                }));
            }
            Err(error) => {
                last_error = Some(format!("{path}: {error}"));
            }
        }
    }

    Ok(Json(ConfigResponse {
        source: None,
        format: "jsonc".to_string(),
        content: String::new(),
        loaded_at,
        error: last_error
            .or_else(|| Some("Config path is not configured in Settings.".to_string())),
    }))
}

async fn save_config_source(
    State(state): State<AppState>,
    Json(input): Json<ConfigSourceRequest>,
) -> Result<Json<ConfigSourceRequest>, AppError> {
    let path = input.path.trim();
    if path.is_empty() {
        delete_string_kv(&state, "config_path")?;
        return Ok(Json(ConfigSourceRequest {
            path: String::new(),
        }));
    }
    save_string_kv(&state, "config_path", path)?;
    Ok(Json(ConfigSourceRequest {
        path: path.to_string(),
    }))
}

fn config_path_candidates(configured: Option<String>) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Some(path) = configured {
        push_config_path_candidate(&mut candidates, path);
    }
    candidates
}

fn push_config_path_candidate(candidates: &mut Vec<String>, path: impl AsRef<str>) {
    let path = path.as_ref().trim();
    if path.is_empty() || candidates.iter().any(|candidate| candidate == path) {
        return;
    }
    candidates.push(path.to_string());
}

fn node_source_config_path(config_path: &Path) -> Option<PathBuf> {
    config_path
        .parent()
        .map(|parent| parent.join(SINGDECK_CONFIG_FILE))
        .or_else(|| Some(PathBuf::from(SINGDECK_CONFIG_FILE)))
}

fn node_source_config_candidate_paths(config_path: &Path) -> Vec<PathBuf> {
    let primary = node_source_config_path(config_path)
        .unwrap_or_else(|| PathBuf::from(SINGDECK_CONFIG_FILE));
    let fallback = primary.with_file_name(SINGDECK_CONFIG_JSONC_FILE);
    if primary == fallback {
        vec![primary]
    } else {
        vec![primary, fallback]
    }
}

fn read_node_source_config_for_config_path(config_path: &Path) -> Result<NodeSourceConfig> {
    for sidecar_path in node_source_config_candidate_paths(config_path) {
        if !sidecar_path.exists() {
            continue;
        }

        let content = fs::read_to_string(&sidecar_path)
            .with_context(|| format!("read {}", sidecar_path.display()))?;
        let parse_content = if sidecar_path.extension().and_then(|value| value.to_str()) == Some("jsonc") {
            normalize_jsonc(&content)
        } else {
            content
        };
        let config: SingDeckSidecarConfig = serde_json::from_str(&parse_content)
            .with_context(|| format!("parse {}", sidecar_path.display()))?;
        return Ok(NodeSourceConfig {
            sources: config.node_sources,
        });
    }

    Ok(NodeSourceConfig::default())
}

fn normalize_jsonc(content: &str) -> String {
    strip_jsonc_trailing_commas(&strip_jsonc_comments(content))
}

fn strip_jsonc_comments(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(character) = chars.next() {
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
            output.push(character);
            continue;
        }

        if character != '/' {
            output.push(character);
            continue;
        }

        match chars.peek().copied() {
            Some('/') => {
                chars.next();
                for next in chars.by_ref() {
                    if next == '\n' {
                        output.push('\n');
                        break;
                    }
                }
            }
            Some('*') => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    if next == '\n' {
                        output.push('\n');
                    }
                    previous = next;
                }
            }
            _ => output.push(character),
        }
    }

    output
}

fn strip_jsonc_trailing_commas(content: &str) -> String {
    let mut output = String::with_capacity(content.len());
    let mut in_string = false;
    let mut escaped = false;

    for character in content.chars() {
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }

        if character == '"' {
            in_string = true;
            output.push(character);
            continue;
        }

        if character == '}' || character == ']' {
            if let Some((comma_index, _)) = output
                .char_indices()
                .rev()
                .find(|(_, existing)| !existing.is_whitespace())
                .filter(|(_, existing)| *existing == ',')
            {
                output.truncate(comma_index);
            }
        }
        output.push(character);
    }

    output
}

async fn sync_node_sources_on_startup(state: &AppState) -> Result<()> {
    let Some(config_path) = load_string_kv(state, "config_path")? else {
        return Ok(());
    };
    let source_config = read_node_source_config_for_config_path(Path::new(config_path.trim()))?;
    hide_unconfigured_node_sources(state, &source_config)?;
    if source_config.sources.is_empty() {
        return Ok(());
    }

    let controller = load_controller(state)?;
    let current_nodes = match fetch_proxies(state, &controller).await {
        Ok(proxies) => proxy_node_names(&proxies),
        Err(error) => {
            let message = format!("controller proxies unavailable: {error}");
            for source in source_config.sources.iter().filter(|source| source.associate) {
                save_node_source_error(state, source, message.clone())?;
            }
            return Err(anyhow!(message));
        }
    };

    sync_node_sources_with_nodes(state, &source_config, &current_nodes).await
}

async fn sync_node_sources_on_startup_with_retries(
    state: &AppState,
    attempts: usize,
    retry_delay: Duration,
) -> Result<()> {
    let attempts = attempts.max(1);
    let mut last_error = None;
    for attempt in 1..=attempts {
        match sync_node_sources_on_startup(state).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < attempts {
                    tokio::time::sleep(retry_delay).await;
                }
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow!("node source startup sync failed")))
}

async fn sync_node_sources_with_nodes(
    state: &AppState,
    config: &NodeSourceConfig,
    current_nodes: &[String],
) -> Result<()> {
    hide_unconfigured_node_sources(state, config)?;

    let mut seen = BTreeSet::new();
    let mut source_errors = Vec::new();
    for source in &config.sources {
        if !seen.insert(source.name.clone()) {
            let message = "duplicate source name".to_string();
            save_node_source_error(state, source, message.clone())?;
            source_errors.push(format!("{}: {message}", source.name.trim()));
            continue;
        }

        if !source.associate {
            save_node_source_metadata_preserving_links(state, source)?;
            continue;
        }

        let result = async {
            let content = state
                .http
                .get(source.url.trim())
                .header(header::USER_AGENT, NODE_SOURCE_FETCH_USER_AGENT)
                .send()
                .await
                .with_context(|| format!("fetch {}", source.url))?
                .error_for_status()
                .with_context(|| format!("fetch {}", source.url))?
                .text()
                .await
                .with_context(|| format!("read {}", source.url))?;
            let subscription_names = extract_subscription_node_names(&content)?;
            Ok::<_, anyhow::Error>(match_subscription_nodes(&subscription_names, current_nodes))
        }
        .await;

        match result {
            Ok(nodes) => save_node_source_links(state, source, &nodes, None)?,
            Err(error) => {
                let message = format!("{error:#}");
                save_node_source_error(state, source, message.clone())?;
                source_errors.push(format!("{}: {message}", source.name.trim()));
            }
        }
    }
    if source_errors.is_empty() {
        Ok(())
    } else {
        Err(anyhow!("node source sync failed: {}", source_errors.join("; ")))
    }
}

fn hide_unconfigured_node_sources(state: &AppState, config: &NodeSourceConfig) -> Result<()> {
    let configured_names = config
        .sources
        .iter()
        .map(|source| source.name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect::<BTreeSet<_>>();
    let db = state.db.lock().map_err(|_| anyhow!("database lock poisoned"))?;
    if configured_names.is_empty() {
        db.execute("DELETE FROM node_sources", [])?;
        return Ok(());
    }

    let existing_names = {
        let mut stmt = db.prepare("SELECT name FROM node_sources")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    for name in existing_names {
        if !configured_names.contains(name.trim()) {
            db.execute("DELETE FROM node_sources WHERE name = ?1", params![name])?;
        }
    }
    Ok(())
}

fn load_node_sources_response(state: &AppState) -> Result<NodeSourcesResponse> {
    let db = state.db.lock().map_err(|_| anyhow!("database lock poisoned"))?;
    let mut stmt = db.prepare(
        "SELECT name, url, associate, last_synced_ms, last_error, node_count
         FROM node_sources
         ORDER BY name",
    )?;
    let source_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;

    let mut sources = Vec::with_capacity(source_rows.len());
    for (name, url, associate, last_synced_ms, last_error, node_count) in source_rows {
        let nodes = load_node_source_nodes_from_db(&db, &name)?;
        sources.push(NodeSourceView {
            name,
            url,
            associate,
            last_synced_at: last_synced_ms.map(format_time),
            last_error,
            node_count: node_count.max(0) as usize,
            nodes,
        });
    }
    Ok(NodeSourcesResponse { sources })
}

fn load_node_source_nodes_from_db(db: &Connection, source_name: &str) -> Result<Vec<String>> {
    let mut stmt = db.prepare(
        "SELECT node_name FROM node_source_nodes WHERE source_name = ?1 ORDER BY node_name",
    )?;
    let nodes = stmt
        .query_map(params![source_name], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(nodes)
}

fn save_node_source_metadata_preserving_links(
    state: &AppState,
    source: &NodeSourceConfigEntry,
) -> Result<()> {
    let db = state.db.lock().map_err(|_| anyhow!("database lock poisoned"))?;
    let node_count = count_node_source_nodes_from_db(&db, &source.name)?;
    db.execute(
        "INSERT INTO node_sources (name, url, associate, last_synced_ms, last_error, node_count)
         VALUES (?1, ?2, ?3, COALESCE((SELECT last_synced_ms FROM node_sources WHERE name = ?1), NULL), NULL, ?4)
         ON CONFLICT(name) DO UPDATE SET
           url = excluded.url,
           associate = excluded.associate,
           last_error = NULL,
           node_count = excluded.node_count",
        params![source.name.trim(), source.url.trim(), bool_int(source.associate), node_count],
    )?;
    Ok(())
}

fn save_node_source_links(
    state: &AppState,
    source: &NodeSourceConfigEntry,
    nodes: &[String],
    error: Option<String>,
) -> Result<()> {
    let mut db = state.db.lock().map_err(|_| anyhow!("database lock poisoned"))?;
    let tx = db.transaction()?;
    tx.execute(
        "INSERT INTO node_sources (name, url, associate, last_synced_ms, last_error, node_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(name) DO UPDATE SET
           url = excluded.url,
           associate = excluded.associate,
           last_synced_ms = excluded.last_synced_ms,
           last_error = excluded.last_error,
           node_count = excluded.node_count",
        params![
            source.name.trim(),
            source.url.trim(),
            bool_int(source.associate),
            now_ms(),
            error,
            nodes.len() as i64
        ],
    )?;
    tx.execute(
        "DELETE FROM node_source_nodes WHERE source_name = ?1",
        params![source.name.trim()],
    )?;
    for node in nodes {
        tx.execute(
            "INSERT OR IGNORE INTO node_source_nodes (source_name, node_name) VALUES (?1, ?2)",
            params![source.name.trim(), node],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn save_node_source_error(
    state: &AppState,
    source: &NodeSourceConfigEntry,
    error: String,
) -> Result<()> {
    let db = state.db.lock().map_err(|_| anyhow!("database lock poisoned"))?;
    let node_count = count_node_source_nodes_from_db(&db, &source.name)?;
    db.execute(
        "INSERT INTO node_sources (name, url, associate, last_synced_ms, last_error, node_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(name) DO UPDATE SET
           url = excluded.url,
           associate = excluded.associate,
           last_synced_ms = excluded.last_synced_ms,
           last_error = excluded.last_error,
           node_count = excluded.node_count",
        params![
            source.name.trim(),
            source.url.trim(),
            bool_int(source.associate),
            now_ms(),
            error,
            node_count
        ],
    )?;
    Ok(())
}

fn count_node_source_nodes_from_db(db: &Connection, source_name: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM node_source_nodes WHERE source_name = ?1",
        params![source_name.trim()],
        |row| row.get::<_, i64>(0),
    )?)
}

fn bool_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

async fn read_config_raw(State(state): State<AppState>) -> Result<Response, AppError> {
    let Json(config) = read_config(State(state)).await?;
    if let Some(error) = config.error {
        return Err(AppError::bad_request(error));
    }
    if config.content.is_empty() {
        return Err(AppError::bad_request("config content is empty"));
    }

    let content_type = if config.format.eq_ignore_ascii_case("json") {
        "application/json; charset=utf-8"
    } else {
        "application/jsonc; charset=utf-8"
    };

    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"sing-box-config.json\"",
            ),
        ],
        config.content,
    )
        .into_response())
}

async fn read_traffic(
    State(state): State<AppState>,
) -> Result<Json<traffic::TrafficResponse>, AppError> {
    let settings = load_traffic_settings(&state)?;
    let profile = traffic::chrome_profile_path(&settings.browser_profile);
    if !settings.enabled {
        return Ok(Json(traffic::disabled_traffic_response(&profile)));
    }
    if profile.as_os_str().is_empty() {
        return Err(AppError::bad_request(
            "Chrome profile is not configured in Settings.",
        ));
    }
    Ok(Json(traffic::read_traffic(&state.http, &profile).await))
}

async fn probe_node(
    state: &AppState,
    controller: &ControllerConfig,
    group: &str,
    node: &str,
    probe_target: &str,
    test_url: &str,
    timeout_ms: i64,
    concurrency: usize,
    progress: Option<ProbeProgressContext>,
) -> Result<()> {
    let path = format!(
        "/proxies/{}/delay?timeout={}&url={}",
        url_encode(probe_target),
        timeout_ms,
        url_encode(test_url)
    );
    let _probe_permit = state.probe_limiter.acquire(concurrency).await;
    let _active_node = begin_active_probe_node(state, group, node);
    let tested_at_ms = now_ms();
    let result = controller_get::<serde_json::Value>(state, controller, &path).await;
    match result {
        Ok(value) => {
            let delay = value.get("delay").and_then(|item| item.as_i64());
            save_probe_sample(
                state,
                group,
                node,
                test_url,
                delay,
                true,
                None,
                tested_at_ms,
            )?;
        }
        Err(error) => {
            let error = error.to_string();
            save_probe_sample(
                state,
                group,
                node,
                test_url,
                None,
                false,
                Some(error.clone()),
                tested_at_ms,
            )?;
        }
    }
    if let Some(progress) = progress.as_ref() {
        publish_probe_progress_score(state, group, node, &progress.config)?;
    }
    Ok(())
}

async fn probe_group_internal(
    state: &AppState,
    group: &str,
    concurrency: usize,
    apply_urltest: bool,
) -> Result<ScoresResponse> {
    let controller = load_controller(state)?;
    let proxies = fetch_proxies(state, &controller).await?;
    let proxy_map = proxy_map(&proxies);
    let group_proxy = proxy_map
        .get(group)
        .ok_or_else(|| anyhow!("group not found: {group}"))?;
    let config = load_group_config(state, group)?;

    if uses_native_urltest_delay(group_proxy, &config) {
        let scores = compute_scores_for_group(state, group, &group_proxy.all, &config)?;
        let recommended = if group_proxy.now.is_empty() {
            recommended_node(&scores)
        } else {
            Some(group_proxy.now.clone())
        };

        let response = ScoresResponse {
            group: group.to_string(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url,
            recommended,
            apply_error: None,
            nodes: scores,
        };
        publish_helper_event(
            state,
            HelperEvent::ProbeScores {
                scores: response.clone(),
                partial: false,
            },
        );
        return Ok(response);
    }

    let run_status =
        probe_group_nodes(state, &controller, group, group_proxy, &config, concurrency, &proxy_map).await?;
    if run_status == ProbeRunStatus::Skipped {
        let scores = compute_scores_for_group(state, group, &group_proxy.all, &config)?;
        return Ok(ScoresResponse {
            group: group.to_string(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url,
            recommended: recommended_node(&scores),
            apply_error: None,
            nodes: scores,
        });
    }

    let scores = compute_scores_after_probe_run(state, group, &group_proxy.all, &config)?;
    let recommended = recommended_node(&scores);
    let apply_error = if should_apply_probe_result(apply_urltest, &config) {
        if let Some(target) = recommended.as_deref() {
            apply_recommended_node(state, &controller, group_proxy, target).await
        } else {
            None
        }
    } else {
        None
    };

    let response = ScoresResponse {
        group: group.to_string(),
        mode: config.mode,
        scheme: config.scheme,
        test_url: config.test_url,
        recommended,
        apply_error,
        nodes: scores,
    };
    save_last_probe_snapshot(state, &response)?;
        publish_helper_event(
            state,
            HelperEvent::ProbeScores {
                scores: response.clone(),
                partial: false,
            },
        );
    Ok(response)
}

async fn probe_group_nodes(
    state: &AppState,
    controller: &ControllerConfig,
    group: &str,
    group_proxy: &ProxyView,
    config: &GroupConfig,
    concurrency: usize,
    proxy_map: &HashMap<String, ProxyView>,
) -> Result<ProbeRunStatus> {
    let concurrency = normalize_probe_concurrency(concurrency);
    let active_probe = begin_active_probe(state, group);
    if !active_probe.is_active() {
        return Ok(ProbeRunStatus::Skipped);
    }
    let timeout_ms = load_delay_test_timeout_ms(state)?;
    let progress = ProbeProgressContext {
        config: config.clone(),
    };
    let nodes = group_proxy.all.clone();
    let mut next_index = 0_usize;
    let mut tasks = tokio::task::JoinSet::new();
    spawn_probe_workers(
        &mut tasks,
        &mut next_index,
        &nodes,
        concurrency,
        concurrency,
        state,
        controller,
        group,
        config,
        proxy_map,
        timeout_ms,
        &progress,
    );

    while let Some(result) = tasks.join_next().await {
        result.map_err(|error| anyhow!("probe task failed: {error}"))??;
        spawn_probe_workers(
            &mut tasks,
            &mut next_index,
            &nodes,
            1,
            concurrency,
            state,
            controller,
            group,
            config,
            proxy_map,
            timeout_ms,
            &progress,
        );
    }
    Ok(ProbeRunStatus::Ran)
}

#[allow(clippy::too_many_arguments)]
fn spawn_probe_workers(
    tasks: &mut tokio::task::JoinSet<Result<()>>,
    next_index: &mut usize,
    nodes: &[String],
    max_to_spawn: usize,
    concurrency: usize,
    state: &AppState,
    controller: &ControllerConfig,
    group: &str,
    config: &GroupConfig,
    proxy_map: &HashMap<String, ProxyView>,
    timeout_ms: i64,
    progress: &ProbeProgressContext,
) {
    for _ in 0..max_to_spawn {
        let Some(node) = nodes.get(*next_index) else {
            return;
        };
        *next_index += 1;

        let state_clone = state.clone();
        let controller_clone = controller.clone();
        let group_name = group.to_string();
        let test_url = config.test_url.clone();
        let node_name = node.clone();
        let probe_target = resolve_leaf_proxy_name(node, proxy_map);
        let progress = progress.clone();
        tasks.spawn(async move {
            probe_node(
                &state_clone,
                &controller_clone,
                &group_name,
                &node_name,
                &probe_target,
                &test_url,
                timeout_ms,
                concurrency,
                Some(progress),
            )
            .await
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeRunStatus {
    Ran,
    Skipped,
}

async fn apply_recommended_node(
    state: &AppState,
    controller: &ControllerConfig,
    group_proxy: &ProxyView,
    target: &str,
) -> Option<String> {
    if !is_switchable_kind(&group_proxy.kind) {
        return Some(format!(
            "{} is {}, but Clash API can only switch Selector groups",
            group_proxy.name, group_proxy.kind
        ));
    }

    if group_proxy.now == target {
        return None;
    }

    let body = serde_json::json!({ "name": target });
    controller_put(
        state,
        controller,
        &format!("/proxies/{}", url_encode(&group_proxy.name)),
        &body,
    )
    .await
    .err()
    .map(|error| error.to_string())
}

fn is_switchable_kind(kind: &str) -> bool {
    kind.eq_ignore_ascii_case("selector")
}

fn is_urltest_kind(kind: &str) -> bool {
    let normalized = kind
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    normalized.contains("urltest")
}

fn is_fallback_kind(kind: &str) -> bool {
    kind.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .eq_ignore_ascii_case("fallback")
}

fn uses_native_urltest_delay(group_proxy: &ProxyView, config: &GroupConfig) -> bool {
    matches!(config.mode, ScoreMode::Delay)
        && (is_urltest_kind(&group_proxy.kind) || is_fallback_kind(&group_proxy.kind))
}

fn should_apply_probe_result(apply_requested: bool, config: &GroupConfig) -> bool {
    apply_requested && config.auto_switch
}

fn spawn_probe_scheduler(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Err(error) = run_scheduled_probes(&state, true).await {
            eprintln!("startup scheduled probe failed: {error}");
        }

        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        loop {
            ticker.tick().await;
            if let Err(error) = run_scheduled_probes(&state, false).await {
                eprintln!("scheduled probe failed: {error}");
            }
        }
    });
}

fn spawn_node_source_startup_sync(state: AppState) {
    tokio::spawn(async move {
        if let Err(error) = sync_node_sources_on_startup_with_retries(
            &state,
            NODE_SOURCE_STARTUP_SYNC_ATTEMPTS,
            Duration::from_millis(NODE_SOURCE_STARTUP_SYNC_RETRY_MS),
        )
        .await
        {
            eprintln!("node source startup sync failed: {error}");
        }
    });
}

fn spawn_realtime_event_publisher(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(REALTIME_EVENT_INTERVAL_MS));
        loop {
            ticker.tick().await;
            if state.events.receiver_count() == 0 {
                continue;
            }
            if let Err(error) = publish_realtime_snapshot_events(&state).await {
                publish_helper_event(
                    &state,
                    HelperEvent::Error {
                        scope: "realtime".to_string(),
                        message: error.to_string(),
                    },
                );
            }
        }
    });
}

fn spawn_network_usage_sampler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(Duration::from_millis(NETWORK_USAGE_SAMPLE_INTERVAL_MS));
        loop {
            ticker.tick().await;
            if let Err(error) = sample_network_usage(&state).await {
                eprintln!("network usage sample failed: {error}");
            }
        }
    });
}

async fn sample_network_usage(state: &AppState) -> Result<()> {
    let settings = {
        let db = state
            .db
            .lock()
            .map_err(|_| anyhow!("database lock poisoned"))?;
        network_usage::load_settings(&db)?
    };
    if !settings.enabled {
        return Ok(());
    }

    let controller = load_controller(state)?;
    if controller.controller_url.is_empty() {
        return Ok(());
    }

    let snapshot = controller_get::<serde_json::Value>(state, &controller, "/connections").await?;
    let sampled_at_ms = now_ms();
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    network_usage::apply_connections_snapshot(&db, &snapshot, sampled_at_ms)?;
    network_usage::cleanup_old_usage(&db, sampled_at_ms, settings.retention_days)?;
    Ok(())
}

async fn publish_realtime_snapshot_events(state: &AppState) -> Result<()> {
    let controller = load_controller(state)?;
    if controller.controller_url.is_empty() {
        return Ok(());
    }

    let configs = controller_get::<serde_json::Value>(state, &controller, "/configs")
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let connections =
        controller_get::<serde_json::Value>(state, &controller, "/connections").await?;
    let traffic = controller_traffic_json(state, &controller)
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    let sampled_at = format_time(now_ms());

    publish_helper_event(
        state,
        build_connections_snapshot_event(connections.clone(), sampled_at.clone()),
    );
    publish_helper_event(
        state,
        build_traffic_snapshot_event(configs, connections, traffic, sampled_at),
    );
    Ok(())
}

fn build_connections_snapshot_event(
    snapshot: serde_json::Value,
    sampled_at: String,
) -> HelperEvent {
    HelperEvent::ConnectionsSnapshot {
        snapshot,
        sampled_at,
    }
}

fn build_traffic_snapshot_event(
    configs: serde_json::Value,
    connections: serde_json::Value,
    traffic: serde_json::Value,
    sampled_at: String,
) -> HelperEvent {
    HelperEvent::TrafficSnapshot {
        up: traffic
            .get("up")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        down: traffic
            .get("down")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        upload_total: connections
            .get("uploadTotal")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        download_total: connections
            .get("downloadTotal")
            .and_then(|value| value.as_i64())
            .unwrap_or(0),
        connection_count: connections
            .get("connections")
            .and_then(|value| value.as_array())
            .map(|connections| connections.len())
            .unwrap_or(0),
        mode: configs
            .get("mode")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
            .to_string(),
        sampled_at,
    }
}

async fn run_scheduled_probes(state: &AppState, force: bool) -> Result<()> {
    let controller = load_controller(state)?;
    if controller.controller_url.is_empty() {
        return Ok(());
    }
    let probe_concurrency = load_probe_concurrency(state)?;

    let proxies = match fetch_proxies(state, &controller).await {
        Ok(proxies) => proxies,
        Err(error) if is_controller_poll_error(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
    let proxy_map = proxy_map(&proxies);
    for group in proxy_groups(&proxies) {
        let config = load_group_config(state, &group.name)?;
        if !config.auto_probe {
            continue;
        }
        if uses_native_urltest_delay(&group, &config) {
            continue;
        }

        let now = now_ms();
        let last_key = format!("auto_probe_last:{}", group.name);
        let last_run = load_string_kv(state, &last_key)?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let due = force
            || last_run == 0
            || now - last_run >= normalize_probe_interval(config.probe_interval_sec) * 1000;
        if !due {
            continue;
        }

        let run_status =
            probe_group_nodes(
                state,
                &controller,
                &group.name,
                &group,
                &config,
                probe_concurrency,
                &proxy_map,
            )
            .await?;
        if run_status == ProbeRunStatus::Skipped {
            continue;
        }

        let scores = compute_scores_after_probe_run(state, &group.name, &group.all, &config)?;
        if config.auto_switch {
            if let Some(target) = recommended_node(&scores) {
                if let Some(error) =
                    apply_recommended_node(state, &controller, &group, &target).await
                {
                    eprintln!("auto switch failed for {}: {error}", group.name);
                }
            }
        }
        let response = ScoresResponse {
            group: group.name.clone(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url.clone(),
            recommended: recommended_node(&scores),
            apply_error: None,
            nodes: scores,
        };
        save_last_probe_snapshot(state, &response)?;
        publish_helper_event(
            state,
            HelperEvent::ProbeScores {
                scores: response,
                partial: false,
            },
        );
        save_string_kv(state, &last_key, &now.to_string())?;
    }

    observe_failed_request_logs(state, &controller, &proxies).await?;

    Ok(())
}

async fn observe_failed_request_logs(
    state: &AppState,
    controller: &ControllerConfig,
    proxies: &ClashProxiesResponse,
) -> Result<()> {
    let log_chunk = controller_log_chunk(state, controller).await?;
    if log_chunk.trim().is_empty() {
        return Ok(());
    }

    for group in proxy_groups(proxies) {
        let config = load_group_config(state, &group.name)?;
        if !config.auto_probe || !network_failure_log_chunk_matches_group(&log_chunk, &group) {
            continue;
        }
        if uses_native_urltest_delay(&group, &config) {
            continue;
        }

        let now = now_ms();
        let last_key = format!("failure_probe_last:{}", group.name);
        let last_run = load_string_kv(state, &last_key)?
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        if now - last_run < FAILURE_PROBE_COOLDOWN_MS {
            continue;
        }

        save_string_kv(state, &last_key, &now.to_string())?;
        let probe_concurrency = load_probe_concurrency(state)?;
        if let Err(error) = probe_group_internal(state, &group.name, probe_concurrency, true).await {
            eprintln!("request-failure probe failed for {}: {error}", group.name);
        }
    }

    Ok(())
}

async fn controller_log_chunk(state: &AppState, controller: &ControllerConfig) -> Result<String> {
    if controller.controller_url.is_empty() {
        return Ok(String::new());
    }

    let response = tokio::time::timeout(
        Duration::from_secs(4),
        state
            .http
            .get(format!(
                "{}/logs",
                controller.controller_url.trim_end_matches('/')
            ))
            .bearer_auth_if(&controller.secret)
            .send(),
    )
    .await;
    let mut response = match response {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => return Ok(String::new()),
        Err(_) => return Ok(String::new()),
    };

    if !response.status().is_success() {
        return Ok(String::new());
    }

    let chunk = tokio::time::timeout(Duration::from_secs(4), response.chunk()).await;
    match chunk {
        Ok(Ok(Some(bytes))) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Ok(Ok(None)) | Err(_) => Ok(String::new()),
        Ok(Err(_)) => Ok(String::new()),
    }
}

async fn controller_traffic_json(
    state: &AppState,
    controller: &ControllerConfig,
) -> Result<serde_json::Value> {
    if controller.controller_url.is_empty() {
        return Ok(serde_json::json!({}));
    }

    let response = tokio::time::timeout(
        Duration::from_secs(4),
        state
            .http
            .get(format!(
                "{}/traffic",
                controller.controller_url.trim_end_matches('/')
            ))
            .bearer_auth_if(&controller.secret)
            .send(),
    )
    .await??;
    if !response.status().is_success() {
        return Err(anyhow!("controller returned HTTP {}", response.status()));
    }

    let mut response = response;
    let Some(bytes) = tokio::time::timeout(Duration::from_secs(4), response.chunk()).await?? else {
        return Ok(serde_json::json!({}));
    };
    let text = String::from_utf8_lossy(&bytes);
    let line = text
        .split(['\r', '\n'])
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("{}");
    Ok(serde_json::from_str(line).unwrap_or_else(|_| serde_json::json!({})))
}

fn is_controller_poll_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("error sending request")
        || message.contains("controller returned HTTP")
        || message.contains("operation timed out")
        || message.contains("connection refused")
        || message.contains("connection reset")
}

fn network_failure_log_chunk_matches_group(log_chunk: &str, group: &ProxyView) -> bool {
    log_chunk
        .lines()
        .any(|line| network_failure_log_matches_group(line, group))
}

fn network_failure_log_matches_group(line: &str, group: &ProxyView) -> bool {
    let text = normalized_log_text(line);
    let lower = text.to_ascii_lowercase();
    if lower.contains("delay test") || lower.contains("/delay") || lower.contains("probe") {
        return false;
    }

    if !is_network_failure_text(&lower) {
        return false;
    }

    label_matches(&text, &group.name)
        || label_matches(&text, &group.now)
        || group.all.iter().any(|node| label_matches(&text, node))
}

fn normalized_log_text(line: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        let parts = ["level", "type", "message", "payload"]
            .iter()
            .filter_map(|key| value.get(*key).and_then(|item| item.as_str()))
            .collect::<Vec<_>>();
        if !parts.is_empty() {
            return parts.join(" ");
        }
    }

    line.to_string()
}

fn is_network_failure_text(lower: &str) -> bool {
    [
        "timeout",
        "timed out",
        "i/o timeout",
        "failed",
        "failure",
        "network is unreachable",
        "connection refused",
        "refused",
        "connection reset",
        "reset by peer",
        "no route",
        "eof",
        "broken pipe",
        "deadline exceeded",
        "tls handshake",
        "dns error",
        "status 5",
        "http 5",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn label_matches(text: &str, label: &str) -> bool {
    let label = label.trim();
    if label.is_empty() {
        return false;
    }

    let text = text.to_ascii_lowercase();
    let label = label.to_ascii_lowercase();
    if label
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return text
            .split(|character: char| {
                !(character.is_ascii_alphanumeric() || character == '-' || character == '_')
            })
            .any(|part| part == label);
    }

    text.contains(&label)
}

#[derive(Debug, Clone)]
struct ProxyView {
    name: String,
    kind: String,
    now: String,
    all: Vec<String>,
}

fn proxy_groups(response: &ClashProxiesResponse) -> Vec<ProxyView> {
    let mut groups = response
        .proxies
        .as_ref()
        .into_iter()
        .flat_map(|proxies| proxies.iter())
        .filter_map(|(name, proxy)| {
            let all = proxy.all.clone().unwrap_or_default();
            if all.is_empty() {
                return None;
            }
            Some(ProxyView {
                name: proxy.name.clone().unwrap_or_else(|| name.clone()),
                kind: proxy
                    .proxy_type
                    .clone()
                    .unwrap_or_else(|| "Unknown".to_string()),
                now: proxy.now.clone().unwrap_or_default(),
                all,
            })
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| left.name.cmp(&right.name));
    groups
}

fn proxy_map(response: &ClashProxiesResponse) -> HashMap<String, ProxyView> {
    proxy_groups(response)
        .into_iter()
        .map(|proxy| (proxy.name.clone(), proxy))
        .collect()
}

fn proxy_node_names(response: &ClashProxiesResponse) -> Vec<String> {
    let mut names = response
        .proxies
        .as_ref()
        .into_iter()
        .flat_map(|proxies| proxies.iter())
        .filter_map(|(name, proxy)| {
            if proxy.all.as_ref().is_some_and(|all| !all.is_empty()) {
                return None;
            }
            Some(proxy.name.clone().unwrap_or_else(|| name.clone()))
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

fn extract_subscription_node_names(content: &str) -> Result<Vec<String>> {
    let decoded = decode_base64_text(content)?;
    let mut names = Vec::new();
    decoded
        .lines()
        .filter_map(subscription_line_node_name)
        .for_each(|name| {
            if !names.iter().any(|existing| existing == &name) {
                names.push(name);
            }
        });
    Ok(names)
}

fn decode_base64_text(content: &str) -> Result<String> {
    let compact = content.split_whitespace().collect::<String>();
    for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        if let Ok(bytes) = engine.decode(&compact) {
            return String::from_utf8(bytes).context("subscription is not utf-8 after base64 decode");
        }
    }
    Err(anyhow!("subscription is not valid base64"))
}

fn subscription_line_node_name(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    if let Some(encoded) = line.strip_prefix("vmess://") {
        return decode_base64_text(encoded)
            .ok()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .and_then(|value| value.get("ps").and_then(|item| item.as_str()).map(str::to_string))
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
    }

    line.rsplit_once('#')
        .map(|(_, fragment)| percent_decode(fragment))
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn match_subscription_nodes(subscription_names: &[String], current_nodes: &[String]) -> Vec<String> {
    let current_by_exact = current_nodes
        .iter()
        .map(|node| (node.as_str(), node.as_str()))
        .collect::<HashMap<_, _>>();
    let mut current_by_normalized = HashMap::new();
    current_nodes.iter().for_each(|node| {
        current_by_normalized
            .entry(normalize_node_name(node))
            .or_insert(node.as_str());
    });
    let mut matched = BTreeSet::new();

    subscription_names.iter().for_each(|name| {
        if let Some(node) = current_by_exact.get(name.as_str()) {
            matched.insert((*node).to_string());
            return;
        }
        if let Some(node) = current_by_normalized.get(&normalize_node_name(name)) {
            matched.insert((*node).to_string());
        }
    });

    matched.into_iter().collect()
}

fn normalize_node_name(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn resolve_leaf_proxy_name(name: &str, proxies: &HashMap<String, ProxyView>) -> String {
    let mut current_name = name.to_string();
    let mut visited = std::collections::HashSet::new();

    while visited.insert(current_name.clone()) {
        let Some(proxy) = proxies.get(&current_name) else {
            break;
        };
        if proxy.now.is_empty() {
            break;
        }
        current_name = proxy.now.clone();
    }

    current_name
}

async fn fetch_proxies(
    state: &AppState,
    controller: &ControllerConfig,
) -> Result<ClashProxiesResponse> {
    controller_get(state, controller, "/proxies").await
}

async fn controller_get<T: for<'de> Deserialize<'de>>(
    state: &AppState,
    controller: &ControllerConfig,
    path: &str,
) -> Result<T> {
    if controller.controller_url.is_empty() {
        return Err(anyhow!("controller URL is not configured"));
    }
    let response = state
        .http
        .get(format!("{}{}", controller.controller_url, path))
        .bearer_auth_if(&controller.secret)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("controller returned HTTP {}", response.status()));
    }
    Ok(response.json::<T>().await?)
}

async fn controller_put<T: Serialize + ?Sized>(
    state: &AppState,
    controller: &ControllerConfig,
    path: &str,
    body: &T,
) -> Result<()> {
    let response = state
        .http
        .put(format!("{}{}", controller.controller_url, path))
        .bearer_auth_if(&controller.secret)
        .json(body)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow!("controller returned HTTP {}", response.status()));
    }
    Ok(())
}

trait BearerAuthIf {
    fn bearer_auth_if(self, secret: &str) -> reqwest::RequestBuilder;
}

impl BearerAuthIf for reqwest::RequestBuilder {
    fn bearer_auth_if(self, secret: &str) -> reqwest::RequestBuilder {
        if secret.is_empty() {
            self
        } else {
            self.bearer_auth(secret)
        }
    }
}

fn load_controller(state: &AppState) -> Result<ControllerConfig> {
    load_json_kv(state, "controller").map(|value| value.unwrap_or_default())
}

fn load_default_test_url(state: &AppState) -> Result<String> {
    Ok(load_string_kv(state, "default_test_url")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TEST_URL.to_string()))
}

fn load_delay_test_timeout_ms(state: &AppState) -> Result<i64> {
    Ok(load_string_kv(state, "delay_test_timeout_ms")?
        .and_then(|value| value.parse::<i64>().ok())
        .map(normalize_delay_test_timeout)
        .unwrap_or(DEFAULT_DELAY_TEST_TIMEOUT_MS))
}

fn load_min_probe_interval_sec(state: &AppState) -> Result<i64> {
    Ok(load_string_kv(state, "min_probe_interval_sec")?
        .and_then(|value| value.parse::<i64>().ok())
        .map(normalize_min_probe_interval)
        .unwrap_or(DEFAULT_MIN_PROBE_INTERVAL_SEC))
}

fn load_probe_concurrency(state: &AppState) -> Result<usize> {
    Ok(load_string_kv(state, "probe_concurrency")?
        .and_then(|value| value.parse::<usize>().ok())
        .map(normalize_probe_concurrency)
        .unwrap_or(DEFAULT_PROBE_CONCURRENCY))
}

fn default_traffic_settings() -> TrafficSettings {
    TrafficSettings {
        enabled: false,
        browser_profile: String::new(),
    }
}

fn normalize_traffic_settings(settings: TrafficSettings) -> TrafficSettings {
    let browser_profile = settings.browser_profile.trim();
    TrafficSettings {
        enabled: settings.enabled,
        browser_profile: browser_profile.to_string(),
    }
}

fn load_traffic_settings(state: &AppState) -> Result<TrafficSettings> {
    load_json_kv(state, "traffic_settings").map(|settings| {
        settings
            .map(normalize_traffic_settings)
            .unwrap_or_else(default_traffic_settings)
    })
}

fn save_traffic_settings_row(state: &AppState, settings: &TrafficSettings) -> Result<()> {
    save_json_kv(
        state,
        "traffic_settings",
        &normalize_traffic_settings(settings.clone()),
    )
}

fn load_group_config(state: &AppState, group: &str) -> Result<GroupConfig> {
    let default_test_url = load_default_test_url(state)?;
    let min_probe_interval_sec = load_min_probe_interval_sec(state)?;
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    let row = db
        .query_row(
            "SELECT test_url, test_url_overridden, mode, scheme, auto_switch, auto_probe, probe_interval_sec FROM group_configs WHERE group_name = ?1",
            params![group],
            |row| {
                let raw_test_url: String = row.get(0)?;
                let test_url_overridden = row.get::<_, i64>(1)? != 0;
                let probe_interval_sec =
                    normalize_probe_interval_with_min(row.get::<_, i64>(6)?, min_probe_interval_sec);
                Ok(GroupConfig {
                    test_url: if test_url_overridden {
                        raw_test_url
                    } else {
                        default_test_url.clone()
                    },
                    test_url_overridden,
                    mode: parse_mode(row.get::<_, String>(2)?.as_str()),
                    scheme: parse_scheme(row.get::<_, String>(3)?.as_str()),
                    auto_switch: row.get::<_, i64>(4)? != 0,
                    auto_probe: row.get::<_, i64>(5)? != 0,
                    probe_interval_sec,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or_else(|| GroupConfig::with_default_test_url(default_test_url)))
}

fn save_group_config_row(state: &AppState, group: &str, config: &GroupConfig) -> Result<()> {
    let min_probe_interval_sec = load_min_probe_interval_sec(state)?;
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    db.execute(
        r#"
        INSERT INTO group_configs(group_name, test_url, test_url_overridden, mode, scheme, auto_switch, auto_probe, probe_interval_sec)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(group_name) DO UPDATE SET
          test_url = excluded.test_url,
          test_url_overridden = excluded.test_url_overridden,
          mode = excluded.mode,
          scheme = excluded.scheme,
          auto_switch = excluded.auto_switch,
          auto_probe = excluded.auto_probe,
          probe_interval_sec = excluded.probe_interval_sec
        "#,
        params![
            group,
            config.test_url,
            if config.test_url_overridden { 1 } else { 0 },
            mode_name(config.mode),
            scheme_name(config.scheme),
            if config.auto_switch { 1 } else { 0 },
            if config.auto_probe { 1 } else { 0 },
            normalize_probe_interval_with_min(config.probe_interval_sec, min_probe_interval_sec)
        ],
    )?;
    Ok(())
}

fn save_probe_sample(
    state: &AppState,
    group: &str,
    node: &str,
    test_url: &str,
    delay_ms: Option<i64>,
    success: bool,
    error: Option<String>,
    tested_at_ms: i64,
) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    db.execute(
        r#"
        INSERT INTO probe_samples(group_name, node_name, test_url, delay_ms, success, error, tested_at_ms)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
        params![
            group,
            node,
            test_url,
            delay_ms,
            if success { 1 } else { 0 },
            error,
            tested_at_ms
        ],
    )?;
    Ok(())
}

fn compute_scores_for_group(
    state: &AppState,
    group: &str,
    nodes: &[String],
    config: &GroupConfig,
) -> Result<Vec<NodeScore>> {
    let mut scores = nodes
        .iter()
        .map(|node| {
            let samples = load_recent_samples(
                state,
                group,
                node,
                &config.test_url,
                score_sample_window_ms(config),
            )?;
            Ok(score_node(node, &samples, config))
        })
        .collect::<Result<Vec<_>>>()?;
    sort_node_scores(&mut scores, config);
    Ok(scores)
}

fn compute_scores_after_probe_run(
    state: &AppState,
    group: &str,
    nodes: &[String],
    config: &GroupConfig,
) -> Result<Vec<NodeScore>> {
    compute_scores_for_group(state, group, nodes, config)
}

fn recommended_node(scores: &[NodeScore]) -> Option<String> {
    scores
        .iter()
        .find(|score| score.raw.success)
        .map(|score| score.name.clone())
}

fn save_last_probe_snapshot(state: &AppState, response: &ScoresResponse) -> Result<()> {
    save_json_kv(state, &last_probe_snapshot_key(&response.group), response)
}

#[cfg(test)]
fn load_last_probe_snapshot(
    state: &AppState,
    group: &str,
    config: &GroupConfig,
) -> Result<Option<ScoresResponse>> {
    Ok(
        load_json_kv::<ScoresResponse>(state, &last_probe_snapshot_key(group))?.filter(
            |snapshot| {
                snapshot.group == group
                    && snapshot.mode == config.mode
                    && snapshot.scheme == config.scheme
                    && snapshot.test_url == config.test_url
                    && score_snapshot_matches_current_algorithm(snapshot)
            },
        ),
    )
}

#[cfg(test)]
fn score_snapshot_matches_current_algorithm(snapshot: &ScoresResponse) -> bool {
    snapshot.nodes.iter().all(|node| {
        node.raw.sample_window_sec.is_some()
            && node.raw.confidence.is_some()
            && node.raw.gate_reason.is_some()
    })
}

fn last_probe_snapshot_key(group: &str) -> String {
    format!("last_probe_snapshot:{group}")
}

fn sort_node_scores(scores: &mut [NodeScore], config: &GroupConfig) {
    match config.mode {
        ScoreMode::Delay => scores.sort_by(compare_delay_then_name),
        ScoreMode::Score => scores.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| compare_delay_then_name(left, right))
        }),
    }
}

fn compare_delay_then_name(left: &NodeScore, right: &NodeScore) -> std::cmp::Ordering {
    match (left.delay_ms, right.delay_ms) {
        (Some(left_delay), Some(right_delay)) => left_delay
            .cmp(&right_delay)
            .then_with(|| left.name.cmp(&right.name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.name.cmp(&right.name),
    }
}

fn load_recent_samples(
    state: &AppState,
    group: &str,
    node: &str,
    test_url: &str,
    window_ms: i64,
) -> Result<Vec<Sample>> {
    let window_start = now_ms() - window_ms;
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    let mut stmt = db.prepare(
        r#"
        SELECT delay_ms, success, error, tested_at_ms
        FROM (
          SELECT delay_ms, success, error, tested_at_ms
          FROM probe_samples
          WHERE group_name = ?1 AND node_name = ?2 AND test_url = ?3 AND tested_at_ms >= ?4
          ORDER BY tested_at_ms DESC
          LIMIT ?5
        )
        ORDER BY tested_at_ms ASC
        "#,
    )?;
    let rows = stmt.query_map(
        params![group, node, test_url, window_start, MAX_SCORE_SAMPLE_COUNT],
        |row| {
            Ok(Sample {
                delay_ms: row.get(0)?,
                success: row.get::<_, i64>(1)? != 0,
                error: row.get(2)?,
                tested_at_ms: row.get(3)?,
            })
        },
    )?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn score_sample_window_ms(config: &GroupConfig) -> i64 {
    (normalize_probe_interval(config.probe_interval_sec)
        * SCORE_SAMPLE_WINDOW_INTERVAL_MULTIPLIER
        * 1000)
        .max(MIN_SCORE_SAMPLE_WINDOW_MS)
}

fn score_sample_window_sec(config: &GroupConfig) -> i64 {
    score_sample_window_ms(config) / 1000
}

fn score_node(name: &str, samples: &[Sample], config: &GroupConfig) -> NodeScore {
    score_node_at(name, samples, config, now_ms())
}

fn score_node_at(name: &str, samples: &[Sample], config: &GroupConfig, now: i64) -> NodeScore {
    let raw = score_raw_from_samples(samples, config, now);
    let latest = samples.last();
    if latest.is_none() {
        return zero_node_score(name, None, None, raw);
    }
    if let Some(sample) = latest.filter(|sample| !sample.success) {
        return zero_node_score(name, sample.error.clone(), Some(sample.tested_at_ms), raw);
    }
    if raw.gate_reason.as_deref() == Some("expired") {
        return zero_node_score(
            name,
            latest.and_then(|sample| sample.error.clone()),
            latest.map(|sample| sample.tested_at_ms),
            raw,
        );
    }
    let delay_ms = latest.and_then(|sample| {
        if sample.success {
            sample.delay_ms
        } else {
            None
        }
    });
    let components = ScoreComponents {
        latency: real_latency_score(samples),
        availability: availability_score(samples),
        jitter: jitter_score(samples),
        freshness: freshness_gate_score(raw.freshness_state.as_deref()),
    };
    let mut score = match config.mode {
        ScoreMode::Delay => components.latency,
        ScoreMode::Score => weighted_score(components, config.scheme),
    };
    if raw.freshness_state.as_deref() == Some("stale") {
        score = score.min(80.0);
    }
    NodeScore {
        name: name.to_string(),
        score: round_score(score),
        delay_ms,
        components: round_components(components),
        last_tested_at: latest.map(|sample| format_time(sample.tested_at_ms)),
        error: latest.and_then(|sample| sample.error.clone()),
        raw,
    }
}

fn zero_node_score(
    name: &str,
    error: Option<String>,
    tested_at_ms: Option<i64>,
    mut raw: NodeScoreRaw,
) -> NodeScore {
    if raw.error.is_none() {
        raw.error = error.clone();
    }
    if raw.tested_at.is_none() {
        raw.tested_at = tested_at_ms.map(format_time);
    }
    NodeScore {
        name: name.to_string(),
        score: 0.0,
        delay_ms: None,
        components: ScoreComponents::default(),
        last_tested_at: tested_at_ms.map(format_time),
        error: error.clone(),
        raw,
    }
}

fn score_raw_from_samples(samples: &[Sample], config: &GroupConfig, now: i64) -> NodeScoreRaw {
    let latest = samples.last();
    let success_count = samples.iter().filter(|sample| sample.success).count();
    let failure_count = samples.len().saturating_sub(success_count);
    let confidence = sample_confidence(samples.len());
    let mut delays = samples
        .iter()
        .filter_map(|sample| {
            if sample.success {
                sample.delay_ms
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    delays.sort_unstable();
    let latency_p50_ms = (!delays.is_empty()).then(|| percentile(&delays, 0.50));
    let latency_p90_ms = (!delays.is_empty()).then(|| percentile(&delays, 0.90));
    let jitter_ms = latency_p50_ms
        .zip(latency_p90_ms)
        .map(|(p50, p95)| (p95 - p50).max(0));
    let latest_tested_at = latest.map(|sample| sample.tested_at_ms);
    let weights = score_weights(config.scheme);
    let freshness_age_ms = latest_tested_at.map(|tested_at| (now - tested_at).max(0));
    let freshness_state = freshness_age_ms.map(|age| freshness_state(age, config).to_string());
    let gate_reason = score_gate_reason(latest, freshness_state.as_deref());
    NodeScoreRaw {
        success: latest.map(|sample| sample.success).unwrap_or(false),
        delay_ms: latest.and_then(|sample| {
            if sample.success {
                sample.delay_ms
            } else {
                None
            }
        }),
        error: latest.and_then(|sample| sample.error.clone()),
        tested_at: latest_tested_at.map(format_time),
        sample_window_sec: Some(score_sample_window_sec(config)),
        sample_count: samples.len(),
        success_count,
        failure_count,
        confidence: Some(confidence),
        latency_delay_ms: latest.and_then(|sample| {
            if sample.success {
                sample.delay_ms
            } else {
                None
            }
        }),
        latency_p50_ms,
        latency_p90_ms,
        jitter_p50_ms: latency_p50_ms,
        jitter_p95_ms: latency_p90_ms,
        jitter_ms,
        freshness_age_ms,
        freshness_state,
        gate_reason: Some(gate_reason.to_string()),
        mode: Some(mode_name(config.mode).to_string()),
        scheme: Some(scheme_name(config.scheme).to_string()),
        weights: Some(weights),
    }
}

fn real_latency_score(samples: &[Sample]) -> f64 {
    let mut delays = successful_delays(samples);
    if delays.is_empty() {
        return 0.0;
    }
    delays.sort_unstable();
    let p50 = percentile(&delays, 0.50);
    let p90 = percentile(&delays, 0.90);
    latency_curve_score(Some(p50)) * 0.70 + latency_curve_score(Some(p90)) * 0.30
}

fn latency_curve_score(delay_ms: Option<i64>) -> f64 {
    let Some(delay) = delay_ms else {
        return 0.0;
    };
    if delay <= 120 {
        100.0
    } else if delay <= 400 {
        linear(delay as f64, 120.0, 400.0, 100.0, 75.0)
    } else if delay <= 1000 {
        linear(delay as f64, 400.0, 1000.0, 75.0, 35.0)
    } else if delay <= 2500 {
        linear(delay as f64, 1000.0, 2500.0, 35.0, 5.0)
    } else {
        0.0
    }
}

fn availability_score(samples: &[Sample]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let success = samples.iter().filter(|sample| sample.success).count() as f64;
    success / samples.len() as f64 * sample_confidence(samples.len()) * 100.0
}

fn jitter_score(samples: &[Sample]) -> f64 {
    let mut delays = successful_delays(samples);
    if delays.len() < 2 {
        return if delays.is_empty() { 0.0 } else { 50.0 };
    }
    delays.sort_unstable();
    let p50 = percentile(&delays, 0.50);
    let p90 = percentile(&delays, 0.90);
    let jitter = (p90 - p50).max(0) as f64;
    if jitter <= 80.0 {
        100.0
    } else if jitter <= 500.0 {
        linear(jitter, 80.0, 500.0, 100.0, 0.0)
    } else {
        0.0
    }
}

fn successful_delays(samples: &[Sample]) -> Vec<i64> {
    samples
        .iter()
        .filter_map(|sample| {
            if sample.success {
                sample.delay_ms
            } else {
                None
            }
        })
        .collect()
}

fn sample_confidence(sample_count: usize) -> f64 {
    (sample_count as f64 / CONNECTIVITY_CONFIDENCE_SAMPLE_TARGET).min(1.0)
}

fn freshness_state(age_ms: i64, config: &GroupConfig) -> &'static str {
    let fresh_ms = freshness_fresh_threshold_ms(config);
    if age_ms <= fresh_ms {
        "fresh"
    } else if age_ms <= fresh_ms * 3 {
        "stale"
    } else {
        "expired"
    }
}

fn freshness_fresh_threshold_ms(config: &GroupConfig) -> i64 {
    (normalize_probe_interval(config.probe_interval_sec) * 1000).max(120 * 1000)
}

fn freshness_gate_score(state: Option<&str>) -> f64 {
    match state {
        Some("fresh") => 100.0,
        Some("stale") => 80.0,
        _ => 0.0,
    }
}

fn score_gate_reason(latest: Option<&Sample>, freshness_state: Option<&str>) -> &'static str {
    let Some(latest) = latest else {
        return "no_sample";
    };
    if !latest.success {
        return "latest_failed";
    }
    if freshness_state == Some("expired") {
        return "expired";
    }
    "none"
}

fn weighted_score(components: ScoreComponents, scheme: ScoreScheme) -> f64 {
    let weights = score_weights(scheme);
    components.latency * weights.latency
        + components.availability * weights.availability
        + components.jitter * weights.jitter
        + components.freshness * weights.freshness
}

fn score_weights(scheme: ScoreScheme) -> ScoreWeights {
    match scheme {
        ScoreScheme::LatencyFirst => ScoreWeights {
            latency: 0.45,
            availability: 0.45,
            jitter: 0.10,
            freshness: 0.0,
        },
        ScoreScheme::Balanced => ScoreWeights {
            latency: 0.30,
            availability: 0.60,
            jitter: 0.10,
            freshness: 0.0,
        },
    }
}

fn linear(value: f64, from_value: f64, to_value: f64, from_score: f64, to_score: f64) -> f64 {
    let ratio = ((value - from_value) / (to_value - from_value)).clamp(0.0, 1.0);
    from_score + (to_score - from_score) * ratio
}

fn percentile(values: &[i64], percentile: f64) -> i64 {
    let index = ((values.len() - 1) as f64 * percentile).round() as usize;
    values[index]
}

fn round_score(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round_components(components: ScoreComponents) -> ScoreComponents {
    ScoreComponents {
        latency: round_score(components.latency),
        availability: round_score(components.availability),
        jitter: round_score(components.jitter),
        freshness: round_score(components.freshness),
    }
}

fn parse_mode(value: &str) -> ScoreMode {
    match value {
        "delay" => ScoreMode::Delay,
        _ => ScoreMode::Score,
    }
}

fn mode_name(value: ScoreMode) -> &'static str {
    match value {
        ScoreMode::Delay => "delay",
        ScoreMode::Score => "score",
    }
}

fn parse_scheme(value: &str) -> ScoreScheme {
    match value {
        "LatencyFirst" => ScoreScheme::LatencyFirst,
        _ => ScoreScheme::Balanced,
    }
}

fn scheme_name(value: ScoreScheme) -> &'static str {
    match value {
        ScoreScheme::LatencyFirst => "LatencyFirst",
        ScoreScheme::Balanced => "Balanced",
    }
}

fn normalize_probe_interval(value: i64) -> i64 {
    value.clamp(MIN_PROBE_INTERVAL_SEC, MAX_PROBE_INTERVAL_SEC)
}

fn normalize_probe_interval_with_min(value: i64, minimum: i64) -> i64 {
    value.clamp(
        normalize_min_probe_interval(minimum),
        MAX_PROBE_INTERVAL_SEC,
    )
}

fn normalize_min_probe_interval(value: i64) -> i64 {
    value.clamp(MIN_PROBE_INTERVAL_SEC, MAX_PROBE_INTERVAL_SEC)
}

fn normalize_probe_concurrency(value: usize) -> usize {
    value.clamp(MIN_PROBE_CONCURRENCY, MAX_PROBE_CONCURRENCY)
}

fn normalize_delay_test_timeout(value: i64) -> i64 {
    value.clamp(MIN_DELAY_TEST_TIMEOUT_MS, MAX_DELAY_TEST_TIMEOUT_MS)
}

fn default_delay_test_timeout_ms() -> i64 {
    DEFAULT_DELAY_TEST_TIMEOUT_MS
}

fn default_min_probe_interval_sec() -> i64 {
    DEFAULT_MIN_PROBE_INTERVAL_SEC
}

fn default_probe_concurrency() -> usize {
    DEFAULT_PROBE_CONCURRENCY
}

fn public_config_url() -> Option<String> {
    env::var("SINGDECK_HELPER_PUBLIC_URL")
        .ok()
        .and_then(|value| config_url_from_base(&value))
}

fn config_url_from_base(base_url: &str) -> Option<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return None;
    }

    Some(format!("{base_url}/api/v1/config/raw"))
}

fn mobile_config_url_for_bind(bind: &str, lan_ip: Option<String>) -> Option<String> {
    let bind_addr = bind.parse::<SocketAddr>().ok()?;
    let ip = bind_addr.ip();
    let host = if ip.is_unspecified() {
        lan_ip?
    } else if ip.is_loopback() {
        return None;
    } else {
        format_host(ip)
    };

    Some(format!(
        "http://{}:{}/api/v1/config/raw",
        host,
        bind_addr.port()
    ))
}

fn detect_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip.to_string()),
        IpAddr::V6(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(format!("[{ip}]")),
        _ => None,
    }
}

fn format_host(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    }
}

fn load_json_kv<T: for<'de> Deserialize<'de>>(state: &AppState, key: &str) -> Result<Option<T>> {
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    let value = db
        .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    value
        .map(|raw| serde_json::from_str(&raw).context("invalid JSON in kv"))
        .transpose()
}

fn save_json_kv<T: Serialize>(state: &AppState, key: &str, value: &T) -> Result<()> {
    save_string_kv(state, key, &serde_json::to_string(value)?)
}

fn load_string_kv(state: &AppState, key: &str) -> Result<Option<String>> {
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    Ok(db
        .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
            row.get::<_, String>(0)
        })
        .optional()?)
}

fn save_string_kv(state: &AppState, key: &str, value: &str) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    db.execute(
        "INSERT INTO kv(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn delete_string_kv(state: &AppState, key: &str) -> Result<()> {
    let db = state
        .db
        .lock()
        .map_err(|_| anyhow!("database lock poisoned"))?;
    db.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
    Ok(())
}

fn begin_active_probe(state: &AppState, group: &str) -> ActiveProbeGuard {
    let mut active = false;
    if let Ok(mut active_probes) = state.active_probes.lock() {
        let active_probe =
            active_probes
                .entry(group.to_string())
                .or_insert_with(|| ActiveProbeState {
                    started_at_ms: now_ms(),
                    count: 0,
                    active_nodes: HashMap::new(),
                });
        if active_probe.count == 0 && active_probe.active_nodes.is_empty() {
            active_probe.count = 1;
            active_probe.started_at_ms = now_ms();
            active = true;
        }
    }
    if active {
        publish_probe_status(state);
    }

    ActiveProbeGuard {
        state: state.clone(),
        group: group.to_string(),
        active,
    }
}

fn begin_active_probe_node(state: &AppState, group: &str, node: &str) -> ActiveProbeNodeGuard {
    if let Ok(mut active_probes) = state.active_probes.lock() {
        let active_probe =
            active_probes
                .entry(group.to_string())
                .or_insert_with(|| ActiveProbeState {
                    started_at_ms: now_ms(),
                    count: 0,
                    active_nodes: HashMap::new(),
                });
        *active_probe
            .active_nodes
            .entry(node.to_string())
            .or_insert(0) += 1;
    }
    publish_probe_status(state);

    ActiveProbeNodeGuard {
        state: state.clone(),
        group: group.to_string(),
        node: node.to_string(),
    }
}

fn active_probe_groups(state: &AppState) -> Vec<ActiveProbeView> {
    let Ok(active_probes) = state.active_probes.lock() else {
        return Vec::new();
    };
    let mut groups = active_probes
        .iter()
        .map(|(group, active_probe)| {
            let mut active_nodes = active_probe
                .active_nodes
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            active_nodes.sort();
            ActiveProbeView {
                group: group.clone(),
                started_at: format_time(active_probe.started_at_ms),
                active_nodes,
            }
        })
        .collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        left.started_at
            .cmp(&right.started_at)
            .then_with(|| left.group.cmp(&right.group))
    });
    groups
}

fn helper_event_channel() -> broadcast::Sender<HelperEvent> {
    let (sender, _) = broadcast::channel(256);
    sender
}

fn publish_helper_event(state: &AppState, event: HelperEvent) {
    let _ = state.events.send(event);
}

fn publish_probe_status(state: &AppState) {
    publish_helper_event(
        state,
        HelperEvent::ProbeStatus {
            groups: active_probe_groups(state),
        },
    );
}

fn publish_probe_progress_score(
    state: &AppState,
    group: &str,
    node: &str,
    config: &GroupConfig,
) -> Result<()> {
    let scores = compute_scores_after_probe_run(state, group, &[node.to_string()], config)?;
    let response = ScoresResponse {
        group: group.to_string(),
        mode: config.mode,
        scheme: config.scheme,
        test_url: config.test_url.clone(),
        recommended: None,
        apply_error: None,
        nodes: scores,
    };
    publish_helper_event(
        state,
        HelperEvent::ProbeScores {
            scores: response,
            partial: true,
        },
    );
    Ok(())
}

fn remove_idle_active_probe(active_probes: &mut HashMap<String, ActiveProbeState>, group: &str) {
    let should_remove = active_probes
        .get(group)
        .map(|active_probe| active_probe.count == 0 && active_probe.active_nodes.is_empty())
        .unwrap_or(false);
    if should_remove {
        active_probes.remove(group);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_usage_window(from: Option<i64>, to: Option<i64>) -> (i64, i64) {
    let now = now_ms();
    let to_ms = to.unwrap_or(now).clamp(0, now);
    let default_from = to_ms.saturating_sub(network_usage::DAY_MS);
    let from_ms = from.unwrap_or(default_from).clamp(0, to_ms);
    if from_ms == to_ms {
        (from_ms.saturating_sub(1), to_ms)
    } else {
        (from_ms, to_ms)
    }
}

fn format_time(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|time: DateTime<Local>| time.to_rfc3339())
        .unwrap_or_else(|| Local::now().to_rfc3339())
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn latency_curve_favors_low_latency() {
        assert_eq!(latency_curve_score(Some(40)), 100.0);
        assert!(latency_curve_score(Some(200)) > latency_curve_score(Some(700)));
        assert_eq!(latency_curve_score(Some(2500)), 5.0);
        assert_eq!(latency_curve_score(Some(2501)), 0.0);
        assert_eq!(latency_curve_score(None), 0.0);
    }

    #[test]
    fn balanced_weights_availability_more_than_latency_first() {
        let components = ScoreComponents {
            latency: 50.0,
            availability: 100.0,
            jitter: 100.0,
            freshness: 100.0,
        };
        assert!(
            weighted_score(components, ScoreScheme::Balanced)
                > weighted_score(components, ScoreScheme::LatencyFirst)
        );
    }

    #[test]
    fn connectivity_score_uses_sample_confidence() {
        let now = now_ms();
        let success = |tested_at_ms| Sample {
            delay_ms: Some(120),
            success: true,
            error: None,
            tested_at_ms,
        };
        let failure = |tested_at_ms| Sample {
            delay_ms: None,
            success: false,
            error: Some("timeout".to_string()),
            tested_at_ms,
        };

        assert_eq!(round_score(availability_score(&[success(now)])), 20.0);
        assert_eq!(
            round_score(availability_score(&[
                success(now),
                success(now + 1),
                success(now + 2)
            ])),
            60.0
        );
        assert_eq!(
            round_score(availability_score(&[
                success(now),
                success(now + 1),
                success(now + 2),
                success(now + 3),
                success(now + 4),
            ])),
            100.0
        );
        assert_eq!(
            round_score(availability_score(&[
                success(now),
                success(now + 1),
                success(now + 2),
                success(now + 3),
                failure(now + 4),
            ])),
            80.0
        );
    }

    #[test]
    fn real_latency_uses_p50_and_p90_successful_samples() {
        let now = now_ms();
        let samples = vec![
            Sample {
                delay_ms: Some(100),
                success: true,
                error: None,
                tested_at_ms: now,
            },
            Sample {
                delay_ms: Some(200),
                success: true,
                error: None,
                tested_at_ms: now + 1,
            },
            Sample {
                delay_ms: Some(800),
                success: true,
                error: None,
                tested_at_ms: now + 2,
            },
        ];

        let score = score_node("hk", &samples, &GroupConfig::default());

        assert_eq!(score.raw.latency_p50_ms, Some(200));
        assert_eq!(score.raw.latency_p90_ms, Some(800));
        assert_eq!(score.raw.jitter_ms, Some(600));
        assert!(score.components.latency < 90.0);
        assert!(score.components.jitter < 10.0);
    }

    #[test]
    fn stale_and_expired_samples_gate_final_score() {
        let now = now_ms();
        let config = GroupConfig {
            probe_interval_sec: 15 * 60,
            ..GroupConfig::default()
        };
        let stale_score = score_node_at(
            "stale",
            &[Sample {
                delay_ms: Some(120),
                success: true,
                error: None,
                tested_at_ms: now - 20 * 60 * 1000,
            }],
            &config,
            now,
        );
        let expired_score = score_node_at(
            "expired",
            &[Sample {
                delay_ms: Some(120),
                success: true,
                error: None,
                tested_at_ms: now - 60 * 60 * 1000,
            }],
            &config,
            now,
        );

        assert_eq!(stale_score.raw.freshness_state.as_deref(), Some("stale"));
        assert_eq!(stale_score.raw.gate_reason.as_deref(), Some("none"));
        assert!(stale_score.score <= 80.0);
        assert_eq!(
            expired_score.raw.freshness_state.as_deref(),
            Some("expired")
        );
        assert_eq!(expired_score.raw.gate_reason.as_deref(), Some("expired"));
        assert_eq!(expired_score.score, 0.0);
    }

    #[test]
    fn score_node_uses_recent_samples() {
        let now = now_ms();
        let samples = vec![
            Sample {
                delay_ms: Some(90),
                success: true,
                error: None,
                tested_at_ms: now - 1_000,
            },
            Sample {
                delay_ms: Some(120),
                success: true,
                error: None,
                tested_at_ms: now,
            },
        ];
        let score = score_node("hk", &samples, &GroupConfig::default());
        assert_eq!(score.name, "hk");
        assert!(score.score > 60.0);
        assert_eq!(score.delay_ms, Some(120));
    }

    #[test]
    fn score_node_raw_explains_component_inputs() {
        let now = now_ms();
        let samples = vec![
            Sample {
                delay_ms: Some(90),
                success: true,
                error: None,
                tested_at_ms: now - 2_000,
            },
            Sample {
                delay_ms: None,
                success: false,
                error: Some("timeout".to_string()),
                tested_at_ms: now - 1_000,
            },
            Sample {
                delay_ms: Some(140),
                success: true,
                error: None,
                tested_at_ms: now,
            },
        ];

        let score = score_node("hk", &samples, &GroupConfig::default());

        assert_eq!(score.raw.sample_count, 3);
        assert_eq!(score.raw.success_count, 2);
        assert_eq!(score.raw.failure_count, 1);
        assert_eq!(score.raw.latency_delay_ms, Some(140));
        assert_eq!(score.raw.jitter_p50_ms, Some(140));
        assert_eq!(score.raw.jitter_p95_ms, Some(140));
        assert_eq!(score.raw.jitter_ms, Some(0));
        assert_eq!(score.raw.sample_window_sec, Some(90 * 60));
        assert_eq!(score.raw.confidence, Some(0.6));
        assert_eq!(score.raw.latency_p50_ms, Some(140));
        assert_eq!(score.raw.latency_p90_ms, Some(140));
        assert_eq!(score.raw.freshness_state.as_deref(), Some("fresh"));
        assert_eq!(score.raw.gate_reason.as_deref(), Some("none"));
        assert_eq!(score.raw.mode.as_deref(), Some("score"));
        assert_eq!(score.raw.scheme.as_deref(), Some("Balanced"));
        assert_eq!(
            score.raw.weights.as_ref().map(|weights| weights.latency),
            Some(0.30)
        );
        assert!(score.raw.freshness_age_ms.unwrap_or(i64::MAX) < 1_000);
    }

    #[test]
    fn score_sample_window_follows_probe_interval() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let config = GroupConfig {
            test_url: "https://latency.example.test".to_string(),
            probe_interval_sec: 15 * 60,
            ..GroupConfig::default()
        };
        save_probe_sample(
            &state,
            "select",
            "hk",
            &config.test_url,
            Some(120),
            true,
            None,
            now_ms() - 11 * 60 * 1000,
        )
        .unwrap();

        let scores =
            compute_scores_for_group(&state, "select", &["hk".to_string()], &config).unwrap();

        assert_eq!(scores[0].delay_ms, Some(120));
        assert!(scores[0].score > 0.0);
        assert_eq!(scores[0].raw.sample_window_sec, Some(90 * 60));
    }

    #[test]
    fn score_sample_window_keeps_latest_ten_samples() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let config = GroupConfig {
            test_url: "https://latency.example.test".to_string(),
            probe_interval_sec: 15 * 60,
            ..GroupConfig::default()
        };
        let now = now_ms();
        for index in 0..12 {
            save_probe_sample(
                &state,
                "select",
                "hk",
                &config.test_url,
                Some(100 + index),
                true,
                None,
                now - (12 - index) * 60 * 1000,
            )
            .unwrap();
        }

        let scores =
            compute_scores_for_group(&state, "select", &["hk".to_string()], &config).unwrap();

        assert_eq!(scores[0].raw.sample_count, 10);
        assert_eq!(scores[0].raw.success_count, 10);
        assert_eq!(scores[0].raw.latency_p50_ms, Some(107));
    }

    #[test]
    fn delay_mode_recommends_lowest_recent_delay() {
        let now = now_ms();
        let config = GroupConfig {
            mode: ScoreMode::Delay,
            ..GroupConfig::default()
        };
        let mut scores = vec![
            score_node(
                "node-a",
                &[Sample {
                    delay_ms: Some(60),
                    success: true,
                    error: None,
                    tested_at_ms: now,
                }],
                &config,
            ),
            score_node(
                "node-b",
                &[Sample {
                    delay_ms: Some(40),
                    success: true,
                    error: None,
                    tested_at_ms: now,
                }],
                &config,
            ),
        ];

        sort_node_scores(&mut scores, &config);

        assert_eq!(
            scores.first().map(|score| score.name.as_str()),
            Some("node-b")
        );
    }

    #[test]
    fn score_mode_does_not_recommend_node_with_latest_failure() {
        let config = GroupConfig::default();
        let mut scores = vec![
            score_node(
                "recent-failure",
                &[
                    Sample {
                        delay_ms: Some(40),
                        success: true,
                        error: None,
                        tested_at_ms: 1,
                    },
                    Sample {
                        delay_ms: Some(45),
                        success: true,
                        error: None,
                        tested_at_ms: 2,
                    },
                    Sample {
                        delay_ms: Some(42),
                        success: true,
                        error: None,
                        tested_at_ms: 3,
                    },
                    Sample {
                        delay_ms: None,
                        success: false,
                        error: Some("timeout".to_string()),
                        tested_at_ms: 4,
                    },
                ],
                &config,
            ),
            score_node(
                "current-success",
                &[Sample {
                    delay_ms: Some(350),
                    success: true,
                    error: None,
                    tested_at_ms: 4,
                }],
                &config,
            ),
        ];

        sort_node_scores(&mut scores, &config);

        assert_eq!(
            scores.first().map(|score| score.name.as_str()),
            Some("current-success")
        );
        assert_eq!(
            scores
                .iter()
                .find(|score| score.name == "recent-failure")
                .and_then(|score| score.delay_ms),
            None
        );
    }

    #[test]
    fn current_probe_snapshot_scores_failed_nodes_zero_and_persists_raw_values() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let config = GroupConfig::default();
        let tested_at_ms = now_ms();
        let scores = vec![
            score_node(
                "hk",
                &[Sample {
                    delay_ms: Some(82),
                    success: true,
                    error: None,
                    tested_at_ms,
                }],
                &config,
            ),
            score_node(
                "jp",
                &[Sample {
                    delay_ms: None,
                    success: false,
                    error: Some("timeout".to_string()),
                    tested_at_ms,
                }],
                &config,
            ),
        ];
        let failed = scores.iter().find(|score| score.name == "jp").unwrap();

        assert_eq!(failed.score, 0.0);
        assert_eq!(failed.components, ScoreComponents::default());
        assert_eq!(failed.raw.delay_ms, None);
        assert!(!failed.raw.success);
        assert_eq!(failed.raw.error.as_deref(), Some("timeout"));

        let response = ScoresResponse {
            group: "select".to_string(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url.clone(),
            recommended: scores.first().map(|score| score.name.clone()),
            apply_error: None,
            nodes: scores,
        };
        save_last_probe_snapshot(&state, &response).unwrap();

        let restored = load_last_probe_snapshot(&state, "select", &config)
            .unwrap()
            .unwrap();
        let restored_failed = restored
            .nodes
            .iter()
            .find(|score| score.name == "jp")
            .unwrap();
        assert_eq!(restored_failed.score, 0.0);
        assert_eq!(restored_failed.raw.error.as_deref(), Some("timeout"));
    }

    #[test]
    fn probe_run_scores_are_recomputed_from_historical_samples() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let config = GroupConfig::default();
        let now = now_ms();
        for index in 0..4 {
            save_probe_sample(
                &state,
                "select",
                "hk",
                &config.test_url,
                Some(100 + index),
                true,
                None,
                now - (5 - index) * 60 * 1000,
            )
            .unwrap();
        }
        save_probe_sample(
            &state,
            "select",
            "hk",
            &config.test_url,
            Some(90),
            true,
            None,
            now,
        )
        .unwrap();

        let scores =
            compute_scores_after_probe_run(&state, "select", &["hk".to_string()], &config).unwrap();

        assert_eq!(scores[0].raw.sample_count, 5);
        assert_eq!(scores[0].raw.success_count, 5);
        assert_eq!(scores[0].components.availability, 100.0);
    }

    #[test]
    fn legacy_probe_snapshots_are_ignored() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let config = GroupConfig::default();
        let legacy_response = ScoresResponse {
            group: "select".to_string(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url.clone(),
            recommended: Some("hk".to_string()),
            apply_error: None,
            nodes: vec![NodeScore {
                name: "hk".to_string(),
                score: 100.0,
                delay_ms: Some(40),
                components: ScoreComponents::default(),
                last_tested_at: None,
                error: None,
                raw: NodeScoreRaw {
                    success: true,
                    delay_ms: Some(40),
                    error: None,
                    tested_at: None,
                    ..NodeScoreRaw::default()
                },
            }],
        };
        save_last_probe_snapshot(&state, &legacy_response).unwrap();

        assert!(load_last_probe_snapshot(&state, "select", &config)
            .unwrap()
            .is_none());
    }

    #[test]
    fn score_mode_ties_prefer_lower_current_delay() {
        let config = GroupConfig::default();
        let mut scores = vec![
            NodeScore {
                name: "a-slower".to_string(),
                score: 88.0,
                delay_ms: Some(280),
                components: ScoreComponents::default(),
                last_tested_at: None,
                error: None,
                raw: NodeScoreRaw {
                    success: true,
                    delay_ms: Some(280),
                    error: None,
                    tested_at: None,
                    ..NodeScoreRaw::default()
                },
            },
            NodeScore {
                name: "z-faster".to_string(),
                score: 88.0,
                delay_ms: Some(80),
                components: ScoreComponents::default(),
                last_tested_at: None,
                error: None,
                raw: NodeScoreRaw {
                    success: true,
                    delay_ms: Some(80),
                    error: None,
                    tested_at: None,
                    ..NodeScoreRaw::default()
                },
            },
        ];

        sort_node_scores(&mut scores, &config);

        assert_eq!(
            scores.first().map(|score| score.name.as_str()),
            Some("z-faster")
        );
    }

    #[test]
    fn only_selector_groups_are_switchable_through_clash_api() {
        assert!(is_switchable_kind("Selector"));
        assert!(is_switchable_kind("selector"));
        assert!(!is_switchable_kind("URLTest"));
        assert!(!is_switchable_kind("Fallback"));
    }

    #[test]
    fn urltest_and_fallback_delay_groups_are_native_managed() {
        let urltest_group = ProxyView {
            name: "auto".to_string(),
            kind: "URL-Test".to_string(),
            now: "hk-1".to_string(),
            all: vec!["hk-1".to_string(), "jp-1".to_string()],
        };
        let fallback_group = ProxyView {
            name: "GLOBAL".to_string(),
            kind: "Fallback".to_string(),
            now: "manual".to_string(),
            all: vec!["manual".to_string(), "hk-1".to_string()],
        };
        let selector_group = ProxyView {
            name: "manual".to_string(),
            kind: "Selector".to_string(),
            now: "jp-1".to_string(),
            all: vec!["hk-1".to_string(), "jp-1".to_string()],
        };
        let delay_config = GroupConfig {
            mode: ScoreMode::Delay,
            ..GroupConfig::default()
        };
        let score_config = GroupConfig {
            mode: ScoreMode::Score,
            ..GroupConfig::default()
        };

        assert!(is_urltest_kind("URLTest"));
        assert!(uses_native_urltest_delay(&urltest_group, &delay_config));
        assert!(uses_native_urltest_delay(&fallback_group, &delay_config));
        assert!(!uses_native_urltest_delay(&selector_group, &delay_config));
        assert!(!uses_native_urltest_delay(&urltest_group, &score_config));
    }

    #[test]
    fn nested_group_members_probe_their_current_leaf_node() {
        let mut proxies = HashMap::new();
        proxies.insert(
            "outer".to_string(),
            ProxyView {
                name: "outer".to_string(),
                kind: "Selector".to_string(),
                now: "inner".to_string(),
                all: vec!["inner".to_string()],
            },
        );
        proxies.insert(
            "inner".to_string(),
            ProxyView {
                name: "inner".to_string(),
                kind: "Selector".to_string(),
                now: "leaf".to_string(),
                all: vec!["leaf".to_string()],
            },
        );
        proxies.insert(
            "leaf".to_string(),
            ProxyView {
                name: "leaf".to_string(),
                kind: "Trojan".to_string(),
                now: String::new(),
                all: vec![],
            },
        );

        assert_eq!(resolve_leaf_proxy_name("outer", &proxies), "leaf");
        assert_eq!(resolve_leaf_proxy_name("inner", &proxies), "leaf");
        assert_eq!(resolve_leaf_proxy_name("missing", &proxies), "missing");
    }

    #[test]
    fn probe_apply_respects_group_auto_switch() {
        let manual = GroupConfig {
            auto_switch: false,
            ..GroupConfig::default()
        };
        let automatic = GroupConfig {
            auto_switch: true,
            ..GroupConfig::default()
        };

        assert!(!should_apply_probe_result(true, &manual));
        assert!(should_apply_probe_result(true, &automatic));
        assert!(!should_apply_probe_result(false, &automatic));
    }

    #[test]
    fn scheduler_treats_controller_poll_failures_as_skippable() {
        assert!(is_controller_poll_error(&anyhow!(
            "error sending request for url (http://127.0.0.1:9527/proxies)"
        )));
        assert!(is_controller_poll_error(&anyhow!(
            "controller returned HTTP 401 Unauthorized"
        )));
        assert!(!is_controller_poll_error(&anyhow!(
            "database lock poisoned"
        )));
    }

    #[test]
    fn delay_test_timeout_is_normalized_for_active_probes() {
        assert_eq!(normalize_delay_test_timeout(100), 500);
        assert_eq!(normalize_delay_test_timeout(10_000), 10_000);
        assert_eq!(normalize_delay_test_timeout(120_000), 60_000);
    }

    #[test]
    fn traffic_settings_are_persisted_in_helper_database() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let settings = TrafficSettings {
            enabled: true,
            browser_profile: "/home/alice/.config/google-chrome/Default".to_string(),
        };

        save_traffic_settings_row(&state, &settings).unwrap();

        assert_eq!(load_traffic_settings(&state).unwrap(), settings);
    }

    #[tokio::test]
    async fn read_traffic_requires_explicit_profile_when_enabled() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_traffic_settings_row(
            &state,
            &TrafficSettings {
                enabled: true,
                browser_profile: String::new(),
            },
        )
        .unwrap();

        let error = read_traffic(State(state)).await.unwrap_err();

        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(
            error.message,
            "Chrome profile is not configured in Settings."
        );
    }

    #[test]
    fn active_probe_tracking_skips_duplicate_group_runs() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };

        let first = begin_active_probe(&state, "select");
        let second = begin_active_probe(&state, "select");

        assert_eq!(active_probe_groups(&state).len(), 1);
        assert_eq!(
            state
                .active_probes
                .lock()
                .unwrap()
                .get("select")
                .map(|probe| probe.count),
            Some(1)
        );
        drop(second);
        assert_eq!(active_probe_groups(&state).len(), 1);
        drop(first);
        assert!(active_probe_groups(&state).is_empty());
    }

    #[test]
    fn background_probe_concurrency_is_persisted_and_normalized() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };

        assert_eq!(load_probe_concurrency(&state).unwrap(), 4);

        save_string_kv(&state, "probe_concurrency", "0").unwrap();
        assert_eq!(load_probe_concurrency(&state).unwrap(), 1);

        save_string_kv(&state, "probe_concurrency", "99").unwrap();
        assert_eq!(load_probe_concurrency(&state).unwrap(), 12);

        save_string_kv(&state, "probe_concurrency", "7").unwrap();
        assert_eq!(load_probe_concurrency(&state).unwrap(), 7);
    }

    #[test]
    fn active_probe_tracking_reports_only_current_nodes() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };

        let group = begin_active_probe(&state, "select");
        let hk = begin_active_probe_node(&state, "select", "hk-1");
        let jp = begin_active_probe_node(&state, "select", "jp-1");

        assert_eq!(
            active_probe_groups(&state)
                .first()
                .map(|probe| probe.active_nodes.clone()),
            Some(vec!["hk-1".to_string(), "jp-1".to_string()])
        );

        drop(hk);
        assert_eq!(
            active_probe_groups(&state)
                .first()
                .map(|probe| probe.active_nodes.clone()),
            Some(vec!["jp-1".to_string()])
        );

        drop(jp);
        assert_eq!(
            active_probe_groups(&state)
                .first()
                .map(|probe| probe.active_nodes.clone()),
            Some(Vec::new())
        );

        drop(group);
        assert!(active_probe_groups(&state).is_empty());
    }

    #[test]
    fn helper_events_broadcast_probe_status_payloads() {
        let events = helper_event_channel();
        let mut receiver = events.subscribe();
        let state = AppState {
            db: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events,
        };

        publish_helper_event(
            &state,
            HelperEvent::ProbeStatus {
                groups: vec![ActiveProbeView {
                    group: "select".to_string(),
                    started_at: "2026-05-21T10:00:00+08:00".to_string(),
                    active_nodes: vec!["hk-1".to_string()],
                }],
            },
        );

        let event = receiver.try_recv().unwrap();
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "probeStatus");
        assert_eq!(value["groups"][0]["group"], "select");
        assert_eq!(value["groups"][0]["activeNodes"][0], "hk-1");
    }

    #[test]
    fn active_probe_tracking_broadcasts_node_lifecycle_status() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let events = helper_event_channel();
        let mut receiver = events.subscribe();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events,
        };

        let group = begin_active_probe(&state, "select");
        let node = begin_active_probe_node(&state, "select", "hk-1");
        drop(node);
        drop(group);

        let events = (0..4)
            .map(|_| serde_json::to_value(receiver.try_recv().unwrap()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(events[0]["groups"][0]["activeNodes"], serde_json::json!([]));
        assert_eq!(
            events[1]["groups"][0]["activeNodes"],
            serde_json::json!(["hk-1"])
        );
        assert_eq!(events[2]["groups"][0]["activeNodes"], serde_json::json!([]));
        assert_eq!(events[3]["groups"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn probe_limiter_enforces_global_limit() {
        let limiter = ProbeLimiter::new();
        let first = limiter.acquire(1).await;
        assert_eq!(limiter.active_count(), 1);

        let queued_limiter = limiter.clone();
        let queued = tokio::spawn(async move {
            let _permit = queued_limiter.acquire(1).await;
            queued_limiter.active_count()
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!queued.is_finished());

        drop(first);
        assert_eq!(queued.await.unwrap(), 1);
        assert_eq!(limiter.active_count(), 0);
    }

    #[tokio::test]
    async fn probe_node_publishes_progress_scores_after_sample() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let events = helper_event_channel();
        let mut receiver = events.subscribe();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events,
        };
        let controller_url = spawn_one_delay_response_server(42).await;
        let controller = ControllerConfig {
            controller_url,
            secret: String::new(),
        };
        let config = GroupConfig::default();
        let test_url = config.test_url.clone();

        probe_node(
            &state,
            &controller,
            "select",
            "hk-1",
            "hk-1",
            &test_url,
            5000,
            4,
            Some(ProbeProgressContext { config }),
        )
        .await
        .unwrap();

        let events = drain_helper_events(&mut receiver);
        assert!(events.iter().any(|event| {
            matches!(
                event,
                HelperEvent::ProbeScores {
                    scores,
                    partial: true,
                }
                    if scores.group == "select"
                        && scores.nodes.iter().any(|node| node.name == "hk-1" && node.delay_ms == Some(42))
            )
        }));
    }

    #[tokio::test]
    async fn probe_group_reuses_initial_proxy_snapshot_for_node_resolution() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let proxy_request_count = Arc::new(AtomicUsize::new(0));
        let controller_url = spawn_counting_probe_controller(proxy_request_count.clone()).await;
        save_json_kv(
            &state,
            "controller",
            &ControllerConfig {
                controller_url,
                secret: String::new(),
            },
        )
        .unwrap();

        let response = probe_group_internal(&state, "select", 4, false)
            .await
            .unwrap();

        assert_eq!(response.nodes[0].delay_ms, Some(42));
        assert_eq!(proxy_request_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn probe_group_fills_finished_worker_slots_without_waiting_for_slow_nodes() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let next_started = Arc::new(AtomicBool::new(false));
        let release_slow = Arc::new(tokio::sync::Notify::new());
        let controller_url =
            spawn_dynamic_queue_probe_controller(next_started.clone(), release_slow.clone()).await;
        save_json_kv(
            &state,
            "controller",
            &ControllerConfig {
                controller_url,
                secret: String::new(),
            },
        )
        .unwrap();

        let probe_state = state.clone();
        let probe = tokio::spawn(async move { probe_group_internal(&probe_state, "select", 2, false).await });

        let started_before_slow_finished = wait_for_atomic_bool(&next_started, Duration::from_millis(300)).await;
        release_slow.notify_waiters();
        let response = probe.await.unwrap().unwrap();

        assert!(
            started_before_slow_finished,
            "next node should start as soon as a worker slot finishes, before slow nodes time out"
        );
        assert_eq!(response.nodes.len(), 3);
    }

    async fn spawn_one_delay_response_server(delay_ms: i64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).await.unwrap();
            let body = format!(r#"{{"delay":{delay_ms}}}"#);
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn spawn_subscription_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).await.unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn spawn_subscription_server_requiring_user_agent(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]);
            if !request.to_ascii_lowercase().contains("\r\nuser-agent:") {
                let response =
                    "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                stream.write_all(response.as_bytes()).await.unwrap();
                return;
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn spawn_flaky_proxy_controller(failures: usize, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let request_count = Arc::new(AtomicUsize::new(0));
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let request_count = request_count.clone();
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 2048];
                    let _ = stream.read(&mut buffer).await.unwrap_or(0);
                    let index = request_count.fetch_add(1, Ordering::SeqCst);
                    if index < failures {
                        let response =
                            "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
                        let _ = stream.write_all(response.as_bytes()).await;
                        return;
                    }
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        format!("http://{addr}")
    }

    async fn spawn_dynamic_queue_probe_controller(
        next_started: Arc<AtomicBool>,
        release_slow: Arc<tokio::sync::Notify>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let next_started = next_started.clone();
                let release_slow = release_slow.clone();
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 2048];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let body = if path == "/proxies" {
                        r#"{"proxies":{"select":{"name":"select","type":"Selector","now":"slow","all":["slow","fast","next"]},"slow":{"name":"slow","type":"Trojan","now":"","all":[]},"fast":{"name":"fast","type":"Trojan","now":"","all":[]},"next":{"name":"next","type":"Trojan","now":"","all":[]}}}"#.to_string()
                    } else if path.starts_with("/proxies/slow/delay") {
                        release_slow.notified().await;
                        r#"{"delay":900}"#.to_string()
                    } else if path.starts_with("/proxies/fast/delay") {
                        r#"{"delay":50}"#.to_string()
                    } else if path.starts_with("/proxies/next/delay") {
                        next_started.store(true, Ordering::SeqCst);
                        r#"{"delay":60}"#.to_string()
                    } else {
                        r#"{"error":"not found"}"#.to_string()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        format!("http://{addr}")
    }

    async fn wait_for_atomic_bool(value: &AtomicBool, timeout: Duration) -> bool {
        let started_at = tokio::time::Instant::now();
        loop {
            if value.load(Ordering::SeqCst) {
                return true;
            }
            if started_at.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn spawn_counting_probe_controller(proxy_request_count: Arc<AtomicUsize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let mut buffer = [0_u8; 2048];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let body = if path == "/proxies" {
                    proxy_request_count.fetch_add(1, Ordering::SeqCst);
                    r#"{"proxies":{"select":{"name":"select","type":"Selector","now":"hk-1","all":["hk-1"]},"hk-1":{"name":"hk-1","type":"Trojan","now":"","all":[]}}}"#.to_string()
                } else if path.starts_with("/proxies/hk-1/delay") {
                    r#"{"delay":42}"#.to_string()
                } else {
                    r#"{"error":"not found"}"#.to_string()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        format!("http://{addr}")
    }

    fn drain_helper_events(receiver: &mut broadcast::Receiver<HelperEvent>) -> Vec<HelperEvent> {
        let mut events = Vec::new();
        while let Ok(event) = receiver.try_recv() {
            events.push(event);
        }
        events
    }

    #[test]
    fn realtime_connections_snapshot_event_keeps_controller_payload() {
        let event = build_connections_snapshot_event(
            serde_json::json!({
                "connections": [
                    { "id": "conn-1", "chains": ["proxy-a"] }
                ]
            }),
            "2026-05-21T10:00:00+08:00".to_string(),
        );

        let value = serde_json::to_value(event).unwrap();

        assert_eq!(value["type"], "connectionsSnapshot");
        assert_eq!(value["sampledAt"], "2026-05-21T10:00:00+08:00");
        assert_eq!(value["snapshot"]["connections"][0]["id"], "conn-1");
    }

    #[test]
    fn realtime_traffic_snapshot_event_combines_controller_runtime_fields() {
        let event = build_traffic_snapshot_event(
            serde_json::json!({ "mode": "rule" }),
            serde_json::json!({
                "connections": [{ "id": "conn-1" }, { "id": "conn-2" }],
                "uploadTotal": 1024,
                "downloadTotal": 2048
            }),
            serde_json::json!({ "up": 128, "down": 256 }),
            "2026-05-21T10:00:01+08:00".to_string(),
        );

        let value = serde_json::to_value(event).unwrap();

        assert_eq!(value["type"], "trafficSnapshot");
        assert_eq!(value["up"], 128);
        assert_eq!(value["down"], 256);
        assert_eq!(value["uploadTotal"], 1024);
        assert_eq!(value["downloadTotal"], 2048);
        assert_eq!(value["connectionCount"], 2);
        assert_eq!(value["mode"], "rule");
        assert_eq!(value["sampledAt"], "2026-05-21T10:00:01+08:00");
    }

    #[test]
    fn jitter_penalizes_spread() {
        let stable = vec![
            Sample {
                delay_ms: Some(100),
                success: true,
                error: None,
                tested_at_ms: 1,
            },
            Sample {
                delay_ms: Some(120),
                success: true,
                error: None,
                tested_at_ms: 2,
            },
            Sample {
                delay_ms: Some(130),
                success: true,
                error: None,
                tested_at_ms: 3,
            },
        ];
        let unstable = vec![
            Sample {
                delay_ms: Some(100),
                success: true,
                error: None,
                tested_at_ms: 1,
            },
            Sample {
                delay_ms: Some(600),
                success: true,
                error: None,
                tested_at_ms: 2,
            },
            Sample {
                delay_ms: Some(900),
                success: true,
                error: None,
                tested_at_ms: 3,
            },
        ];
        assert!(jitter_score(&stable) > jitter_score(&unstable));
    }

    #[test]
    fn request_failure_logs_match_strategy_group_members() {
        let group = ProxyView {
            name: "GLOBAL".to_string(),
            kind: "URLTest".to_string(),
            now: "香港 08".to_string(),
            all: vec!["香港 08".to_string(), "日本 03".to_string()],
        };

        assert!(network_failure_log_matches_group(
            r#"{"level":"warning","payload":"connect failed via 香港 08: i/o timeout"}"#,
            &group
        ));
        assert!(network_failure_log_matches_group(
            "GLOBAL outbound failed: network is unreachable",
            &group
        ));
        assert!(!network_failure_log_matches_group(
            "Delay test failed for 香港 08: HTTP 504",
            &group
        ));
    }

    #[test]
    fn mobile_config_url_uses_non_loopback_bind_address() {
        assert_eq!(
            mobile_config_url_for_bind("192.168.31.8:9531", None),
            Some("http://192.168.31.8:9531/api/v1/config/raw".to_string())
        );
        assert_eq!(
            mobile_config_url_for_bind("0.0.0.0:9531", Some("10.0.0.12".to_string())),
            Some("http://10.0.0.12:9531/api/v1/config/raw".to_string())
        );
        assert_eq!(
            mobile_config_url_for_bind("127.0.0.1:9531", Some("10.0.0.12".to_string())),
            None
        );
        assert_eq!(mobile_config_url_for_bind("127.0.0.1:9531", None), None);
    }

    #[test]
    fn default_traffic_settings_require_explicit_profile() {
        assert_eq!(
            default_traffic_settings(),
            TrafficSettings {
                enabled: false,
                browser_profile: String::new(),
            }
        );
        assert_eq!(
            normalize_traffic_settings(TrafficSettings {
                enabled: true,
                browser_profile: "  ".to_string(),
            }),
            TrafficSettings {
                enabled: true,
                browser_profile: String::new(),
            }
        );
    }

    #[test]
    fn config_path_candidates_use_only_settings_path() {
        assert_eq!(
            config_path_candidates(Some(" /custom/sing-box.json ".to_string())),
            vec!["/custom/sing-box.json".to_string()]
        );
        assert!(config_path_candidates(None).is_empty());
        assert!(config_path_candidates(Some("  ".to_string())).is_empty());
    }

    #[test]
    fn node_source_tables_are_initialized() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();

        conn.execute(
            "INSERT INTO node_sources (name, url, associate, last_synced_ms, last_error, node_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "provider-a",
                "https://example.com/sub",
                1_i64,
                123_i64,
                Option::<String>::None,
                2_i64
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO node_source_nodes (source_name, node_name) VALUES (?1, ?2)",
            params!["provider-a", "hk-1"],
        )
        .unwrap();

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM node_source_nodes WHERE source_name = 'provider-a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn node_source_config_path_uses_singdeck_json_next_to_sing_box_config() {
        assert_eq!(
            node_source_config_path(Path::new("/etc/sing-box/config.jsonc")),
            Some(Path::new("/etc/sing-box/singdeck.json").to_path_buf())
        );
        assert_eq!(
            node_source_config_path(Path::new("config.jsonc")),
            Some(Path::new("singdeck.json").to_path_buf())
        );
    }

    #[test]
    fn reads_node_sources_from_singdeck_sidecar_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.json");
        fs::write(
            &sidecar_path,
            r#"{"nodeSources":[{"name":"bing-us","url":"https://example.com/sub","associate":true}]}"#,
        )
        .unwrap();

        let config = read_node_source_config_for_config_path(&config_path).unwrap();

        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].name, "bing-us");
        assert!(config.sources[0].associate);
    }

    #[test]
    fn reads_node_sources_from_singdeck_jsonc_when_json_is_missing() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.jsonc");
        fs::write(
            &sidecar_path,
            r#"{"nodeSources":[{"name":"west-data","url":"https://example.com/sub","associate":true}]}"#,
        )
        .unwrap();

        let config = read_node_source_config_for_config_path(&config_path).unwrap();

        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].name, "west-data");
    }

    #[test]
    fn reads_node_sources_from_jsonc_with_comments_and_trailing_commas() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.jsonc");
        fs::write(
            &sidecar_path,
            r#"
            {
              // provider source list
              "nodeSources": [
                {
                  "name": "west-data",
                  "url": "https://example.com/sub",
                  "associate": true,
                },
              ],
            }
            "#,
        )
        .unwrap();

        let config = read_node_source_config_for_config_path(&config_path).unwrap();

        assert_eq!(config.sources.len(), 1);
        assert_eq!(config.sources[0].name, "west-data");
    }

    #[test]
    fn extracts_node_names_from_base64_subscription() {
        let encoded = "dHJvamFuOi8vcGFzc0BleGFtcGxlLmNvbTo0NDMjVW5pdGVkJTIwU3RhdGVzJTIwJTdDJTIwMDEKdmxlc3M6Ly9pZEBleGFtcGxlLmNvbTo0NDMjSG9uZyUyMEtvbmclMjAlN0MlMjAwMQ==";

        let names = extract_subscription_node_names(encoded).unwrap();

        assert_eq!(names, vec!["United States | 01".to_string(), "Hong Kong | 01".to_string()]);
    }

    #[test]
    fn matches_subscription_nodes_against_current_leaf_proxies() {
        let proxies: ClashProxiesResponse = serde_json::from_str(
            r#"{"proxies":{"select":{"type":"Selector","all":["United States | 01","Hong Kong | 01"]},"United States | 01":{"type":"Trojan"},"Hong Kong | 01":{"type":"Trojan"},"Other":{"type":"Trojan"}}}"#,
        )
        .unwrap();

        let matched = match_subscription_nodes(
            &["united-states-01".to_string(), "Hong Kong | 01".to_string()],
            &proxy_node_names(&proxies),
        );

        assert_eq!(matched, vec!["Hong Kong | 01".to_string(), "United States | 01".to_string()]);
    }

    #[tokio::test]
    async fn sync_node_sources_associates_enabled_sources_and_preserves_disabled_sources() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_node_source_links(
            &state,
            &NodeSourceConfigEntry {
                name: "manual".to_string(),
                url: "http://127.0.0.1:1/not-requested".to_string(),
                associate: false,
            },
            &["manual-node".to_string()],
            None,
        )
        .unwrap();
        let subscription_url = spawn_subscription_server(
            "dHJvamFuOi8vcGFzc0BleGFtcGxlLmNvbTo0NDMjaGstMQp2bGVzczovL2lkQGV4YW1wbGUuY29tOjQ0MyNtaXNzaW5n",
        )
        .await;
        let config = NodeSourceConfig {
            sources: vec![
                NodeSourceConfigEntry {
                    name: "auto".to_string(),
                    url: subscription_url,
                    associate: true,
                },
                NodeSourceConfigEntry {
                    name: "manual".to_string(),
                    url: "http://127.0.0.1:1/not-requested".to_string(),
                    associate: false,
                },
            ],
        };

        sync_node_sources_with_nodes(&state, &config, &["hk-1".to_string(), "manual-node".to_string()])
            .await
            .unwrap();
        let response = load_node_sources_response(&state).unwrap();

        let auto = response.sources.iter().find(|source| source.name == "auto").unwrap();
        assert_eq!(auto.nodes, vec!["hk-1".to_string()]);
        assert_eq!(auto.node_count, 1);
        assert!(auto.last_error.is_none());

        let manual = response.sources.iter().find(|source| source.name == "manual").unwrap();
        assert_eq!(manual.nodes, vec!["manual-node".to_string()]);
        assert_eq!(manual.node_count, 1);
        assert!(manual.last_error.is_none());
    }

    #[tokio::test]
    async fn sync_node_sources_sends_user_agent_when_fetching_subscription() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        let subscription_url = spawn_subscription_server_requiring_user_agent(
            "dHJvamFuOi8vcGFzc0BleGFtcGxlLmNvbTo0NDMjaGstMQ==",
        )
        .await;
        let config = NodeSourceConfig {
            sources: vec![NodeSourceConfigEntry {
                name: "west-data".to_string(),
                url: subscription_url,
                associate: true,
            }],
        };

        sync_node_sources_with_nodes(&state, &config, &["hk-1".to_string()])
            .await
            .unwrap();

        let response = load_node_sources_response(&state).unwrap();
        let source = response.sources.iter().find(|source| source.name == "west-data").unwrap();
        assert_eq!(source.nodes, vec!["hk-1".to_string()]);
        assert!(source.last_error.is_none());
    }

    #[tokio::test]
    async fn startup_node_source_sync_reports_controller_unavailable_as_retryable_error() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.json");
        fs::write(
            &sidecar_path,
            r#"{"nodeSources":[{"name":"west-data","url":"https://example.com/sub","associate":true}]}"#,
        )
        .unwrap();
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_string_kv(&state, "config_path", config_path.to_str().unwrap()).unwrap();
        save_json_kv(
            &state,
            "controller",
            &ControllerConfig {
                controller_url: "http://127.0.0.1:1".to_string(),
                secret: String::new(),
            },
        )
        .unwrap();

        let error = sync_node_sources_on_startup(&state).await.unwrap_err();

        assert!(error.to_string().contains("controller proxies unavailable"));
        let response = load_node_sources_response(&state).unwrap();
        let source = response.sources.iter().find(|source| source.name == "west-data").unwrap();
        assert_eq!(source.node_count, 0);
        assert!(source
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("controller proxies unavailable"));
    }

    #[tokio::test]
    async fn startup_node_source_sync_retries_until_controller_is_ready() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.json");
        let subscription_url = spawn_subscription_server(
            "dHJvamFuOi8vcGFzc0BleGFtcGxlLmNvbTo0NDMjaGstMQ==",
        )
        .await;
        fs::write(
            &sidecar_path,
            format!(
                r#"{{"nodeSources":[{{"name":"west-data","url":"{subscription_url}","associate":true}}]}}"#
            ),
        )
        .unwrap();
        let controller_url = spawn_flaky_proxy_controller(
            1,
            r#"{"proxies":{"select":{"type":"Selector","all":["hk-1"]},"hk-1":{"type":"Trojan"}}}"#,
        )
        .await;
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_string_kv(&state, "config_path", config_path.to_str().unwrap()).unwrap();
        save_json_kv(
            &state,
            "controller",
            &ControllerConfig {
                controller_url,
                secret: String::new(),
            },
        )
        .unwrap();

        sync_node_sources_on_startup_with_retries(&state, 2, Duration::from_millis(1))
            .await
            .unwrap();

        let response = load_node_sources_response(&state).unwrap();
        let source = response.sources.iter().find(|source| source.name == "west-data").unwrap();
        assert_eq!(source.nodes, vec!["hk-1".to_string()]);
        assert!(source.last_error.is_none());
    }

    #[tokio::test]
    async fn startup_node_source_sync_retries_until_subscription_is_ready() {
        let temp_dir = tempfile::tempdir().unwrap();
        let config_path = temp_dir.path().join("config.jsonc");
        let sidecar_path = temp_dir.path().join("singdeck.json");
        let subscription_url = spawn_flaky_proxy_controller(
            1,
            "dHJvamFuOi8vcGFzc0BleGFtcGxlLmNvbTo0NDMjaGstMQ==",
        )
        .await;
        fs::write(
            &sidecar_path,
            format!(
                r#"{{"nodeSources":[{{"name":"west-data","url":"{subscription_url}","associate":true}}]}}"#
            ),
        )
        .unwrap();
        let controller_url = spawn_flaky_proxy_controller(
            0,
            r#"{"proxies":{"select":{"type":"Selector","all":["hk-1"]},"hk-1":{"type":"Trojan"}}}"#,
        )
        .await;
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_string_kv(&state, "config_path", config_path.to_str().unwrap()).unwrap();
        save_json_kv(
            &state,
            "controller",
            &ControllerConfig {
                controller_url,
                secret: String::new(),
            },
        )
        .unwrap();

        sync_node_sources_on_startup_with_retries(&state, 2, Duration::from_millis(1))
            .await
            .unwrap();

        let response = load_node_sources_response(&state).unwrap();
        let source = response.sources.iter().find(|source| source.name == "west-data").unwrap();
        assert_eq!(source.nodes, vec!["hk-1".to_string()]);
        assert!(source.last_error.is_none());
    }

    #[tokio::test]
    async fn sync_node_sources_hides_unconfigured_sources_but_keeps_links() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
            probe_limiter: ProbeLimiter::new(),
            events: helper_event_channel(),
        };
        save_node_source_links(
            &state,
            &NodeSourceConfigEntry {
                name: "removed".to_string(),
                url: "https://example.com/removed".to_string(),
                associate: true,
            },
            &["kept-node".to_string()],
            None,
        )
        .unwrap();

        sync_node_sources_with_nodes(&state, &NodeSourceConfig::default(), &[])
            .await
            .unwrap();

        let response = load_node_sources_response(&state).unwrap();
        assert!(response.sources.is_empty());

        let db = state.db.lock().unwrap();
        let link_count = count_node_source_nodes_from_db(&db, "removed").unwrap();
        assert_eq!(link_count, 1);
    }
}
