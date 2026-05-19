#[cfg(unix)]
use std::os::unix::{fs::MetadataExt, process::CommandExt};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use aes::Aes128;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use reqwest::{header, Client};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use rusty_leveldb::{LdbIterator, Options as LevelDbOptions, DB};
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};

const WMSXWD_HOMEPAGE: &str = "https://2.wmsxwd-3.men/app.html#/dashboard";
const WMSXWD_ORIGIN: &str = "https://2.wmsxwd-3.men";
const HAITA_HOMEPAGE: &str = "https://haita.io/dashboard";
const HAITA_ORIGIN: &str = "https://haita.io";
const WMSXWD_API_KEY: &str = "51b056910a4fd60d";
const WMSXWD_API_BASES: &[&str] = &[
    "https://z01.111285.xyz",
    "https://z01.themeapi.men",
    "https://z02.111285.xyz",
    "https://z03.111285.xyz",
    "https://z02.themeapi.men",
    "https://z03.themeapi.men",
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
        fetch_haita(http, profile, &fetched_at).await,
        fetch_wmsxwd(http, profile, &fetched_at).await,
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

pub fn parse_haita_dashboard(html: &str, fetched_at: &str) -> Result<TrafficSnapshot> {
    let subinfo = extract_js_assignment(html, "subinfo")?;
    build_snapshot(
        "haita",
        "Haita",
        "https://haita.io/dashboard",
        &subinfo,
        None,
        fetched_at,
    )
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

async fn fetch_haita(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result = async {
        let auth = read_haita_auth(profile)?;
        let html = fetch_text(
            http.get(HAITA_HOMEPAGE)
                .header(header::COOKIE, format!("auth={auth}; lang=zh-cn"))
                .header(header::USER_AGENT, user_agent()),
        )
        .await?;
        parse_haita_dashboard(&html, fetched_at)
    }
    .await;

    result
        .unwrap_or_else(|error| provider_error("haita", "Haita", HAITA_HOMEPAGE, fetched_at, error))
}

fn read_haita_auth(profile: &Path) -> Result<String> {
    select_haita_auth(read_chrome_cookie(profile, "haita.io", "auth"), || {
        read_chrome_local_storage(profile, HAITA_ORIGIN, "token")
    })
}

fn select_haita_auth(
    cookie_auth: Result<String>,
    local_storage_auth: impl FnOnce() -> Result<String>,
) -> Result<String> {
    match cookie_auth {
        Ok(auth) => Ok(auth),
        Err(cookie_error) => local_storage_auth()
            .with_context(|| format!("Chrome cookie auth unavailable: {cookie_error}")),
    }
}

async fn fetch_wmsxwd(http: &Client, profile: &Path, fetched_at: &str) -> TrafficSnapshot {
    let result = match fetch_wmsxwd_current(http, profile, fetched_at).await {
        Ok(snapshot) => Ok(snapshot),
        Err(current_error) => fetch_wmsxwd_legacy(http, profile, fetched_at)
            .await
            .with_context(|| format!("current API failed: {current_error}")),
    };

    result.unwrap_or_else(|error| {
        provider_error("wmsxwd", "wmsxwd", WMSXWD_HOMEPAGE, fetched_at, error)
    })
}

async fn fetch_wmsxwd_current(
    http: &Client,
    profile: &Path,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let token = read_chrome_local_storage(profile, WMSXWD_ORIGIN, "WM_token")?;
    let iv = read_chrome_local_storage(profile, WMSXWD_ORIGIN, "temp_iv")?;
    let subscribe = fetch_wmsxwd_current_text(http, "/user/getSubscribe", &token, &iv).await?;
    let user = fetch_wmsxwd_current_text(http, "/user/info", &token, &iv).await?;

    parse_v2board_traffic(
        "wmsxwd",
        "wmsxwd",
        WMSXWD_HOMEPAGE,
        &subscribe,
        Some(&user),
        fetched_at,
    )
}

async fn fetch_wmsxwd_legacy(
    http: &Client,
    profile: &Path,
    fetched_at: &str,
) -> Result<TrafficSnapshot> {
    let token = read_chrome_cookie(profile, "wmsxwd-3.men", "vue_admin_template_token")?;
    let subscribe = fetch_text(
        http.get("https://wmsxwd-1.men/api/v1/user/getSubscribe")
            .header(header::AUTHORIZATION, token.as_str())
            .header(header::USER_AGENT, user_agent()),
    )
    .await?;
    let user = fetch_text(
        http.get("https://wmsxwd-1.men/api/v1/user/info")
            .header(header::AUTHORIZATION, token.as_str())
            .header(header::USER_AGENT, user_agent()),
    )
    .await?;

    parse_v2board_traffic(
        "wmsxwd",
        "wmsxwd",
        WMSXWD_HOMEPAGE,
        &subscribe,
        Some(&user),
        fetched_at,
    )
}

async fn fetch_wmsxwd_current_text(
    http: &Client,
    raw_path: &str,
    token: &str,
    iv: &str,
) -> Result<String> {
    let api_path = build_wmsxwd_api_path(raw_path, iv)?;
    let mut errors = Vec::new();
    for base in WMSXWD_API_BASES {
        let url = format!("{base}{api_path}");
        let request = http
            .get(url)
            .header(header::AUTHORIZATION, token)
            .header(header::ACCEPT, "application/json, text/plain, */*")
            .header(header::USER_AGENT, user_agent())
            .header("X-IV", iv);

        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let body = response.text().await?;
                ensure_provider_json_success(&body)?;
                return Ok(body);
            }
            Ok(response) => errors.push(format!("{base} returned HTTP {}", response.status())),
            Err(error) => errors.push(format!("{base} request failed: {error}")),
        }
    }

    Err(anyhow!(
        "wmsxwd current API failed for {raw_path}: {}",
        errors.join("; ")
    ))
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
        fetched_at: fetched_at.to_string(),
        error: Some(error.to_string()),
    }
}

fn user_agent() -> &'static str {
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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

fn build_wmsxwd_api_path(raw_path: &str, iv: &str) -> Result<String> {
    type Aes128CbcEnc = cbc::Encryptor<Aes128>;

    let mut buffer = raw_path.as_bytes().to_vec();
    let message_len = buffer.len();
    buffer.resize(message_len + 16, 0);
    let encrypted = Aes128CbcEnc::new_from_slices(WMSXWD_API_KEY.as_bytes(), iv.as_bytes())
        .map_err(|error| anyhow!("invalid wmsxwd API key/iv: {error}"))?
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, message_len)
        .map_err(|error| anyhow!("wmsxwd API path encrypt failed: {error}"))?;
    let inner = BASE64.encode(encrypted);
    Ok(format!("/api/{}", BASE64.encode(inner.as_bytes())))
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
        reset_day: read_i64(subscribe_data, "reset_day"),
        fetched_at: fetched_at.to_string(),
        error: None,
    })
}

fn extract_js_assignment(html: &str, name: &str) -> Result<Value> {
    let marker = format!("var {name} = ");
    let start = html
        .find(&marker)
        .ok_or_else(|| anyhow!("{name} assignment not found"))?
        + marker.len();
    let tail = &html[start..];
    let end = tail
        .find(";\n")
        .or_else(|| tail.find(';'))
        .ok_or_else(|| anyhow!("{name} assignment is not terminated"))?;
    serde_json::from_str(tail[..end].trim()).with_context(|| format!("invalid {name} JSON"))
}

fn read_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|item| item.as_i64())
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

    #[test]
    fn parses_haita_dashboard_embedded_subinfo() {
        let html = r#"
          <script>
            var subinfo = {"data":{"u":1024,"d":2048,"transfer_enable":8192,"expired_at":1779595946,"reset_day":17,"plan":{"name":"Basic Connect"}}};
          </script>
        "#;

        let snapshot = parse_haita_dashboard(html, "2026-05-07T16:00:00+08:00").unwrap();

        assert_eq!(snapshot.id, "haita");
        assert_eq!(snapshot.plan_name.as_deref(), Some("Basic Connect"));
        assert_eq!(snapshot.used_upload_bytes, Some(1024));
        assert_eq!(snapshot.used_download_bytes, Some(2048));
        assert_eq!(snapshot.used_total_bytes, Some(3072));
        assert_eq!(snapshot.total_bytes, Some(8192));
        assert_eq!(snapshot.remaining_bytes, Some(5120));
        assert_eq!(snapshot.used_ratio, Some(37.5));
        assert_eq!(snapshot.expire_at, Some(1779595946));
        assert_eq!(snapshot.reset_day, Some(17));
        assert_eq!(snapshot.error, None);
    }

    #[test]
    fn parses_v2board_subscribe_and_user_json() {
        let subscribe = r#"{"data":{"u":4096,"d":8192,"transfer_enable":32768,"expired_at":1779595946,"reset_day":24,"plan":{"name":"Pro"}}}"#;
        let user = r#"{"data":{"transfer_enable":65536,"expired_at":1779680000}}"#;

        let snapshot = parse_v2board_traffic(
            "wmsxwd",
            "wmsxwd",
            "https://2.wmsxwd-3.men/app.html#/dashboard",
            subscribe,
            Some(user),
            "2026-05-07T16:00:00+08:00",
        )
        .unwrap();

        assert_eq!(snapshot.id, "wmsxwd");
        assert_eq!(snapshot.plan_name.as_deref(), Some("Pro"));
        assert_eq!(snapshot.used_upload_bytes, Some(4096));
        assert_eq!(snapshot.used_download_bytes, Some(8192));
        assert_eq!(snapshot.used_total_bytes, Some(12288));
        assert_eq!(snapshot.total_bytes, Some(65536));
        assert_eq!(snapshot.remaining_bytes, Some(53248));
        assert_eq!(snapshot.used_ratio, Some(18.8));
        assert_eq!(snapshot.expire_at, Some(1779680000));
        assert_eq!(snapshot.reset_day, Some(24));
        assert_eq!(snapshot.error, None);
    }

    #[test]
    fn decrypts_chrome_linux_cookie_and_strips_host_digest() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        let secret = b"test chrome safe storage";
        let host = "haita.io";
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
        let host = "haita.io";
        let value = b"haita-auth-cookie";
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

        assert_eq!(decrypted, "haita-auth-cookie");
    }

    #[test]
    fn decrypts_chrome_linux_cookie_with_base64_secret_candidate() {
        type Aes128CbcEnc = cbc::Encryptor<Aes128>;

        let decoded_secret = b"1234567890abcdef";
        let encoded_secret = BASE64.encode(decoded_secret);
        let host = "haita.io";
        let value = b"haita-auth-cookie";
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

        assert_eq!(decrypted, "haita-auth-cookie");
    }

    #[test]
    fn haita_auth_falls_back_to_local_storage_token_when_cookie_fails() {
        let auth = select_haita_auth(Err(anyhow!("cookie not found for haita.io/auth")), || {
            Ok("local-storage-token".to_string())
        })
        .unwrap();

        assert_eq!(auth, "local-storage-token");
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
    fn builds_current_wmsxwd_encrypted_api_path() {
        let iv = "9529406f3be9509b";

        assert_eq!(
            build_wmsxwd_api_path("/user/getSubscribe", iv).unwrap(),
            "/api/UHZBMWgxU0pNN2hlU3djS1FBeGRpc09NUWJVYU9xMVNlY1BtVW9mZjZvWT0="
        );
        assert_eq!(
            build_wmsxwd_api_path("/user/info", iv).unwrap(),
            "/api/c2Z2S284emdvK2N4cTR1eEkvNnhPdz09"
        );
    }

    #[test]
    fn decodes_chrome_local_storage_key_and_utf8_value() {
        let key = chrome_local_storage_key("https://2.wmsxwd-3.men", "WM_token");

        assert_eq!(key, b"_https://2.wmsxwd-3.men\0\x01WM_token".to_vec());
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
    }

    #[test]
    fn chrome_profile_path_keeps_empty_value_unconfigured() {
        assert!(chrome_profile_path("  ").as_os_str().is_empty());
    }
}
