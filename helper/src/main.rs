use std::{
    collections::HashMap,
    env, fs,
    net::{IpAddr, SocketAddr, UdpSocket},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Path as AxumPath, State},
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Local, TimeZone};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tower_http::cors::{Any, CorsLayer};

mod traffic;

const DEFAULT_BIND: &str = "0.0.0.0:9531";
const DEFAULT_TEST_URL: &str = "https://cp.cloudflare.com/generate_204";
const DEFAULT_DELAY_TEST_TIMEOUT_MS: i64 = 5000;
const MIN_DELAY_TEST_TIMEOUT_MS: i64 = 500;
const MAX_DELAY_TEST_TIMEOUT_MS: i64 = 60_000;
const DEFAULT_PROBE_INTERVAL_SEC: i64 = 15 * 60;
const MIN_PROBE_INTERVAL_SEC: i64 = 60;
const MAX_PROBE_INTERVAL_SEC: i64 = 24 * 60 * 60;
const FAILURE_PROBE_COOLDOWN_MS: i64 = 30 * 1000;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    http: Client,
    mobile_config_url: Option<String>,
    active_probes: Arc<Mutex<HashMap<String, ActiveProbeState>>>,
}

#[derive(Debug, Clone)]
struct ActiveProbeState {
    started_at_ms: i64,
    count: usize,
    active_nodes: HashMap<String, usize>,
}

struct ActiveProbeGuard {
    state: AppState,
    group: String,
}

struct ActiveProbeNodeGuard {
    state: AppState,
    group: String,
    node: String,
}

impl Drop for ActiveProbeGuard {
    fn drop(&mut self) {
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
}

impl Drop for ActiveProbeNodeGuard {
    fn drop(&mut self) {
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestingSettingsInput {
    default_test_url: String,
    delay_test_timeout_ms: Option<i64>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeScore {
    name: String,
    score: f64,
    delay_ms: Option<i64>,
    components: ScoreComponents,
    last_tested_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ScoreComponents {
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
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin(Any);

    spawn_probe_scheduler(state.clone());

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
        .route("/api/v1/groups", get(groups))
        .route("/api/v1/probes", get(active_probes))
        .route("/api/v1/groups/:group/config", put(save_group_config))
        .route("/api/v1/groups/:group/probe", post(probe_group))
        .route("/api/v1/groups/:group/scores", get(group_scores))
        .route("/api/v1/groups/:group/apply", post(apply_group))
        .route("/api/v1/config", get(read_config))
        .route("/api/v1/config/raw", get(read_config_raw))
        .route("/api/v1/config/source", put(save_config_source))
        .route("/api/v1/traffic", get(read_traffic))
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
        "#,
    )?;
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
    let state_clone = state.clone();
    tokio::spawn(async move {
        if let Err(error) = run_scheduled_probes(&state_clone, true).await {
            eprintln!("startup probe after controller sync failed: {error}");
        }
    });
    Ok(Json(normalized))
}

async fn testing_settings(
    State(state): State<AppState>,
) -> Result<Json<TestingSettings>, AppError> {
    Ok(Json(TestingSettings {
        default_test_url: load_default_test_url(&state)?,
        delay_test_timeout_ms: load_delay_test_timeout_ms(&state)?,
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
    save_string_kv(&state, "default_test_url", default_test_url)?;
    save_string_kv(
        &state,
        "delay_test_timeout_ms",
        &delay_test_timeout_ms.to_string(),
    )?;
    Ok(Json(TestingSettings {
        default_test_url: default_test_url.to_string(),
        delay_test_timeout_ms,
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

async fn groups(State(state): State<AppState>) -> Result<Json<GroupsResponse>, AppError> {
    let controller = load_controller(&state)?;
    let proxies = fetch_proxies(&state, &controller).await?;
    let groups = proxy_groups(&proxies)
        .into_iter()
        .map(|proxy| {
            let config = load_group_config(&state, &proxy.name)?;
            let scores = compute_scores_for_group(&state, &proxy.name, &proxy.all, &config)?;
            let recommended = scores.first().map(|score| score.name.clone());
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

async fn active_probes(
    State(state): State<AppState>,
) -> Result<Json<ProbeStatusResponse>, AppError> {
    Ok(Json(ProbeStatusResponse {
        groups: active_probe_groups(&state),
    }))
}

async fn save_group_config(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(config): Json<GroupConfig>,
) -> Result<Json<GroupConfig>, AppError> {
    save_group_config_row(&state, &group, &config)?;
    Ok(Json(config))
}

async fn probe_group(
    State(state): State<AppState>,
    AxumPath(group): AxumPath<String>,
    Json(request): Json<ProbeRequest>,
) -> Result<Json<ScoresResponse>, AppError> {
    let concurrency = request.concurrency.unwrap_or(4).clamp(1, 12);
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
        recommended: scores.first().map(|score| score.name.clone()),
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
        .or_else(|| scores.first().map(|score| score.name.clone()))
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
        recommended: scores.first().map(|score| score.name.clone()),
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
) -> Result<bool> {
    let path = format!(
        "/proxies/{}/delay?timeout={}&url={}",
        url_encode(probe_target),
        timeout_ms,
        url_encode(test_url)
    );
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
            Ok(true)
        }
        Err(error) => {
            save_probe_sample(
                state,
                group,
                node,
                test_url,
                None,
                false,
                Some(error.to_string()),
                tested_at_ms,
            )?;
            Ok(false)
        }
    }
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
            scores.first().map(|score| score.name.clone())
        } else {
            Some(group_proxy.now.clone())
        };

        return Ok(ScoresResponse {
            group: group.to_string(),
            mode: config.mode,
            scheme: config.scheme,
            test_url: config.test_url,
            recommended,
            apply_error: None,
            nodes: scores,
        });
    }

    probe_group_nodes(state, &controller, group, group_proxy, &config, concurrency).await?;

    let scores = compute_scores_for_group(state, group, &group_proxy.all, &config)?;
    let recommended = scores.first().map(|score| score.name.clone());
    let apply_error = if should_apply_probe_result(apply_urltest, &config) {
        if let Some(target) = recommended.as_deref() {
            apply_recommended_node(state, &controller, group_proxy, target).await
        } else {
            None
        }
    } else {
        None
    };

    Ok(ScoresResponse {
        group: group.to_string(),
        mode: config.mode,
        scheme: config.scheme,
        test_url: config.test_url,
        recommended,
        apply_error,
        nodes: scores,
    })
}

async fn probe_group_nodes(
    state: &AppState,
    controller: &ControllerConfig,
    group: &str,
    group_proxy: &ProxyView,
    config: &GroupConfig,
    concurrency: usize,
) -> Result<usize> {
    let concurrency = concurrency.clamp(1, 12);
    let _active_probe = begin_active_probe(state, group);
    let timeout_ms = load_delay_test_timeout_ms(state)?;
    let proxy_map = fetch_proxies(state, controller)
        .await
        .map(|proxies| proxy_map(&proxies))
        .unwrap_or_default();
    let mut failures = 0usize;
    let mut handles = Vec::new();
    for chunk in group_proxy.all.chunks(concurrency) {
        handles.clear();
        for node in chunk {
            let state_clone = state.clone();
            let controller_clone = controller.clone();
            let group_name = group.to_string();
            let test_url = config.test_url.clone();
            let node_name = node.clone();
            let probe_target = resolve_leaf_proxy_name(node, &proxy_map);
            handles.push(tokio::spawn(async move {
                probe_node(
                    &state_clone,
                    &controller_clone,
                    &group_name,
                    &node_name,
                    &probe_target,
                    &test_url,
                    timeout_ms,
                )
                .await
            }));
        }

        for handle in handles.drain(..) {
            let ok = handle
                .await
                .map_err(|error| anyhow!("probe task failed: {error}"))??;
            if !ok {
                failures += 1;
            }
        }
    }
    Ok(failures)
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

async fn run_scheduled_probes(state: &AppState, force: bool) -> Result<()> {
    let controller = load_controller(state)?;
    if controller.controller_url.is_empty() {
        return Ok(());
    }

    let proxies = match fetch_proxies(state, &controller).await {
        Ok(proxies) => proxies,
        Err(error) if is_controller_poll_error(&error) => return Ok(()),
        Err(error) => return Err(error),
    };
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

        probe_group_nodes(state, &controller, &group.name, &group, &config, 4).await?;

        let scores = compute_scores_for_group(state, &group.name, &group.all, &config)?;
        if config.auto_switch {
            if let Some(target) = scores.first().map(|score| score.name.clone()) {
                if let Some(error) =
                    apply_recommended_node(state, &controller, &group, &target).await
                {
                    eprintln!("auto switch failed for {}: {error}", group.name);
                }
            }
        }
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
        if let Err(error) = probe_group_internal(state, &group.name, 4, true).await {
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
                let probe_interval_sec = normalize_probe_interval(row.get::<_, i64>(6)?);
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
            normalize_probe_interval(config.probe_interval_sec)
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
        FROM probe_samples
        WHERE group_name = ?1 AND node_name = ?2 AND test_url = ?3 AND tested_at_ms >= ?4
        ORDER BY tested_at_ms ASC
        "#,
    )?;
    let rows = stmt.query_map(params![group, node, test_url, window_start], |row| {
        Ok(Sample {
            delay_ms: row.get(0)?,
            success: row.get::<_, i64>(1)? != 0,
            error: row.get(2)?,
            tested_at_ms: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn score_sample_window_ms(config: &GroupConfig) -> i64 {
    normalize_probe_interval(config.probe_interval_sec) * 1000
}

fn score_node(name: &str, samples: &[Sample], config: &GroupConfig) -> NodeScore {
    let now = now_ms();
    let latest = samples.last();
    let delay_ms = latest.and_then(|sample| {
        if sample.success {
            sample.delay_ms
        } else {
            None
        }
    });
    let components = ScoreComponents {
        latency: latency_score(delay_ms),
        availability: availability_score(samples),
        jitter: jitter_score(samples),
        freshness: freshness_score(latest.map(|sample| sample.tested_at_ms), now),
    };
    let score = match config.mode {
        ScoreMode::Delay => components.latency,
        ScoreMode::Score => weighted_score(components, config.scheme),
    };
    NodeScore {
        name: name.to_string(),
        score: round_score(score),
        delay_ms,
        components: round_components(components),
        last_tested_at: latest.map(|sample| format_time(sample.tested_at_ms)),
        error: latest.and_then(|sample| sample.error.clone()),
    }
}

fn latency_score(delay_ms: Option<i64>) -> f64 {
    let Some(delay) = delay_ms else {
        return 0.0;
    };
    if delay <= 80 {
        100.0
    } else if delay <= 300 {
        linear(delay as f64, 80.0, 300.0, 100.0, 70.0)
    } else if delay <= 800 {
        linear(delay as f64, 300.0, 800.0, 70.0, 30.0)
    } else if delay <= 2000 {
        linear(delay as f64, 800.0, 2000.0, 30.0, 5.0)
    } else {
        0.0
    }
}

fn availability_score(samples: &[Sample]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let success = samples.iter().filter(|sample| sample.success).count() as f64;
    success / samples.len() as f64 * 100.0
}

fn jitter_score(samples: &[Sample]) -> f64 {
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
    if delays.len() < 2 {
        return if delays.is_empty() { 0.0 } else { 100.0 };
    }
    delays.sort_unstable();
    let p50 = percentile(&delays, 0.50);
    let p95 = percentile(&delays, 0.95);
    let jitter = (p95 - p50).max(0) as f64;
    if jitter <= 50.0 {
        100.0
    } else if jitter <= 400.0 {
        linear(jitter, 50.0, 400.0, 100.0, 0.0)
    } else {
        0.0
    }
}

fn freshness_score(last_tested_at: Option<i64>, now: i64) -> f64 {
    let Some(last) = last_tested_at else {
        return 0.0;
    };
    let age = (now - last).max(0) as f64;
    let two_min = 2.0 * 60.0 * 1000.0;
    let fifteen_min = 15.0 * 60.0 * 1000.0;
    if age <= two_min {
        100.0
    } else if age <= fifteen_min {
        linear(age, two_min, fifteen_min, 100.0, 0.0)
    } else {
        0.0
    }
}

fn weighted_score(components: ScoreComponents, scheme: ScoreScheme) -> f64 {
    let weights = match scheme {
        ScoreScheme::LatencyFirst => (0.70, 0.15, 0.10, 0.05),
        ScoreScheme::Balanced => (0.45, 0.30, 0.15, 0.10),
    };
    components.latency * weights.0
        + components.availability * weights.1
        + components.jitter * weights.2
        + components.freshness * weights.3
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

fn normalize_delay_test_timeout(value: i64) -> i64 {
    value.clamp(MIN_DELAY_TEST_TIMEOUT_MS, MAX_DELAY_TEST_TIMEOUT_MS)
}

fn default_delay_test_timeout_ms() -> i64 {
    DEFAULT_DELAY_TEST_TIMEOUT_MS
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
        lan_ip?
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
    if let Ok(mut active_probes) = state.active_probes.lock() {
        let active_probe =
            active_probes
                .entry(group.to_string())
                .or_insert_with(|| ActiveProbeState {
                    started_at_ms: now_ms(),
                    count: 0,
                    active_nodes: HashMap::new(),
                });
        active_probe.count += 1;
    }

    ActiveProbeGuard {
        state: state.clone(),
        group: group.to_string(),
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
            let mut active_nodes = active_probe.active_nodes.keys().cloned().collect::<Vec<_>>();
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

fn remove_idle_active_probe(
    active_probes: &mut HashMap<String, ActiveProbeState>,
    group: &str,
) {
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

    #[test]
    fn latency_score_favors_low_latency() {
        assert_eq!(latency_score(Some(40)), 100.0);
        assert!(latency_score(Some(200)) > latency_score(Some(700)));
        assert_eq!(latency_score(Some(2500)), 0.0);
        assert_eq!(latency_score(None), 0.0);
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
        assert!(score.score > 80.0);
        assert_eq!(score.delay_ms, Some(120));
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
    }

    #[test]
    fn delay_mode_recommends_lowest_recent_delay() {
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
                    tested_at_ms: 1,
                }],
                &config,
            ),
            score_node(
                "node-b",
                &[Sample {
                    delay_ms: Some(40),
                    success: true,
                    error: None,
                    tested_at_ms: 1,
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
            },
            NodeScore {
                name: "z-faster".to_string(),
                score: 88.0,
                delay_ms: Some(80),
                components: ScoreComponents::default(),
                last_tested_at: None,
                error: None,
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
    fn active_probe_tracking_keeps_group_until_all_runs_finish() {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let state = AppState {
            db: Arc::new(Mutex::new(conn)),
            http: Client::new(),
            mobile_config_url: None,
            active_probes: Arc::new(Mutex::new(HashMap::new())),
        };

        let first = begin_active_probe(&state, "select");
        let second = begin_active_probe(&state, "select");

        assert_eq!(active_probe_groups(&state).len(), 1);
        drop(first);
        assert_eq!(active_probe_groups(&state).len(), 1);
        drop(second);
        assert!(active_probe_groups(&state).is_empty());
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
            Some("http://10.0.0.12:9531/api/v1/config/raw".to_string())
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
}
