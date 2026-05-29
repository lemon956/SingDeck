#[cfg(unix)]
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::{
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

const WD_GOLD_HOMEPAGE: &str = "https://wd-gold.net/clientarea.php?action=productdetails&id=217101";
const XNYUN_HOMEPAGE: &str = "https://xnyun.wiki/#/dashboard";
const XNYUN_STORAGE_ORIGIN: &str = "https://xnyun.wiki";
const XNYUN_ORIGIN: &str = "https://api.xnyun.wiki";
const XNYUN_API_ORIGINS: &[&str] = &[XNYUN_ORIGIN, XNYUN_STORAGE_ORIGIN];
const XNYUN_PRIMARY_AUTH_STORAGE_KEYS: &[&str] = &["auth_data", "cookie_auth_data"];
const XNYUN_AUTH_COOKIE_NAMES: &[&str] = &["auth_data", "auth"];
const XNYUN_FALLBACK_AUTH_STORAGE_KEYS: &[&str] = &["token"];
const XNYUN_SUBSCRIBE_PATHS: &[&str] = &[
    "/api/v1/user/getSubscribe",
    "/api/v1/user/getStat",
    "/api/v1/user/stat",
    "/api/v1/user/traffic",
];
const XNYUN_USER_PATHS: &[&str] = &[
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
        fetch_wd_gold(http, profile, &fetched_at).await,
        fetch_xnyun(http, profile, &fetched_at).await,
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

pub fn parse_wd_gold_product_details(html: &str, fetched_at: &str) -> Result<TrafficSnapshot> {
    let text = normalize_html_text(html);
    let total = extract_labeled_bytes(
        &text,
        &[
            "总流量",
            "total traffic",
            "traffic limit",
            "bandwidth limit",
        ],
    );
    let used = extract_labeled_bytes(
        &text,
        &[
            "已使用流量",
            "已用流量",
            "used traffic",
            "traffic used",
            "bandwidth usage",
            "used bandwidth",
        ],
    );
    let fraction = extract_fraction_bytes(&text);
    let total = total.or_else(|| fraction.map(|(_, total)| total));
    let used_total = used.or_else(|| fraction.map(|(used, _)| used));

    let (Some(used_total), Some(total)) = (used_total, total) else {
        if is_login_or_challenge_page(&text) {
            return Err(anyhow!("provider returned login or challenge page"));
        }
        return Err(anyhow!("missing WD Gold traffic data"));
    };

    let remaining = (total - used_total).max(0);
    let used_ratio = if total > 0 {
        Some(round_one(used_total as f64 / total as f64 * 100.0))
    } else {
        None
    };
    let reset_at = extract_labeled_date(
        &text,
        &[
            "重置时间",
            "重置日期",
            "reset time",
            "reset date",
            "next reset",
        ],
    );
    let expire_at = extract_labeled_date(
        &text,
        &[
            "到期时间",
            "到期日期",
            "付费时间",
            "付款时间",
            "续费时间",
            "expire time",
            "expire date",
            "expiration date",
            "expiry date",
            "due date",
            "next due date",
            "payment due",
            "paid until",
        ],
    );
    let reset_day = if reset_at.is_none() {
        extract_labeled_i64(&text, &["重置日", "reset day"])
    } else {
        None
    };

    Ok(TrafficSnapshot {
        id: "wd-gold".to_string(),
        name: "WD Gold".to_string(),
        homepage: WD_GOLD_HOMEPAGE.to_string(),
        plan_name: None,
        used_upload_bytes: None,
        used_download_bytes: None,
        used_total_bytes: Some(used_total),
        total_bytes: Some(total),
        remaining_bytes: Some(remaining),
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

async fn fetch_wd_gold(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result: Result<TrafficSnapshot> = async {
        if let Ok(snapshot) = fetch_wd_gold_from_subscription(http, profile, fetched_at).await {
            remember_wd_gold_success(&snapshot);
            return Ok(snapshot);
        }

        let cookie = read_chrome_cookie_header(profile, "wd-gold.net")?;
        let user_agent = chrome_profile_user_agent(profile);
        let html = fetch_text(
            http.get(WD_GOLD_HOMEPAGE)
                .header(header::COOKIE, cookie)
                .header(
                    header::ACCEPT,
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                )
                .header(header::USER_AGENT, user_agent),
        )
        .await?;
        let snapshot = parse_wd_gold_product_details(&html, fetched_at)?;
        remember_wd_gold_success(&snapshot);
        Ok(snapshot)
    }
    .await;

    result.unwrap_or_else(|error| wd_gold_stale_or_error(fetched_at, error))
}

#[derive(Debug, PartialEq, Eq)]
struct WdSubscriptionUserInfo {
    upload: i64,
    download: i64,
    total: i64,
    expire: Option<i64>,
}

async fn fetch_wd_gold_from_subscription(
    http: &Client,
    profile: &Path,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let urls = collect_wd_red_subscription_urls(profile)?;
    if urls.is_empty() {
        return Err(anyhow!(
            "WD Gold subscription URL not found in Chrome session files"
        ));
    }

    let mut errors = Vec::new();
    for (index, url) in urls.iter().enumerate() {
        match fetch_wd_subscription_userinfo(http, url)
            .await
            .and_then(|info| build_wd_subscription_snapshot(&info, fetched_at))
        {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => errors.push(format!("candidate {}: {error}", index + 1)),
        }
    }

    Err(anyhow!(
        "WD Gold subscription traffic unavailable: {}",
        errors.join("; ")
    ))
}

async fn fetch_wd_subscription_userinfo(
    http: &Client,
    subscription_url: &str,
) -> Result<WdSubscriptionUserInfo> {
    let response = http
        .get(subscription_url)
        .header(header::ACCEPT, "*/*")
        .header(header::USER_AGENT, "clash-verge/v2.0.0")
        .send()
        .await
        .context("WD Gold subscription request failed")?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "WD Gold subscription returned HTTP {}",
            response.status()
        ));
    }

    let userinfo = response
        .headers()
        .get("subscription-userinfo")
        .ok_or_else(|| anyhow!("WD Gold subscription-userinfo header missing"))?
        .to_str()
        .context("WD Gold subscription-userinfo header is not UTF-8")?;
    parse_wd_subscription_userinfo(userinfo)
}

fn build_wd_subscription_snapshot(
    info: &WdSubscriptionUserInfo,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let used_total = info.upload + info.download;
    let remaining = (info.total - used_total).max(0);
    let used_ratio = if info.total > 0 {
        Some(round_one(used_total as f64 / info.total as f64 * 100.0))
    } else {
        None
    };

    Ok(TrafficSnapshot {
        id: "wd-gold".to_string(),
        name: "WD Gold".to_string(),
        homepage: WD_GOLD_HOMEPAGE.to_string(),
        plan_name: Some("Subscription".to_string()),
        used_upload_bytes: Some(info.upload),
        used_download_bytes: Some(info.download),
        used_total_bytes: Some(used_total),
        total_bytes: Some(info.total),
        remaining_bytes: Some(remaining),
        used_ratio,
        expire_at: info.expire,
        reset_day: None,
        reset_at: None,
        stale: false,
        last_successful_at: Some(fetched_at.to_string()),
        fetched_at: fetched_at.to_string(),
        error: None,
    })
}

fn parse_wd_subscription_userinfo(header_value: &str) -> Result<WdSubscriptionUserInfo> {
    let mut upload = None;
    let mut download = None;
    let mut total = None;
    let mut expire = None;

    for part in header_value.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        let value = value.trim().parse::<i64>().ok();
        match key.trim() {
            "upload" => upload = value,
            "download" => download = value,
            "total" => total = value,
            "expire" => expire = value.filter(|value| *value > 0),
            _ => {}
        }
    }

    Ok(WdSubscriptionUserInfo {
        upload: upload.ok_or_else(|| anyhow!("WD Gold subscription upload missing"))?,
        download: download.ok_or_else(|| anyhow!("WD Gold subscription download missing"))?,
        total: total.ok_or_else(|| anyhow!("WD Gold subscription total missing"))?,
        expire,
    })
}

fn collect_wd_red_subscription_urls(profile: &Path) -> Result<Vec<String>> {
    let sessions_dir = profile.join("Sessions");
    let mut files = Vec::new();
    if sessions_dir.is_dir() {
        for entry in fs::read_dir(&sessions_dir)? {
            let entry = entry?;
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.starts_with("Session_") && !file_name.starts_with("Tabs_") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok();
            files.push((modified, path));
        }
    }
    files.sort_by(|left, right| right.0.cmp(&left.0));

    let mut urls = Vec::new();
    for (_, path) in files {
        let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        push_unique_urls(
            &mut urls,
            extract_wd_red_subscription_urls_from_bytes(&bytes),
        );
    }

    Ok(urls)
}

fn extract_wd_red_subscription_urls_from_bytes(bytes: &[u8]) -> Vec<String> {
    let mut urls = Vec::new();
    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
        push_unique_urls(&mut urls, extract_wd_red_subscription_urls_from_text(&text));
    } else {
        let text = String::from_utf8_lossy(bytes);
        push_unique_urls(&mut urls, extract_wd_red_subscription_urls_from_text(&text));
    }
    let utf16 = decode_utf16le_lossy(bytes);
    push_unique_urls(
        &mut urls,
        extract_wd_red_subscription_urls_from_text(&utf16),
    );
    urls
}

fn extract_wd_red_subscription_urls_from_text(text: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let mut rest = text;
    while let Some(index) = rest.find("http") {
        rest = &rest[index..];
        let end = rest
            .char_indices()
            .find(|(_, character)| is_url_delimiter(*character))
            .map(|(index, _)| index)
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if let Some(url) = normalize_wd_red_subscription_url(candidate) {
            push_unique_url(&mut urls, url);
        }
        rest = &rest[end..];
    }
    urls
}

fn normalize_wd_red_subscription_url(candidate: &str) -> Option<String> {
    if let Some(tail) = candidate.strip_prefix("https://wd-red.com/subscribe/") {
        let token = tail
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
            })
            .collect::<String>();
        if !token.is_empty() {
            return Some(format!("https://wd-red.com/subscribe/{token}"));
        }
    }

    if candidate.starts_with("https://api.wd-red.com/sub?") {
        for part in candidate.split('?').nth(1)?.split('&') {
            let Some((key, value)) = part.split_once('=') else {
                continue;
            };
            if key == "url" {
                if let Some(decoded) = percent_decode(value) {
                    if let Some(url) = normalize_wd_red_subscription_url(&decoded) {
                        return Some(url);
                    }
                }
            }
        }
    }

    None
}

fn decode_utf16le_lossy(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn is_url_delimiter(character: char) -> bool {
    character.is_whitespace()
        || character.is_control()
        || matches!(character, '"' | '\'' | '<' | '>' | '\\')
}

fn push_unique_urls(target: &mut Vec<String>, urls: Vec<String>) {
    for url in urls {
        push_unique_url(target, url);
    }
}

fn push_unique_url(target: &mut Vec<String>, url: String) {
    if !target.iter().any(|existing| existing == &url) {
        target.push(url);
    }
}

async fn fetch_xnyun(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result: Result<TrafficSnapshot> = async {
        let cookie = read_chrome_cookie_header(profile, "xnyun.wiki").ok();
        let auth = read_xnyun_auth(profile).ok();
        if cookie.is_none() && auth.is_none() {
            return Err(anyhow!("Chrome login state not found for xnyun.wiki"));
        }
        let subscribe = fetch_first_xnyun_api_text(
            http,
            XNYUN_API_ORIGINS,
            XNYUN_SUBSCRIBE_PATHS,
            auth.as_deref(),
            cookie.as_deref(),
        )
        .await?;
        let user = fetch_optional_xnyun_api_text(
            http,
            XNYUN_API_ORIGINS,
            XNYUN_USER_PATHS,
            auth.as_deref(),
            cookie.as_deref(),
        )
        .await;

        parse_v2board_traffic(
            "xnyun",
            "XNYun",
            XNYUN_HOMEPAGE,
            &subscribe,
            user.as_deref(),
            fetched_at,
        )
    }
    .await;

    result
        .unwrap_or_else(|error| provider_error("xnyun", "XNYun", XNYUN_HOMEPAGE, fetched_at, error))
}

fn read_xnyun_auth(profile: &Path) -> Result<String> {
    let mut errors = Vec::new();

    for key in XNYUN_PRIMARY_AUTH_STORAGE_KEYS {
        match read_xnyun_storage_auth(profile, key) {
            Ok(value) => {
                if let Some(auth) = normalize_xnyun_auth(&value) {
                    return Ok(auth);
                }
                errors.push(format!("localStorage {key} was empty"));
            }
            Err(error) => errors.push(format!("localStorage {key}: {error}")),
        }
    }

    for name in XNYUN_AUTH_COOKIE_NAMES {
        match read_chrome_cookie(profile, "xnyun.wiki", name) {
            Ok(value) => {
                if let Some(auth) = normalize_xnyun_auth(&value) {
                    return Ok(auth);
                }
                errors.push(format!("cookie {name} was empty"));
            }
            Err(error) => errors.push(format!("cookie {name}: {error}")),
        }
    }

    for key in XNYUN_FALLBACK_AUTH_STORAGE_KEYS {
        match read_xnyun_storage_auth(profile, key) {
            Ok(value) => {
                if let Some(auth) = normalize_xnyun_auth(&value) {
                    return Ok(auth);
                }
                errors.push(format!("localStorage {key} was empty"));
            }
            Err(error) => errors.push(format!("localStorage {key}: {error}")),
        }
    }

    Err(anyhow!(
        "Chrome XNYun auth unavailable: {}",
        errors.join("; ")
    ))
}

fn read_xnyun_storage_auth(profile: &Path, key: &str) -> Result<String> {
    read_chrome_local_storage(profile, XNYUN_STORAGE_ORIGIN, key)
}

#[cfg(test)]
fn select_xnyun_auth_from_pairs(values: &[(&str, &str)]) -> Option<String> {
    for key in [
        "localStorage:auth_data",
        "auth_data",
        "localStorage:cookie_auth_data",
        "cookie_auth_data",
        "cookie:auth_data",
        "cookie:auth",
        "localStorage:token",
        "token",
    ] {
        if let Some((_, value)) = values.iter().find(|(candidate, _)| *candidate == key) {
            if let Some(auth) = normalize_xnyun_auth(value) {
                return Some(auth);
            }
        }
    }
    None
}

fn normalize_xnyun_auth(raw: &str) -> Option<String> {
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
        ] {
            if let Some(auth) = value.get(key).and_then(Value::as_str) {
                if let Some(auth) = normalize_xnyun_auth(auth) {
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

async fn fetch_first_xnyun_api_text(
    http: &Client,
    origins: &[&str],
    paths: &[&str],
    auth: Option<&str>,
    cookie: Option<&str>,
) -> Result<String> {
    let mut errors = Vec::new();
    for origin in origins {
        for path in paths {
            match fetch_xnyun_api_text(http, origin, path, auth, cookie).await {
                Ok(body) => return Ok(body),
                Err(error) => errors.push(format!("{origin}{path}: {error}")),
            }
        }
    }

    Err(anyhow!(
        "all XNYun API candidates failed: {}",
        errors.join("; ")
    ))
}

async fn fetch_optional_xnyun_api_text(
    http: &Client,
    origins: &[&str],
    paths: &[&str],
    auth: Option<&str>,
    cookie: Option<&str>,
) -> Option<String> {
    fetch_first_xnyun_api_text(http, origins, paths, auth, cookie)
        .await
        .ok()
}

async fn fetch_xnyun_api_text(
    http: &Client,
    origin: &str,
    path: &str,
    auth: Option<&str>,
    cookie: Option<&str>,
) -> Result<String> {
    let mut request = http
        .get(format!("{origin}{path}"))
        .header(header::ACCEPT, "application/json, text/plain, */*")
        .header(header::USER_AGENT, default_chrome_user_agent());
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

static WD_GOLD_LAST_SUCCESS: OnceLock<Mutex<Option<TrafficSnapshot>>> = OnceLock::new();

fn wd_gold_last_success() -> &'static Mutex<Option<TrafficSnapshot>> {
    WD_GOLD_LAST_SUCCESS.get_or_init(|| Mutex::new(None))
}

fn remember_wd_gold_success(snapshot: &TrafficSnapshot) {
    if snapshot.error.is_some() || snapshot.stale {
        return;
    }
    if let Ok(mut cached) = wd_gold_last_success().lock() {
        *cached = Some(snapshot.clone());
    }
}

fn wd_gold_stale_or_error(fetched_at: &str, error: impl std::fmt::Display) -> TrafficSnapshot {
    let error = error.to_string();
    if let Ok(cached) = wd_gold_last_success().lock() {
        if let Some(snapshot) = cached.as_ref() {
            let mut stale = snapshot.clone();
            let last_successful_at = stale
                .last_successful_at
                .clone()
                .unwrap_or_else(|| stale.fetched_at.clone());
            stale.fetched_at = fetched_at.to_string();
            stale.last_successful_at = Some(last_successful_at);
            stale.stale = true;
            stale.error = Some(format!(
                "WD Gold sync failed; showing last successful traffic snapshot: {error}"
            ));
            return stale;
        }
    }

    provider_error("wd-gold", "WD Gold", WD_GOLD_HOMEPAGE, fetched_at, error)
}

#[cfg(test)]
fn clear_wd_gold_cache_for_test() {
    if let Ok(mut cached) = wd_gold_last_success().lock() {
        *cached = None;
    }
}

fn default_chrome_user_agent() -> &'static str {
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

fn chrome_profile_user_agent(profile: &Path) -> String {
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
    format!(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36"
    )
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

pub fn read_chrome_cookie_header(profile: &Path, host_key: &str) -> Result<String> {
    let cookies_path = find_cookies_db(profile)?;
    let db = open_cookies_db(&cookies_path)?;
    let host_with_dot = format!(".{host_key}");
    let mut stmt = db.prepare(
        r#"
        SELECT host_key, name, value, encrypted_value
        FROM cookies
        WHERE host_key = ?1 OR host_key = ?2
        ORDER BY CASE WHEN host_key = ?1 THEN 0 ELSE 1 END, name
        "#,
    )?;
    let rows = stmt.query_map(params![host_key, host_with_dot], |row| {
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
            decrypt_chrome_linux_cookie_with_secrets(&actual_host_key, &encrypted_value, secrets)?
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
    Connection::open_with_flags(copy_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(Into::into)
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

    if secrets.is_empty() {
        Err(anyhow!(
            "Chrome cookie key not available from secret-tool; install libsecret tools or unlock the Chrome profile owner's keyring"
        ))
    } else {
        Ok(secrets)
    }
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

#[derive(Debug, Clone, Copy)]
struct ByteQuantity {
    start: usize,
    end: usize,
    bytes: i64,
}

fn normalize_html_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                text.push(' ');
            }
            '>' => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(character),
            _ => {}
        }
    }
    collapse_whitespace(&decode_basic_html_entities(&text))
}

fn decode_basic_html_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_labeled_bytes(text: &str, labels: &[&str]) -> Option<i64> {
    let lower = text.to_lowercase();
    let quantities = byte_quantities(text);
    for label in labels {
        let mut search_start = 0;
        while let Some(relative) = lower[search_start..].find(label) {
            let label_start = search_start + relative;
            if let Some(quantity) = quantities
                .iter()
                .filter(|quantity| {
                    quantity.start >= label_start
                        && quantity.start.saturating_sub(label_start) <= 120
                })
                .min_by_key(|quantity| quantity.start - label_start)
            {
                return Some(quantity.bytes);
            }
            search_start = label_start + label.len();
        }
    }
    None
}

fn extract_fraction_bytes(text: &str) -> Option<(i64, i64)> {
    let quantities = byte_quantities(text);
    for pair in quantities.windows(2) {
        let first = pair[0];
        let second = pair[1];
        let separator = &text[first.end..second.start];
        let separator_lower = separator.to_lowercase();
        if separator.contains('/') || separator_lower.contains(" of ") {
            return Some((first.bytes, second.bytes));
        }
    }
    None
}

fn byte_quantities(text: &str) -> Vec<ByteQuantity> {
    let bytes = text.as_bytes();
    let mut quantities = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let start = index;
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }

        let mut number_end = index + 1;
        while number_end < bytes.len()
            && (bytes[number_end].is_ascii_digit()
                || bytes[number_end] == b'.'
                || bytes[number_end] == b',')
        {
            number_end += 1;
        }
        let mut unit_start = number_end;
        while unit_start < bytes.len() && bytes[unit_start].is_ascii_whitespace() {
            unit_start += 1;
        }
        let mut unit_end = unit_start;
        while unit_end < bytes.len() && bytes[unit_end].is_ascii_alphabetic() {
            unit_end += 1;
        }

        if let (Ok(number), Some(multiplier)) = (
            text[start..number_end].replace(',', "").parse::<f64>(),
            parse_byte_unit(&text[unit_start..unit_end]),
        ) {
            quantities.push(ByteQuantity {
                start,
                end: unit_end,
                bytes: (number * multiplier as f64).round() as i64,
            });
        }
        index = number_end.max(index + 1);
    }
    quantities
}

fn parse_byte_unit(unit: &str) -> Option<i64> {
    let normalized = unit.trim().to_ascii_lowercase();
    let power = match normalized.as_str() {
        "b" | "byte" | "bytes" => 0,
        "k" | "kb" | "kib" => 1,
        "m" | "mb" | "mib" => 2,
        "g" | "gb" | "gib" => 3,
        "t" | "tb" | "tib" => 4,
        "p" | "pb" | "pib" => 5,
        _ => return None,
    };
    Some(1024_i64.pow(power))
}

fn extract_labeled_date(text: &str, labels: &[&str]) -> Option<i64> {
    let lower = text.to_lowercase();
    for label in labels {
        let mut search_start = 0;
        while let Some(relative) = lower[search_start..].find(label) {
            let label_start = search_start + relative;
            let tail_end = (label_start + 140).min(text.len());
            if let Some(timestamp) = extract_first_date_timestamp(&text[label_start..tail_end]) {
                return Some(timestamp);
            }
            search_start = label_start + label.len();
        }
    }
    None
}

fn extract_first_date_timestamp(text: &str) -> Option<i64> {
    for token in text.split_whitespace() {
        let normalized = token
            .trim_matches(|character: char| {
                matches!(
                    character,
                    ',' | '.' | ':' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
                )
            })
            .replace('/', "-");
        let candidate = normalized.chars().take(10).collect::<String>();
        if candidate.len() < 10 {
            continue;
        }
        if let Ok(date) = chrono::NaiveDate::parse_from_str(&candidate, "%Y-%m-%d") {
            return date
                .and_hms_opt(0, 0, 0)
                .map(|date_time| date_time.and_utc().timestamp());
        }
    }
    None
}

fn extract_labeled_i64(text: &str, labels: &[&str]) -> Option<i64> {
    let lower = text.to_lowercase();
    for label in labels {
        if let Some(label_start) = lower.find(label) {
            let tail = &text[label_start..(label_start + 80).min(text.len())];
            for token in tail.split_whitespace() {
                let digits = token
                    .chars()
                    .filter(|character| character.is_ascii_digit())
                    .collect::<String>();
                if let Ok(value) = digits.parse::<i64>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn is_login_or_challenge_page(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("just a moment")
        || lower.contains("enable javascript and cookies")
        || lower.contains("cloudflare")
        || (lower.contains("login") && lower.contains("password"))
        || (lower.contains("登录") && lower.contains("密码"))
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
    fn parses_xnyun_v2board_traffic() {
        let subscribe = r#"{"data":{"u":2147483648,"d":3221225472,"transfer_enable":10737418240,"expired_at":1783094400,"reset_day":30,"plan":{"name":"XNYun Pro"}}}"#;
        let user = r#"{"data":{"transfer_enable":10737418240,"expired_at":1783094400}}"#;

        let snapshot = parse_v2board_traffic(
            "xnyun",
            "XNYun",
            "https://xnyun.wiki/#/dashboard",
            subscribe,
            Some(user),
            "2026-05-28T09:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.id, "xnyun");
        assert_eq!(snapshot.plan_name.as_deref(), Some("XNYun Pro"));
        assert_eq!(snapshot.used_total_bytes, Some(5368709120));
        assert_eq!(snapshot.total_bytes, Some(10737418240));
        assert_eq!(snapshot.expire_at, Some(1783094400));
        assert_eq!(snapshot.reset_day, Some(30));
        assert_eq!(snapshot.reset_at, Some(1782489600));
        assert!(!snapshot.stale);
        assert_eq!(
            snapshot.last_successful_at.as_deref(),
            Some("2026-05-28T09:00:00+08:00")
        );
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
    fn selects_xnyun_auth_data_before_legacy_token() {
        let auth = select_xnyun_auth_from_pairs(&[
            ("token", "legacy-token"),
            ("auth_data", "Bearer current-token"),
            ("cookie_auth_data", "Bearer cookie-token"),
        ]);

        assert_eq!(auth.as_deref(), Some("Bearer current-token"));
    }

    #[test]
    fn selects_xnyun_cookie_auth_data_before_legacy_token() {
        let auth = select_xnyun_auth_from_pairs(&[
            ("localStorage:token", "legacy-token"),
            ("cookie:auth_data", "Bearer cookie-token"),
        ]);

        assert_eq!(auth.as_deref(), Some("Bearer cookie-token"));
    }

    #[test]
    fn normalizes_xnyun_auth_from_json_value() {
        let auth = normalize_xnyun_auth(r#"{"token":"json-token"}"#);

        assert_eq!(auth.as_deref(), Some("json-token"));
    }

    #[test]
    fn normalizes_xnyun_percent_encoded_auth_cookie() {
        let auth = normalize_xnyun_auth("Bearer%20cookie-token");

        assert_eq!(auth.as_deref(), Some("Bearer cookie-token"));
    }

    #[test]
    fn xnyun_api_origin_uses_real_api_host() {
        assert_eq!(XNYUN_ORIGIN, "https://api.xnyun.wiki");
    }

    #[tokio::test]
    async fn fetches_first_successful_xnyun_api_candidate() {
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
        let body = fetch_first_xnyun_api_text(
            &Client::new(),
            &origins,
            &["/missing", "/api/v1/user/getStat"],
            Some("Bearer test-token"),
            Some("session=test"),
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
    }

    #[test]
    fn parses_wd_gold_product_page_text() {
        let html = r#"
          <main>
            <section>套餐名称 WD Gold Premium</section>
            <div>总流量</div><strong>100 GB</strong>
            <div>已使用流量</div><strong>37.5 GB</strong>
            <div>重置时间</div><strong>2026-06-01</strong>
          </main>
        "#;

        let snapshot = parse_wd_gold_product_details(html, "2026-05-27T18:00:00+08:00").unwrap();

        assert_eq!(snapshot.id, "wd-gold");
        assert_eq!(snapshot.name, "WD Gold");
        assert_eq!(snapshot.homepage, WD_GOLD_HOMEPAGE);
        assert_eq!(snapshot.used_total_bytes, Some(40265318400));
        assert_eq!(snapshot.total_bytes, Some(107374182400));
        assert_eq!(snapshot.remaining_bytes, Some(67108864000));
        assert_eq!(snapshot.used_ratio, Some(37.5));
        assert_eq!(snapshot.reset_at, Some(1780272000));
        assert_eq!(snapshot.error, None);
        assert!(!snapshot.stale);
    }

    #[test]
    fn parses_wd_gold_payment_time_separately_from_reset_time() {
        let html = r#"
          <main>
            <div>总流量</div><strong>100 GB</strong>
            <div>已使用流量</div><strong>37.5 GB</strong>
            <div>重置时间</div><strong>2026-06-01</strong>
            <div>到期时间</div><strong>2026-06-21</strong>
          </main>
        "#;

        let snapshot = parse_wd_gold_product_details(html, "2026-05-27T18:00:00+08:00").unwrap();

        assert_eq!(snapshot.reset_at, Some(1780272000));
        assert_eq!(snapshot.expire_at, Some(1782000000));
    }

    #[test]
    fn rejects_wd_gold_login_or_challenge_pages() {
        let html = r#"<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>"#;

        let error = parse_wd_gold_product_details(html, "2026-05-27T18:00:00+08:00").unwrap_err();

        assert!(error.to_string().contains("login or challenge page"));
    }

    #[test]
    fn returns_stale_wd_gold_snapshot_when_current_fetch_fails() {
        clear_wd_gold_cache_for_test();
        let fresh = parse_wd_gold_product_details(
            r#"
            <section>
              <span>Total Traffic</span><b>2 TB</b>
              <span>Used Traffic</span><b>512 GB</b>
              <span>Reset Date</span><b>2026-06-01</b>
            </section>
            "#,
            "2026-05-27T18:00:00+08:00",
        )
        .unwrap();
        remember_wd_gold_success(&fresh);

        let stale = wd_gold_stale_or_error(
            "2026-05-28T09:00:00+08:00",
            anyhow!("provider returned login or challenge page"),
        );

        assert_eq!(stale.id, "wd-gold");
        assert!(stale.stale);
        assert_eq!(stale.used_total_bytes, fresh.used_total_bytes);
        assert_eq!(stale.total_bytes, fresh.total_bytes);
        assert_eq!(
            stale.last_successful_at.as_deref(),
            Some("2026-05-27T18:00:00+08:00")
        );
        assert!(stale
            .error
            .as_deref()
            .unwrap()
            .contains("provider returned login or challenge page"));
        clear_wd_gold_cache_for_test();
    }

    #[test]
    fn chrome_profile_user_agent_uses_profile_last_version() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("Default");
        fs::create_dir(&profile).unwrap();
        fs::write(root.path().join("Last Version"), "148.0.7778.178\n").unwrap();

        let user_agent = chrome_profile_user_agent(&profile);

        assert!(user_agent.contains("Chrome/148.0.7778.178 "));
    }

    #[test]
    fn extracts_wd_red_subscription_url_from_chrome_session_text() {
        let text = "https://api.wd-red.com/sub?target=surge&url=https%3A%2F%2Fwd-red.com%2Fsubscribe%2Fabc-123_X&emoji=true";

        let urls = extract_wd_red_subscription_urls_from_text(text);

        assert_eq!(urls, vec!["https://wd-red.com/subscribe/abc-123_X"]);
    }

    #[test]
    fn parses_wd_subscription_userinfo_header() {
        let info = parse_wd_subscription_userinfo(
            "upload=1317600046; download=15225664223; total=214748364800; expire=1781971200",
        )
        .unwrap();

        assert_eq!(
            info,
            WdSubscriptionUserInfo {
                upload: 1317600046,
                download: 15225664223,
                total: 214748364800,
                expire: Some(1781971200)
            }
        );
    }

    #[test]
    fn builds_wd_gold_snapshot_from_subscription_userinfo() {
        let info = WdSubscriptionUserInfo {
            upload: 1000,
            download: 3000,
            total: 10_000,
            expire: Some(1781971200),
        };

        let snapshot = build_wd_subscription_snapshot(&info, "2026-05-28T13:00:00+08:00").unwrap();

        assert_eq!(snapshot.used_upload_bytes, Some(1000));
        assert_eq!(snapshot.used_download_bytes, Some(3000));
        assert_eq!(snapshot.used_total_bytes, Some(4000));
        assert_eq!(snapshot.total_bytes, Some(10_000));
        assert_eq!(snapshot.remaining_bytes, Some(6000));
        assert_eq!(snapshot.used_ratio, Some(40.0));
        assert_eq!(snapshot.expire_at, Some(1781971200));
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
        assert_eq!(response.providers[0].id, "wd-gold");
        assert_eq!(response.providers[1].id, "xnyun");
    }

    #[test]
    fn chrome_profile_path_keeps_empty_value_unconfigured() {
        assert!(chrome_profile_path("  ").as_os_str().is_empty());
    }
}
