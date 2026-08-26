use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use chrono::Local;
use reqwest::{
    cookie::Jar,
    header::{self, HeaderValue},
    redirect::Policy,
    Client, StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
pub const GEMINI_GROUP_NAME: &str = "gemini-us";
pub const GEMINI_HOST: &str = "gemini.google.com";
pub const GEMINI_LOCATION_SOURCE: &str = "SWML_DESCRIPTION_FROM_YOUR_INTERNET_ADDRESS";

pub(crate) const GEMINI_APP_URL: &str = "https://gemini.google.com/app";
pub(crate) const GEMINI_BATCH_URL: &str =
    "https://gemini.google.com/_/BardChatUi/data/batchexecute";
const GEMINI_LOCATION_RPC_ID: &str = "K4WWud";
const GEMINI_AUTHENTICATED_FORM: &str = r#"[[["K4WWud","[[1],[\"zh-CN\"]]",null,"generic"]]]"#;
const GEMINI_ACCEPT_LANGUAGE: &str = "en,zh-CN;q=0.9,zh;q=0.8";
const WIZ_GLOBAL_DATA_MARKER: &str = "window.WIZ_global_data";
const GOOGLE_ACCOUNT_SESSION_COOKIES: [&str; 3] = ["SID", "__Secure-1PSID", "__Secure-3PSID"];

static GEMINI_REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeminiLocationStatus {
    Success,
    AntiAbuseChallenge,
    AuthError,
    RoutingError,
    TransportError,
    HttpError,
    ParseError,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeminiAuthMode {
    Anonymous,
    Chrome,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeminiLocationResult {
    pub status: GeminiLocationStatus,
    pub label: Option<String>,
    pub source: Option<String>,
    pub auth_mode: GeminiAuthMode,
    pub tested_at: String,
    pub error: Option<String>,
}

impl GeminiLocationResult {
    pub fn success(payload: GeminiLocationPayload, auth_mode: GeminiAuthMode) -> Self {
        Self {
            status: GeminiLocationStatus::Success,
            label: Some(payload.label),
            source: Some(payload.source),
            auth_mode,
            tested_at: Local::now().to_rfc3339(),
            error: None,
        }
    }

    pub fn failure(
        status: GeminiLocationStatus,
        auth_mode: GeminiAuthMode,
        error: impl Into<String>,
    ) -> Self {
        Self {
            status,
            label: None,
            source: None,
            auth_mode,
            tested_at: Local::now().to_rfc3339(),
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiLocationPayload {
    pub label: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeminiSessionParameters {
    at: String,
    f_sid: String,
    bl: String,
}

pub(crate) async fn query_authenticated_location_at_urls(
    timeout_ms: i64,
    cookie_header: &str,
    user_agent: &str,
    app_url: &str,
    batch_url: &str,
) -> GeminiLocationResult {
    if let Err(error) = validate_chrome_session(cookie_header, user_agent) {
        return GeminiLocationResult::failure(
            GeminiLocationStatus::AuthError,
            GeminiAuthMode::Chrome,
            error.to_string(),
        );
    }

    let app_url = match Url::parse(app_url) {
        Ok(url) => url,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                format!("invalid Gemini app URL: {error}"),
            )
        }
    };
    let batch_url = match Url::parse(batch_url) {
        Ok(url) => url,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                format!("invalid Gemini batch URL: {error}"),
            )
        }
    };
    let client = match build_authenticated_client(timeout_ms, cookie_header, &app_url) {
        Ok(client) => client,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                error.to_string(),
            )
        }
    };

    let bootstrap = match client
        .get(app_url.clone())
        .header(
            header::ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(header::ACCEPT_LANGUAGE, GEMINI_ACCEPT_LANGUAGE)
        .header(header::USER_AGENT, user_agent)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                safe_request_error("load authenticated Gemini session", error),
            )
        }
    };
    let bootstrap_status = bootstrap.status();
    let bootstrap_redirect = bootstrap
        .headers()
        .get(header::LOCATION)
        .and_then(header_value_to_str);
    if is_anti_abuse_challenge(bootstrap_status, bootstrap_redirect) {
        return anti_abuse_result("Gemini session bootstrap");
    }
    if is_google_sign_in_redirect(bootstrap_status, bootstrap_redirect) {
        return GeminiLocationResult::failure(
            GeminiLocationStatus::AuthError,
            GeminiAuthMode::Chrome,
            "Chrome Google login is unavailable or expired; Gemini redirected to Google sign-in",
        );
    }
    if !bootstrap_status.is_success() {
        return GeminiLocationResult::failure(
            GeminiLocationStatus::HttpError,
            GeminiAuthMode::Chrome,
            format!("Gemini session bootstrap returned HTTP {bootstrap_status}"),
        );
    }
    let bootstrap_body = match bootstrap.text().await {
        Ok(body) => body,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                safe_request_error("read authenticated Gemini session", error),
            )
        }
    };
    let session = match parse_session_parameters(&bootstrap_body) {
        Ok(session) => session,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::ParseError,
                GeminiAuthMode::Chrome,
                format!("parse authenticated Gemini session: {error}"),
            )
        }
    };

    let origin = request_origin(&app_url);
    let referer = format!("{origin}/");
    let request_id = next_request_id();
    let response = match client
        .post(batch_url)
        .query(&[
            ("rpcids", GEMINI_LOCATION_RPC_ID),
            ("source-path", "/app"),
            ("bl", session.bl.as_str()),
            ("f.sid", session.f_sid.as_str()),
            ("hl", "zh-CN"),
            ("_reqid", request_id.as_str()),
            ("rt", "c"),
        ])
        .header(header::ACCEPT, "*/*")
        .header(header::ACCEPT_LANGUAGE, GEMINI_ACCEPT_LANGUAGE)
        .header(header::ORIGIN, &origin)
        .header(header::REFERER, &referer)
        .header(header::USER_AGENT, user_agent)
        .header("x-same-domain", "1")
        .form(&[
            ("f.req", GEMINI_AUTHENTICATED_FORM),
            ("at", session.at.as_str()),
        ])
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                safe_request_error("send authenticated Gemini location request", error),
            )
        }
    };
    parse_location_response(response).await
}

pub(crate) fn validate_chrome_session(cookie_header: &str, user_agent: &str) -> Result<()> {
    if user_agent.trim().is_empty() {
        return Err(anyhow!("Chrome user agent is unavailable"));
    }
    let cookie_names = cookie_header.split(';').filter_map(|pair| {
        pair.trim()
            .split_once('=')
            .map(|(name, _)| name.trim())
            .filter(|name| !name.is_empty())
    });
    if !cookie_names
        .into_iter()
        .any(|name| GOOGLE_ACCOUNT_SESSION_COOKIES.contains(&name))
    {
        return Err(anyhow!(
            "Chrome Google account session cookies are missing; sign in to Google with the configured Chrome profile"
        ));
    }
    Ok(())
}

fn build_authenticated_client(
    timeout_ms: i64,
    cookie_header: &str,
    app_url: &Url,
) -> Result<Client> {
    let jar = Jar::default();
    let secure_attribute = if app_url.scheme() == "https" {
        "; Secure"
    } else {
        ""
    };
    for cookie in cookie_header
        .split(';')
        .map(str::trim)
        .filter(|cookie| cookie.contains('='))
    {
        jar.add_cookie_str(&format!("{cookie}; Path=/{secure_attribute}"), app_url);
    }
    let timeout_ms = timeout_ms.max(1) as u64;
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(Policy::none())
        .pool_max_idle_per_host(0)
        .cookie_provider(Arc::new(jar))
        .build()
        .context("build authenticated Gemini HTTP client")
}

fn parse_session_parameters(html: &str) -> Result<GeminiSessionParameters> {
    let marker_offset = html
        .find(WIZ_GLOBAL_DATA_MARKER)
        .ok_or_else(|| anyhow!("WIZ_global_data marker not found"))?;
    let object_start = html[marker_offset..]
        .find('{')
        .map(|offset| marker_offset + offset)
        .ok_or_else(|| anyhow!("WIZ_global_data JSON object not found"))?;
    let object_end = find_json_object_end(html, object_start)
        .ok_or_else(|| anyhow!("WIZ_global_data JSON object is incomplete"))?;
    let data = serde_json::from_str::<Value>(&html[object_start..object_end])
        .context("decode WIZ_global_data JSON")?;
    Ok(GeminiSessionParameters {
        at: required_session_string(&data, "SNlM0e")?,
        f_sid: required_session_string(&data, "FdrFJe")?,
        bl: required_session_string(&data, "cfb2h")?,
    })
}

fn find_json_object_end(input: &str, object_start: usize) -> Option<usize> {
    let mut depth = 0_u32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in input[object_start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(object_start + offset + character.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn required_session_string(data: &Value, key: &str) -> Result<String> {
    data.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow!("WIZ_global_data field {key} is missing"))
}

fn request_origin(url: &Url) -> String {
    let host = url.host_str().unwrap_or(GEMINI_HOST);
    match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    }
}

fn next_request_id() -> String {
    let sequence = GEMINI_REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let timestamp = chrono::Utc::now().timestamp_millis().unsigned_abs();
    (((timestamp + sequence) % 9_000_000) + 1_000_000).to_string()
}

fn safe_request_error(context: &str, error: reqwest::Error) -> String {
    format!("{context}: {}", error.without_url())
}

fn is_google_sign_in_redirect(status: StatusCode, location: Option<&str>) -> bool {
    status.is_redirection()
        && location
            .map(|value| {
                value.contains("accounts.google.com")
                    || value.contains("/ServiceLogin")
                    || value.contains("/signin/")
            })
            .unwrap_or(false)
}

fn anti_abuse_result(stage: &str) -> GeminiLocationResult {
    GeminiLocationResult::failure(
        GeminiLocationStatus::AntiAbuseChallenge,
        GeminiAuthMode::Chrome,
        format!(
            "{stage} was redirected to Google /sorry/ anti-abuse challenge; Google did not disclose the matched rule"
        ),
    )
}

async fn parse_location_response(response: reqwest::Response) -> GeminiLocationResult {
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(header_value_to_str)
        .unwrap_or("unknown")
        .to_string();
    let content_encoding = response
        .headers()
        .get(header::CONTENT_ENCODING)
        .and_then(header_value_to_str)
        .unwrap_or("identity")
        .to_string();
    let content_length = response.content_length();
    let redirect_location = response
        .headers()
        .get(header::LOCATION)
        .and_then(header_value_to_str);
    if is_anti_abuse_challenge(status, redirect_location) {
        return anti_abuse_result("Authenticated Gemini location request");
    }
    if is_google_sign_in_redirect(status, redirect_location) {
        return GeminiLocationResult::failure(
            GeminiLocationStatus::AuthError,
            GeminiAuthMode::Chrome,
            "Chrome Google login is unavailable or expired; Gemini redirected to Google sign-in",
        );
    }
    if !status.is_success() {
        return GeminiLocationResult::failure(
            GeminiLocationStatus::HttpError,
            GeminiAuthMode::Chrome,
            format!("Gemini location returned HTTP {status}"),
        );
    }
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return GeminiLocationResult::failure(
                GeminiLocationStatus::TransportError,
                GeminiAuthMode::Chrome,
                format!(
                    "{} (HTTP {status}, content-type={content_type}, content-encoding={content_encoding}, content-length={content_length:?})",
                    safe_request_error("read authenticated Gemini location response", error)
                ),
            )
        }
    };
    let body_bytes = body.len();
    match parse_batchexecute(&body) {
        Ok(payload) => GeminiLocationResult::success(payload, GeminiAuthMode::Chrome),
        Err(error) => GeminiLocationResult::failure(
            GeminiLocationStatus::ParseError,
            GeminiAuthMode::Chrome,
            format!(
                "parse Gemini location response: {error} (HTTP {status}, content-type={content_type}, content-encoding={content_encoding}, body-bytes={body_bytes})"
            ),
        ),
    }
}

fn header_value_to_str(value: &HeaderValue) -> Option<&str> {
    value.to_str().ok()
}

fn is_anti_abuse_challenge(status: StatusCode, location: Option<&str>) -> bool {
    status.is_redirection()
        && location
            .map(|value| value.contains("google.com/sorry/") || value.contains("/sorry/"))
            .unwrap_or(false)
}

pub fn parse_batchexecute(body: &str) -> Result<GeminiLocationPayload> {
    let body = body
        .strip_prefix(")]}'")
        .unwrap_or(body)
        .trim_start_matches(['\r', '\n']);

    for line in body.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.bytes().all(|byte| byte.is_ascii_digit()) || !line.starts_with('[') {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(payload) = find_location_payload(&frame)? {
            return Ok(payload);
        }
    }

    Err(anyhow!("{GEMINI_LOCATION_RPC_ID} payload not found"))
}

fn find_location_payload(value: &Value) -> Result<Option<GeminiLocationPayload>> {
    let Some(items) = value.as_array() else {
        return Ok(None);
    };
    if items.len() >= 3
        && items.first().and_then(Value::as_str) == Some("wrb.fr")
        && items.get(1).and_then(Value::as_str) == Some(GEMINI_LOCATION_RPC_ID)
    {
        let encoded_value = items
            .get(2)
            .ok_or_else(|| anyhow!("{GEMINI_LOCATION_RPC_ID} result is missing"))?;
        let encoded = encoded_value.as_str().ok_or_else(|| {
            anyhow!(
                "{GEMINI_LOCATION_RPC_ID} result has JSON type {} instead of string",
                json_value_kind(encoded_value)
            )
        })?;
        let payload = serde_json::from_str::<Value>(encoded)
            .context("decode nested Gemini location payload")?;
        return parse_location_row(&payload).map(Some);
    }

    for item in items {
        if let Some(payload) = find_location_payload(item)? {
            return Ok(Some(payload));
        }
    }
    Ok(None)
}

fn json_value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn parse_location_row(payload: &Value) -> Result<GeminiLocationPayload> {
    let row = payload
        .as_array()
        .and_then(|rows| rows.first())
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Gemini location row is missing"))?;
    let label = row
        .first()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Gemini location label is missing"))?;
    let source = row
        .get(1)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Gemini location source is missing"))?;
    if source != GEMINI_LOCATION_SOURCE {
        return Err(anyhow!("unexpected Gemini location source: {source}"));
    }

    Ok(GeminiLocationPayload {
        label: label.to_string(),
        source: source.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn parses_location_labels_with_variable_granularity() {
        for label in ["美国", "美国加利福尼亚", "美国加利福尼亚洛杉矶"] {
            let response = location_response(label, GEMINI_LOCATION_SOURCE);

            let payload = parse_batchexecute(&response).unwrap();

            assert_eq!(payload.label, label);
            assert_eq!(payload.source, GEMINI_LOCATION_SOURCE);
        }
    }

    #[test]
    fn rejects_missing_rpc_and_unexpected_source() {
        let missing = r#")]}'

25
[["e",4,null,null,473]]
"#;
        assert!(parse_batchexecute(missing)
            .unwrap_err()
            .to_string()
            .contains("K4WWud payload not found"));

        let unexpected = location_response("美国", "UNKNOWN_SOURCE");
        assert!(parse_batchexecute(&unexpected)
            .unwrap_err()
            .to_string()
            .contains("unexpected Gemini location source"));
    }

    #[test]
    fn reports_the_actual_k4wwud_result_type() {
        let response = r#")]}'

48
[["wrb.fr","K4WWud",null,null,null,null,"generic"]]
"#;

        let error = parse_batchexecute(response).unwrap_err().to_string();

        assert!(error.contains("K4WWud result has JSON type null instead of string"));
    }

    #[test]
    fn authenticated_form_matches_observed_k4wwud_arguments() {
        let envelope = serde_json::from_str::<Value>(GEMINI_AUTHENTICATED_FORM).unwrap();
        let arguments = envelope
            .get(0)
            .and_then(|batch| batch.get(0))
            .and_then(|call| call.get(1))
            .and_then(Value::as_str)
            .unwrap();

        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            serde_json::json!([[1], ["zh-CN"]])
        );
    }

    #[test]
    fn parses_authenticated_session_parameters_from_wiz_bootstrap() {
        let session = parse_session_parameters(&bootstrap_html()).unwrap();

        assert_eq!(session.at, "at-test-secret");
        assert_eq!(session.f_sid, "-123456789");
        assert_eq!(session.bl, "boq-test-build");
    }

    #[tokio::test]
    async fn sends_authenticated_bootstrap_and_complete_location_request() {
        let (base_url, captured) = spawn_http_sequence(vec![
            StubResponse {
                status: "200 OK",
                headers: vec![
                    "content-type: text/html; charset=utf-8",
                    "set-cookie: COMPASS=bootstrap-cookie; Path=/",
                ],
                body: bootstrap_html(),
            },
            StubResponse {
                status: "200 OK",
                headers: vec!["content-type: application/json; charset=utf-8"],
                body: location_response("美国加利福尼亚洛杉矶", GEMINI_LOCATION_SOURCE),
            },
        ])
        .await;

        let result = query_authenticated_location_at_urls(
            2_000,
            "SID=account-session; NID=browser-cookie",
            "chrome-test/1.0",
            &format!("{base_url}/app"),
            &format!("{base_url}/rpc"),
        )
        .await;

        assert_eq!(result.status, GeminiLocationStatus::Success);
        assert_eq!(result.auth_mode, GeminiAuthMode::Chrome);
        assert_eq!(result.label.as_deref(), Some("美国加利福尼亚洛杉矶"));
        let requests = captured.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let bootstrap_request = requests[0].to_ascii_lowercase();
        assert!(bootstrap_request.starts_with("get /app http/1.1"));
        assert!(bootstrap_request.contains("user-agent: chrome-test/1.0"));
        assert!(bootstrap_request.contains("sid=account-session"));

        let rpc_request = &requests[1];
        let rpc_request_lower = rpc_request.to_ascii_lowercase();
        assert!(rpc_request_lower.starts_with("post /rpc?"));
        assert!(rpc_request_lower.contains("content-type: application/x-www-form-urlencoded"));
        assert!(rpc_request_lower.contains("origin: http://127.0.0.1:"));
        assert!(rpc_request_lower.contains("x-same-domain: 1"));
        assert!(rpc_request_lower.contains("sid=account-session"));
        assert!(rpc_request_lower.contains("compass=bootstrap-cookie"));

        let target = rpc_request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let parsed_target = Url::parse(&format!("http://test{target}")).unwrap();
        let query = parsed_target
            .query_pairs()
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query.get("rpcids").map(String::as_str), Some("K4WWud"));
        assert_eq!(query.get("source-path").map(String::as_str), Some("/app"));
        assert_eq!(query.get("bl").map(String::as_str), Some("boq-test-build"));
        assert_eq!(query.get("f.sid").map(String::as_str), Some("-123456789"));
        assert_eq!(query.get("hl").map(String::as_str), Some("zh-CN"));
        assert_eq!(query.get("rt").map(String::as_str), Some("c"));
        assert!(query.get("_reqid").is_some_and(
            |value| value.len() == 7 && value.bytes().all(|byte| byte.is_ascii_digit())
        ));

        let form_body = rpc_request.split_once("\r\n\r\n").unwrap().1;
        let parsed_form = Url::parse(&format!("http://test/?{form_body}")).unwrap();
        let form = parsed_form
            .query_pairs()
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            form.get("f.req").map(String::as_str),
            Some(r#"[[["K4WWud","[[1],[\"zh-CN\"]]",null,"generic"]]]"#)
        );
        assert_eq!(form.get("at").map(String::as_str), Some("at-test-secret"));
    }

    #[tokio::test]
    async fn rejects_missing_google_account_session_without_network_request() {
        let result = query_authenticated_location_at_urls(
            2_000,
            "NID=anonymous-cookie",
            "chrome-test/1.0",
            "http://127.0.0.1:1/app",
            "http://127.0.0.1:1/rpc",
        )
        .await;

        assert_eq!(result.status, GeminiLocationStatus::AuthError);
        assert_eq!(result.auth_mode, GeminiAuthMode::Chrome);
        assert!(result
            .error
            .unwrap()
            .contains("account session cookies are missing"));
    }

    #[tokio::test]
    async fn classifies_authenticated_bootstrap_sorry_without_posting_rpc() {
        let (base_url, captured) = spawn_http_sequence(vec![StubResponse {
            status: "302 Found",
            headers: vec!["location: https://www.google.com/sorry/index?continue=test"],
            body: String::new(),
        }])
        .await;

        let result = query_authenticated_location_at_urls(
            2_000,
            "SID=account-session",
            "chrome-test/1.0",
            &format!("{base_url}/app"),
            &format!("{base_url}/rpc"),
        )
        .await;

        assert_eq!(result.status, GeminiLocationStatus::AntiAbuseChallenge);
        assert_eq!(result.auth_mode, GeminiAuthMode::Chrome);
        assert_eq!(captured.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn classifies_google_sign_in_redirect_as_auth_error() {
        let (base_url, captured) = spawn_http_sequence(vec![StubResponse {
            status: "302 Found",
            headers: vec!["location: https://accounts.google.com/ServiceLogin?continue=test"],
            body: String::new(),
        }])
        .await;

        let result = query_authenticated_location_at_urls(
            2_000,
            "SID=account-session",
            "chrome-test/1.0",
            &format!("{base_url}/app"),
            &format!("{base_url}/rpc"),
        )
        .await;

        assert_eq!(result.status, GeminiLocationStatus::AuthError);
        assert_eq!(result.auth_mode, GeminiAuthMode::Chrome);
        assert_eq!(captured.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn transport_errors_do_not_disclose_dynamic_session_values() {
        let (base_url, _) = spawn_http_sequence(vec![StubResponse {
            status: "200 OK",
            headers: vec!["content-type: text/html; charset=utf-8"],
            body: bootstrap_html(),
        }])
        .await;

        let result = query_authenticated_location_at_urls(
            2_000,
            "SID=account-session",
            "chrome-test/1.0",
            &format!("{base_url}/app"),
            &format!("{base_url}/rpc"),
        )
        .await;

        assert_eq!(result.status, GeminiLocationStatus::TransportError);
        let error = result.error.unwrap();
        assert!(!error.contains("at-test-secret"));
        assert!(!error.contains("-123456789"));
        assert!(!error.contains("boq-test-build"));
    }

    fn location_response(label: &str, source: &str) -> String {
        let nested = serde_json::json!([[label, source, false, null, "//maps.test/token"]]);
        let frame = serde_json::json!([[
            "wrb.fr",
            "K4WWud",
            nested.to_string(),
            null,
            null,
            null,
            "generic"
        ]])
        .to_string();
        format!(
            ")]}}'\n\n{}\n{}\n25\n[[\"e\",4,null,null,473]]\n",
            frame.chars().count() + 2,
            frame
        )
    }

    fn bootstrap_html() -> String {
        r#"<!doctype html><script>window.WIZ_global_data = {"SNlM0e":"at-test-secret","nested":{"brace":"}"},"FdrFJe":"-123456789","cfb2h":"boq-test-build"};</script>"#.to_string()
    }

    struct StubResponse {
        status: &'static str,
        headers: Vec<&'static str>,
        body: String,
    }

    async fn spawn_http_sequence(
        responses: Vec<StubResponse>,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let captured = Arc::new(Mutex::new(Vec::new()));
        let captured_requests = captured.clone();
        tokio::spawn(async move {
            for stub in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut stream).await;
                captured_requests.lock().unwrap().push(request);
                let mut response = format!(
                    "HTTP/1.1 {}\r\ncontent-length: {}\r\nconnection: close\r\n",
                    stub.status,
                    stub.body.len()
                );
                for header in stub.headers {
                    response.push_str(header);
                    response.push_str("\r\n");
                }
                response.push_str("\r\n");
                response.push_str(&stub.body);
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (format!("http://{addr}"), captured)
    }

    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4_096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n")
            else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8_lossy(&request).to_string()
    }
}
