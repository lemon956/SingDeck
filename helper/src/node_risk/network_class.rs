mod ipquery;
mod proxycheck;

use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;

use super::types::{
    CheckStatus, NetworkClassEvidence, NetworkClassResult, NetworkClassSignal, NetworkClassVerdict,
};

const PROXYCHECK_ENDPOINT_BASE: &str = "https://proxycheck.io/v3";
const IPQUERY_ENDPOINT_BASE: &str = "https://api.ipquery.io";
const COMBINED_SOURCE: &str = "independent proxycheck.io and ipquery.io evidence";

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
    failure(Vec::new(), reason)
}

async fn detect_at_endpoints(
    client: &Client,
    ip: IpAddr,
    proxycheck_key: Option<&str>,
    request_timeout: Duration,
    proxycheck_endpoint_base: &str,
    ipquery_endpoint_base: &str,
) -> NetworkClassResult {
    let (proxycheck, ipquery) = tokio::join!(
        proxycheck::detect(
            client,
            ip,
            proxycheck_key,
            request_timeout,
            proxycheck_endpoint_base,
        ),
        ipquery::detect(client, ip, request_timeout, ipquery_endpoint_base),
    );
    aggregate(vec![proxycheck, ipquery])
}

fn aggregate(evidence: Vec<NetworkClassEvidence>) -> NetworkClassResult {
    let successful = evidence
        .iter()
        .filter(|item| item.status == CheckStatus::Success)
        .collect::<Vec<_>>();
    if successful.is_empty() {
        let errors = evidence
            .iter()
            .filter_map(|item| {
                item.error
                    .as_deref()
                    .map(|error| format!("{}: {error}", item.provider))
            })
            .collect::<Vec<_>>();
        return failure(
            evidence,
            if errors.is_empty() {
                "network classification providers returned no evidence".to_string()
            } else {
                format!(
                    "network classification providers unavailable: {}",
                    errors.join("; ")
                )
            },
        );
    }

    let mut signals = Vec::new();
    for item in &successful {
        for signal in &item.signals {
            if !signals.contains(signal) {
                signals.push(*signal);
            }
        }
    }
    let verdict = verdict_for_signals(&signals);
    let source = evidence
        .iter()
        .map(|item| item.provider.as_str())
        .collect::<Vec<_>>()
        .join(" + ");

    NetworkClassResult {
        status: CheckStatus::Success,
        verdict,
        user_type: consensus_value(&successful, |item| item.user_type.as_ref()),
        is_hosting_provider: consensus_value(&successful, |item| item.is_hosting_provider.as_ref()),
        connection_type: consensus_value(&successful, |item| item.connection_type.as_ref()),
        isp: consensus_value(&successful, |item| item.isp.as_ref()),
        organization: consensus_value(&successful, |item| item.organization.as_ref()),
        autonomous_system_number: consensus_value(&successful, |item| {
            item.autonomous_system_number.as_ref()
        }),
        network: consensus_value(&successful, |item| item.network.as_ref()),
        user_count: None,
        evidence,
        source,
        checked_at: Local::now().to_rfc3339(),
        error: None,
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

fn consensus_value<T, F>(evidence: &[&NetworkClassEvidence], value: F) -> Option<T>
where
    T: Clone + Eq,
    F: Fn(&NetworkClassEvidence) -> Option<&T>,
{
    let mut consensus = None;
    for item in evidence {
        let Some(candidate) = value(item) else {
            continue;
        };
        match consensus.as_ref() {
            None => consensus = Some(candidate.clone()),
            Some(existing) if existing == candidate => {}
            Some(_) => return None,
        }
    }
    consensus
}

fn failure(evidence: Vec<NetworkClassEvidence>, error: impl Into<String>) -> NetworkClassResult {
    NetworkClassResult {
        status: CheckStatus::Unavailable,
        verdict: NetworkClassVerdict::Unknown,
        user_type: None,
        is_hosting_provider: None,
        connection_type: None,
        isp: None,
        organization: None,
        autonomous_system_number: None,
        network: None,
        user_count: None,
        evidence,
        source: COMBINED_SOURCE.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: Some(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn evidence(
        provider: &str,
        status: CheckStatus,
        signals: Vec<NetworkClassSignal>,
    ) -> NetworkClassEvidence {
        NetworkClassEvidence {
            provider: provider.to_string(),
            status,
            verdict: verdict_for_signals(&signals),
            signals,
            user_type: None,
            is_hosting_provider: None,
            connection_type: None,
            isp: None,
            organization: None,
            autonomous_system_number: None,
            network: None,
            error: (status != CheckStatus::Success).then(|| "provider failed".to_string()),
        }
    }

    #[test]
    fn aggregates_independent_evidence_without_provider_priority() {
        let result = aggregate(vec![
            evidence(
                proxycheck::PROVIDER,
                CheckStatus::Success,
                vec![NetworkClassSignal::Residential],
            ),
            evidence(ipquery::PROVIDER, CheckStatus::Success, Vec::new()),
        ]);
        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.verdict, NetworkClassVerdict::Residential);
        assert_eq!(result.evidence.len(), 2);

        let conflict = aggregate(vec![
            evidence(
                proxycheck::PROVIDER,
                CheckStatus::Success,
                vec![NetworkClassSignal::Residential],
            ),
            evidence(
                ipquery::PROVIDER,
                CheckStatus::Success,
                vec![NetworkClassSignal::DataCenter],
            ),
        ]);
        assert_eq!(conflict.verdict, NetworkClassVerdict::Mixed);
    }

    #[test]
    fn preserves_partial_and_total_provider_failures_as_evidence() {
        let partial = aggregate(vec![
            evidence(proxycheck::PROVIDER, CheckStatus::Unavailable, Vec::new()),
            evidence(
                ipquery::PROVIDER,
                CheckStatus::Success,
                vec![NetworkClassSignal::DataCenter],
            ),
        ]);
        assert_eq!(partial.status, CheckStatus::Success);
        assert_eq!(partial.verdict, NetworkClassVerdict::DataCenter);
        assert_eq!(partial.evidence[0].status, CheckStatus::Unavailable);

        let unavailable = aggregate(vec![
            evidence(proxycheck::PROVIDER, CheckStatus::Unavailable, Vec::new()),
            evidence(ipquery::PROVIDER, CheckStatus::Unavailable, Vec::new()),
        ]);
        assert_eq!(unavailable.status, CheckStatus::Unavailable);
        assert_eq!(unavailable.evidence.len(), 2);
    }

    async fn spawn_json_server(body: String, requests: Arc<AtomicUsize>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4_096];
            let _ = stream.read(&mut request).await.unwrap();
            requests.fetch_add(1, Ordering::SeqCst);
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn requests_both_providers_even_when_proxycheck_is_decisive() {
        let proxy_requests = Arc::new(AtomicUsize::new(0));
        let ipquery_requests = Arc::new(AtomicUsize::new(0));
        let proxy_endpoint = spawn_json_server(
            r#"{"status":"ok","203.0.113.8":{"network":{"type":"Residential"},"detections":{"hosting":false}}}"#.to_string(),
            proxy_requests.clone(),
        )
        .await;
        let ipquery_endpoint = spawn_json_server(
            r#"{"risk":{"is_mobile":false,"is_datacenter":false}}"#.to_string(),
            ipquery_requests.clone(),
        )
        .await;

        let result = detect_at_endpoints(
            &Client::new(),
            "203.0.113.8".parse().unwrap(),
            None,
            Duration::from_secs(1),
            &proxy_endpoint,
            &ipquery_endpoint,
        )
        .await;

        assert_eq!(result.verdict, NetworkClassVerdict::Residential);
        assert_eq!(proxy_requests.load(Ordering::SeqCst), 1);
        assert_eq!(ipquery_requests.load(Ordering::SeqCst), 1);
    }
}
