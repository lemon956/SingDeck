#[cfg(unix)]
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

use aes::Aes128;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use chrono::{DateTime, Duration as ChronoDuration, TimeZone};
use pbkdf2::pbkdf2_hmac;
use reqwest::{header, Client};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use rusty_leveldb::{LdbIterator, Options as LevelDbOptions, DB};
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};

const NEWSSID_HOMEPAGE: &str = "https://qe.newssid.com/#/dashboard";
const NEWSSID_ORIGIN: &str = "https://qe.newssid.com";
const NEWSSID_HOST: &str = "qe.newssid.com";
const NEWSSID_API_ORIGINS: &[&str] = &[NEWSSID_ORIGIN];
const NEWSSID_SUBSCRIBE_PATHS: &[&str] = &["/api/v1/access/getSubscribe"];
const NEWSSID_USER_PATHS: &[&str] = &["/api/v1/access/info"];
const NEWSSID_AUTH_STORAGE_KEYS: &[&str] = &["auth_data", "cookie_auth_data", "token"];
const NEWSSID_AUTH_COOKIE_NAMES: &[&str] = &["auth_data", "auth"];
const YUYAN_HOMEPAGE: &str = "https://yuyan.co/#/dashboard";
const YUYAN_ORIGIN: &str = "https://yuyan.co";
const YUYAN_HOST: &str = "yuyan.co";
const YUYAN_API_ORIGINS: &[&str] = &[YUYAN_ORIGIN];
const YUYAN_AUTH_STORAGE_KEYS: &[&str] =
    &["ACCESS_TOKEN", "token", "auth_data", "authorization", "access_token"];
const YUYAN_AUTH_COOKIE_NAMES: &[&str] = &["token", "auth_data"];
const V2BOARD_SUBSCRIBE_PATHS: &[&str] = &[
    "/api/v1/user/getSubscribe",
    "/api/v1/user/getStat",
    "/api/v1/user/stat",
    "/api/v1/user/traffic",
];
const V2BOARD_USER_PATHS: &[&str] = &[
    "/api/v1/user/info",
    "/api/v1/user/getUserInfo",
    "/api/v1/user/profile",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub id: String,
    pub name: String,
    pub homepage: String,
    pub plan_name: Option<String>,
    pub used_upload_bytes: Option<i64>,
    pub used_download_bytes: Option<i64>,
    pub used_total_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    pub remaining_bytes: Option<i64>,
    pub used_ratio: Option<f64>,
    pub expire_at: Option<i64>,
    pub reset_day: Option<i64>,
    pub reset_at: Option<i64>,
    pub stale: bool,
    pub last_successful_at: Option<String>,
    pub fetched_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficResponse {
    pub providers: Vec<TrafficSnapshot>,
    pub updated_at: String,
    pub profile: String,
}

pub async fn read_traffic(http: &Client, profile: &Path) -> TrafficResponse {
    let fetched_at = chrono::Local::now().to_rfc3339();
    let providers = vec![
        fetch_newssid(http, profile, &fetched_at).await,
        fetch_yuyan(http, profile, &fetched_at).await,
    ];

    TrafficResponse {
        providers,
        updated_at: fetched_at,
        profile: profile.display().to_string(),
    }
}

pub fn disabled_traffic_response(profile: &Path) -> TrafficResponse {
    TrafficResponse {
        providers: Vec::new(),
        updated_at: chrono::Local::now().to_rfc3339(),
        profile: profile.display().to_string(),
    }
}

pub fn chrome_profile_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(trimmed)
}

pub fn parse_v2board_traffic(
    id: &str,
    name: &str,
    homepage: &str,
    subscribe_json: &str,
    user_json: Option<&str>,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let subscribe =
        serde_json::from_str::<Value>(subscribe_json).context("invalid subscribe JSON")?;
    let user = user_json
        .map(|raw| serde_json::from_str::<Value>(raw).context("invalid user JSON"))
        .transpose()?;
    build_snapshot(id, name, homepage, &subscribe, user.as_ref(), fetched_at)
}

async fn fetch_newssid(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result: Result<TrafficSnapshot> = async {
        // read_chrome_cookie_header brings every cookie for the host, including
        // Cloudflare's cf_clearance, which (with a Chrome User-Agent and the
        // same machine/IP) lets a plain HTTP client pass the managed challenge.
        let cookie_result = read_chrome_cookie_header(profile, NEWSSID_HOST);
        let cookie = cookie_result.as_ref().ok().cloned();
        let auth = read_newssid_auth(profile).ok();
        if cookie.is_none() && auth.is_none() {
            return Err(anyhow!("Chrome login state not found for {NEWSSID_HOST}"));
        }
        // Diagnostic: surface exactly why cf_clearance might be absent — DB read
        // failure vs cookies-read-but-no-cf_clearance vs present-but-rejected.
        let cookie_diag = match &cookie_result {
            Ok(value) if value.contains("cf_clearance") => "cf_clearance present".to_string(),
            Ok(value) => format!("cookies read but no cf_clearance (names: {})", cookie_names(value)),
            Err(error) => format!("cookie read failed: {error}"),
        };
        // Match the user's real Chrome version: Cloudflare binds cf_clearance to
        // the User-Agent that solved the challenge, so a stale default UA can fail.
        let user_agent = chrome_profile_user_agent(profile);
        let subscribe = fetch_first_provider_api_text(
            http,
            NEWSSID_API_ORIGINS,
            NEWSSID_SUBSCRIBE_PATHS,
            auth.as_deref(),
            cookie.as_deref(),
            &user_agent,
        )
        .await
        .map_err(|error| anyhow!("{error} [{cookie_diag}]"))?;
        let user = fetch_optional_provider_api_text(
            http,
            NEWSSID_API_ORIGINS,
            NEWSSID_USER_PATHS,
            auth.as_deref(),
            cookie.as_deref(),
            &user_agent,
        )
        .await;

        parse_v2board_traffic(
            "newssid",
            "SS-ID",
            NEWSSID_HOMEPAGE,
            &subscribe,
            user.as_deref(),
            fetched_at,
        )
    }
    .await;

    finalize_provider("newssid", "SS-ID", NEWSSID_HOMEPAGE, fetched_at, result)
}

fn read_newssid_auth(profile: &Path) -> Result<String> {
    let mut errors = Vec::new();

    for key in NEWSSID_AUTH_STORAGE_KEYS {
        match read_chrome_local_storage(profile, NEWSSID_ORIGIN, key) {
            Ok(value) => {
                if let Some(auth) = normalize_provider_auth(&value) {
                    return Ok(auth);
                }
                errors.push(format!("localStorage {key} was empty"));
            }
            Err(error) => errors.push(format!("localStorage {key}: {error}")),
        }
    }

    for name in NEWSSID_AUTH_COOKIE_NAMES {
        match read_chrome_cookie(profile, NEWSSID_HOST, name) {
            Ok(value) => {
                if let Some(auth) = normalize_provider_auth(&value) {
                    return Ok(auth);
                }
                errors.push(format!("cookie {name} was empty"));
            }
            Err(error) => errors.push(format!("cookie {name}: {error}")),
        }
    }

    Err(anyhow!(
        "Chrome {NEWSSID_HOST} auth unavailable: {}",
        errors.join("; ")
    ))
}

async fn fetch_yuyan(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result: Result<TrafficSnapshot> = async {
        // yuyan.co is a plain V2board (no Cloudflare challenge); auth is a Bearer
        // token kept in localStorage, not a session cookie. Cookies are optional.
        let cookie = read_chrome_cookie_header(profile, YUYAN_HOST).ok();
        let auth = read_yuyan_auth(profile)?;
        let user_agent = chrome_profile_user_agent(profile);
        let subscribe = fetch_first_provider_api_text(
            http,
            YUYAN_API_ORIGINS,
            V2BOARD_SUBSCRIBE_PATHS,
            Some(auth.as_str()),
            cookie.as_deref(),
            &user_agent,
        )
        .await?;
        let user = fetch_optional_provider_api_text(
            http,
            YUYAN_API_ORIGINS,
            V2BOARD_USER_PATHS,
            Some(auth.as_str()),
            cookie.as_deref(),
            &user_agent,
        )
        .await;

        parse_v2board_traffic(
            "yuyan",
            "雨燕云",
            YUYAN_HOMEPAGE,
            &subscribe,
            user.as_deref(),
            fetched_at,
        )
    }
    .await;

    finalize_provider("yuyan", "雨燕云", YUYAN_HOMEPAGE, fetched_at, result)
}

fn read_yuyan_auth(profile: &Path) -> Result<String> {
    let mut errors = Vec::new();

    for key in YUYAN_AUTH_STORAGE_KEYS {
        match read_chrome_local_storage(profile, YUYAN_ORIGIN, key) {
            Ok(value) => {
                if let Some(auth) = normalize_provider_auth(&value) {
                    return Ok(bearer_token(&auth));
                }
                errors.push(format!("localStorage {key} was empty"));
            }
            Err(error) => errors.push(format!("localStorage {key}: {error}")),
        }
    }

    for name in YUYAN_AUTH_COOKIE_NAMES {
        match read_chrome_cookie(profile, YUYAN_HOST, name) {
            Ok(value) => {
                if let Some(auth) = normalize_provider_auth(&value) {
                    return Ok(bearer_token(&auth));
                }
                errors.push(format!("cookie {name} was empty"));
            }
            Err(error) => errors.push(format!("cookie {name}: {error}")),
        }
    }

    Err(anyhow!(
        "Chrome {YUYAN_HOST} auth unavailable: {}",
        errors.join("; ")
    ))
}

/// List cookie names from a `name=value; name2=value2` header, values omitted
/// (so diagnostics never leak cookie contents).
fn cookie_names(header_value: &str) -> String {
    header_value
        .split(';')
        .filter_map(|pair| pair.split('=').next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

/// Ensure a token carries a single `Bearer ` prefix for the Authorization header.
fn bearer_token(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.to_ascii_lowercase().starts_with("bearer ") {
        trimmed.to_string()
    } else {
        format!("Bearer {trimmed}")
    }
}

fn normalize_provider_auth(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let decoded = percent_decode(trimmed);
    let trimmed = decoded
        .as_deref()
        .unwrap_or(trimmed)
        .trim()
        .trim_matches('"')
        .trim();

    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        for key in [
            "auth_data",
            "cookie_auth_data",
            "authorization",
            "access_token",
            "token",
            // Xboard frontends store auth_data as {"site":"...","value":"<JWT>"}.
            "value",
        ] {
            if let Some(auth) = value.get(key).and_then(Value::as_str) {
                if let Some(auth) = normalize_provider_auth(auth) {
                    return Some(auth);
                }
            }
        }
    }

    Some(trimmed.to_string())
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut changed = false;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push(high << 4 | low);
                index += 3;
                changed = true;
                continue;
            }
        }
        if bytes[index] == b'+' {
            output.push(b' ');
            changed = true;
        } else {
            output.push(bytes[index]);
        }
        index += 1;
    }

    changed.then(|| String::from_utf8(output).ok()).flatten()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

async fn fetch_first_provider_api_text(
    http: &Client,
    origins: &[&str],
    paths: &[&str],
    auth: Option<&str>,
    cookie: Option<&str>,
    user_agent: &str,
) -> Result<String> {
    let mut errors = Vec::new();
    for origin in origins {
        for path in paths {
            match fetch_provider_api_text(http, origin, path, auth, cookie, user_agent).await {
                Ok(body) => return Ok(body),
                Err(error) => errors.push(format!("{origin}{path}: {error}")),
            }
        }
    }

    Err(anyhow!(
        "all provider API candidates failed: {}",
        errors.join("; ")
    ))
}

async fn fetch_optional_provider_api_text(
    http: &Client,
    origins: &[&str],
    paths: &[&str],
    auth: Option<&str>,
    cookie: Option<&str>,
    user_agent: &str,
) -> Option<String> {
    fetch_first_provider_api_text(http, origins, paths, auth, cookie, user_agent)
        .await
        .ok()
}

async fn fetch_provider_api_text(
    http: &Client,
    origin: &str,
    path: &str,
    auth: Option<&str>,
    cookie: Option<&str>,
    user_agent: &str,
) -> Result<String> {
    // Mimic a real Chrome XHR so Cloudflare-fronted providers don't flag the
    // request as a bot (Chrome UA without client-hints / sec-fetch headers).
    let major = chrome_major_from_user_agent(user_agent).unwrap_or("124");
    let sec_ch_ua =
        format!("\"Google Chrome\";v=\"{major}\", \"Chromium\";v=\"{major}\", \"Not)A;Brand\";v=\"24\"");
    let mut request = http
        .get(format!("{origin}{path}"))
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(header::USER_AGENT, user_agent.to_string())
        .header(header::REFERER, format!("{origin}/"))
        .header("sec-ch-ua", sec_ch_ua)
        .header("sec-ch-ua-mobile", "?0")
        .header("sec-ch-ua-platform", "\"Linux\"")
        .header("sec-fetch-dest", "empty")
        .header("sec-fetch-mode", "cors")
        .header("sec-fetch-site", "same-origin")
        .header("priority", "u=1, i");
    if let Some(auth) = auth {
        request = request.header(header::AUTHORIZATION, auth);
    }
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }

    let body = fetch_text(request).await?;
    ensure_provider_json_success(&body)?;
    Ok(body)
}

async fn fetch_text(request: reqwest::RequestBuilder) -> Result<String> {
    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(anyhow!("provider returned HTTP {}", response.status()));
    }
    Ok(response.text().await?)
}

fn provider_error(
    id: &str,
    name: &str,
    homepage: &str,
    fetched_at: &str,
    error: impl std::fmt::Display,
) -> TrafficSnapshot {
    TrafficSnapshot {
        id: id.to_string(),
        name: name.to_string(),
        homepage: homepage.to_string(),
        plan_name: None,
        used_upload_bytes: None,
        used_download_bytes: None,
        used_total_bytes: None,
        total_bytes: None,
        remaining_bytes: None,
        used_ratio: None,
        expire_at: None,
        reset_day: None,
        reset_at: None,
        stale: false,
        last_successful_at: None,
        fetched_at: fetched_at.to_string(),
        error: Some(error.to_string()),
    }
}

// Per-provider last-successful snapshot, so a transient sync failure (e.g. an
// expired cf_clearance) shows the previous numbers marked stale instead of a
// red error. In-memory only; resets on helper restart.
static TRAFFIC_LAST_SUCCESS: OnceLock<Mutex<HashMap<String, TrafficSnapshot>>> = OnceLock::new();

fn traffic_last_success() -> &'static Mutex<HashMap<String, TrafficSnapshot>> {
    TRAFFIC_LAST_SUCCESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn finalize_provider(id: &str, name: &str, homepage: &str, fetched_at: &str, result: Result<TrafficSnapshot>) -> TrafficSnapshot {
    match result {
        Ok(snapshot) => {
            if let Ok(mut cache) = traffic_last_success().lock() {
                cache.insert(snapshot.id.clone(), snapshot.clone());
            }
            snapshot
        }
        Err(error) => {
            let error = error.to_string();
            if let Ok(cache) = traffic_last_success().lock() {
                if let Some(previous) = cache.get(id) {
                    let mut stale = previous.clone();
                    let last_successful_at = stale
                        .last_successful_at
                        .clone()
                        .unwrap_or_else(|| stale.fetched_at.clone());
                    stale.fetched_at = fetched_at.to_string();
                    stale.last_successful_at = Some(last_successful_at);
                    stale.stale = true;
                    stale.error = Some(format!("sync failed, showing last successful data: {error}"));
                    return stale;
                }
            }
            provider_error(id, name, homepage, fetched_at, error)
        }
    }
}

fn default_chrome_user_agent() -> &'static str {
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

pub fn chrome_profile_user_agent(profile: &Path) -> String {
    read_chrome_profile_version(profile)
        .map(|version| chrome_user_agent_for_version(&version))
        .unwrap_or_else(|| default_chrome_user_agent().to_string())
}

fn read_chrome_profile_version(profile: &Path) -> Option<String> {
    let browser_root = profile.parent()?;
    let version = fs::read_to_string(browser_root.join("Last Version")).ok()?;
    let version = version.trim();
    is_valid_chrome_version(version).then(|| version.to_string())
}

fn chrome_user_agent_for_version(version: &str) -> String {
    // Chrome reduces its User-Agent header to "<major>.0.0.0" (the full build
    // version only appears in sec-ch-ua-full-version). Cloudflare's cf_clearance
    // is bound to the exact UA header, so we must emit the reduced form to match
    // what the browser sent when it solved the challenge.
    let major = version
        .split('.')
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or("124");
    format!(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
    )
}

fn chrome_major_from_user_agent(user_agent: &str) -> Option<&str> {
    let after = user_agent.split("Chrome/").nth(1)?;
    let major = after.split('.').next()?;
    (!major.is_empty() && major.chars().all(|c| c.is_ascii_digit())).then_some(major)
}

fn is_valid_chrome_version(version: &str) -> bool {
    version.chars().any(|character| character.is_ascii_digit())
        && version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
}

pub fn read_chrome_cookie(profile: &Path, host_key: &str, name: &str) -> Result<String> {
    let cookies_path = find_cookies_db(profile)?;
    let db = open_cookies_db(&cookies_path)?;
    let host_with_dot = format!(".{host_key}");
    let row = db
        .query_row(
            r#"
            SELECT host_key, value, encrypted_value
            FROM cookies
            WHERE name = ?1 AND (host_key = ?2 OR host_key = ?3)
            ORDER BY CASE WHEN host_key = ?2 THEN 0 ELSE 1 END
            LIMIT 1
            "#,
            params![name, host_key, host_with_dot],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| anyhow!("cookie not found for {host_key}/{name}"))?;

    let (actual_host_key, value, encrypted_value) = row;
    if !value.is_empty() {
        return Ok(value);
    }

    let secrets = chrome_linux_secrets(profile)?;
    decrypt_chrome_linux_cookie_with_secrets(&actual_host_key, &encrypted_value, &secrets)
}

/// Host-key candidates a browser would send to `host`: the exact host plus each
/// dotted parent domain down to (but not including) the bare TLD. So for
/// `qe.newssid.com` → `["qe.newssid.com", ".qe.newssid.com", ".newssid.com"]`,
/// which is where Cloudflare's cf_clearance domain cookie actually lives.
fn cookie_host_key_candidates(host: &str) -> Vec<String> {
    let mut candidates = vec![host.to_string()];
    let labels: Vec<&str> = host.split('.').collect();
    for start in 0..labels.len() {
        let suffix = labels[start..].join(".");
        // Only dotted suffixes with >=2 labels (one dot), never the bare TLD.
        if suffix.contains('.') {
            candidates.push(format!(".{suffix}"));
        }
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

pub fn read_chrome_cookie_header(profile: &Path, host_key: &str) -> Result<String> {
    let cookies_path = find_cookies_db(profile)?;
    let db = open_cookies_db(&cookies_path)?;
    // Match the exact host AND parent-domain cookies (e.g. cf_clearance is often
    // stored under ".newssid.com", not "qe.newssid.com") — the browser sends
    // those to the subdomain too, so we must include them.
    let host_keys = cookie_host_key_candidates(host_key);
    let placeholders = vec!["?"; host_keys.len()].join(",");
    let mut stmt = db.prepare(&format!(
        "SELECT host_key, name, value, encrypted_value FROM cookies WHERE host_key IN ({placeholders}) ORDER BY name"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(host_keys.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;

    let mut secrets: Option<Vec<Vec<u8>>> = None;
    let mut cookies = Vec::new();
    for row in rows {
        let (actual_host_key, name, value, encrypted_value) = row?;
        let cookie_value = if !value.is_empty() {
            value
        } else {
            let secrets = match secrets.as_ref() {
                Some(secrets) => secrets,
                None => {
                    secrets = Some(chrome_linux_secrets(profile)?);
                    secrets.as_ref().unwrap()
                }
            };
            // Skip an individual cookie that won't decrypt instead of dropping the
            // whole header. Otherwise one bad sibling cookie (e.g. __cf_bm) would
            // take cf_clearance / auth_data down with it and break the request.
            match decrypt_chrome_linux_cookie_with_secrets(&actual_host_key, &encrypted_value, secrets) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("singdeck-helper: skipping cookie {name} for {host_key}: {error}");
                    continue;
                }
            }
        };
        if !name.is_empty() {
            cookies.push(format!("{name}={cookie_value}"));
        }
    }

    if cookies.is_empty() {
        Err(anyhow!("cookies not found for {host_key}"))
    } else {
        Ok(cookies.join("; "))
    }
}

pub fn read_chrome_local_storage(profile: &Path, origin: &str, name: &str) -> Result<String> {
    let source = find_local_storage_leveldb(profile)?;
    let copy_path = copy_local_storage_leveldb(&source)?;
    let result = (|| {
        let mut options = LevelDbOptions {
            create_if_missing: false,
            ..LevelDbOptions::default()
        };
        options.reuse_logs = false;
        let mut db = DB::open(&copy_path, options)
            .map_err(|error| anyhow!("cannot open Chrome Local Storage LevelDB: {error}"))?;
        read_chrome_local_storage_from_db(&mut db, origin, name)
    })();
    let _ = fs::remove_dir_all(&copy_path);
    result
}

fn read_chrome_local_storage_from_db(db: &mut DB, origin: &str, name: &str) -> Result<String> {
    let key = chrome_local_storage_key(origin, name);
    if let Some(value) = db.get(&key) {
        return decode_chrome_local_storage_value(&value);
    }

    let prefix = format!("_{origin}\0\x01").into_bytes();
    let suffix = name.as_bytes();
    let mut iter = db
        .new_iter()
        .map_err(|error| anyhow!("cannot iterate Chrome Local Storage: {error}"))?;
    while let Some((entry_key, value)) = iter.next() {
        if entry_key.starts_with(&prefix) && entry_key.ends_with(suffix) {
            return decode_chrome_local_storage_value(&value);
        }
    }

    Err(anyhow!("localStorage item not found for {origin}/{name}"))
}

fn chrome_local_storage_key(origin: &str, name: &str) -> Vec<u8> {
    format!("_{origin}\0\x01{name}").into_bytes()
}

fn decode_chrome_local_storage_value(value: &[u8]) -> Result<String> {
    match value.split_first() {
        Some((1, rest)) => String::from_utf8(rest.to_vec())
            .context("Chrome Local Storage UTF-8 value is not valid UTF-8"),
        Some((0, rest)) => {
            if rest.len() % 2 != 0 {
                return Err(anyhow!(
                    "Chrome Local Storage UTF-16 value has odd byte length"
                ));
            }
            let code_units = rest
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]));
            String::from_utf16(&code_units.collect::<Vec<_>>())
                .context("Chrome Local Storage UTF-16 value is not valid UTF-16")
        }
        Some(_) => String::from_utf8(value.to_vec())
            .context("Chrome Local Storage value is not valid UTF-8"),
        None => Ok(String::new()),
    }
}

fn find_local_storage_leveldb(profile: &Path) -> Result<PathBuf> {
    let path = profile.join("Local Storage/leveldb");
    path.is_dir().then_some(path).ok_or_else(|| {
        anyhow!(
            "Chrome Local Storage LevelDB not found under {}",
            profile.display()
        )
    })
}

fn copy_local_storage_leveldb(source: &Path) -> Result<PathBuf> {
    let copy_path = env::temp_dir().join(format!(
        "singdeck-local-storage-{}-{}",
        std::process::id(),
        crate::now_ms()
    ));
    fs::create_dir_all(&copy_path)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if !file_type.is_file() || entry.file_name() == "LOCK" {
            continue;
        }
        fs::copy(&path, copy_path.join(entry.file_name()))?;
    }
    Ok(copy_path)
}

fn find_cookies_db(profile: &Path) -> Result<PathBuf> {
    let candidates = [profile.join("Cookies"), profile.join("Network/Cookies")];
    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| {
            anyhow!(
                "Chrome Cookies database not found under {}",
                profile.display()
            )
        })
}

fn open_cookies_db(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .or_else(|_| open_copied_cookies_db(path))
        .with_context(|| format!("cannot open Chrome Cookies database {}", path.display()))
}

fn open_copied_cookies_db(path: &Path) -> Result<Connection> {
    let copy_path = env::temp_dir().join(format!(
        "singdeck-cookies-{}-{}.sqlite",
        std::process::id(),
        crate::now_ms()
    ));
    fs::copy(path, &copy_path)?;
    // Chrome's Cookies DB is WAL-mode: recently-set cookies (e.g. a just-refreshed
    // cf_clearance) live in the -wal file, not the main DB. Copy the sidecars too
    // so the snapshot includes them, otherwise we read a stale view.
    for suffix in ["-wal", "-shm"] {
        let sidecar = path_with_suffix(path, suffix);
        if sidecar.exists() {
            let _ = fs::copy(&sidecar, path_with_suffix(&copy_path, suffix));
        }
    }
    // Open read-write (it is our throwaway copy) so SQLite can replay the WAL.
    Connection::open(copy_path).map_err(Into::into)
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SecretToolContext {
    uid: Option<u32>,
    gid: Option<u32>,
    envs: Vec<(String, String)>,
}

impl SecretToolContext {
    fn current() -> Self {
        Self {
            uid: None,
            gid: None,
            envs: Vec::new(),
        }
    }

    fn apply(&self, command: &mut Command) {
        for (key, value) in &self.envs {
            command.env(key, value);
        }
        #[cfg(unix)]
        {
            if let Some(gid) = self.gid {
                command.gid(gid);
            }
            if let Some(uid) = self.uid {
                command.uid(uid);
            }
        }
    }
}

#[cfg(unix)]
fn chrome_profile_owner_secret_context(profile: &Path) -> Option<SecretToolContext> {
    let metadata = fs::metadata(profile).ok()?;
    let uid = metadata.uid();
    Some(SecretToolContext {
        uid: Some(uid),
        gid: Some(metadata.gid()),
        envs: vec![
            ("XDG_RUNTIME_DIR".to_string(), format!("/run/user/{uid}")),
            (
                "DBUS_SESSION_BUS_ADDRESS".to_string(),
                format!("unix:path=/run/user/{uid}/bus"),
            ),
        ],
    })
}

#[cfg(not(unix))]
fn chrome_profile_owner_secret_context(_profile: &Path) -> Option<SecretToolContext> {
    None
}

fn chrome_linux_secrets(profile: &Path) -> Result<Vec<Vec<u8>>> {
    let lookups: &[&[&str]] = &[
        &["lookup", "application", "chrome"],
        &["lookup", "application", "chromium"],
        &[
            "lookup",
            "xdg:schema",
            "chrome_libsecret_os_crypt_password_v2",
        ],
    ];
    let mut contexts = vec![SecretToolContext::current()];
    if let Some(context) = chrome_profile_owner_secret_context(profile) {
        if !contexts.contains(&context) {
            contexts.push(context);
        }
    }
    let mut secrets = Vec::new();

    for context in contexts {
        for args in lookups {
            let mut command = Command::new("secret-tool");
            command.args(*args);
            context.apply(&mut command);
            let output = command.output();
            let Ok(output) = output else {
                continue;
            };
            if !output.status.success() {
                continue;
            }

            let mut secret = output.stdout;
            while matches!(secret.last(), Some(b'\n' | b'\r')) {
                secret.pop();
            }
            if !secret.is_empty() {
                push_unique_secret(&mut secrets, secret);
            }
        }
    }

    // Always try the basic-store key ("peanuts") last. Chrome uses it for v10
    // cookies / when no keyring is configured, and it needs no keyring access —
    // so it still decrypts even when the helper runs as root and can't open the
    // user's keyring. Keyring secrets (above) are tried first for v11 cookies.
    push_unique_secret(&mut secrets, b"peanuts".to_vec());
    Ok(secrets)
}

fn push_unique_secret(secrets: &mut Vec<Vec<u8>>, secret: Vec<u8>) {
    if !secrets.iter().any(|existing| existing == &secret) {
        secrets.push(secret);
    }
}

fn chrome_linux_secret_candidates<S: AsRef<[u8]>>(secrets: &[S]) -> Vec<Vec<u8>> {
    let mut candidates = Vec::new();
    for secret in secrets {
        let secret = secret.as_ref();
        push_unique_secret(&mut candidates, secret.to_vec());
        if let Ok(decoded) = BASE64.decode(secret) {
            if !decoded.is_empty() {
                push_unique_secret(&mut candidates, decoded);
            }
        }
    }
    candidates
}

fn decrypt_chrome_linux_cookie_with_secrets<S: AsRef<[u8]>>(
    host_key: &str,
    encrypted_value: &[u8],
    secrets: &[S],
) -> Result<String> {
    let candidates = chrome_linux_secret_candidates(secrets);
    if candidates.is_empty() {
        return Err(anyhow!("Chrome cookie decrypt failed: no candidate keys"));
    }

    let mut errors = Vec::new();
    for (index, secret) in candidates.iter().enumerate() {
        match decrypt_chrome_linux_cookie_with_secret(host_key, encrypted_value, secret) {
            Ok(value) => return Ok(value),
            Err(error) => errors.push(format!("candidate {}: {error}", index + 1)),
        }
    }

    Err(anyhow!(
        "Chrome cookie decrypt failed with {} candidate keys: {}",
        candidates.len(),
        errors.join("; ")
    ))
}

fn decrypt_chrome_linux_cookie_with_secret(
    host_key: &str,
    encrypted_value: &[u8],
    secret: &[u8],
) -> Result<String> {
    type Aes128CbcDec = cbc::Decryptor<Aes128>;

    let payload = encrypted_value
        .strip_prefix(b"v10")
        .or_else(|| encrypted_value.strip_prefix(b"v11"))
        .unwrap_or(encrypted_value);
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(secret, b"saltysalt", 1, &mut key);
    let iv = [b' '; 16];
    let mut buffer = payload.to_vec();
    let decrypted = Aes128CbcDec::new_from_slices(&key, &iv)
        .map_err(|error| anyhow!("invalid Chrome cookie cipher key/iv: {error}"))?
        .decrypt_padded_mut::<Pkcs7>(&mut buffer)
        .map_err(|error| anyhow!("Chrome cookie decrypt failed: {error}"))?;
    let value = strip_chrome_host_digest(host_key, decrypted);
    String::from_utf8(value.to_vec()).context("Chrome cookie value is not UTF-8")
}

fn strip_chrome_host_digest<'a>(host_key: &str, plaintext: &'a [u8]) -> &'a [u8] {
    let digest = Sha256::digest(host_key.as_bytes());
    if plaintext.len() >= digest.len() && &plaintext[..digest.len()] == digest.as_slice() {
        &plaintext[digest.len()..]
    } else {
        plaintext
    }
}

fn ensure_provider_json_success(body: &str) -> Result<()> {
    let value = serde_json::from_str::<Value>(body).context("provider returned invalid JSON")?;
    let code = value.get("code").and_then(|code| code.as_i64());
    if matches!(code, Some(0 | 200) | None) {
        return Ok(());
    }

    let message = value
        .get("message")
        .or_else(|| value.get("msg"))
        .and_then(|message| message.as_str())
        .unwrap_or("provider rejected request");
    Err(anyhow!(
        "provider returned code {}: {message}",
        code.unwrap()
    ))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

fn build_snapshot(
    id: &str,
    name: &str,
    homepage: &str,
    subscribe: &Value,
    user: Option<&Value>,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let subscribe_data = subscribe
        .get("data")
        .ok_or_else(|| anyhow!("missing traffic data"))?;
    let user_data = user.and_then(|value| value.get("data"));
    let used_upload = read_i64(subscribe_data, "u");
    let used_download = read_i64(subscribe_data, "d");
    let used_total = used_upload
        .zip(used_download)
        .map(|(upload, download)| upload + download);
    let total = user_data
        .and_then(|data| read_i64(data, "transfer_enable"))
        .or_else(|| read_i64(subscribe_data, "transfer_enable"));
    let expire_at = user_data
        .and_then(|data| read_i64(data, "expired_at"))
        .or_else(|| read_i64(subscribe_data, "expired_at"));
    let remaining = used_total
        .zip(total)
        .map(|(used, total)| (total - used).max(0));
    let used_ratio = used_total.zip(total).and_then(|(used, total)| {
        if total <= 0 {
            None
        } else {
            Some(round_one(used as f64 / total as f64 * 100.0))
        }
    });

    let reset_day = read_i64(subscribe_data, "reset_day").filter(|value| *value >= 0);
    let reset_at = v2board_reset_at(reset_day, fetched_at);

    Ok(TrafficSnapshot {
        id: id.to_string(),
        name: name.to_string(),
        homepage: homepage.to_string(),
        plan_name: subscribe_data
            .get("plan")
            .and_then(|plan| plan.get("name"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        used_upload_bytes: used_upload,
        used_download_bytes: used_download,
        used_total_bytes: used_total,
        total_bytes: total,
        remaining_bytes: remaining,
        used_ratio,
        expire_at,
        reset_day,
        reset_at,
        stale: false,
        last_successful_at: Some(fetched_at.to_string()),
        fetched_at: fetched_at.to_string(),
        error: None,
    })
}

fn v2board_reset_at(reset_day: Option<i64>, fetched_at: &str) -> Option<i64> {
    let days = reset_day?;
    let fetched = DateTime::parse_from_rfc3339(fetched_at).ok()?;
    let reset_date = fetched.date_naive().checked_add_signed(ChronoDuration::days(days))?;
    let reset_time = reset_date.and_hms_opt(0, 0, 0)?;
    fetched
        .offset()
        .from_local_datetime(&reset_time)
        .single()
        .map(|time| time.timestamp())
}

fn read_i64(value: &Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|item| item.as_i64().or_else(|| item.as_str()?.trim().parse().ok()))
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::Aes128;
    use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use pbkdf2::pbkdf2_hmac;
    use sha1::Sha1;
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn parses_v2board_subscribe_and_user_json() {
        let subscribe = r#"{"data":{"u":4096,"d":8192,"transfer_enable":32768,"expired_at":1779595946,"reset_day":24,"plan":{"name":"Pro"}}}"#;
        let user = r#"{"data":{"transfer_enable":65536,"expired_at":1779680000}}"#;

        let snapshot = parse_v2board_traffic(
            "v2board",
            "V2Board",
            "https://example.com/dashboard",
            subscribe,
            Some(user),
            "2026-05-07T16:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.id, "v2board");
        assert_eq!(snapshot.plan_name.as_deref(), Some("Pro"));
        assert_eq!(snapshot.used_upload_bytes, Some(4096));
        assert_eq!(snapshot.used_download_bytes, Some(8192));
        assert_eq!(snapshot.used_total_bytes, Some(12288));
        assert_eq!(snapshot.total_bytes, Some(65536));
        assert_eq!(snapshot.remaining_bytes, Some(53248));
        assert_eq!(snapshot.used_ratio, Some(18.8));
        assert_eq!(snapshot.expire_at, Some(1779680000));
        assert_eq!(snapshot.reset_day, Some(24));
        assert_eq!(snapshot.reset_at, Some(1780156800));
        assert_eq!(snapshot.error, None);
    }

    #[test]
    fn v2board_reset_day_zero_resets_today() {
        let subscribe = r#"{"data":{"u":1024,"d":2048,"transfer_enable":8192,"expired_at":1783094400,"reset_day":0}}"#;

        let snapshot = parse_v2board_traffic(
            "xnyun",
            "XNYun",
            "https://xnyun.wiki/#/dashboard",
            subscribe,
            None,
            "2026-05-28T09:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.reset_day, Some(0));
        assert_eq!(snapshot.reset_at, Some(1779897600));
    }

    #[test]
    fn parses_v2board_numeric_fields_from_strings() {
        let subscribe = r#"{"data":{"u":"1024","d":"2048","transfer_enable":"8192","expired_at":"1780243200","reset_day":"3"}}"#;

        let snapshot = parse_v2board_traffic(
            "xnyun",
            "XNYun",
            "https://xnyun.wiki/#/dashboard",
            subscribe,
            None,
            "2026-05-27T18:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.used_total_bytes, Some(3072));
        assert_eq!(snapshot.total_bytes, Some(8192));
        assert_eq!(snapshot.expire_at, Some(1780243200));
        assert_eq!(snapshot.reset_day, Some(3));
    }

    #[test]
    fn normalizes_xnyun_auth_from_json_value() {
        let auth = normalize_provider_auth(r#"{"token":"json-token"}"#);

        assert_eq!(auth.as_deref(), Some("json-token"));
    }

    #[test]
    fn normalizes_xnyun_percent_encoded_auth_cookie() {
        let auth = normalize_provider_auth("Bearer%20cookie-token");

        assert_eq!(auth.as_deref(), Some("Bearer cookie-token"));
    }

    #[test]
    fn normalizes_xboard_auth_data_value_from_url_encoded_cookie() {
        // Shape of qe.newssid.com's auth_data cookie: URL-encoded
        // {"site":"SS-ID","value":"<JWT>"}; the JWT lives under `.value`.
        let auth = normalize_provider_auth(
            "%7B%22site%22%3A%22SS-ID%22%2C%22value%22%3A%22jwt-token-abc%22%7D",
        );

        assert_eq!(auth.as_deref(), Some("jwt-token-abc"));
    }

    #[test]
    fn parses_newssid_v2board_traffic() {
        let subscribe = r#"{"data":{"u":1073741824,"d":2147483648,"transfer_enable":10737418240,"expired_at":1781843330,"reset_day":1,"plan":{"name":"SS-ID 高级"}}}"#;

        let snapshot = parse_v2board_traffic(
            "newssid",
            "SS-ID",
            NEWSSID_HOMEPAGE,
            subscribe,
            None,
            "2026-06-12T13:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.id, "newssid");
        assert_eq!(snapshot.name, "SS-ID");
        assert_eq!(snapshot.homepage, NEWSSID_HOMEPAGE);
        assert_eq!(snapshot.plan_name.as_deref(), Some("SS-ID 高级"));
        assert_eq!(snapshot.used_total_bytes, Some(3221225472));
        assert_eq!(snapshot.total_bytes, Some(10737418240));
        assert_eq!(snapshot.expire_at, Some(1781843330));
        assert_eq!(snapshot.error, None);
    }

    #[test]
    fn parses_yuyan_v2board_traffic() {
        let subscribe = r#"{"data":{"u":1073741824,"d":2147483648,"transfer_enable":53687091200,"expired_at":1796797452,"reset_day":5,"plan":{"name":"雨燕云 标准"}}}"#;

        let snapshot = parse_v2board_traffic(
            "yuyan",
            "雨燕云",
            YUYAN_HOMEPAGE,
            subscribe,
            None,
            "2026-06-12T13:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.id, "yuyan");
        assert_eq!(snapshot.name, "雨燕云");
        assert_eq!(snapshot.homepage, YUYAN_HOMEPAGE);
        assert_eq!(snapshot.plan_name.as_deref(), Some("雨燕云 标准"));
        assert_eq!(snapshot.used_total_bytes, Some(3221225472));
        assert_eq!(snapshot.total_bytes, Some(53687091200));
        assert_eq!(snapshot.expire_at, Some(1796797452));
        assert_eq!(snapshot.error, None);
    }

    #[test]
    fn extracts_yuyan_access_token_value_with_bearer() {
        // yuyan.co localStorage ACCESS_TOKEN holds {"value":"Bearer <token>",...}.
        let raw = r#"{"value":"Bearer Ad6AMiv9zrNYppXrIG8ZV1iJW0g3wBMZjw02EV2U3e1269a6","time":1781245652306,"expire":1781267252306}"#;
        let token = normalize_provider_auth(raw).unwrap();
        assert_eq!(token, "Bearer Ad6AMiv9zrNYppXrIG8ZV1iJW0g3wBMZjw02EV2U3e1269a6");
        // bearer_token leaves an already-prefixed token untouched.
        assert_eq!(bearer_token(&token), token);
    }

    #[test]
    fn finalize_provider_falls_back_to_stale_snapshot_on_failure() {
        let id = "stale-cache-test";
        let ok = parse_v2board_traffic(
            id,
            "Stale Test",
            "https://x/",
            r#"{"data":{"u":1,"d":2,"transfer_enable":10}}"#,
            None,
            "2026-06-12T13:00:00+08:00",
        )
        .unwrap();

        // Success is cached and returned as-is.
        let cached = finalize_provider(id, "Stale Test", "https://x/", "2026-06-12T13:00:00+08:00", Ok(ok));
        assert_eq!(cached.error, None);
        assert!(!cached.stale);

        // A later failure returns the previous numbers, marked stale.
        let stale = finalize_provider(
            id,
            "Stale Test",
            "https://x/",
            "2026-06-12T13:30:00+08:00",
            Err(anyhow!("HTTP 403 Forbidden")),
        );
        assert!(stale.stale);
        assert_eq!(stale.used_total_bytes, Some(3));
        assert_eq!(stale.last_successful_at.as_deref(), Some("2026-06-12T13:00:00+08:00"));
        assert_eq!(stale.fetched_at, "2026-06-12T13:30:00+08:00");
        assert!(stale.error.unwrap().contains("HTTP 403 Forbidden"));

        // A provider that never succeeded just returns a plain error snapshot.
        let fresh_error = finalize_provider(
            "never-succeeded-xyz",
            "X",
            "https://x/",
            "2026-06-12T13:30:00+08:00",
            Err(anyhow!("boom")),
        );
        assert!(!fresh_error.stale);
        assert_eq!(fresh_error.used_total_bytes, None);
        assert!(fresh_error.error.unwrap().contains("boom"));
    }

    #[test]
    fn bearer_token_wraps_once() {
        assert_eq!(bearer_token("Ad6AtokenXYZ"), "Bearer Ad6AtokenXYZ");
        assert_eq!(bearer_token("Bearer Ad6AtokenXYZ"), "Bearer Ad6AtokenXYZ");
        assert_eq!(bearer_token("bearer lowercase"), "bearer lowercase");
        assert_eq!(bearer_token("  spaced  "), "Bearer spaced");
    }

    #[tokio::test]
    async fn fetches_newssid_access_traffic_contract() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let request = Arc::new(StdMutex::new(String::new()));
        let captured = Arc::clone(&request);

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let bytes_read = stream.read(&mut buffer).await.unwrap();
            *captured.lock().unwrap() = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();

            let body = r#"{"data":{"u":1024,"d":2048,"transfer_enable":10240,"expired_at":1781843330,"reset_day":18,"plan":{"id":1,"name":"100G"}}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let origins = [origin.as_str()];
        let body = fetch_first_provider_api_text(
            &Client::new(),
            &origins,
            NEWSSID_SUBSCRIBE_PATHS,
            Some("raw-auth-value"),
            Some("auth_data=test-cookie"),
            "test-agent/1.0",
        )
        .await
        .unwrap();
        server.await.unwrap();

        let snapshot = parse_v2board_traffic(
            "newssid",
            "SS-ID",
            NEWSSID_HOMEPAGE,
            &body,
            None,
            "2026-08-25T15:00:00+08:00",
        )
        .unwrap();
        assert_eq!(snapshot.used_upload_bytes, Some(1024));
        assert_eq!(snapshot.used_download_bytes, Some(2048));
        assert_eq!(snapshot.total_bytes, Some(10240));
        assert_eq!(snapshot.plan_name.as_deref(), Some("100G"));

        let request = request.lock().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /api/v1/access/getsubscribe http/1.1"));
        assert!(request.contains("authorization: raw-auth-value"));
        assert!(!request.contains("authorization: bearer raw-auth-value"));
    }

    #[tokio::test]
    async fn fetches_first_successful_provider_api_candidate() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let captured = Arc::clone(&requests);

        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 2048];
                let bytes_read = stream.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
                captured.lock().unwrap().push(request.clone());

                let response = if request.starts_with("GET /missing ") {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_string()
                } else {
                    let body = r#"{"data":{"u":1,"d":2,"transfer_enable":8}}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let origins = [origin.as_str()];
        let body = fetch_first_provider_api_text(
            &Client::new(),
            &origins,
            &["/missing", "/api/v1/user/getStat"],
            Some("Bearer test-token"),
            Some("session=test"),
            "test-agent/1.0",
        )
        .await
        .unwrap();
        server.await.unwrap();

        assert_eq!(body, r#"{"data":{"u":1,"d":2,"transfer_enable":8}}"#);
        let requests = requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /missing "));
        assert!(requests[1].starts_with("GET /api/v1/user/getStat "));
        let second_request = requests[1].to_ascii_lowercase();
        assert!(second_request.contains("authorization: bearer test-token"));
        assert!(second_request.contains("cookie: session=test"));
        assert!(second_request.contains("user-agent: test-agent/1.0"));
        // Browser-mimic headers so Cloudflare-fronted providers don't flag a bot.
        assert!(second_request.contains("sec-fetch-site: same-origin"));
        assert!(second_request.contains("sec-fetch-mode: cors"));
        assert!(second_request.contains("sec-ch-ua:"));
        assert!(second_request.contains("referer: http://"));
        assert!(second_request.contains("accept-language:"));
    }

    #[test]
    fn chrome_major_from_user_agent_extracts_major() {
        assert_eq!(
            chrome_major_from_user_agent(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
            ),
            Some("149")
        );
        assert_eq!(chrome_major_from_user_agent("curl/8.0"), None);
        assert_eq!(chrome_major_from_user_agent("Chrome/"), None);
    }

    #[test]
    fn chrome_profile_user_agent_uses_profile_last_version() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("Default");
        fs::create_dir(&profile).unwrap();
        fs::write(root.path().join("Last Version"), "148.0.7778.178\n").unwrap();

        let user_agent = chrome_profile_user_agent(&profile);

        // Reduced UA (major.0.0.0) so it matches Chrome's actual header / cf_clearance.
        assert!(user_agent.contains("Chrome/148.0.0.0 "));
        assert!(!user_agent.contains("148.0.7778.178"));
    }

    #[test]
    fn copied_cookies_db_includes_wal_resident_rows() {
        // Simulate Chrome's WAL-mode Cookies DB where a freshly-set cookie still
        // lives in the -wal file (not yet checkpointed into the main DB file).
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("Cookies");
        let writer = Connection::open(&db_path).unwrap();
        writer.pragma_update(None, "journal_mode", "WAL").unwrap();
        writer.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        writer
            .execute(
                "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)",
                [],
            )
            .unwrap();
        writer
            .execute(
                "INSERT INTO cookies VALUES ('qe.newssid.com', 'cf_clearance', 'wal-token', x'')",
                [],
            )
            .unwrap();
        // Keep `writer` open so the row stays in -wal (closing would checkpoint).
        assert!(path_with_suffix(&db_path, "-wal").exists());

        let copy = open_copied_cookies_db(&db_path).unwrap();
        let value: String = copy
            .query_row(
                "SELECT value FROM cookies WHERE name = 'cf_clearance'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(value, "wal-token");
        drop(writer);
    }

    #[test]
    fn cookie_host_key_candidates_includes_parent_domains() {
        assert_eq!(
            cookie_host_key_candidates("qe.newssid.com"),
            vec![
                ".newssid.com".to_string(),
                ".qe.newssid.com".to_string(),
                "qe.newssid.com".to_string(),
            ]
        );
        // Never matches the bare TLD.
        assert!(!cookie_host_key_candidates("qe.newssid.com").contains(&".com".to_string()));
        assert_eq!(
            cookie_host_key_candidates("yuyan.co"),
            vec![".yuyan.co".to_string(), "yuyan.co".to_string()]
        );
    }

    #[test]
    fn reads_parent_domain_cf_clearance_cookie() {
        let profile = tempfile::tempdir().unwrap();
        let db = Connection::open(profile.path().join("Cookies")).unwrap();
        db.execute(
            "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO cookies VALUES ('.qe.newssid.com', 'auth_data', 'a', x'')",
            [],
        )
        .unwrap();
        // cf_clearance lives under the parent domain ".newssid.com".
        db.execute(
            "INSERT INTO cookies VALUES ('.newssid.com', 'cf_clearance', 'cf', x'')",
            [],
        )
        .unwrap();

        let header = read_chrome_cookie_header(profile.path(), "qe.newssid.com").unwrap();

        assert!(header.contains("cf_clearance=cf"));
        assert!(header.contains("auth_data=a"));
    }

    #[test]
    fn reads_chrome_cookie_header_for_provider_host() {
        let profile = tempfile::tempdir().unwrap();
        let db_path = profile.path().join("Cookies");
        let db = Connection::open(&db_path).unwrap();
        db.execute(
            "CREATE TABLE cookies (host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL)",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?1, ?2, ?3, ?4)",
            params!["wd-gold.net", "WHMCS", "session-token", Vec::<u8>::new()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?1, ?2, ?3, ?4)",
            params![
                ".wd-gold.net",
                "cf_clearance",
                "challenge-token",
                Vec::<u8>::new()
            ],
        )
        .unwrap();

        let header = read_chrome_cookie_header(profile.path(), "wd-gold.net").unwrap();

        assert_eq!(header, "WHMCS=session-token; cf_clearance=challenge-token");
    }

    #[test]
    fn decrypts_chrome_linux_cookie_and_strips_host_digest() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        let secret = b"test chrome safe storage";
        let host = "wd-gold.net";
        let value = b"browser-cookie-value";
        let mut plaintext = Sha256::digest(host.as_bytes()).to_vec();
        plaintext.extend_from_slice(value);
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(secret, b"saltysalt", 1, &mut key);
        let iv = [b' '; 16];
        let mut buffer = plaintext;
        let message_len = buffer.len();
        buffer.resize(message_len + 16, 0);
        let ciphertext = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, message_len)
            .unwrap()
            .to_vec();
        let mut encrypted = b"v11".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let decrypted = decrypt_chrome_linux_cookie_with_secret(host, &encrypted, secret).unwrap();

        assert_eq!(decrypted, "browser-cookie-value");
    }

    #[test]
    fn decrypts_v10_basic_store_cookie_with_peanuts_key() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        // Chrome's basic password store ("peanuts") used for v10 cookies — no
        // keyring needed, so the helper can read it even when running as root.
        let secret = b"peanuts";
        let host = "qe.newssid.com";
        let value = b"cf_clearance-token";
        let mut plaintext = Sha256::digest(host.as_bytes()).to_vec();
        plaintext.extend_from_slice(value);
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(secret, b"saltysalt", 1, &mut key);
        let iv = [b' '; 16];
        let mut buffer = plaintext;
        let message_len = buffer.len();
        buffer.resize(message_len + 16, 0);
        let ciphertext = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, message_len)
            .unwrap()
            .to_vec();
        let mut encrypted = b"v10".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let decrypted =
            decrypt_chrome_linux_cookie_with_secrets(host, &encrypted, &[b"peanuts".to_vec()]).unwrap();

        assert_eq!(decrypted, "cf_clearance-token");
    }

    #[test]
    fn decrypts_chrome_linux_cookie_with_later_secret_candidate() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        let correct_secret = b"correct chrome safe storage";
        let wrong_secret = b"wrong chrome safe storage";
        let host = "wd-gold.net";
        let value = b"wd-gold-cookie";
        let mut plaintext = Sha256::digest(host.as_bytes()).to_vec();
        plaintext.extend_from_slice(value);
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(correct_secret, b"saltysalt", 1, &mut key);
        let iv = [b' '; 16];
        let mut buffer = plaintext;
        let message_len = buffer.len();
        buffer.resize(message_len + 16, 0);
        let ciphertext = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, message_len)
            .unwrap()
            .to_vec();
        let mut encrypted = b"v11".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let secrets: [&[u8]; 2] = [&wrong_secret[..], &correct_secret[..]];
        let decrypted =
            decrypt_chrome_linux_cookie_with_secrets(host, &encrypted, &secrets).unwrap();

        assert_eq!(decrypted, "wd-gold-cookie");
    }

    #[test]
    fn decrypts_chrome_linux_cookie_with_base64_secret_candidate() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        let decoded_secret = b"1234567890abcdef";
        let encoded_secret = BASE64.encode(decoded_secret);
        let host = "wd-gold.net";
        let value = b"wd-gold-cookie";
        let mut plaintext = Sha256::digest(host.as_bytes()).to_vec();
        plaintext.extend_from_slice(value);
        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(decoded_secret, b"saltysalt", 1, &mut key);
        let iv = [b' '; 16];
        let mut buffer = plaintext;
        let message_len = buffer.len();
        buffer.resize(message_len + 16, 0);
        let ciphertext = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, message_len)
            .unwrap()
            .to_vec();
        let mut encrypted = b"v11".to_vec();
        encrypted.extend_from_slice(&ciphertext);

        let secrets = [encoded_secret.as_bytes()];
        let decrypted =
            decrypt_chrome_linux_cookie_with_secrets(host, &encrypted, &secrets).unwrap();

        assert_eq!(decrypted, "wd-gold-cookie");
    }

    #[test]
    fn chrome_secret_context_uses_profile_owner_runtime_bus() {
        let profile = tempfile::tempdir().unwrap();
        let context = chrome_profile_owner_secret_context(profile.path()).unwrap();
        let metadata = fs::metadata(profile.path()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;

            let uid = metadata.uid();
            assert_eq!(context.uid, Some(uid));
            assert_eq!(context.gid, Some(metadata.gid()));
            assert_eq!(
                context.envs,
                vec![
                    ("XDG_RUNTIME_DIR".to_string(), format!("/run/user/{uid}")),
                    (
                        "DBUS_SESSION_BUS_ADDRESS".to_string(),
                        format!("unix:path=/run/user/{uid}/bus")
                    ),
                ]
            );
        }
    }

    #[test]
    fn decodes_chrome_local_storage_key_and_utf8_value() {
        let key = chrome_local_storage_key("https://xnyun.wiki", "token");

        assert_eq!(key, b"_https://xnyun.wiki\0\x01token".to_vec());
        assert_eq!(
            decode_chrome_local_storage_value(b"\x01browser-local-storage-token").unwrap(),
            "browser-local-storage-token"
        );
    }

    #[tokio::test]
    async fn traffic_response_reports_supplied_chrome_profile_path() {
        let profile = PathBuf::from("/tmp/singdeck-test-chrome-profile/Default");
        let response = read_traffic(&Client::new(), &profile).await;

        assert_eq!(response.profile, profile.display().to_string());
        assert_eq!(response.providers.len(), 2);
        assert_eq!(response.providers[0].id, "newssid");
        assert_eq!(response.providers[1].id, "yuyan");
    }

    #[test]
    fn chrome_profile_path_keeps_empty_value_unconfigured() {
        assert!(chrome_profile_path("  ").as_os_str().is_empty());
    }
}
