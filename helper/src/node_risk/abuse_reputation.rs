use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::{header, Client};
use serde::Deserialize;
use tokio::time::timeout;

use super::types::{AbuseReputationResult, AbuseVerdict, CheckStatus};

const ENDPOINT: &str = "https://api.abuseipdb.com/api/v2/check";
const SOURCE_NAME: &str = "AbuseIPDB API v2 CHECK (90 day window)";
const MAX_AGE_DAYS: &str = "90";
const HIGH_CONFIDENCE_THRESHOLD: u8 = 75;

#[derive(Debug, Deserialize)]
struct AbuseResponse {
    data: AbuseData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbuseData {
    abuse_confidence_score: Option<u8>,
    total_reports: Option<u64>,
    num_distinct_users: Option<u64>,
    last_reported_at: Option<String>,
    is_tor: Option<bool>,
    is_whitelisted: Option<bool>,
    usage_type: Option<String>,
    isp: Option<String>,
    country_code: Option<String>,
}

pub async fn detect(
    client: &Client,
    ip: IpAddr,
    api_key: Option<&str>,
    request_timeout: Duration,
) -> AbuseReputationResult {
    detect_at_url(client, ip, api_key, request_timeout, ENDPOINT).await
}

pub fn unavailable(reason: impl Into<String>) -> AbuseReputationResult {
    failure(CheckStatus::Unavailable, reason)
}

pub fn not_configured() -> AbuseReputationResult {
    failure(
        CheckStatus::NotConfigured,
        "SINGDECK_ABUSEIPDB_KEY is not configured",
    )
}

async fn detect_at_url(
    client: &Client,
    ip: IpAddr,
    api_key: Option<&str>,
    request_timeout: Duration,
    endpoint: &str,
) -> AbuseReputationResult {
    let Some(api_key) = api_key.map(str::trim).filter(|key| !key.is_empty()) else {
        return not_configured();
    };
    let response = match timeout(
        request_timeout,
        client
            .get(endpoint)
            .query(&[
                ("ipAddress", ip.to_string()),
                ("maxAgeInDays", MAX_AGE_DAYS.to_string()),
            ])
            .header("Key", api_key)
            .header(header::ACCEPT, "application/json")
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("AbuseIPDB request failed: {error}"),
            )
        }
        Err(_) => return failure(CheckStatus::Unavailable, "AbuseIPDB request timed out"),
    };
    let status = response.status();
    if !status.is_success() {
        return failure(
            CheckStatus::Unavailable,
            format!("AbuseIPDB returned HTTP {status}"),
        );
    }
    let body = match timeout(request_timeout, response.bytes()).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                format!("read AbuseIPDB response: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                "read AbuseIPDB response timed out",
            )
        }
    };
    parse_response(&body)
}

fn parse_response(body: &[u8]) -> AbuseReputationResult {
    let response = match serde_json::from_slice::<AbuseResponse>(body) {
        Ok(response) => response,
        Err(error) => {
            return failure(
                CheckStatus::Error,
                format!("decode AbuseIPDB response: {error}"),
            )
        }
    };
    let Some(verdict) = verdict(
        response.data.abuse_confidence_score,
        response.data.total_reports,
    ) else {
        return failure(
            CheckStatus::Error,
            "AbuseIPDB response omitted confidence score and report count",
        );
    };
    AbuseReputationResult {
        status: CheckStatus::Success,
        verdict,
        abuse_confidence_score: response.data.abuse_confidence_score,
        total_reports: response.data.total_reports,
        distinct_reporters: response.data.num_distinct_users,
        last_reported_at: response.data.last_reported_at,
        is_tor: response.data.is_tor,
        is_whitelisted: response.data.is_whitelisted,
        usage_type: response.data.usage_type,
        isp: response.data.isp,
        country_code: response.data.country_code,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn verdict(score: Option<u8>, total_reports: Option<u64>) -> Option<AbuseVerdict> {
    if score.is_none() && total_reports.is_none() {
        return None;
    }
    let score = score.unwrap_or(0);
    let total_reports = total_reports.unwrap_or(0);
    Some(if score >= HIGH_CONFIDENCE_THRESHOLD {
        AbuseVerdict::HighConfidence
    } else if score > 0 || total_reports > 0 {
        AbuseVerdict::Reported
    } else {
        AbuseVerdict::NoReports
    })
}

fn failure(status: CheckStatus, error: impl Into<String>) -> AbuseReputationResult {
    AbuseReputationResult {
        status,
        verdict: AbuseVerdict::Unknown,
        abuse_confidence_score: None,
        total_reports: None,
        distinct_reporters: None,
        last_reported_at: None,
        is_tor: None,
        is_whitelisted: None,
        usage_type: None,
        isp: None,
        country_code: None,
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
    fn applies_only_the_documented_high_confidence_boundary() {
        assert_eq!(verdict(Some(0), Some(0)), Some(AbuseVerdict::NoReports));
        assert_eq!(verdict(Some(24), Some(3)), Some(AbuseVerdict::Reported));
        assert_eq!(verdict(Some(74), Some(10)), Some(AbuseVerdict::Reported));
        assert_eq!(
            verdict(Some(75), Some(10)),
            Some(AbuseVerdict::HighConfidence)
        );
        assert_eq!(verdict(None, None), None);
    }

    #[tokio::test]
    async fn missing_key_is_explicitly_not_configured() {
        let result = detect_at_url(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            None,
            Duration::from_millis(10),
            "http://127.0.0.1:1",
        )
        .await;

        assert_eq!(result.status, CheckStatus::NotConfigured);
        assert_eq!(result.verdict, AbuseVerdict::Unknown);
    }

    #[test]
    fn parses_reputation_evidence_without_verbose_reports() {
        let result = parse_response(
            br#"{
              "data": {
                "abuseConfidenceScore": 82,
                "totalReports": 14,
                "numDistinctUsers": 8,
                "lastReportedAt": "2026-08-20T10:00:00+00:00",
                "isTor": false,
                "isWhitelisted": false,
                "usageType": "Data Center/Web Hosting/Transit",
                "isp": "Example Hosting",
                "countryCode": "US"
              }
            }"#,
        );

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.verdict, AbuseVerdict::HighConfidence);
        assert_eq!(result.abuse_confidence_score, Some(82));
        assert_eq!(result.distinct_reporters, Some(8));
    }

    #[tokio::test]
    async fn api_key_is_a_header_and_query_is_bounded_to_90_days() {
        let captured = Arc::new(Mutex::new(String::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let captured_clone = captured.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let read = stream.read(&mut request).await.unwrap();
            *captured_clone.lock().unwrap() = String::from_utf8_lossy(&request[..read]).to_string();
            let body = r#"{"data":{"abuseConfidenceScore":0,"totalReports":0}}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let result = detect_at_url(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            Some("secret-key"),
            Duration::from_secs(1),
            &format!("http://{address}/check"),
        )
        .await;

        assert_eq!(result.verdict, AbuseVerdict::NoReports);
        let request = captured.lock().unwrap();
        assert!(request.contains("ipAddress=203.0.113.8"));
        assert!(request.contains("maxAgeInDays=90"));
        assert!(request.contains("key: secret-key"));
        assert!(!request.lines().next().unwrap().contains("secret-key"));
        assert!(!request.contains("verbose="));
    }
}
