use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::{header, Client};
use serde::Deserialize;
use serde_json::Value;
use tokio::time::timeout;

use super::types::{CheckStatus, NetworkClassResult, NetworkClassVerdict};

const PROXYCHECK_ENDPOINT_BASE: &str = "https://proxycheck.io/v3";
const IPQUERY_ENDPOINT_BASE: &str = "https://api.ipquery.io";
const PROXYCHECK_SOURCE: &str = "proxycheck.io v3 API";
const IPQUERY_SOURCE: &str = "ipquery.io API fallback";
const COMBINED_SOURCE: &str = "proxycheck.io v3 API with ipquery.io fallback";

#[derive(Debug, Default, Deserialize)]
struct ProxycheckEntry {
    network: Option<ProxycheckNetwork>,
    detections: Option<ProxycheckDetections>,
}

#[derive(Debug, Default, Deserialize)]
struct ProxycheckNetwork {
    asn: Option<String>,
    range: Option<String>,
    provider: Option<String>,
    organisation: Option<String>,
    #[serde(rename = "type")]
    network_type: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ProxycheckDetections {
    hosting: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct IpqueryResponse {
    isp: Option<IpqueryIsp>,
    risk: Option<IpqueryRisk>,
}

#[derive(Debug, Default, Deserialize)]
struct IpqueryIsp {
    asn: Option<String>,
    org: Option<String>,
    isp: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct IpqueryRisk {
    is_mobile: Option<bool>,
    is_datacenter: Option<bool>,
}

pub async fn detect(
    client: &Client,
    ip: IpAddr,
    proxycheck_key: Option<&str>,
    request_timeout: Duration,
) -> NetworkClassResult {
    detect_at_endpoints(
        client,
        ip,
        proxycheck_key,
        request_timeout,
        PROXYCHECK_ENDPOINT_BASE,
        IPQUERY_ENDPOINT_BASE,
    )
    .await
}

pub fn unavailable(reason: impl Into<String>) -> NetworkClassResult {
    failure(CheckStatus::Unavailable, reason)
}

async fn detect_at_endpoints(
    client: &Client,
    ip: IpAddr,
    proxycheck_key: Option<&str>,
    request_timeout: Duration,
    proxycheck_endpoint_base: &str,
    ipquery_endpoint_base: &str,
) -> NetworkClassResult {
    match query_proxycheck(
        client,
        ip,
        proxycheck_key,
        request_timeout,
        proxycheck_endpoint_base,
    )
    .await
    {
        Ok(primary) if primary.verdict != NetworkClassVerdict::Unknown => primary,
        Ok(primary) => {
            match query_ipquery(client, ip, request_timeout, ipquery_endpoint_base).await {
                Ok(fallback) if fallback.verdict != NetworkClassVerdict::Unknown => fallback,
                _ => primary,
            }
        }
        Err(primary_error) => {
            match query_ipquery(client, ip, request_timeout, ipquery_endpoint_base).await {
                Ok(fallback) => fallback,
                Err(fallback_error) => failure(
                    CheckStatus::Unavailable,
                    format!(
                        "network classification providers unavailable: {primary_error}; {fallback_error}"
                    ),
                ),
            }
        }
    }
}

async fn query_proxycheck(
    client: &Client,
    ip: IpAddr,
    proxycheck_key: Option<&str>,
    request_timeout: Duration,
    endpoint_base: &str,
) -> Result<NetworkClassResult, String> {
    let endpoint = format!("{}/{ip}", endpoint_base.trim_end_matches('/'));
    let mut request = client
        .get(endpoint)
        .header(header::ACCEPT, "application/json");
    if let Some(key) = proxycheck_key.filter(|value| !value.trim().is_empty()) {
        request = request.query(&[("key", key.trim())]);
    }
    let response = match timeout(request_timeout, request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(format!(
                "proxycheck.io request failed: {}",
                error.without_url()
            ))
        }
        Err(_) => return Err("proxycheck.io request timed out".to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(format!("proxycheck.io returned HTTP {status}"));
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            return Err(format!(
                "read proxycheck.io response: {}",
                error.without_url()
            ))
        }
        Err(_) => return Err("read proxycheck.io response timed out".to_string()),
    };
    parse_proxycheck_response(&body, ip)
}

fn parse_proxycheck_response(body: &[u8], ip: IpAddr) -> Result<NetworkClassResult, String> {
    let response = serde_json::from_slice::<Value>(body)
        .map_err(|error| format!("decode proxycheck.io response: {error}"))?;
    if response.get("status").and_then(Value::as_str) != Some("ok") {
        let message = response
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("provider returned a non-ok status");
        return Err(format!("proxycheck.io response rejected: {message}"));
    }
    let entry = response
        .get(ip.to_string())
        .cloned()
        .ok_or_else(|| format!("proxycheck.io response omitted {ip}"))?;
    let entry = serde_json::from_value::<ProxycheckEntry>(entry)
        .map_err(|error| format!("decode proxycheck.io IP entry: {error}"))?;
    Ok(proxycheck_result(entry))
}

fn proxycheck_result(entry: ProxycheckEntry) -> NetworkClassResult {
    let network = entry.network.unwrap_or_default();
    let explicit_hosting = entry.detections.and_then(|value| value.hosting);
    let verdict = classify_proxycheck(network.network_type.as_deref(), explicit_hosting);
    let type_is_hosting = network
        .network_type
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("hosting"));

    NetworkClassResult {
        status: CheckStatus::Success,
        verdict,
        user_type: network
            .network_type
            .as_ref()
            .map(|value| value.to_lowercase()),
        is_hosting_provider: explicit_hosting.or(type_is_hosting),
        connection_type: network.network_type,
        isp: network.provider,
        organization: network.organisation,
        autonomous_system_number: network.asn.as_deref().and_then(parse_asn),
        network: network.range,
        user_count: None,
        source: PROXYCHECK_SOURCE.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn classify_proxycheck(
    network_type: Option<&str>,
    explicit_hosting: Option<bool>,
) -> NetworkClassVerdict {
    let base = match network_type.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "residential" => NetworkClassVerdict::Residential,
        Some(value) if value == "hosting" => NetworkClassVerdict::DataCenter,
        Some(value) if value == "wireless" => NetworkClassVerdict::Mobile,
        Some(value) if value == "business" => NetworkClassVerdict::Business,
        Some(_) => NetworkClassVerdict::Other,
        None => NetworkClassVerdict::Unknown,
    };
    if explicit_hosting == Some(true) {
        if base == NetworkClassVerdict::Residential {
            NetworkClassVerdict::Mixed
        } else {
            NetworkClassVerdict::DataCenter
        }
    } else {
        base
    }
}

async fn query_ipquery(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    endpoint_base: &str,
) -> Result<NetworkClassResult, String> {
    let endpoint = format!("{}/{ip}", endpoint_base.trim_end_matches('/'));
    let response = match timeout(
        request_timeout,
        client
            .get(endpoint)
            .header(header::ACCEPT, "application/json")
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return Err(format!(
                "ipquery.io request failed: {}",
                error.without_url()
            ))
        }
        Err(_) => return Err("ipquery.io request timed out".to_string()),
    };
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ipquery.io returned HTTP {status}"));
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => return Err(format!("read ipquery.io response: {}", error.without_url())),
        Err(_) => return Err("read ipquery.io response timed out".to_string()),
    };
    parse_ipquery_response(&body)
}

fn parse_ipquery_response(body: &[u8]) -> Result<NetworkClassResult, String> {
    let response = serde_json::from_slice::<IpqueryResponse>(body)
        .map_err(|error| format!("decode ipquery.io response: {error}"))?;
    let isp = response.isp.unwrap_or_default();
    let risk = response.risk.unwrap_or_default();
    let is_mobile = risk.is_mobile == Some(true);
    let is_datacenter = risk.is_datacenter == Some(true);
    let verdict = match (is_mobile, is_datacenter) {
        (true, true) => NetworkClassVerdict::Mixed,
        (_, true) => NetworkClassVerdict::DataCenter,
        (true, false) => NetworkClassVerdict::Mobile,
        (false, false) => NetworkClassVerdict::Unknown,
    };
    let connection_type = match verdict {
        NetworkClassVerdict::DataCenter => Some("Hosting".to_string()),
        NetworkClassVerdict::Mobile => Some("Wireless".to_string()),
        NetworkClassVerdict::Mixed => Some("Wireless / Hosting".to_string()),
        _ => None,
    };

    Ok(NetworkClassResult {
        status: CheckStatus::Success,
        verdict,
        user_type: connection_type.as_ref().map(|value| value.to_lowercase()),
        is_hosting_provider: risk.is_datacenter,
        connection_type,
        isp: isp.isp,
        organization: isp.org,
        autonomous_system_number: isp.asn.as_deref().and_then(parse_asn),
        network: None,
        user_count: None,
        source: IPQUERY_SOURCE.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    })
}

fn parse_asn(value: &str) -> Option<u32> {
    let value = value.trim();
    value
        .strip_prefix("AS")
        .or_else(|| value.strip_prefix("as"))
        .unwrap_or(value)
        .parse()
        .ok()
}

fn failure(status: CheckStatus, error: impl Into<String>) -> NetworkClassResult {
    NetworkClassResult {
        status,
        verdict: NetworkClassVerdict::Unknown,
        user_type: None,
        is_hosting_provider: None,
        connection_type: None,
        isp: None,
        organization: None,
        autonomous_system_number: None,
        network: None,
        user_count: None,
        source: COMBINED_SOURCE.to_string(),
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

    fn proxycheck_body(ip: &str, network_type: Option<&str>, hosting: Option<bool>) -> Vec<u8> {
        let mut response = serde_json::json!({ "status": "ok" });
        response.as_object_mut().unwrap().insert(
            ip.to_string(),
            serde_json::json!({
                "network": {
                    "asn": "AS64500",
                    "range": "203.0.113.0/24",
                    "provider": "Example ISP",
                    "organisation": "Example Network",
                    "type": network_type
                },
                "detections": { "hosting": hosting }
            }),
        );
        serde_json::to_vec(&response).unwrap()
    }

    #[test]
    fn maps_only_explicit_proxycheck_network_types() {
        let ip = "203.0.113.8".parse().unwrap();
        let residential = parse_proxycheck_response(
            &proxycheck_body("203.0.113.8", Some("Residential"), Some(false)),
            ip,
        )
        .unwrap();
        let data_center = parse_proxycheck_response(
            &proxycheck_body("203.0.113.8", Some("Hosting"), Some(true)),
            ip,
        )
        .unwrap();
        let mobile = parse_proxycheck_response(
            &proxycheck_body("203.0.113.8", Some("Wireless"), Some(false)),
            ip,
        )
        .unwrap();

        assert_eq!(residential.verdict, NetworkClassVerdict::Residential);
        assert_eq!(residential.autonomous_system_number, Some(64500));
        assert_eq!(data_center.verdict, NetworkClassVerdict::DataCenter);
        assert_eq!(mobile.verdict, NetworkClassVerdict::Mobile);
    }

    #[test]
    fn preserves_residential_and_hosting_conflict_as_mixed() {
        assert_eq!(
            classify_proxycheck(Some("Residential"), Some(true)),
            NetworkClassVerdict::Mixed
        );
    }

    #[test]
    fn ipquery_never_infers_residential_from_negative_datacenter_flag() {
        let result = parse_ipquery_response(
            br#"{"isp":{"asn":"AS64500","org":"Example","isp":"Example"},"risk":{"is_mobile":false,"is_datacenter":false}}"#,
        )
        .unwrap();

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.verdict, NetworkClassVerdict::Unknown);
    }

    #[tokio::test]
    async fn falls_back_to_ipquery_when_proxycheck_is_rate_limited() {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy_listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = proxy_listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let _ = stream.read(&mut request).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let ipquery_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ipquery_address = ipquery_listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = ipquery_listener.accept().await.unwrap();
            let mut request = [0_u8; 2_048];
            let _ = stream.read(&mut request).await.unwrap();
            let body = r#"{"isp":{"asn":"AS13335","org":"Cloudflare","isp":"Cloudflare"},"risk":{"is_mobile":false,"is_datacenter":true}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let result = detect_at_endpoints(
            &Client::new(),
            "1.1.1.1".parse().unwrap(),
            None,
            Duration::from_secs(1),
            &format!("http://{proxy_address}"),
            &format!("http://{ipquery_address}"),
        )
        .await;

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.verdict, NetworkClassVerdict::DataCenter);
        assert_eq!(result.source, IPQUERY_SOURCE);
    }

    #[tokio::test]
    async fn optional_proxycheck_key_is_not_required_for_residential_result() {
        let captured = Arc::new(Mutex::new(String::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let read = stream.read(&mut request).await.unwrap();
            *captured_clone.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            let body = proxycheck_body("203.0.113.8", Some("Residential"), Some(false));
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        });

        let result = detect_at_endpoints(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            None,
            Duration::from_secs(1),
            &format!("http://{address}"),
            "http://127.0.0.1:1",
        )
        .await;

        assert_eq!(result.verdict, NetworkClassVerdict::Residential);
        assert!(captured
            .lock()
            .unwrap()
            .starts_with("GET /203.0.113.8 HTTP/1.1"));
    }
}
