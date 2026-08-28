use std::{net::IpAddr, time::Duration};

use chrono::Local;
use serde::Deserialize;

use crate::sing_box_outbound::SingBoxOutboundFetcher;

use super::types::{AddressFamily, CheckStatus, ExitIpResult};

pub const DEFAULT_EGRESS_IP_URL: &str = "https://api64.ipify.org?format=json";
const SOURCE_NAME: &str = "ipify HTTPS via sing-box outbound";

#[derive(Debug, Deserialize)]
struct IpifyResponse {
    ip: String,
}

pub async fn detect(
    fetcher: &SingBoxOutboundFetcher,
    outbound: &str,
    probe_timeout: Duration,
) -> ExitIpResult {
    let body = match fetcher
        .fetch(outbound, DEFAULT_EGRESS_IP_URL, probe_timeout)
        .await
    {
        Ok(body) => body,
        Err(error) => {
            return unavailable(format!(
                "observe exit IP through outbound {outbound:?}: {error:#}"
            ))
        }
    };
    parse_response(&body).unwrap_or_else(|error| {
        unavailable(format!(
            "decode exit IP response for outbound {outbound:?}: {error}"
        ))
    })
}

pub fn unavailable(reason: impl Into<String>) -> ExitIpResult {
    ExitIpResult {
        status: CheckStatus::Unavailable,
        ip: None,
        port: None,
        family: None,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: Some(reason.into()),
    }
}

fn parse_response(body: &[u8]) -> Result<ExitIpResult, String> {
    let response = serde_json::from_slice::<IpifyResponse>(body)
        .map_err(|error| format!("invalid ipify JSON: {error}"))?;
    let ip = response
        .ip
        .trim()
        .parse::<IpAddr>()
        .map_err(|error| format!("invalid public IP address: {error}"))?;
    Ok(ExitIpResult {
        status: CheckStatus::Success,
        ip: Some(ip.to_string()),
        port: None,
        family: Some(address_family(ip)),
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    })
}

fn address_family(ip: IpAddr) -> AddressFamily {
    match ip {
        IpAddr::V4(_) => AddressFamily::Ipv4,
        IpAddr::V6(_) => AddressFamily::Ipv6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_and_ipv6_ipify_responses() {
        let ipv4 = parse_response(br#"{"ip":"203.0.113.7"}"#).unwrap();
        assert_eq!(ipv4.ip.as_deref(), Some("203.0.113.7"));
        assert_eq!(ipv4.family, Some(AddressFamily::Ipv4));
        assert_eq!(ipv4.port, None);

        let ipv6 = parse_response(br#"{"ip":"2001:db8::7"}"#).unwrap();
        assert_eq!(ipv6.ip.as_deref(), Some("2001:db8::7"));
        assert_eq!(ipv6.family, Some(AddressFamily::Ipv6));
    }

    #[test]
    fn rejects_invalid_ipify_responses() {
        assert!(parse_response(br#"{"ip":"not-an-ip"}"#)
            .unwrap_err()
            .contains("invalid public IP"));
        assert!(parse_response(b"not-json")
            .unwrap_err()
            .contains("invalid ipify JSON"));
    }
}
