use anyhow::Result;
use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MINUTE_MS: i64 = 60 * 1000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const SETTINGS_KEY: &str = "network_usage_settings";
const LAST_SAMPLE_AT_KEY: &str = "network_usage_last_sample_at";
const DEFAULT_RETENTION_DAYS: i64 = 7;
const MIN_RETENTION_DAYS: i64 = 1;
pub const MAX_RETENTION_DAYS: i64 = 90;
const MAX_QUERY_LIMIT: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkUsageSettings {
    pub enabled: bool,
    pub retention_days: i64,
}

impl Default for NetworkUsageSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            retention_days: DEFAULT_RETENTION_DAYS,
        }
    }
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
    pub connections: UsageConnectionsResponse,
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
    }
}

pub fn apply_connections_snapshot(
    conn: &Connection,
    snapshot: &Value,
    sampled_at_ms: i64,
) -> Result<()> {
    let previous_sampled_at_ms = load_last_sample_at(conn)?;
    for sample in parse_connection_samples(snapshot) {
        record_connection_sample(conn, &sample, sampled_at_ms, previous_sampled_at_ms)?;
    }
    save_last_sample_at(conn, sampled_at_ms)?;
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
    Ok(conn
        .query_row(
            "SELECT value FROM kv WHERE key = ?1",
            [LAST_SAMPLE_AT_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<i64>().ok()))
}

fn save_last_sample_at(conn: &Connection, sampled_at_ms: i64) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO kv(key, value)
        VALUES(?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![LAST_SAMPLE_AT_KEY, sampled_at_ms.to_string()],
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
            ORDER BY COALESCE(SUM(b.upload_bytes + b.download_bytes), 0) DESC, c.last_seen_ms DESC
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
            ORDER BY COALESCE(SUM(b.upload_bytes + b.download_bytes), 0) DESC, c.last_seen_ms DESC
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
        connections: query_connections(conn, from_ms, to_ms, limit, query)?,
    })
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
        assert_eq!(window.top_outbounds.group_by, "outbound");
        assert_eq!(window.top_outbounds.items[0].label, "proxy-a");
        assert_eq!(window.connections.connections[0].id, "conn-1");
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
            },
        )
        .unwrap();

        assert_eq!(saved.retention_days, MAX_RETENTION_DAYS);
        assert_eq!(load_settings(&conn).unwrap(), saved);
    }
}
