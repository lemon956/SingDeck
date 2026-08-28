pub mod abuse_reputation;
pub mod address_scope;
pub mod exit_ip;
pub mod ip_privacy;
pub mod network_class;
pub mod network_identity;
pub mod rpki;
pub mod tor_exit;
pub mod types;

use std::{env, net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;

use crate::sing_box_outbound::SingBoxOutboundFetcher;

use self::types::{ExitIpResult, NodeRiskChecks, NodeRiskReport};

#[derive(Clone, Default)]
pub struct ProviderConfig {
    ipinfo_token: Option<String>,
    abuseipdb_key: Option<String>,
    proxycheck_key: Option<String>,
}

impl ProviderConfig {
    pub fn from_env() -> Self {
        Self {
            ipinfo_token: non_empty_env("SINGDECK_IPINFO_TOKEN"),
            abuseipdb_key: non_empty_env("SINGDECK_ABUSEIPDB_KEY"),
            proxycheck_key: non_empty_env("SINGDECK_PROXYCHECK_KEY"),
        }
    }
}

pub async fn assess_outbound_node(
    client: &Client,
    fetcher: &SingBoxOutboundFetcher,
    outbound: &str,
    probe_timeout: Duration,
    provider_timeout: Duration,
    checks: NodeRiskChecks,
    config: &ProviderConfig,
) -> NodeRiskReport {
    if !checks.any() {
        return empty_report(checks);
    }
    let exit_ip = exit_ip::detect(fetcher, outbound, probe_timeout).await;
    let ip = exit_ip.ip.as_deref().and_then(|value| value.parse().ok());
    let Some(ip) = ip else {
        let reason = exit_ip
            .error
            .clone()
            .unwrap_or_else(|| "exit IP probe returned no valid IP address".to_string());
        return unavailable_report(exit_ip, checks, config, reason);
    };

    assess_ip(client, exit_ip, ip, provider_timeout, checks, config).await
}

pub fn probe_error_report(
    reason: impl Into<String>,
    checks: NodeRiskChecks,
    config: &ProviderConfig,
) -> NodeRiskReport {
    let reason = reason.into();
    if !checks.any() {
        return empty_report(checks);
    }
    unavailable_report(exit_ip::unavailable(reason.clone()), checks, config, reason)
}

async fn assess_ip(
    client: &Client,
    exit_ip: ExitIpResult,
    ip: IpAddr,
    provider_timeout: Duration,
    checks: NodeRiskChecks,
    config: &ProviderConfig,
) -> NodeRiskReport {
    let address_scope = checks.address_scope.then(|| address_scope::classify(ip));
    let (network_identity, network_class, route_security, tor, privacy, abuse) = tokio::join!(
        async {
            if checks.network_identity {
                Some(network_identity::detect(client, ip, provider_timeout).await)
            } else {
                None
            }
        },
        async {
            if checks.network_class {
                Some(
                    network_class::detect(
                        client,
                        ip,
                        config.proxycheck_key.as_deref(),
                        provider_timeout,
                    )
                    .await,
                )
            } else {
                None
            }
        },
        async {
            if checks.route_security {
                Some(rpki::detect(client, ip, provider_timeout).await)
            } else {
                None
            }
        },
        async {
            if checks.tor {
                Some(tor_exit::detect(client, ip, provider_timeout).await)
            } else {
                None
            }
        },
        async {
            if checks.privacy {
                Some(
                    ip_privacy::detect(
                        client,
                        ip,
                        config.ipinfo_token.as_deref(),
                        provider_timeout,
                    )
                    .await,
                )
            } else {
                None
            }
        },
        async {
            if checks.abuse {
                Some(
                    abuse_reputation::detect(
                        client,
                        ip,
                        config.abuseipdb_key.as_deref(),
                        provider_timeout,
                    )
                    .await,
                )
            } else {
                None
            }
        },
    );
    NodeRiskReport {
        checks,
        exit_ip: checks.exit_ip.then_some(exit_ip),
        address_scope,
        network_identity,
        network_class,
        route_security,
        tor,
        privacy,
        abuse,
        assessed_at: Local::now().to_rfc3339(),
    }
}

fn unavailable_report(
    exit_ip: ExitIpResult,
    checks: NodeRiskChecks,
    config: &ProviderConfig,
    reason: impl Into<String>,
) -> NodeRiskReport {
    let reason = reason.into();
    NodeRiskReport {
        checks,
        exit_ip: checks.exit_ip.then_some(exit_ip),
        address_scope: checks
            .address_scope
            .then(|| address_scope::unavailable(reason.clone())),
        network_identity: checks
            .network_identity
            .then(|| network_identity::unavailable(reason.clone())),
        network_class: checks
            .network_class
            .then(|| network_class::unavailable(reason.clone())),
        route_security: checks
            .route_security
            .then(|| rpki::unavailable(reason.clone())),
        tor: checks.tor.then(|| tor_exit::unavailable(reason.clone())),
        privacy: checks.privacy.then(|| {
            if config.ipinfo_token.is_some() {
                ip_privacy::unavailable(reason.clone())
            } else {
                ip_privacy::not_configured()
            }
        }),
        abuse: checks.abuse.then(|| {
            if config.abuseipdb_key.is_some() {
                abuse_reputation::unavailable(reason)
            } else {
                abuse_reputation::not_configured()
            }
        }),
        assessed_at: Local::now().to_rfc3339(),
    }
}

fn empty_report(checks: NodeRiskChecks) -> NodeRiskReport {
    NodeRiskReport {
        checks,
        exit_ip: None,
        address_scope: None,
        network_identity: None,
        network_class: None,
        route_security: None,
        tor: None,
        privacy: None,
        abuse: None,
        assessed_at: Local::now().to_rfc3339(),
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_risk::types::CheckStatus;

    #[test]
    fn outbound_probe_failure_preserves_independent_provider_statuses() {
        let report = probe_error_report(
            "outbound probe failed",
            NodeRiskChecks::all(),
            &ProviderConfig::default(),
        );

        assert_eq!(report.exit_ip.unwrap().status, CheckStatus::Unavailable);
        assert_eq!(
            report.address_scope.unwrap().status,
            CheckStatus::Unavailable
        );
        assert_eq!(
            report.network_identity.unwrap().status,
            CheckStatus::Unavailable
        );
        assert_eq!(
            report.network_class.unwrap().status,
            CheckStatus::Unavailable
        );
        assert_eq!(
            report.route_security.unwrap().status,
            CheckStatus::Unavailable
        );
        assert_eq!(report.tor.unwrap().status, CheckStatus::Unavailable);
        assert_eq!(report.privacy.unwrap().status, CheckStatus::NotConfigured);
        assert_eq!(report.abuse.unwrap().status, CheckStatus::NotConfigured);
    }

    #[test]
    fn outbound_probe_failure_marks_configured_providers_unavailable() {
        let config = ProviderConfig {
            ipinfo_token: Some("configured".to_string()),
            abuseipdb_key: Some("configured".to_string()),
            proxycheck_key: Some("configured".to_string()),
        };
        let report = probe_error_report("outbound probe failed", NodeRiskChecks::all(), &config);

        assert_eq!(report.privacy.unwrap().status, CheckStatus::Unavailable);
        assert_eq!(report.abuse.unwrap().status, CheckStatus::Unavailable);
        assert_eq!(
            report.network_class.unwrap().status,
            CheckStatus::Unavailable
        );
    }

    #[tokio::test]
    async fn only_selected_checks_produce_results() {
        let checks = NodeRiskChecks {
            exit_ip: true,
            address_scope: true,
            ..NodeRiskChecks::default()
        };
        let exit_ip = ExitIpResult {
            status: CheckStatus::Success,
            ip: Some("203.0.113.10".to_string()),
            port: Some(443),
            family: Some(types::AddressFamily::Ipv4),
            source: "test".to_string(),
            checked_at: "2026-08-26T00:00:00Z".to_string(),
            error: None,
        };

        let report = assess_ip(
            &Client::new(),
            exit_ip,
            "203.0.113.10".parse().unwrap(),
            Duration::from_millis(1),
            checks,
            &ProviderConfig::default(),
        )
        .await;

        assert!(report.exit_ip.is_some());
        assert!(report.address_scope.is_some());
        assert!(report.network_identity.is_none());
        assert!(report.network_class.is_none());
        assert!(report.route_security.is_none());
        assert!(report.tor.is_none());
        assert!(report.privacy.is_none());
        assert!(report.abuse.is_none());
    }

    #[tokio::test]
    async fn selected_network_class_does_not_enable_other_provider_checks() {
        let checks = NodeRiskChecks {
            network_class: true,
            ..NodeRiskChecks::default()
        };
        let exit_ip = ExitIpResult {
            status: CheckStatus::Success,
            ip: Some("203.0.113.10".to_string()),
            port: Some(443),
            family: Some(types::AddressFamily::Ipv4),
            source: "test".to_string(),
            checked_at: "2026-08-26T00:00:00Z".to_string(),
            error: None,
        };

        let report = assess_ip(
            &Client::new(),
            exit_ip,
            "203.0.113.10".parse().unwrap(),
            Duration::from_millis(1),
            checks,
            &ProviderConfig::default(),
        )
        .await;

        assert_eq!(
            report.network_class.unwrap().status,
            CheckStatus::Unavailable
        );
        assert!(report.exit_ip.is_none());
        assert!(report.network_identity.is_none());
        assert!(report.route_security.is_none());
        assert!(report.tor.is_none());
        assert!(report.privacy.is_none());
        assert!(report.abuse.is_none());
    }
}
