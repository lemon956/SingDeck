use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;
use serde::Deserialize;
use tokio::time::timeout;

use super::types::{CheckStatus, TorRelayEvidence, TorResult, TorVerdict};

const ENDPOINT: &str = "https://onionoo.torproject.org/details";
const SOURCE_NAME: &str = "Tor Project Onionoo relay details";
const REQUEST_FIELDS: &str = "fingerprint,nickname,or_addresses,exit_addresses,flags";

#[derive(Debug, Deserialize)]
struct OnionooResponse {
    #[serde(default)]
    relays: Vec<Relay>,
}

#[derive(Debug, Deserialize)]
struct Relay {
    fingerprint: String,
    nickname: Option<String>,
    #[serde(default)]
    or_addresses: Vec<String>,
    #[serde(default)]
    exit_addresses: Vec<String>,
    #[serde(default)]
    flags: Vec<String>,
}

pub async fn detect(client: &Client, ip: IpAddr, request_timeout: Duration) -> TorResult {
    detect_at_url(client, ip, request_timeout, ENDPOINT).await
}

pub fn unavailable(reason: impl Into<String>) -> TorResult {
    failure(CheckStatus::Unavailable, reason)
}

async fn detect_at_url(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    endpoint: &str,
) -> TorResult {
    let response = match timeout(
        request_timeout,
        client
            .get(endpoint)
            .query(&[
                ("type", "relay".to_string()),
                ("running", "true".to_string()),
                ("search", ip.to_string()),
                ("fields", REQUEST_FIELDS.to_string()),
            ])
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("Tor Onionoo request failed: {error}"),
            )
        }
        Err(_) => return failure(CheckStatus::Unavailable, "Tor Onionoo request timed out"),
    };
    let status = response.status();
    if !status.is_success() {
        return failure(
            CheckStatus::Unavailable,
            format!("Tor Onionoo returned HTTP {status}"),
        );
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("read Tor Onionoo response: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                "read Tor Onionoo response timed out",
            )
        }
    };
    parse_response(ip, &body)
}

fn parse_response(ip: IpAddr, body: &[u8]) -> TorResult {
    let response = match serde_json::from_slice::<OnionooResponse>(body) {
        Ok(response) => response,
        Err(error) => {
            return failure(
                CheckStatus::Error,
                format!("decode Tor Onionoo response: {error}"),
            )
        }
    };
    let relays = response
        .relays
        .into_iter()
        .filter_map(|relay| {
            let exit_address_match = relay
                .exit_addresses
                .iter()
                .filter_map(|address| address.parse::<IpAddr>().ok())
                .any(|address| address == ip);
            let onion_address_match = relay
                .or_addresses
                .iter()
                .filter_map(|address| address_ip(address))
                .any(|address| address == ip);
            if !exit_address_match && !onion_address_match {
                return None;
            }
            Some(TorRelayEvidence {
                fingerprint: relay.fingerprint,
                nickname: relay.nickname,
                exit_address_match,
                exit_flag: relay
                    .flags
                    .iter()
                    .any(|flag| flag.eq_ignore_ascii_case("exit")),
            })
        })
        .collect::<Vec<_>>();
    let verdict = if relays
        .iter()
        .any(|relay| relay.exit_address_match || relay.exit_flag)
    {
        TorVerdict::Exit
    } else if !relays.is_empty() {
        TorVerdict::Relay
    } else {
        TorVerdict::NotDetected
    };
    TorResult {
        status: CheckStatus::Success,
        verdict,
        relays,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn address_ip(value: &str) -> Option<IpAddr> {
    value
        .parse::<std::net::SocketAddr>()
        .map(|address| address.ip())
        .ok()
        .or_else(|| value.parse::<IpAddr>().ok())
        .or_else(|| {
            let (host, _) = value.rsplit_once(':')?;
            host.parse::<IpAddr>().ok()
        })
}

fn failure(status: CheckStatus, error: impl Into<String>) -> TorResult {
    TorResult {
        status,
        verdict: TorVerdict::Unknown,
        relays: Vec::new(),
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

    #[test]
    fn exact_exit_address_is_confirmed() {
        let body = br#"{
          "relays": [
            {
              "fingerprint": "ABC123",
              "nickname": "exit-a",
              "or_addresses": ["198.51.100.4:9001"],
              "exit_addresses": ["203.0.113.8"],
              "flags": ["Running", "Exit"]
            }
          ]
        }"#;

        let result = parse_response("203.0.113.8".parse().unwrap(), body);

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.verdict, TorVerdict::Exit);
        assert!(result.relays[0].exit_address_match);
    }

    #[test]
    fn exact_non_exit_relay_and_prefix_only_match_are_distinguished() {
        let body = br#"{
          "relays": [
            {
              "fingerprint": "RELAY",
              "or_addresses": ["[2001:db8::1]:9001"],
              "flags": ["Running", "Guard"]
            },
            {
              "fingerprint": "PREFIX_ONLY",
              "or_addresses": ["203.0.113.80:9001"],
              "flags": ["Exit"]
            }
          ]
        }"#;

        let relay = parse_response("2001:db8::1".parse().unwrap(), body);
        assert_eq!(relay.verdict, TorVerdict::Relay);
        assert_eq!(relay.relays.len(), 1);

        let absent = parse_response("203.0.113.8".parse().unwrap(), body);
        assert_eq!(absent.verdict, TorVerdict::NotDetected);
        assert!(absent.relays.is_empty());
    }

    #[tokio::test]
    async fn queries_onionoo_with_exact_ip_and_minimal_fields() {
        let captured = Arc::new(Mutex::new(String::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let read = stream.read(&mut request).await.unwrap();
            *captured_clone.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            let body = r#"{"relays":[]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let result = detect_at_url(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            Duration::from_secs(1),
            &format!("http://{address}/details"),
        )
        .await;

        assert_eq!(result.verdict, TorVerdict::NotDetected);
        let request = captured.lock().unwrap();
        assert!(request.contains("search=203.0.113.8"));
        assert!(request.contains("type=relay"));
        assert!(request.contains("running=true"));
        assert!(request.contains("fields="));
    }
}
