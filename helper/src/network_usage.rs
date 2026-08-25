use anyhow::Result;
use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MINUTE_MS: i64 = 60 * 1000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const SETTINGS_KEY: &str = "network_usage_settings";
const LAST_SAMPLE_AT_KEY: &str = "network_usage_last_sample_at";
const LAST_CLEANUP_AT_KEY: &str = "network_usage_last_cleanup_at";
const DEFAULT_RETENTION_DAYS: i64 = 7;
const MIN_RETENTION_DAYS: i64 = 1;
pub const MAX_RETENTION_DAYS: i64 = 90;
pub const DEFAULT_SAMPLE_INTERVAL_SEC: i64 = 5;
const MIN_SAMPLE_INTERVAL_SEC: i64 = 2;
pub const MAX_SAMPLE_INTERVAL_SEC: i64 = 3600;
const MAX_QUERY_LIMIT: i64 = 200;
const CLEANUP_INTERVAL_MS: i64 = HOUR_MS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkUsageSettings {
    pub enabled: bool,
    pub retention_days: i64,
    #[serde(default = "default_sample_interval_sec")]
    pub sample_interval_sec: i64,
}

impl Default for NetworkUsageSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            sample_interval_sec: DEFAULT_SAMPLE_INTERVAL_SEC,
        }
    }
}

fn default_sample_interval_sec() -> i64 {
    DEFAULT_SAMPLE_INTERVAL_SEC
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageBucket {
    Minute,
    Hour,
}

impl UsageBucket {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "hour" => Self::Hour,
            _ => Self::Minute,
        }
    }

    fn size_ms(self) -> i64 {
        match self {
            Self::Minute => MINUTE_MS,
            Self::Hour => HOUR_MS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceTrendBucket {
    Hour,
    Day,
}

impl SourceTrendBucket {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "day" => Self::Day,
            _ => Self::Hour,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }

    fn size_ms(self) -> i64 {
        match self {
            Self::Hour => HOUR_MS,
            Self::Day => DAY_MS,
        }
    }

    fn point_count(self, days: i64) -> usize {
        match self {
            Self::Hour => (days * 24) as usize,
            Self::Day => days as usize,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageGroupBy {
    Host,
    Outbound,
    Rule,
}

impl UsageGroupBy {
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").trim().to_ascii_lowercase().as_str() {
            "outbound" => Self::Outbound,
            "rule" => Self::Rule,
            _ => Self::Host,
        }
    }

    fn column(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Outbound => "outbound",
            Self::Rule => "rule",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Outbound => "outbound",
            Self::Rule => "rule",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryResponse {
    pub from_ms: i64,
    pub to_ms: i64,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
    pub connection_count: i64,
    pub buckets: Vec<UsageSummaryBucket>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryBucket {
    pub bucket_start_ms: i64,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
    pub connection_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTopResponse {
    pub group_by: String,
    pub items: Vec<UsageTopItem>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTopItem {
    pub label: String,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
    pub connection_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageConnectionsResponse {
    pub connections: Vec<UsageConnectionRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowResponse {
    pub summary: UsageSummaryResponse,
    pub top_hosts: UsageTopResponse,
    pub top_outbounds: UsageTopResponse,
    pub top_strategies: UsageTopResponse,
    pub connections: UsageConnectionsResponse,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceTrendResponse {
    pub from_ms: i64,
    pub to_ms: i64,
    pub bucket: String,
    pub sources: Vec<UsageSourceTrendSource>,
    pub unknown_nodes: Vec<UsageUnknownNode>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceTrendSource {
    pub name: String,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
    pub buckets: Vec<UsageSourceTrendPoint>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSourceTrendPoint {
    pub bucket_start_ms: i64,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageUnknownNode {
    pub name: String,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageConnectionRow {
    pub id: String,
    pub host: String,
    pub network: String,
    pub rule: String,
    pub outbound: String,
    pub chains: Vec<String>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub upload_bytes: i64,
    pub download_bytes: i64,
    pub total_bytes: i64,
}

#[derive(Debug, Clone)]
struct ConnectionSample {
    id: String,
    host: String,
    network: String,
    rule: String,
    outbound: String,
    chains: Vec<String>,
    started_at_ms: Option<i64>,
    upload_counter: i64,
    download_counter: i64,
}

#[derive(Debug, Clone, Default)]
struct SourceAggregate {
    upload_bytes: i64,
    download_bytes: i64,
    buckets: BTreeMap<i64, (i64, i64)>,
}

#[derive(Debug, Clone, Default)]
struct StrategyAggregate {
    upload_bytes: i64,
    download_bytes: i64,
    connection_ids: BTreeSet<String>,
}

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS network_usage_connections (
          connection_id TEXT PRIMARY KEY,
          first_seen_ms INTEGER NOT NULL,
          last_seen_ms INTEGER NOT NULL,
          host TEXT NOT NULL,
          network TEXT NOT NULL,
          rule TEXT NOT NULL,
          outbound TEXT NOT NULL,
          chains_json TEXT NOT NULL,
          upload_bytes INTEGER NOT NULL DEFAULT 0,
          download_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS network_usage_last_seen (
          connection_id TEXT PRIMARY KEY,
          upload_counter INTEGER NOT NULL,
          download_counter INTEGER NOT NULL,
          seen_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS network_usage_buckets (
          bucket_start_ms INTEGER NOT NULL,
          connection_id TEXT NOT NULL,
          host TEXT NOT NULL,
          network TEXT NOT NULL,
          rule TEXT NOT NULL,
          outbound TEXT NOT NULL,
          upload_bytes INTEGER NOT NULL DEFAULT 0,
          download_bytes INTEGER NOT NULL DEFAULT 0,
          sample_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(bucket_start_ms, connection_id)
        );
        CREATE INDEX IF NOT EXISTS idx_usage_buckets_time
          ON network_usage_buckets(bucket_start_ms);
        CREATE INDEX IF NOT EXISTS idx_usage_buckets_host_time
          ON network_usage_buckets(host, bucket_start_ms);
        CREATE INDEX IF NOT EXISTS idx_usage_buckets_outbound_time
          ON network_usage_buckets(outbound, bucket_start_ms);
        CREATE INDEX IF NOT EXISTS idx_usage_buckets_rule_time
          ON network_usage_buckets(rule, bucket_start_ms);
        CREATE INDEX IF NOT EXISTS idx_usage_buckets_connection_time
          ON network_usage_buckets(connection_id, bucket_start_ms);
        CREATE INDEX IF NOT EXISTS idx_usage_connections_last_seen
          ON network_usage_connections(last_seen_ms);
        "#,
    )?;
    Ok(())
}

pub fn load_settings(conn: &Connection) -> Result<NetworkUsageSettings> {
    let raw = conn
        .query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(raw) = raw else {
        return Ok(NetworkUsageSettings::default());
    };
    let parsed = serde_json::from_str::<NetworkUsageSettings>(&raw).unwrap_or_default();
    Ok(normalize_settings(parsed))
}

pub fn save_settings(
    conn: &Connection,
    settings: &NetworkUsageSettings,
) -> Result<NetworkUsageSettings> {
    let normalized = normalize_settings(settings.clone());
    let value = serde_json::to_string(&normalized)?;
    conn.execute(
        r#"
        INSERT INTO kv(key, value)
        VALUES(?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![SETTINGS_KEY, value],
    )?;
    Ok(normalized)
}

pub fn normalize_settings(settings: NetworkUsageSettings) -> NetworkUsageSettings {
    NetworkUsageSettings {
        enabled: settings.enabled,
        retention_days: settings
            .retention_days
            .clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
        sample_interval_sec: settings
            .sample_interval_sec
            .clamp(MIN_SAMPLE_INTERVAL_SEC, MAX_SAMPLE_INTERVAL_SEC),
    }
}

pub fn apply_connections_snapshot(
    conn: &Connection,
    snapshot: &Value,
    sampled_at_ms: i64,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let previous_sampled_at_ms = load_last_sample_at(&tx)?;
    for sample in parse_connection_samples(snapshot) {
        record_connection_sample(&tx, &sample, sampled_at_ms, previous_sampled_at_ms)?;
    }
    save_last_sample_at(&tx, sampled_at_ms)?;
    tx.commit()?;
    Ok(())
}

fn record_connection_sample(
    conn: &Connection,
    sample: &ConnectionSample,
    sampled_at_ms: i64,
    previous_sampled_at_ms: Option<i64>,
) -> Result<()> {
    let previous = conn
        .query_row(
            r#"
            SELECT upload_counter, download_counter
            FROM network_usage_last_seen
            WHERE connection_id = ?1
            "#,
            [&sample.id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()?;

    let (upload_delta, download_delta) = match previous {
        Some((upload, download)) => (
            (sample.upload_counter - upload).max(0),
            (sample.download_counter - download).max(0),
        ),
        None if is_new_connection_since_last_sample(
            sample.started_at_ms,
            previous_sampled_at_ms,
            sampled_at_ms,
        ) =>
        {
            (sample.upload_counter.max(0), sample.download_counter.max(0))
        }
        None => (0, 0),
    };
    let chains_json = serde_json::to_string(&sample.chains)?;

    conn.execute(
        r#"
        INSERT INTO network_usage_connections(
          connection_id, first_seen_ms, last_seen_ms, host, network, rule, outbound,
          chains_json, upload_bytes, download_bytes
        )
        VALUES(?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(connection_id) DO UPDATE SET
          last_seen_ms = excluded.last_seen_ms,
          host = excluded.host,
          network = excluded.network,
          rule = excluded.rule,
          outbound = excluded.outbound,
          chains_json = excluded.chains_json,
          upload_bytes = network_usage_connections.upload_bytes + excluded.upload_bytes,
          download_bytes = network_usage_connections.download_bytes + excluded.download_bytes
        "#,
        params![
            sample.id,
            sampled_at_ms,
            sample.host,
            sample.network,
            sample.rule,
            sample.outbound,
            chains_json,
            upload_delta,
            download_delta
        ],
    )?;

    if upload_delta > 0 || download_delta > 0 {
        let bucket_start_ms = (sampled_at_ms / MINUTE_MS) * MINUTE_MS;
        conn.execute(
            r#"
            INSERT INTO network_usage_buckets(
              bucket_start_ms, connection_id, host, network, rule, outbound,
              upload_bytes, download_bytes, sample_count
            )
            VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
            ON CONFLICT(bucket_start_ms, connection_id) DO UPDATE SET
              host = excluded.host,
              network = excluded.network,
              rule = excluded.rule,
              outbound = excluded.outbound,
              upload_bytes = network_usage_buckets.upload_bytes + excluded.upload_bytes,
              download_bytes = network_usage_buckets.download_bytes + excluded.download_bytes,
              sample_count = network_usage_buckets.sample_count + 1
            "#,
            params![
                bucket_start_ms,
                sample.id,
                sample.host,
                sample.network,
                sample.rule,
                sample.outbound,
                upload_delta,
                download_delta
            ],
        )?;
    }

    conn.execute(
        r#"
        INSERT INTO network_usage_last_seen(
          connection_id, upload_counter, download_counter, seen_at_ms
        )
        VALUES(?1, ?2, ?3, ?4)
        ON CONFLICT(connection_id) DO UPDATE SET
          upload_counter = excluded.upload_counter,
          download_counter = excluded.download_counter,
          seen_at_ms = excluded.seen_at_ms
        "#,
        params![
            sample.id,
            sample.upload_counter,
            sample.download_counter,
            sampled_at_ms
        ],
    )?;

    Ok(())
}

fn load_last_sample_at(conn: &Connection) -> Result<Option<i64>> {
    load_i64_kv(conn, LAST_SAMPLE_AT_KEY)
}

fn save_last_sample_at(conn: &Connection, sampled_at_ms: i64) -> Result<()> {
    save_i64_kv(conn, LAST_SAMPLE_AT_KEY, sampled_at_ms)
}

fn load_i64_kv(conn: &Connection, key: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<i64>().ok()))
}

fn save_i64_kv(conn: &Connection, key: &str, value: i64) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO kv(key, value)
        VALUES(?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![key, value.to_string()],
    )?;
    Ok(())
}

fn is_new_connection_since_last_sample(
    started_at_ms: Option<i64>,
    previous_sampled_at_ms: Option<i64>,
    sampled_at_ms: i64,
) -> bool {
    let (Some(started_at_ms), Some(previous_sampled_at_ms)) =
        (started_at_ms, previous_sampled_at_ms)
    else {
        return false;
    };
    started_at_ms >= previous_sampled_at_ms && started_at_ms <= sampled_at_ms
}

pub fn cleanup_old_usage(conn: &Connection, now_ms: i64, retention_days: i64) -> Result<()> {
    let cutoff = now_ms - normalize_settings(NetworkUsageSettings {
        enabled: true,
        retention_days,
        sample_interval_sec: DEFAULT_SAMPLE_INTERVAL_SEC,
    })
    .retention_days
        * DAY_MS;
    conn.execute(
        "DELETE FROM network_usage_buckets WHERE bucket_start_ms < ?1",
        [cutoff],
    )?;
    conn.execute(
        "DELETE FROM network_usage_connections WHERE last_seen_ms < ?1",
        [cutoff],
    )?;
    conn.execute(
        "DELETE FROM network_usage_last_seen WHERE seen_at_ms < ?1",
        [cutoff],
    )?;
    Ok(())
}

pub fn cleanup_old_usage_if_due(
    conn: &Connection,
    now_ms: i64,
    retention_days: i64,
) -> Result<bool> {
    let last_cleanup_at = load_i64_kv(conn, LAST_CLEANUP_AT_KEY)?;
    if last_cleanup_at
        .map(|timestamp| now_ms.saturating_sub(timestamp) < CLEANUP_INTERVAL_MS)
        .unwrap_or(false)
    {
        return Ok(false);
    }

    cleanup_old_usage(conn, now_ms, retention_days)?;
    save_i64_kv(conn, LAST_CLEANUP_AT_KEY, now_ms)?;
    Ok(true)
}

pub fn query_summary(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    bucket: UsageBucket,
) -> Result<UsageSummaryResponse> {
    let (upload_bytes, download_bytes, connection_count) = conn.query_row(
        r#"
        SELECT
          COALESCE(SUM(upload_bytes), 0),
          COALESCE(SUM(download_bytes), 0),
          COUNT(DISTINCT connection_id)
        FROM network_usage_buckets
        WHERE bucket_start_ms >= ?1 AND bucket_start_ms < ?2
        "#,
        params![from_ms, to_ms],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;

    let bucket_size = bucket.size_ms();
    let mut stmt = conn.prepare(
        r#"
        SELECT
          (bucket_start_ms / ?1) * ?1 AS grouped_bucket,
          COALESCE(SUM(upload_bytes), 0),
          COALESCE(SUM(download_bytes), 0),
          COUNT(DISTINCT connection_id)
        FROM network_usage_buckets
        WHERE bucket_start_ms >= ?2 AND bucket_start_ms < ?3
        GROUP BY grouped_bucket
        ORDER BY grouped_bucket ASC
        "#,
    )?;
    let buckets = stmt
        .query_map(params![bucket_size, from_ms, to_ms], |row| {
            let upload_bytes = row.get::<_, i64>(1)?;
            let download_bytes = row.get::<_, i64>(2)?;
            Ok(UsageSummaryBucket {
                bucket_start_ms: row.get(0)?,
                upload_bytes,
                download_bytes,
                total_bytes: upload_bytes + download_bytes,
                connection_count: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(UsageSummaryResponse {
        from_ms,
        to_ms,
        upload_bytes,
        download_bytes,
        total_bytes: upload_bytes + download_bytes,
        connection_count,
        buckets,
    })
}

pub fn query_top(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    group_by: UsageGroupBy,
    limit: i64,
) -> Result<UsageTopResponse> {
    let limit = limit.clamp(1, MAX_QUERY_LIMIT);
    let column = group_by.column();
    let sql = format!(
        r#"
        SELECT
          {column},
          COALESCE(SUM(upload_bytes), 0),
          COALESCE(SUM(download_bytes), 0),
          COUNT(DISTINCT connection_id)
        FROM network_usage_buckets
        WHERE bucket_start_ms >= ?1 AND bucket_start_ms < ?2
        GROUP BY {column}
        ORDER BY COALESCE(SUM(upload_bytes + download_bytes), 0) DESC, {column} ASC
        LIMIT ?3
        "#
    );
    let mut stmt = conn.prepare(&sql)?;
    let items = stmt
        .query_map(params![from_ms, to_ms, limit], |row| {
            let upload_bytes = row.get::<_, i64>(1)?;
            let download_bytes = row.get::<_, i64>(2)?;
            Ok(UsageTopItem {
                label: row.get::<_, String>(0)?,
                upload_bytes,
                download_bytes,
                total_bytes: upload_bytes + download_bytes,
                connection_count: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(UsageTopResponse {
        group_by: group_by.label().to_string(),
        items,
    })
}

pub fn query_top_strategies(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    limit: i64,
) -> Result<UsageTopResponse> {
    let limit = limit.clamp(1, MAX_QUERY_LIMIT) as usize;
    let mut stmt = conn.prepare(
        r#"
        SELECT
          b.connection_id,
          c.rule,
          c.outbound,
          c.chains_json,
          COALESCE(SUM(b.upload_bytes), 0),
          COALESCE(SUM(b.download_bytes), 0)
        FROM network_usage_buckets b
        JOIN network_usage_connections c ON c.connection_id = b.connection_id
        WHERE b.bucket_start_ms >= ?1 AND b.bucket_start_ms < ?2
        GROUP BY b.connection_id, c.rule, c.outbound, c.chains_json
        "#,
    )?;
    let rows = stmt.query_map(params![from_ms, to_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    let mut strategies = BTreeMap::<String, StrategyAggregate>::new();
    for row in rows {
        let (connection_id, rule, outbound, chains_json, upload_bytes, download_bytes) = row?;
        let chains = serde_json::from_str::<Vec<String>>(&chains_json).unwrap_or_default();
        let label = strategy_group_label(&rule, &outbound, &chains);
        let aggregate = strategies.entry(label).or_default();
        aggregate.upload_bytes += upload_bytes;
        aggregate.download_bytes += download_bytes;
        aggregate.connection_ids.insert(connection_id);
    }

    let mut items = strategies
        .into_iter()
        .map(|(label, aggregate)| UsageTopItem {
            label,
            upload_bytes: aggregate.upload_bytes,
            download_bytes: aggregate.download_bytes,
            total_bytes: aggregate.upload_bytes + aggregate.download_bytes,
            connection_count: aggregate.connection_ids.len() as i64,
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .total_bytes
            .cmp(&left.total_bytes)
            .then_with(|| left.label.cmp(&right.label))
    });
    items.truncate(limit);

    Ok(UsageTopResponse {
        group_by: "strategy".to_string(),
        items,
    })
}

pub fn query_connections(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    limit: i64,
    query: Option<&str>,
) -> Result<UsageConnectionsResponse> {
    let limit = limit.clamp(1, MAX_QUERY_LIMIT);
    let trimmed_query = query.map(str::trim).filter(|value| !value.is_empty());
    let connections = if let Some(query) = trimmed_query {
        let pattern = format!("%{query}%");
        let mut stmt = conn.prepare(
            r#"
            SELECT
              c.connection_id,
              c.host,
              c.network,
              c.rule,
              c.outbound,
              c.chains_json,
              MIN(b.bucket_start_ms),
              MAX(b.bucket_start_ms),
              COALESCE(SUM(b.upload_bytes), 0),
              COALESCE(SUM(b.download_bytes), 0)
            FROM network_usage_buckets b
            JOIN network_usage_connections c ON c.connection_id = b.connection_id
            WHERE b.bucket_start_ms >= ?1
              AND b.bucket_start_ms < ?2
              AND (c.host LIKE ?3 OR c.outbound LIKE ?3 OR c.rule LIKE ?3)
            GROUP BY c.connection_id
            ORDER BY MAX(b.bucket_start_ms) DESC,
              COALESCE(SUM(b.upload_bytes + b.download_bytes), 0) DESC,
              c.connection_id ASC
            LIMIT ?4
            "#,
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, pattern, limit], connection_row)?;
        let collected = rows_to_connections(rows);
        collected
    } else {
        let mut stmt = conn.prepare(
            r#"
            SELECT
              c.connection_id,
              c.host,
              c.network,
              c.rule,
              c.outbound,
              c.chains_json,
              MIN(b.bucket_start_ms),
              MAX(b.bucket_start_ms),
              COALESCE(SUM(b.upload_bytes), 0),
              COALESCE(SUM(b.download_bytes), 0)
            FROM network_usage_buckets b
            JOIN network_usage_connections c ON c.connection_id = b.connection_id
            WHERE b.bucket_start_ms >= ?1 AND b.bucket_start_ms < ?2
            GROUP BY c.connection_id
            ORDER BY MAX(b.bucket_start_ms) DESC,
              COALESCE(SUM(b.upload_bytes + b.download_bytes), 0) DESC,
              c.connection_id ASC
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, limit], connection_row)?;
        let collected = rows_to_connections(rows);
        collected
    }?;

    Ok(UsageConnectionsResponse { connections })
}

pub fn query_window(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    bucket: UsageBucket,
    limit: i64,
    query: Option<&str>,
) -> Result<UsageWindowResponse> {
    Ok(UsageWindowResponse {
        summary: query_summary(conn, from_ms, to_ms, bucket)?,
        top_hosts: query_top(conn, from_ms, to_ms, UsageGroupBy::Host, limit)?,
        top_outbounds: query_top(conn, from_ms, to_ms, UsageGroupBy::Outbound, limit)?,
        top_strategies: query_top_strategies(conn, from_ms, to_ms, limit)?,
        connections: query_connections(conn, from_ms, to_ms, limit, query)?,
    })
}

pub fn query_source_trend(
    conn: &Connection,
    now_ms: i64,
    days: i64,
    bucket: SourceTrendBucket,
    tz_offset_minutes: i64,
    current_nodes: Option<&BTreeSet<String>>,
) -> Result<UsageSourceTrendResponse> {
    let days = days.clamp(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
    let bucket_size = bucket.size_ms();
    let point_count = bucket.point_count(days);
    let offset_ms = tz_offset_minutes.clamp(-24 * 60, 24 * 60) * MINUTE_MS;
    let current_bucket_start = aligned_bucket_start(now_ms.max(0), bucket_size, offset_ms);
    let from_ms = current_bucket_start.saturating_sub((point_count as i64 - 1) * bucket_size);
    let to_ms = current_bucket_start.saturating_add(bucket_size);
    let bucket_starts = (0..point_count)
        .map(|index| from_ms + index as i64 * bucket_size)
        .collect::<Vec<_>>();

    let mut sources = BTreeMap::<String, SourceAggregate>::new();

    let mut stmt = conn.prepare(
        r#"
        SELECT
          b.bucket_start_ms,
          b.outbound,
          c.chains_json,
          c.rule,
          COALESCE(SUM(b.upload_bytes), 0),
          COALESCE(SUM(b.download_bytes), 0)
        FROM network_usage_buckets b
        LEFT JOIN network_usage_connections c ON c.connection_id = b.connection_id
        WHERE b.bucket_start_ms >= ?1 AND b.bucket_start_ms < ?2
        GROUP BY b.bucket_start_ms, b.connection_id, b.outbound, c.chains_json, c.rule
        ORDER BY b.bucket_start_ms ASC
        "#,
    )?;
    let rows = stmt.query_map(params![from_ms, to_ms], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    for row in rows {
        let (raw_bucket_start, outbound, chains_json, rule, upload_bytes, download_bytes) = row?;
        if upload_bytes == 0 && download_bytes == 0 {
            continue;
        }
        let chains = chains_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<Vec<String>>(value).ok())
            .unwrap_or_default();
        if let Some(current_nodes) = current_nodes {
            if !current_nodes.is_empty() {
                let candidates = source_candidate_nodes(&outbound, &chains);
                if !candidates.is_empty()
                    && !candidates.iter().any(|node| current_nodes.contains(node.as_str()))
                {
                    continue;
                }
            }
        }
        let rule_str = rule.as_deref().unwrap_or("");
        let group_name = strategy_group_label(rule_str, &outbound, &chains);
        let grouped_bucket = aligned_bucket_start(raw_bucket_start, bucket_size, offset_ms);
        if grouped_bucket < from_ms || grouped_bucket >= to_ms {
            continue;
        }

        let aggregate = sources.entry(group_name).or_default();
        aggregate.upload_bytes += upload_bytes;
        aggregate.download_bytes += download_bytes;
        let bucket_total = aggregate.buckets.entry(grouped_bucket).or_default();
        bucket_total.0 += upload_bytes;
        bucket_total.1 += download_bytes;
    }

    let mut source_rows = sources
        .into_iter()
        .map(|(name, aggregate)| {
            let buckets = bucket_starts
                .iter()
                .map(|bucket_start_ms| {
                    let (upload_bytes, download_bytes) = aggregate
                        .buckets
                        .get(bucket_start_ms)
                        .copied()
                        .unwrap_or_default();
                    UsageSourceTrendPoint {
                        bucket_start_ms: *bucket_start_ms,
                        upload_bytes,
                        download_bytes,
                        total_bytes: upload_bytes + download_bytes,
                    }
                })
                .collect::<Vec<_>>();
            UsageSourceTrendSource {
                name,
                upload_bytes: aggregate.upload_bytes,
                download_bytes: aggregate.download_bytes,
                total_bytes: aggregate.upload_bytes + aggregate.download_bytes,
                buckets,
            }
        })
        .collect::<Vec<_>>();
    source_rows.sort_by(|left, right| {
        right
            .total_bytes
            .cmp(&left.total_bytes)
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(UsageSourceTrendResponse {
        from_ms,
        to_ms,
        bucket: bucket.label().to_string(),
        sources: source_rows,
        unknown_nodes: vec![],
    })
}

fn query_node_source_map(conn: &Connection) -> Result<BTreeMap<String, String>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT node_name, source_name
        FROM node_source_nodes
        ORDER BY source_name ASC, node_name ASC
        "#,
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut node_sources = BTreeMap::new();
    for row in rows {
        let (node_name, source_name) = row?;
        node_sources.entry(node_name).or_insert(source_name);
    }
    Ok(node_sources)
}

fn source_candidate_nodes(outbound: &str, chains: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    std::iter::once(outbound)
        .chain(chains.iter().map(String::as_str))
        .filter_map(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return None;
            }
            if seen.insert(trimmed.to_string()) {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn aligned_bucket_start(value_ms: i64, bucket_size_ms: i64, offset_ms: i64) -> i64 {
    (value_ms - offset_ms).div_euclid(bucket_size_ms) * bucket_size_ms + offset_ms
}

fn strategy_group_label(rule: &str, outbound: &str, chains: &[String]) -> String {
    route_rule_target(rule)
        .or_else(|| {
            chains
                .iter()
                .rev()
                .map(|value| value.trim())
                .find(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            let trimmed = outbound.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn route_rule_target(rule: &str) -> Option<String> {
    let lower = rule.to_ascii_lowercase();
    let start = lower.find("route(")? + "route(".len();
    let end = rule[start..].find(')')? + start;
    let target = rule[start..end].trim();
    if target.is_empty() {
        None
    } else {
        Some(target.to_string())
    }
}

fn rows_to_connections<F>(rows: rusqlite::MappedRows<'_, F>) -> Result<Vec<UsageConnectionRow>>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<UsageConnectionRow>,
{
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn connection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UsageConnectionRow> {
    let chains_json = row.get::<_, String>(5)?;
    let chains = serde_json::from_str::<Vec<String>>(&chains_json).unwrap_or_default();
    let upload_bytes = row.get::<_, i64>(8)?;
    let download_bytes = row.get::<_, i64>(9)?;
    Ok(UsageConnectionRow {
        id: row.get(0)?,
        host: row.get(1)?,
        network: row.get(2)?,
        rule: row.get(3)?,
        outbound: row.get(4)?,
        chains,
        first_seen_ms: row.get(6)?,
        last_seen_ms: row.get(7)?,
        upload_bytes,
        download_bytes,
        total_bytes: upload_bytes + download_bytes,
    })
}

fn parse_connection_samples(snapshot: &Value) -> Vec<ConnectionSample> {
    snapshot
        .get("connections")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(parse_connection_sample)
        .collect()
}

fn parse_connection_sample(connection: &Value) -> Option<ConnectionSample> {
    let id = read_string(connection.get("id"))?;
    let metadata = connection.get("metadata").unwrap_or(&Value::Null);
    let host = read_string(metadata.get("host"))
        .or_else(|| read_string(metadata.get("destinationIP")))
        .unwrap_or_else(|| "unknown".to_string());
    let network = read_string(metadata.get("network")).unwrap_or_else(|| "unknown".to_string());
    let chains = connection
        .get("chains")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| read_string(Some(value)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let outbound = chains
        .first()
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let rule = [read_string(connection.get("rule")), read_string(connection.get("rulePayload"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");

    Some(ConnectionSample {
        id,
        host,
        network,
        rule: if rule.is_empty() {
            "MATCH".to_string()
        } else {
            rule
        },
        outbound,
        chains,
        started_at_ms: parse_connection_start_ms(connection.get("start")),
        upload_counter: read_i64(connection.get("upload")).unwrap_or(0).max(0),
        download_counter: read_i64(connection.get("download")).unwrap_or(0).max(0),
    })
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn read_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn parse_connection_start_ms(value: Option<&Value>) -> Option<i64> {
    let raw = read_string(value)?;
    DateTime::parse_from_rfc3339(&raw)
        .ok()
        .map(|time| time.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    fn init_source_tables(conn: &Connection) {
        conn.execute_batch(
            r#"
            CREATE TABLE node_source_nodes (
              source_name TEXT NOT NULL,
              node_name TEXT NOT NULL,
              PRIMARY KEY (source_name, node_name)
            );
            "#,
        )
        .unwrap();
    }

    fn link_source_node(conn: &Connection, source_name: &str, node_name: &str) {
        conn.execute(
            "INSERT INTO node_source_nodes (source_name, node_name) VALUES (?1, ?2)",
            params![source_name, node_name],
        )
        .unwrap();
    }

    #[test]
    fn first_seen_connection_does_not_count_historical_counters() {
        let conn = test_db();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "conn-1",
                    "metadata": { "host": "example.com", "network": "tcp" },
                    "chains": ["proxy-a"],
                    "rule": "DOMAIN",
                    "rulePayload": "example.com",
                    "upload": 1000,
                    "download": 4000
                }]
            }),
            60_000,
        )
        .unwrap();

        let summary = query_summary(&conn, 0, 120_000, UsageBucket::Minute).unwrap();
        assert_eq!(summary.upload_bytes, 0);
        assert_eq!(summary.download_bytes, 0);
        assert_eq!(summary.connection_count, 0);
    }

    #[test]
    fn first_seen_short_connection_counts_when_started_after_previous_sample() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 60_000).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "short-1",
                    "start": "1970-01-01T00:01:00.500Z",
                    "metadata": { "host": "short.test", "network": "tcp" },
                    "chains": ["proxy-a"],
                    "upload": 120,
                    "download": 880
                }]
            }),
            61_000,
        )
        .unwrap();

        let summary = query_summary(&conn, 0, 120_000, UsageBucket::Minute).unwrap();
        assert_eq!(summary.upload_bytes, 120);
        assert_eq!(summary.download_bytes, 880);
        assert_eq!(summary.connection_count, 1);
    }

    #[test]
    fn first_seen_old_connection_remains_baseline_even_with_start_time() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 60_000).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "old-live-1",
                    "start": "1970-01-01T00:00:20.000Z",
                    "metadata": { "host": "old-live.test", "network": "tcp" },
                    "chains": ["proxy-a"],
                    "upload": 120,
                    "download": 880
                }]
            }),
            61_000,
        )
        .unwrap();

        let summary = query_summary(&conn, 0, 120_000, UsageBucket::Minute).unwrap();
        assert_eq!(summary.upload_bytes, 0);
        assert_eq!(summary.download_bytes, 0);
        assert_eq!(summary.connection_count, 0);
    }

    #[test]
    fn repeated_connection_samples_store_positive_deltas_by_bucket() {
        let conn = test_db();
        let first = json!({
            "connections": [{
                "id": "conn-1",
                "metadata": { "host": "example.com", "network": "tcp" },
                "chains": ["proxy-a", "direct"],
                "rule": "DOMAIN",
                "rulePayload": "example.com",
                "upload": 1000,
                "download": 4000
            }]
        });
        let second = json!({
            "connections": [{
                "id": "conn-1",
                "metadata": { "host": "example.com", "network": "tcp" },
                "chains": ["proxy-a", "direct"],
                "rule": "DOMAIN",
                "rulePayload": "example.com",
                "upload": 1500,
                "download": 6000
            }]
        });

        apply_connections_snapshot(&conn, &first, 60_000).unwrap();
        apply_connections_snapshot(&conn, &second, 61_000).unwrap();

        let summary = query_summary(&conn, 0, 120_000, UsageBucket::Minute).unwrap();
        assert_eq!(summary.upload_bytes, 500);
        assert_eq!(summary.download_bytes, 2000);
        assert_eq!(summary.connection_count, 1);
        assert_eq!(summary.buckets.len(), 1);
        assert_eq!(summary.buckets[0].bucket_start_ms, 60_000);

        let top = query_top(&conn, 0, 120_000, UsageGroupBy::Host, 10).unwrap();
        assert_eq!(top.items[0].label, "example.com");
        assert_eq!(top.items[0].download_bytes, 2000);

        let rows = query_connections(&conn, 0, 120_000, 10, None).unwrap();
        assert_eq!(rows.connections[0].id, "conn-1");
        assert_eq!(rows.connections[0].host, "example.com");
        assert_eq!(rows.connections[0].outbound, "proxy-a");
        assert_eq!(rows.connections[0].download_bytes, 2000);
    }

    #[test]
    fn query_window_combines_usage_summary_top_lists_and_connections() {
        let conn = test_db();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "conn-1",
                    "metadata": { "host": "example.com", "network": "tcp" },
                    "chains": ["proxy-a"],
                    "rule": "DOMAIN",
                    "rulePayload": "example.com",
                    "upload": 100,
                    "download": 200
                }]
            }),
            60_000,
        )
        .unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "conn-1",
                    "metadata": { "host": "example.com", "network": "tcp" },
                    "chains": ["proxy-a"],
                    "rule": "DOMAIN",
                    "rulePayload": "example.com",
                    "upload": 160,
                    "download": 360
                }]
            }),
            61_000,
        )
        .unwrap();

        let window = query_window(&conn, 0, 120_000, UsageBucket::Minute, 10, None).unwrap();

        assert_eq!(window.summary.total_bytes, 220);
        assert_eq!(window.top_hosts.group_by, "host");
        assert_eq!(window.top_hosts.items[0].label, "example.com");
        assert_eq!(window.top_strategies.group_by, "strategy");
        assert_eq!(window.top_strategies.items[0].label, "proxy-a");
        assert_eq!(window.connections.connections[0].id, "conn-1");
    }

    #[test]
    fn query_window_groups_top_strategies_by_route_or_last_chain() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 0).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [
                    {
                        "id": "select-hk",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "hk.example.com", "network": "tcp" },
                        "chains": ["hk-node", "select"],
                        "rule": "DOMAIN",
                        "rulePayload": "hk.example.com",
                        "upload": 100,
                        "download": 900
                    },
                    {
                        "id": "select-jp",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "jp.example.com", "network": "tcp" },
                        "chains": ["jp-node", "select"],
                        "rule": "DOMAIN",
                        "rulePayload": "jp.example.com",
                        "upload": 200,
                        "download": 800
                    },
                    {
                        "id": "route-auto",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "auto.example.com", "network": "tcp" },
                        "chains": ["fallback-node", "fallback"],
                        "rule": "route(auto)",
                        "upload": 125,
                        "download": 375
                    }
                ]
            }),
            60_000,
        )
        .unwrap();

        let window = query_window(&conn, 0, 120_000, UsageBucket::Minute, 10, None).unwrap();

        assert_eq!(window.top_strategies.group_by, "strategy");
        assert_eq!(window.top_strategies.items[0].label, "select");
        assert_eq!(window.top_strategies.items[0].total_bytes, 2000);
        assert_eq!(window.top_strategies.items[0].connection_count, 2);
        assert_eq!(window.top_strategies.items[1].label, "auto");
        assert_eq!(window.top_strategies.items[1].total_bytes, 500);
    }

    #[test]
    fn query_connections_orders_by_recent_activity_before_volume() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 0).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "large-old",
                    "start": "1970-01-01T00:00:00.500Z",
                    "metadata": { "host": "large.example.com", "network": "tcp" },
                    "chains": ["large-node", "select"],
                    "upload": 5000,
                    "download": 1000
                }]
            }),
            60_000,
        )
        .unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "small-new",
                    "start": "1970-01-01T00:01:00.500Z",
                    "metadata": { "host": "small.example.com", "network": "tcp" },
                    "chains": ["small-node", "select"],
                    "upload": 50,
                    "download": 50
                }]
            }),
            120_000,
        )
        .unwrap();

        let rows = query_connections(&conn, 0, 180_000, 10, None).unwrap();

        assert_eq!(rows.connections[0].id, "small-new");
        assert_eq!(rows.connections[1].id, "large-old");
    }

    #[test]
    fn query_source_trend_groups_usage_by_strategy_groups() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 0).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [
                    {
                        "id": "proxy-conn",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "proxy.test", "network": "tcp" },
                        "chains": ["hk-node", "Proxy"],
                        "upload": 100,
                        "download": 400
                    },
                    {
                        "id": "direct-conn",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "direct.test", "network": "tcp" },
                        "chains": ["direct"],
                        "upload": 25,
                        "download": 75
                    }
                ]
            }),
            60_000,
        )
        .unwrap();

        let trend = query_source_trend(&conn, 0, 7, SourceTrendBucket::Day, 0, None).unwrap();

        let proxy = trend
            .sources
            .iter()
            .find(|source| source.name == "Proxy")
            .unwrap();
        assert_eq!(proxy.total_bytes, 500);
        assert_eq!(proxy.buckets.len(), 7);
        assert_eq!(proxy.buckets[6].bucket_start_ms, 0);
        assert_eq!(proxy.buckets[6].total_bytes, 500);

        let direct = trend
            .sources
            .iter()
            .find(|source| source.name == "direct")
            .unwrap();
        assert_eq!(direct.total_bytes, 100);
        assert_eq!(direct.buckets.len(), 7);
        assert_eq!(trend.unknown_nodes, vec![]);
    }

    #[test]
    fn query_source_trend_can_group_last_seven_days_by_hour() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 0).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{
                    "id": "proxy-conn",
                    "start": "1970-01-01T00:00:00.500Z",
                    "metadata": { "host": "proxy.test", "network": "tcp" },
                    "chains": ["hk-node", "Proxy"],
                    "upload": 100,
                    "download": 200
                }]
            }),
            HOUR_MS,
        )
        .unwrap();

        let trend =
            query_source_trend(&conn, HOUR_MS, 7, SourceTrendBucket::Hour, 0, None).unwrap();

        assert_eq!(trend.bucket, "hour");
        assert_eq!(trend.sources[0].buckets.len(), 7 * 24);
        assert_eq!(trend.sources[0].buckets[167].bucket_start_ms, HOUR_MS);
        assert_eq!(trend.sources[0].buckets[167].total_bytes, 300);
    }

    #[test]
    fn query_source_trend_filters_nodes_not_in_current_config() {
        let conn = test_db();
        apply_connections_snapshot(&conn, &json!({ "connections": [] }), 0).unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [
                    {
                        "id": "current-conn",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "current.test", "network": "tcp" },
                        "chains": ["current-node", "Proxy"],
                        "upload": 100,
                        "download": 400
                    },
                    {
                        "id": "removed-conn",
                        "start": "1970-01-01T00:00:00.500Z",
                        "metadata": { "host": "removed.test", "network": "tcp" },
                        "chains": ["removed-node", "Proxy"],
                        "upload": 900,
                        "download": 100
                    }
                ]
            }),
            60_000,
        )
        .unwrap();
        let current_nodes = BTreeSet::from(["current-node".to_string()]);

        let trend =
            query_source_trend(&conn, 0, 7, SourceTrendBucket::Day, 0, Some(&current_nodes))
                .unwrap();
        let proxy = trend
            .sources
            .iter()
            .find(|source| source.name == "Proxy")
            .unwrap();
        assert_eq!(proxy.total_bytes, 500);
        assert_eq!(trend.unknown_nodes, vec![]);
    }

    #[test]
    fn counter_resets_do_not_create_negative_usage() {
        let conn = test_db();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{ "id": "conn-1", "metadata": { "host": "reset.test" }, "upload": 5000, "download": 7000 }]
            }),
            60_000,
        )
        .unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{ "id": "conn-1", "metadata": { "host": "reset.test" }, "upload": 100, "download": 200 }]
            }),
            61_000,
        )
        .unwrap();

        let summary = query_summary(&conn, 0, 120_000, UsageBucket::Minute).unwrap();
        assert_eq!(summary.upload_bytes, 0);
        assert_eq!(summary.download_bytes, 0);
    }

    #[test]
    fn snapshot_write_rolls_back_all_rows_when_one_sample_fails() {
        let conn = test_db();
        conn.execute_batch(
            r#"
            CREATE TRIGGER fail_bad_connection_last_seen
            BEFORE INSERT ON network_usage_last_seen
            WHEN NEW.connection_id = 'bad'
            BEGIN
              SELECT RAISE(ABORT, 'bad sample');
            END;
            "#,
        )
        .unwrap();

        let result = apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [
                    {
                        "id": "good",
                        "metadata": { "host": "good.test", "network": "tcp" },
                        "chains": ["proxy-a"],
                        "upload": 10,
                        "download": 20
                    },
                    {
                        "id": "bad",
                        "metadata": { "host": "bad.test", "network": "tcp" },
                        "chains": ["proxy-a"],
                        "upload": 30,
                        "download": 40
                    }
                ]
            }),
            60_000,
        );

        assert!(result.is_err());
        let connection_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM network_usage_connections", [], |row| row.get(0))
            .unwrap();
        let last_seen_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM network_usage_last_seen", [], |row| row.get(0))
            .unwrap();
        let last_sample_at = load_last_sample_at(&conn).unwrap();
        assert_eq!(connection_count, 0);
        assert_eq!(last_seen_count, 0);
        assert_eq!(last_sample_at, None);
    }

    #[test]
    fn cleanup_removes_data_older_than_retention_window() {
        let conn = test_db();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{ "id": "old", "metadata": { "host": "old.test" }, "upload": 0, "download": 0 }]
            }),
            60_000,
        )
        .unwrap();
        apply_connections_snapshot(
            &conn,
            &json!({
                "connections": [{ "id": "old", "metadata": { "host": "old.test" }, "upload": 10, "download": 20 }]
            }),
            61_000,
        )
        .unwrap();

        cleanup_old_usage(&conn, 2 * DAY_MS, 1).unwrap();
        let summary = query_summary(&conn, 0, 2 * DAY_MS, UsageBucket::Minute).unwrap();
        assert_eq!(summary.total_bytes, 0);
    }

    #[test]
    fn settings_are_normalized_and_persisted() {
        let conn = test_db();
        let saved = save_settings(
            &conn,
            &NetworkUsageSettings {
                enabled: true,
                retention_days: 120,
                sample_interval_sec: 1,
            },
        )
        .unwrap();

        assert_eq!(saved.retention_days, MAX_RETENTION_DAYS);
        assert_eq!(saved.sample_interval_sec, MIN_SAMPLE_INTERVAL_SEC);
        assert_eq!(load_settings(&conn).unwrap(), saved);

        let legacy_settings = serde_json::from_value::<NetworkUsageSettings>(json!({
            "enabled": true,
            "retentionDays": 3
        }))
        .unwrap();
        assert_eq!(
            normalize_settings(legacy_settings).sample_interval_sec,
            DEFAULT_SAMPLE_INTERVAL_SEC
        );
    }
}
