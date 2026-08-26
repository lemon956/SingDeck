use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;
use serde::Deserialize;
use tokio::time::timeout;

use super::types::{CheckStatus, IpPrivacyResult, PrivacySignal};

const ENDPOINT_BASE: &str = "https://api.ipinfo.io/lookup";
const SOURCE_NAME: &str = "IPinfo Privacy Detection API";

#[derive(Debug, Default, Deserialize)]
struct IpinfoResponse {
    is_anonymous: Option<bool>,
    is_hosting: Option<bool>,
    is_proxy: Option<bool>,
    is_relay: Option<bool>,
    is_tor: Option<bool>,
    is_vpn: Option<bool>,
    is_res_proxy: Option<bool>,
    name: Option<String>,
    service: Option<String>,
    confidence: Option<u8>,
    first_seen: Option<String>,
    last_seen: Option<String>,
    anonymous: Option<AnonymousDetails>,
    privacy: Option<PrivacyDetails>,
}

#[derive(Debug, Default, Deserialize)]
struct AnonymousDetails {
    is_anonymous: Option<bool>,
    is_hosting: Option<bool>,
    is_proxy: Option<bool>,
    is_relay: Option<bool>,
    is_tor: Option<bool>,
    is_vpn: Option<bool>,
    is_res_proxy: Option<bool>,
    name: Option<String>,
    confidence: Option<u8>,
    first_seen: Option<String>,
    last_seen: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PrivacyDetails {
    vpn: Option<bool>,
    proxy: Option<bool>,
    tor: Option<bool>,
    relay: Option<bool>,
    hosting: Option<bool>,
    residential_proxy: Option<bool>,
    service: Option<String>,
    confidence: Option<u8>,
    first_seen: Option<String>,
    last_seen: Option<String>,
}

pub async fn detect(
    client: &Client,
    ip: IpAddr,
    token: Option<&str>,
    request_timeout: Duration,
) -> IpPrivacyResult {
    detect_at_base(client, ip, token, request_timeout, ENDPOINT_BASE).await
}

pub fn unavailable(reason: impl Into<String>) -> IpPrivacyResult {
    failure(CheckStatus::Unavailable, reason)
}

pub fn not_configured() -> IpPrivacyResult {
    failure(
        CheckStatus::NotConfigured,
        "SINGDECK_IPINFO_TOKEN is not configured",
    )
}

async fn detect_at_base(
    client: &Client,
    ip: IpAddr,
    token: Option<&str>,
    request_timeout: Duration,
    endpoint_base: &str,
) -> IpPrivacyResult {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
        return not_configured();
    };
    let endpoint = format!("{}/{ip}", endpoint_base.trim_end_matches('/'));
    let response = match timeout(
        request_timeout,
        client.get(&endpoint).bearer_auth(token).send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("IPinfo privacy request failed: {error}"),
            )
        }
        Err(_) => return failure(CheckStatus::Unavailable, "IPinfo privacy request timed out"),
    };
    let status = response.status();
    if !status.is_success() {
        return failure(
            CheckStatus::Unavailable,
            format!("IPinfo privacy returned HTTP {status}"),
        );
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("read IPinfo privacy response: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                "read IPinfo privacy response timed out",
            )
        }
    };
    parse_response(&body)
}

fn parse_response(body: &[u8]) -> IpPrivacyResult {
    let response = match serde_json::from_slice::<IpinfoResponse>(body) {
        Ok(response) => response,
        Err(error) => {
            return failure(
                CheckStatus::Error,
                format!("decode IPinfo privacy response: {error}"),
            )
        }
    };
    let anonymous = response.anonymous.as_ref();
    let privacy = response.privacy.as_ref();
    let fields_present = [
        response.is_anonymous,
        response.is_hosting,
        response.is_proxy,
        response.is_relay,
        response.is_tor,
        response.is_vpn,
        response.is_res_proxy,
        anonymous.and_then(|value| value.is_anonymous),
        anonymous.and_then(|value| value.is_hosting),
        anonymous.and_then(|value| value.is_proxy),
        anonymous.and_then(|value| value.is_relay),
        anonymous.and_then(|value| value.is_tor),
        anonymous.and_then(|value| value.is_vpn),
        anonymous.and_then(|value| value.is_res_proxy),
        privacy.and_then(|value| value.vpn),
        privacy.and_then(|value| value.proxy),
        privacy.and_then(|value| value.tor),
        privacy.and_then(|value| value.relay),
        privacy.and_then(|value| value.hosting),
        privacy.and_then(|value| value.residential_proxy),
    ]
    .into_iter()
    .any(|value| value.is_some());
    if !fields_present {
        return failure(
            CheckStatus::Unavailable,
            "IPinfo response contains no privacy fields; token plan may not include privacy data",
        );
    }

    let mut signals = Vec::new();
    push_signal(
        &mut signals,
        any_true(&[
            response.is_anonymous,
            anonymous.and_then(|value| value.is_anonymous),
        ]),
        PrivacySignal::Anonymous,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_vpn,
            anonymous.and_then(|value| value.is_vpn),
            privacy.and_then(|value| value.vpn),
        ]),
        PrivacySignal::Vpn,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_proxy,
            anonymous.and_then(|value| value.is_proxy),
            privacy.and_then(|value| value.proxy),
        ]),
        PrivacySignal::Proxy,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_tor,
            anonymous.and_then(|value| value.is_tor),
            privacy.and_then(|value| value.tor),
        ]),
        PrivacySignal::Tor,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_relay,
            anonymous.and_then(|value| value.is_relay),
            privacy.and_then(|value| value.relay),
        ]),
        PrivacySignal::Relay,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_hosting,
            anonymous.and_then(|value| value.is_hosting),
            privacy.and_then(|value| value.hosting),
        ]),
        PrivacySignal::Hosting,
    );
    push_signal(
        &mut signals,
        any_true(&[
            response.is_res_proxy,
            anonymous.and_then(|value| value.is_res_proxy),
            privacy.and_then(|value| value.residential_proxy),
        ]),
        PrivacySignal::ResidentialProxy,
    );

    IpPrivacyResult {
        status: CheckStatus::Success,
        signals,
        service: response
            .service
            .or(response.name)
            .or_else(|| anonymous.and_then(|value| value.name.clone()))
            .or_else(|| privacy.and_then(|value| value.service.clone())),
        confidence: response
            .confidence
            .or_else(|| anonymous.and_then(|value| value.confidence))
            .or_else(|| privacy.and_then(|value| value.confidence)),
        first_seen: response
            .first_seen
            .or_else(|| anonymous.and_then(|value| value.first_seen.clone()))
            .or_else(|| privacy.and_then(|value| value.first_seen.clone())),
        last_seen: response
            .last_seen
            .or_else(|| anonymous.and_then(|value| value.last_seen.clone()))
            .or_else(|| privacy.and_then(|value| value.last_seen.clone())),
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn any_true(values: &[Option<bool>]) -> bool {
    values.iter().any(|value| *value == Some(true))
}

fn push_signal(signals: &mut Vec<PrivacySignal>, present: bool, signal: PrivacySignal) {
    if present {
        signals.push(signal);
    }
}

fn failure(status: CheckStatus, error: impl Into<String>) -> IpPrivacyResult {
    IpPrivacyResult {
        status,
        signals: Vec::new(),
        service: None,
        confidence: None,
        first_seen: None,
        last_seen: None,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: Some(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn missing_token_is_explicitly_not_configured() {
        let result = detect_at_base(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            None,
            Duration::from_millis(10),
            "http://127.0.0.1:1",
        )
        .await;

        assert_eq!(result.status, CheckStatus::NotConfigured);
        assert!(result.error.unwrap().contains("SINGDECK_IPINFO_TOKEN"));
    }

    #[test]
    fn merges_top_level_and_nested_signals_without_inference() {
        let result = parse_response(
            br#"{
              "is_anonymous": true,
              "is_hosting": true,
              "anonymous": {
                "is_vpn": true,
                "is_proxy": false,
                "is_res_proxy": true,
                "name": "Example VPN",
                "confidence": 3,
                "last_seen": "2026-08-25"
              }
            }"#,
        );

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(
            result.signals,
            vec![
                PrivacySignal::Anonymous,
                PrivacySignal::Vpn,
                PrivacySignal::Hosting,
                PrivacySignal::ResidentialProxy,
            ]
        );
        assert_eq!(result.service.as_deref(), Some("Example VPN"));
        assert_eq!(result.confidence, Some(3));
    }

    #[test]
    fn absent_privacy_entitlement_is_not_reported_as_clean() {
        let result = parse_response(br#"{"ip":"203.0.113.8","country":"US"}"#);

        assert_eq!(result.status, CheckStatus::Unavailable);
        assert!(result.signals.is_empty());
    }

    #[tokio::test]
    async fn bearer_token_never_appears_in_request_url() {
        let captured = Arc::new(Mutex::new(String::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let read = stream.read(&mut request).await.unwrap();
            *captured_clone.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            let body = r#"{"is_anonymous":false,"is_hosting":false}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let result = detect_at_base(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            Some("secret-token"),
            Duration::from_secs(1),
            &format!("http://{address}/lookup"),
        )
        .await;

        assert_eq!(result.status, CheckStatus::Success);
        assert!(result.signals.is_empty());
        let request = captured.lock().unwrap();
        assert!(request.starts_with("GET /lookup/203.0.113.8 HTTP/1.1"));
        assert!(request.contains("authorization: Bearer secret-token"));
        assert!(!request.lines().next().unwrap().contains("secret-token"));
    }
}
