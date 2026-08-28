use std::{net::IpAddr, time::Duration};

use reqwest::{header, Client};
use serde::Deserialize;
use serde_json::Value;
use tokio::time::timeout;

use crate::node_risk::types::{
    CheckStatus, NetworkClassEvidence, NetworkClassSignal, NetworkClassVerdict,
};

pub(super) const PROVIDER: &str = "proxycheck.io v3 API";

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

pub(super) async fn detect(
    client: &Client,
    ip: IpAddr,
    api_key: Option<&str>,
    request_timeout: Duration,
    endpoint_base: &str,
) -> NetworkClassEvidence {
    match query(client, ip, api_key, request_timeout, endpoint_base).await {
        Ok(evidence) => evidence,
        Err(error) => unavailable(error),
    }
}

async fn query(
    client: &Client,
    ip: IpAddr,
    api_key: Option<&str>,
    request_timeout: Duration,
    endpoint_base: &str,
) -> Result<NetworkClassEvidence, String> {
    let endpoint = format!("{}/{ip}", endpoint_base.trim_end_matches('/'));
    let mut request = client
        .get(endpoint)
        .header(header::ACCEPT, "application/json");
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
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
    parse_response(&body, ip)
}

fn parse_response(body: &[u8], ip: IpAddr) -> Result<NetworkClassEvidence, String> {
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
    Ok(to_evidence(entry))
}

fn to_evidence(entry: ProxycheckEntry) -> NetworkClassEvidence {
    let network = entry.network.unwrap_or_default();
    let explicit_hosting = entry.detections.and_then(|value| value.hosting);
    let mut signals = signals_for_network_type(network.network_type.as_deref());
    if explicit_hosting == Some(true) && !signals.contains(&NetworkClassSignal::DataCenter) {
        signals.push(NetworkClassSignal::DataCenter);
    }
    let type_is_hosting = network
        .network_type
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("hosting"));
    NetworkClassEvidence {
        provider: PROVIDER.to_string(),
        status: CheckStatus::Success,
        verdict: verdict_for_signals(&signals),
        signals,
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
        error: None,
    }
}

fn signals_for_network_type(network_type: Option<&str>) -> Vec<NetworkClassSignal> {
    match network_type.map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "residential" => vec![NetworkClassSignal::Residential],
        Some(value) if value == "hosting" => vec![NetworkClassSignal::DataCenter],
        Some(value) if value == "wireless" => vec![NetworkClassSignal::Mobile],
        Some(value) if value == "business" => vec![NetworkClassSignal::Business],
        Some(_) => vec![NetworkClassSignal::Other],
        None => Vec::new(),
    }
}

fn verdict_for_signals(signals: &[NetworkClassSignal]) -> NetworkClassVerdict {
    if signals.len() > 1 {
        return NetworkClassVerdict::Mixed;
    }
    match signals.first() {
        Some(NetworkClassSignal::Residential) => NetworkClassVerdict::Residential,
        Some(NetworkClassSignal::DataCenter) => NetworkClassVerdict::DataCenter,
        Some(NetworkClassSignal::Mobile) => NetworkClassVerdict::Mobile,
        Some(NetworkClassSignal::Business) => NetworkClassVerdict::Business,
        Some(NetworkClassSignal::Other) => NetworkClassVerdict::Other,
        None => NetworkClassVerdict::Unknown,
    }
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

fn unavailable(error: String) -> NetworkClassEvidence {
    NetworkClassEvidence {
        provider: PROVIDER.to_string(),
        status: CheckStatus::Unavailable,
        verdict: NetworkClassVerdict::Unknown,
        signals: Vec::new(),
        user_type: None,
        is_hosting_provider: None,
        connection_type: None,
        isp: None,
        organization: None,
        autonomous_system_number: None,
        network: None,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(network_type: Option<&str>, hosting: Option<bool>) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "status": "ok",
            "203.0.113.8": {
                "network": {
                    "asn": "AS64500",
                    "range": "203.0.113.0/24",
                    "provider": "Example ISP",
                    "organisation": "Example Network",
                    "type": network_type
                },
                "detections": { "hosting": hosting }
            }
        }))
        .unwrap()
    }

    #[test]
    fn maps_explicit_network_types_and_keeps_hosting_conflicts() {
        let ip = "203.0.113.8".parse().unwrap();
        let residential = parse_response(&body(Some("Residential"), Some(false)), ip).unwrap();
        assert_eq!(residential.verdict, NetworkClassVerdict::Residential);
        assert_eq!(residential.autonomous_system_number, Some(64500));

        let conflict = parse_response(&body(Some("Residential"), Some(true)), ip).unwrap();
        assert_eq!(conflict.verdict, NetworkClassVerdict::Mixed);
        assert_eq!(
            conflict.signals,
            vec![
                NetworkClassSignal::Residential,
                NetworkClassSignal::DataCenter
            ]
        );
    }
}
