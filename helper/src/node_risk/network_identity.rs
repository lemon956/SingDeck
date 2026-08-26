use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;
use serde::{de::Error as _, Deserialize, Deserializer};
use tokio::time::timeout;

use super::types::{CheckStatus, NetworkIdentityResult};

const ENDPOINT: &str = "https://stat.ripe.net/data/network-info/data.json";
const SOURCE_NAME: &str = "RIPEstat Network Info (RIPE RIS)";

#[derive(Debug, Deserialize)]
struct RipeResponse {
    status: String,
    data: NetworkInfoData,
}

#[derive(Debug, Deserialize)]
struct NetworkInfoData {
    prefix: Option<String>,
    #[serde(default, deserialize_with = "deserialize_asns")]
    asns: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AsnValue {
    Number(u32),
    String(String),
}

fn deserialize_asns<'de, D>(deserializer: D) -> Result<Vec<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    Vec::<AsnValue>::deserialize(deserializer)?
        .into_iter()
        .map(|value| match value {
            AsnValue::Number(asn) => Ok(asn),
            AsnValue::String(asn) => asn
                .parse::<u32>()
                .map_err(|error| D::Error::custom(format!("invalid ASN {asn:?}: {error}"))),
        })
        .collect()
}

pub async fn detect(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
) -> NetworkIdentityResult {
    detect_at_url(client, ip, request_timeout, ENDPOINT).await
}

pub fn unavailable(reason: impl Into<String>) -> NetworkIdentityResult {
    failure(CheckStatus::Unavailable, reason)
}

async fn detect_at_url(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    endpoint: &str,
) -> NetworkIdentityResult {
    let response = match timeout(
        request_timeout,
        client
            .get(endpoint)
            .query(&[("resource", ip.to_string())])
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("RIPEstat network-info request failed: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                "RIPEstat network-info request timed out",
            )
        }
    };
    let status = response.status();
    if !status.is_success() {
        return failure(
            CheckStatus::Unavailable,
            format!("RIPEstat network-info returned HTTP {status}"),
        );
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("read RIPEstat network-info response: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                "read RIPEstat network-info response timed out",
            )
        }
    };
    parse_response(&body)
}

fn parse_response(body: &[u8]) -> NetworkIdentityResult {
    let response = match serde_json::from_slice::<RipeResponse>(body) {
        Ok(response) => response,
        Err(error) => {
            return failure(
                CheckStatus::Error,
                format!("decode RIPEstat network-info response: {error}"),
            )
        }
    };
    if response.status != "ok" {
        return failure(
            CheckStatus::Unavailable,
            format!("RIPEstat network-info status: {}", response.status),
        );
    }
    NetworkIdentityResult {
        status: CheckStatus::Success,
        prefix: response.data.prefix,
        origin_asns: response.data.asns,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn failure(status: CheckStatus, error: impl Into<String>) -> NetworkIdentityResult {
    NetworkIdentityResult {
        status,
        prefix: None,
        origin_asns: Vec::new(),
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
    fn parses_announced_prefix_and_all_origins() {
        let result = parse_response(
            br#"{"status":"ok","data":{"prefix":"104.225.232.0/22","asns":["400304",64500]}}"#,
        );

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.prefix.as_deref(), Some("104.225.232.0/22"));
        assert_eq!(result.origin_asns, vec![400304, 64500]);
    }

    #[test]
    fn unrouted_address_remains_a_successful_factual_lookup() {
        let result = parse_response(br#"{"status":"ok","data":{"prefix":null,"asns":[]}}"#);

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.prefix, None);
        assert!(result.origin_asns.is_empty());
    }

    #[tokio::test]
    async fn sends_only_the_observed_ip_as_resource() {
        let captured = Arc::new(Mutex::new(String::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let read = stream.read(&mut request).await.unwrap();
            *captured_clone.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            let body = r#"{"status":"ok","data":{"prefix":"203.0.113.0/24","asns":[64496]}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let endpoint = format!("http://{address}/network-info");

        let result = detect_at_url(
            &Client::new(),
            "203.0.113.9".parse().unwrap(),
            Duration::from_secs(1),
            &endpoint,
        )
        .await;

        assert_eq!(result.status, CheckStatus::Success);
        let request = captured.lock().unwrap();
        assert!(request.starts_with("GET /network-info?resource=203.0.113.9 HTTP/1.1"));
    }
}
