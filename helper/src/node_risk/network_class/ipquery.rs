use std::{net::IpAddr, time::Duration};

use reqwest::{header, Client};
use serde::Deserialize;
use tokio::time::timeout;

use crate::node_risk::types::{
    CheckStatus, NetworkClassEvidence, NetworkClassSignal, NetworkClassVerdict,
};

pub(super) const PROVIDER: &str = "ipquery.io API";

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

pub(super) async fn detect(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    endpoint_base: &str,
) -> NetworkClassEvidence {
    match query(client, ip, request_timeout, endpoint_base).await {
        Ok(evidence) => evidence,
        Err(error) => unavailable(error),
    }
}

async fn query(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    endpoint_base: &str,
) -> Result<NetworkClassEvidence, String> {
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
    parse_response(&body)
}

fn parse_response(body: &[u8]) -> Result<NetworkClassEvidence, String> {
    let response = serde_json::from_slice::<IpqueryResponse>(body)
        .map_err(|error| format!("decode ipquery.io response: {error}"))?;
    let isp = response.isp.unwrap_or_default();
    let risk = response.risk.unwrap_or_default();
    let mut signals = Vec::new();
    if risk.is_mobile == Some(true) {
        signals.push(NetworkClassSignal::Mobile);
    }
    if risk.is_datacenter == Some(true) {
        signals.push(NetworkClassSignal::DataCenter);
    }
    let verdict = verdict_for_signals(&signals);
    let connection_type = match verdict {
        NetworkClassVerdict::DataCenter => Some("Hosting".to_string()),
        NetworkClassVerdict::Mobile => Some("Wireless".to_string()),
        NetworkClassVerdict::Mixed => Some("Wireless / Hosting".to_string()),
        _ => None,
    };
    Ok(NetworkClassEvidence {
        provider: PROVIDER.to_string(),
        status: CheckStatus::Success,
        verdict,
        signals,
        user_type: connection_type.as_ref().map(|value| value.to_lowercase()),
        is_hosting_provider: risk.is_datacenter,
        connection_type,
        isp: isp.isp,
        organization: isp.org,
        autonomous_system_number: isp.asn.as_deref().and_then(parse_asn),
        network: None,
        error: None,
    })
}

fn verdict_for_signals(signals: &[NetworkClassSignal]) -> NetworkClassVerdict {
    if signals.len() > 1 {
        return NetworkClassVerdict::Mixed;
    }
    match signals.first() {
        Some(NetworkClassSignal::Mobile) => NetworkClassVerdict::Mobile,
        Some(NetworkClassSignal::DataCenter) => NetworkClassVerdict::DataCenter,
        _ => NetworkClassVerdict::Unknown,
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

    #[test]
    fn negative_risk_flags_do_not_infer_residential() {
        let evidence = parse_response(
            br#"{"isp":{"asn":"AS64500","org":"Example","isp":"Example"},"risk":{"is_mobile":false,"is_datacenter":false}}"#,
        )
        .unwrap();
        assert_eq!(evidence.status, CheckStatus::Success);
        assert_eq!(evidence.verdict, NetworkClassVerdict::Unknown);
        assert!(evidence.signals.is_empty());
    }
}
