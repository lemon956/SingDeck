use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{header::{HeaderName, HeaderValue}, Client, Proxy, Url};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

pub const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_PREVIEW_BYTES: usize = 512 * 1024;
pub const DEFAULT_HTTP_TOOL_TIMEOUT_MS: i64 = 30_000;
pub const MIN_HTTP_TOOL_TIMEOUT_MS: i64 = 1_000;
pub const MAX_HTTP_TOOL_TIMEOUT_MS: i64 = 120_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HttpInputKind {
    Url,
    RawHttp,
    Curl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedHttpRequest {
    pub input_kind: HttpInputKind,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolsSettings {
    pub proxy_url: String,
    #[serde(default = "default_http_tool_timeout_ms")]
    pub timeout_ms: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RouteMode {
    Direct,
    Proxy,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpExecuteRequest {
    pub input: String,
    pub route_mode: RouteMode,
    pub proxy_url: Option<String>,
    pub timeout_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedHttpRequestView {
    pub input_kind: HttpInputKind,
    pub method: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub body_bytes: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseView {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HttpHeader>,
    pub body_preview: String,
    pub body_bytes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedConnection {
    pub id: String,
    pub target: String,
    pub rule: String,
    pub outbound: String,
    pub chains: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpExecuteResponse {
    pub parsed: ParsedHttpRequestView,
    pub warnings: Vec<String>,
    pub duration_ms: i64,
    pub response: Option<HttpResponseView>,
    pub error: Option<String>,
    pub observed_connections: Vec<ObservedConnection>,
}

impl Default for ToolsSettings {
    fn default() -> Self {
        Self {
            proxy_url: String::new(),
            timeout_ms: DEFAULT_HTTP_TOOL_TIMEOUT_MS,
        }
    }
}

pub fn parse_http_tool_input(input: &str) -> Result<ParsedHttpRequest> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("request input cannot be empty"));
    }
    if contains_shell_operator(trimmed) {
        return Err(anyhow!("shell operators are not supported"));
    }

    if starts_with_curl(trimmed) {
        return parse_curl_input(trimmed);
    }
    if looks_like_raw_http(trimmed) {
        return parse_raw_http_input(trimmed);
    }
    parse_url_input(trimmed)
}

pub fn normalize_tools_settings(settings: ToolsSettings) -> ToolsSettings {
    ToolsSettings {
        proxy_url: settings.proxy_url.trim().trim_end_matches('/').to_string(),
        timeout_ms: normalize_http_tool_timeout(settings.timeout_ms),
    }
}

pub fn normalize_http_tool_timeout(value: i64) -> i64 {
    value.clamp(MIN_HTTP_TOOL_TIMEOUT_MS, MAX_HTTP_TOOL_TIMEOUT_MS)
}

fn default_http_tool_timeout_ms() -> i64 {
    DEFAULT_HTTP_TOOL_TIMEOUT_MS
}

pub async fn execute_http_tool_request(input: HttpExecuteRequest) -> Result<HttpExecuteResponse> {
    let parsed = parse_http_tool_input(&input.input)?;
    let timeout_ms = input
        .timeout_ms
        .map(normalize_http_tool_timeout)
        .unwrap_or(DEFAULT_HTTP_TOOL_TIMEOUT_MS);
    let client = build_http_client(input.route_mode, input.proxy_url.as_deref(), timeout_ms)?;
    let started = Instant::now();
    let parsed_view = parsed_request_view(&parsed);

    let result = send_parsed_request(&client, &parsed).await;
    let duration_ms = started.elapsed().as_millis() as i64;
    let mut warnings = parsed.warnings.clone();

    let (response, error) = match result {
        Ok(response) => (Some(response), None),
        Err(error) => {
            warnings.push("Request failed before a response was received.".to_string());
            (None, Some(error.to_string()))
        }
    };

    Ok(HttpExecuteResponse {
        parsed: parsed_view,
        warnings,
        duration_ms,
        response,
        error,
        observed_connections: Vec::new(),
    })
}

fn build_http_client(route_mode: RouteMode, proxy_url: Option<&str>, timeout_ms: i64) -> Result<Client> {
    let mut builder = Client::builder().timeout(Duration::from_millis(timeout_ms as u64));
    if route_mode == RouteMode::Proxy {
        let proxy_url = proxy_url
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("proxy URL is required for proxy mode"))?;
        builder = builder.proxy(Proxy::all(proxy_url)?);
    }
    Ok(builder.build()?)
}

fn parsed_request_view(parsed: &ParsedHttpRequest) -> ParsedHttpRequestView {
    ParsedHttpRequestView {
        input_kind: parsed.input_kind.clone(),
        method: parsed.method.clone(),
        url: parsed.url.clone(),
        headers: parsed.headers.clone(),
        body_bytes: parsed.body.len(),
    }
}

async fn send_parsed_request(client: &Client, parsed: &ParsedHttpRequest) -> Result<HttpResponseView> {
    let method = reqwest::Method::from_bytes(parsed.method.as_bytes())?;
    let mut request = client.request(method, &parsed.url);
    for header in &parsed.headers {
        request = request.header(
            HeaderName::from_bytes(header.name.as_bytes())?,
            HeaderValue::from_str(&header.value)?,
        );
    }
    if !parsed.body.is_empty() {
        request = request.body(parsed.body.clone());
    }

    let response = request.send().await?;
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| HttpHeader {
            name: name.to_string(),
            value: value.to_str().unwrap_or("<binary>").to_string(),
        })
        .collect();
    let body = response.bytes().await?;
    let truncated = body.len() > MAX_RESPONSE_PREVIEW_BYTES;
    let preview_bytes = if truncated {
        &body[..MAX_RESPONSE_PREVIEW_BYTES]
    } else {
        body.as_ref()
    };

    Ok(HttpResponseView {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body_preview: String::from_utf8_lossy(preview_bytes).to_string(),
        body_bytes: body.len(),
        truncated,
    })
}

fn parse_url_input(input: &str) -> Result<ParsedHttpRequest> {
    let url = normalize_http_url(input)?;
    Ok(ParsedHttpRequest {
        input_kind: HttpInputKind::Url,
        method: "GET".to_string(),
        url,
        headers: Vec::new(),
        body: Vec::new(),
        warnings: Vec::new(),
    })
}

fn parse_raw_http_input(input: &str) -> Result<ParsedHttpRequest> {
    let normalized = input.replace("\r\n", "\n");
    let (head, body) = normalized
        .split_once("\n\n")
        .map(|(head, body)| (head, body.as_bytes().to_vec()))
        .unwrap_or_else(|| (normalized.as_str(), Vec::new()));
    ensure_body_size(&body)?;

    let mut lines = head.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| anyhow!("raw HTTP request line is missing"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = normalize_method(
        request_parts
            .next()
            .ok_or_else(|| anyhow!("raw HTTP method is missing"))?,
    )?;
    let target = request_parts
        .next()
        .ok_or_else(|| anyhow!("raw HTTP target is missing"))?;
    let version = request_parts
        .next()
        .ok_or_else(|| anyhow!("raw HTTP version is missing"))?;
    if !version.starts_with("HTTP/") {
        return Err(anyhow!("raw HTTP version must start with HTTP/"));
    }

    let mut host = String::new();
    let mut headers = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let header = parse_header(line)?;
        if header.name.eq_ignore_ascii_case("host") {
            host = header.value.clone();
        } else {
            headers.push(header);
        }
    }

    let url = if target.starts_with("http://") || target.starts_with("https://") {
        normalize_http_url(target)?
    } else {
        if host.trim().is_empty() {
            return Err(anyhow!("raw HTTP origin-form requests require a Host header"));
        }
        normalize_http_url(&format!("https://{}{}", host.trim(), target))?
    };

    Ok(ParsedHttpRequest {
        input_kind: HttpInputKind::RawHttp,
        method,
        url,
        headers,
        body,
        warnings: Vec::new(),
    })
}

fn parse_curl_input(input: &str) -> Result<ParsedHttpRequest> {
    let tokens = shell_words(input)?;
    if tokens.is_empty() || tokens[0] != "curl" {
        return Err(anyhow!("curl input must start with curl"));
    }

    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut headers = Vec::new();
    let mut body = Vec::new();
    let mut warnings = Vec::new();
    let mut index = 1;

    while index < tokens.len() {
        let token = &tokens[index];
        if token == "-X" || token == "--request" {
            method = Some(normalize_method(next_value(&tokens, &mut index, token)?)?);
        } else if let Some(value) = token.strip_prefix("-X").filter(|value| !value.is_empty()) {
            method = Some(normalize_method(value)?);
        } else if token == "-H" || token == "--header" {
            headers.push(parse_header(next_value(&tokens, &mut index, token)?)?);
        } else if let Some(value) = token.strip_prefix("-H").filter(|value| !value.is_empty()) {
            headers.push(parse_header(value)?);
        } else if is_curl_data_flag(token) {
            append_body(&mut body, next_value(&tokens, &mut index, token)?.as_bytes())?;
        } else if let Some(value) = token.strip_prefix("-d").filter(|value| !value.is_empty()) {
            append_body(&mut body, value.as_bytes())?;
        } else if token == "--json" {
            append_body(&mut body, next_value(&tokens, &mut index, token)?.as_bytes())?;
            if !has_header(&headers, "content-type") {
                headers.push(HttpHeader {
                    name: "Content-Type".to_string(),
                    value: "application/json".to_string(),
                });
            }
            if !has_header(&headers, "accept") {
                headers.push(HttpHeader {
                    name: "Accept".to_string(),
                    value: "application/json".to_string(),
                });
            }
        } else if token == "-A" || token == "--user-agent" {
            headers.push(HttpHeader {
                name: "User-Agent".to_string(),
                value: next_value(&tokens, &mut index, token)?.to_string(),
            });
        } else if token == "-I" || token == "--head" {
            method = Some("HEAD".to_string());
        } else if token == "-u" || token == "--user" {
            let credentials = next_value(&tokens, &mut index, token)?;
            headers.push(HttpHeader {
                name: "Authorization".to_string(),
                value: format!("Basic {}", STANDARD.encode(credentials.as_bytes())),
            });
        } else if token == "-k" || token == "--insecure" {
            warnings.push("TLS verification options are ignored by the helper request runner.".to_string());
        } else if token.starts_with('-') {
            warnings.push(format!("Unsupported curl option ignored: {token}"));
            if option_takes_value(token) && index + 1 < tokens.len() {
                index += 1;
            }
        } else if url.is_none() {
            url = Some(token.clone());
        } else {
            warnings.push(format!("Extra curl argument ignored: {token}"));
        }

        index += 1;
    }

    let url = normalize_http_url(url.as_deref().ok_or_else(|| anyhow!("curl URL is missing"))?)?;
    let method = method.unwrap_or_else(|| if body.is_empty() { "GET" } else { "POST" }.to_string());

    Ok(ParsedHttpRequest {
        input_kind: HttpInputKind::Curl,
        method,
        url,
        headers,
        body,
        warnings,
    })
}

fn starts_with_curl(input: &str) -> bool {
    input == "curl" || input.starts_with("curl ")
}

fn looks_like_raw_http(input: &str) -> bool {
    input
        .lines()
        .next()
        .map(|line| {
            let mut parts = line.split_whitespace();
            matches!(
                (parts.next(), parts.next(), parts.next()),
                (Some(method), Some(_), Some(version))
                    if method.chars().all(|character| character.is_ascii_uppercase())
                        && version.starts_with("HTTP/")
            )
        })
        .unwrap_or(false)
}

fn normalize_http_url(value: &str) -> Result<String> {
    let url = Url::parse(value.trim()).map_err(|error| anyhow!("invalid URL: {error}"))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(anyhow!("only http and https URLs are supported")),
    }
    if url.host_str().is_none() {
        return Err(anyhow!("URL host is required"));
    }
    Ok(url.to_string())
}

fn normalize_method(value: &str) -> Result<String> {
    let method = value.trim().to_ascii_uppercase();
    if method.is_empty() || !method.chars().all(|character| character.is_ascii_alphabetic()) {
        return Err(anyhow!("HTTP method is invalid"));
    }
    Ok(method)
}

fn parse_header(value: &str) -> Result<HttpHeader> {
    let (name, header_value) = value
        .split_once(':')
        .ok_or_else(|| anyhow!("HTTP header must use Name: value format"))?;
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("HTTP header name cannot be empty"));
    }
    Ok(HttpHeader {
        name: name.to_string(),
        value: header_value.trim().to_string(),
    })
}

fn has_header(headers: &[HttpHeader], name: &str) -> bool {
    headers
        .iter()
        .any(|header| header.name.eq_ignore_ascii_case(name))
}

fn is_curl_data_flag(token: &str) -> bool {
    matches!(
        token,
        "-d" | "--data" | "--data-raw" | "--data-binary" | "--data-ascii" | "--data-urlencode"
    )
}

fn append_body(body: &mut Vec<u8>, next: &[u8]) -> Result<()> {
    if !body.is_empty() {
        body.push(b'&');
    }
    body.extend_from_slice(next);
    ensure_body_size(body)
}

fn ensure_body_size(body: &[u8]) -> Result<()> {
    if body.len() > MAX_REQUEST_BODY_BYTES {
        return Err(anyhow!("request body exceeds 1 MiB"));
    }
    Ok(())
}

fn next_value<'a>(tokens: &'a [String], index: &mut usize, option: &str) -> Result<&'a str> {
    *index += 1;
    tokens
        .get(*index)
        .map(String::as_str)
        .ok_or_else(|| anyhow!("{option} requires a value"))
}

fn option_takes_value(token: &str) -> bool {
    matches!(
        token,
        "-o" | "--output" | "--connect-timeout" | "--max-time" | "--proxy" | "-x" | "--request-target"
    )
}

fn contains_shell_operator(input: &str) -> bool {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    let chars = input.chars().collect::<Vec<_>>();
    let mut index = 0;

    while index < chars.len() {
        let character = chars[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if character == '\\' {
            escaped = true;
            index += 1;
            continue;
        }
        if character == '\'' && !double {
            single = !single;
            index += 1;
            continue;
        }
        if character == '"' && !single {
            double = !double;
            index += 1;
            continue;
        }
        if !single && !double {
            if matches!(character, '|' | ';' | '`') {
                return true;
            }
            if character == '&' && chars.get(index + 1) == Some(&'&') {
                return true;
            }
            if character == '$' && chars.get(index + 1) == Some(&'(') {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn shell_words(input: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut single = false;
    let mut double = false;
    let mut escaped = false;

    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '\'' && !double {
            single = !single;
            continue;
        }
        if character == '"' && !single {
            double = !double;
            continue;
        }
        if character.is_whitespace() && !single && !double {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(character);
    }

    if escaped {
        current.push('\\');
    }
    if single || double {
        return Err(anyhow!("curl input has an unterminated quote"));
    }
    if !current.is_empty() {
        words.push(current);
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[test]
    fn parses_bare_url_as_get_request() {
        let request = parse_http_tool_input("https://api.example.test/v1/health").unwrap();

        assert_eq!(request.input_kind, HttpInputKind::Url);
        assert_eq!(request.method, "GET");
        assert_eq!(request.url, "https://api.example.test/v1/health");
        assert!(request.headers.is_empty());
        assert!(request.body.is_empty());
    }

    #[test]
    fn parses_raw_http_origin_form_with_host_header() {
        let request = parse_http_tool_input(
            "POST /v1/messages HTTP/1.1\r\nHost: api.example.test\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}",
        )
        .unwrap();

        assert_eq!(request.input_kind, HttpInputKind::RawHttp);
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://api.example.test/v1/messages");
        assert_eq!(
            request.headers,
            vec![HttpHeader {
                name: "Content-Type".to_string(),
                value: "application/json".to_string()
            }]
        );
        assert_eq!(request.body, br#"{"ok":true}"#);
    }

    #[test]
    fn parses_curl_headers_json_and_basic_auth() {
        let request = parse_http_tool_input(
            "curl -X PATCH 'https://api.example.test/v1/items' -H 'Accept: application/json' --json '{\"name\":\"deck\"}' -u deck:secret",
        )
        .unwrap();

        assert_eq!(request.input_kind, HttpInputKind::Curl);
        assert_eq!(request.method, "PATCH");
        assert_eq!(request.url, "https://api.example.test/v1/items");
        assert!(request.headers.iter().any(|header| {
            header.name == "Accept" && header.value == "application/json"
        }));
        assert!(request.headers.iter().any(|header| {
            header.name == "Content-Type" && header.value == "application/json"
        }));
        assert!(request.headers.iter().any(|header| header.name == "Authorization"));
        assert_eq!(request.body, br#"{"name":"deck"}"#);
    }

    #[test]
    fn rejects_shell_operators_and_non_http_targets() {
        assert!(parse_http_tool_input("curl https://example.test | sh").is_err());
        assert!(parse_http_tool_input("file:///etc/passwd").is_err());
    }

    #[test]
    fn normalizes_tools_settings() {
        let settings = normalize_tools_settings(ToolsSettings {
            proxy_url: "  http://127.0.0.1:7890/  ".to_string(),
            timeout_ms: 300_000,
        });

        assert_eq!(settings.proxy_url, "http://127.0.0.1:7890");
        assert_eq!(settings.timeout_ms, MAX_HTTP_TOOL_TIMEOUT_MS);
    }

    #[tokio::test]
    async fn executes_direct_http_request_with_preview() {
        let server_url = spawn_http_tool_server("hello from tool").await;

        let result = execute_http_tool_request(HttpExecuteRequest {
            input: format!("curl -H 'Accept: text/plain' {server_url}/check"),
            route_mode: RouteMode::Direct,
            proxy_url: None,
            timeout_ms: Some(5_000),
        })
        .await
        .unwrap();

        assert_eq!(result.parsed.method, "GET");
        assert_eq!(result.parsed.url, format!("{server_url}/check"));
        assert!(result.error.is_none());
        let response = result.response.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body_preview, "hello from tool");
        assert!(!response.truncated);
        assert!(result.duration_ms >= 0);
    }

    #[tokio::test]
    async fn rejects_proxy_mode_without_proxy_url() {
        let error = execute_http_tool_request(HttpExecuteRequest {
            input: "https://example.test".to_string(),
            route_mode: RouteMode::Proxy,
            proxy_url: Some("   ".to_string()),
            timeout_ms: Some(5_000),
        })
        .await
        .unwrap_err();

        assert!(error.to_string().contains("proxy URL is required"));
    }

    async fn spawn_http_tool_server(body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0_u8; 2048];
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
}
