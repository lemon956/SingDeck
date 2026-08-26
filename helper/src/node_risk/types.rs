use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Success,
    NotConfigured,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRiskChecks {
    pub exit_ip: bool,
    pub address_scope: bool,
    pub network_identity: bool,
    pub network_class: bool,
    pub route_security: bool,
    pub tor: bool,
    pub privacy: bool,
    pub abuse: bool,
}

impl NodeRiskChecks {
    #[allow(dead_code)]
    pub fn all() -> Self {
        Self {
            exit_ip: true,
            address_scope: true,
            network_identity: true,
            network_class: true,
            route_security: true,
            tor: true,
            privacy: true,
            abuse: true,
        }
    }

    pub fn any(self) -> bool {
        self.exit_ip
            || self.address_scope
            || self.network_identity
            || self.network_class
            || self.route_security
            || self.tor
            || self.privacy
            || self.abuse
    }

    pub fn any_ip_dependent(self) -> bool {
        self.address_scope
            || self.network_identity
            || self.network_class
            || self.route_security
            || self.tor
            || self.privacy
            || self.abuse
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddressFamily {
    Ipv4,
    Ipv6,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExitIpResult {
    pub status: CheckStatus,
    pub ip: Option<String>,
    pub port: Option<u16>,
    pub family: Option<AddressFamily>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AddressScopeKind {
    GlobalUnicast,
    Unspecified,
    Private,
    Shared,
    Loopback,
    LinkLocal,
    Documentation,
    Benchmark,
    Multicast,
    Reserved,
    Broadcast,
    UniqueLocal,
    Ipv4Mapped,
    Nat64,
    OtherSpecial,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddressScopeResult {
    pub status: CheckStatus,
    pub classification: Option<AddressScopeKind>,
    pub globally_reachable: Option<bool>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkIdentityResult {
    pub status: CheckStatus,
    pub prefix: Option<String>,
    pub origin_asns: Vec<u32>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpkiValidity {
    Valid,
    InvalidAsn,
    InvalidLength,
    Unknown,
    Unrouted,
    Mixed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpkiOriginResult {
    pub asn: u32,
    pub check_status: CheckStatus,
    pub validity: RpkiValidity,
    pub description: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RpkiResult {
    pub status: CheckStatus,
    pub validity: Option<RpkiValidity>,
    pub prefix: Option<String>,
    pub origins: Vec<RpkiOriginResult>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TorVerdict {
    Exit,
    Relay,
    NotDetected,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TorRelayEvidence {
    pub fingerprint: String,
    pub nickname: Option<String>,
    pub exit_address_match: bool,
    pub exit_flag: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TorResult {
    pub status: CheckStatus,
    pub verdict: TorVerdict,
    pub relays: Vec<TorRelayEvidence>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrivacySignal {
    Anonymous,
    Vpn,
    Proxy,
    Tor,
    Relay,
    Hosting,
    ResidentialProxy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IpPrivacyResult {
    pub status: CheckStatus,
    pub signals: Vec<PrivacySignal>,
    pub service: Option<String>,
    pub confidence: Option<u8>,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NetworkClassVerdict {
    Residential,
    DataCenter,
    Mobile,
    Business,
    Other,
    Mixed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkClassResult {
    pub status: CheckStatus,
    pub verdict: NetworkClassVerdict,
    pub user_type: Option<String>,
    pub is_hosting_provider: Option<bool>,
    pub connection_type: Option<String>,
    pub isp: Option<String>,
    pub organization: Option<String>,
    pub autonomous_system_number: Option<u32>,
    pub network: Option<String>,
    pub user_count: Option<u64>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AbuseVerdict {
    NoReports,
    Reported,
    HighConfidence,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AbuseReputationResult {
    pub status: CheckStatus,
    pub verdict: AbuseVerdict,
    pub abuse_confidence_score: Option<u8>,
    pub total_reports: Option<u64>,
    pub distinct_reporters: Option<u64>,
    pub last_reported_at: Option<String>,
    pub is_tor: Option<bool>,
    pub is_whitelisted: Option<bool>,
    pub usage_type: Option<String>,
    pub isp: Option<String>,
    pub country_code: Option<String>,
    pub source: String,
    pub checked_at: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRiskReport {
    pub checks: NodeRiskChecks,
    pub exit_ip: Option<ExitIpResult>,
    pub address_scope: Option<AddressScopeResult>,
    pub network_identity: Option<NetworkIdentityResult>,
    pub network_class: Option<NetworkClassResult>,
    pub route_security: Option<RpkiResult>,
    pub tor: Option<TorResult>,
    pub privacy: Option<IpPrivacyResult>,
    pub abuse: Option<AbuseReputationResult>,
    pub assessed_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_checks_are_explicit_strict_and_default_to_false() {
        let checks: NodeRiskChecks = serde_json::from_value(serde_json::json!({
            "exitIp": true,
            "tor": true
        }))
        .unwrap();

        assert!(checks.exit_ip);
        assert!(checks.tor);
        assert!(!checks.address_scope);
        assert!(!checks.network_identity);
        assert!(!checks.network_class);
        assert!(!checks.route_security);
        assert!(!checks.privacy);
        assert!(!checks.abuse);
        assert!(checks.any());
        assert!(checks.any_ip_dependent());
        assert_eq!(NodeRiskChecks::default().any(), false);
        assert!(serde_json::from_value::<NodeRiskChecks>(serde_json::json!({
            "exitIP": true
        }))
        .is_err());
    }

    #[test]
    fn public_contract_uses_stable_camel_case_fields_and_snake_case_values() {
        let report = NodeRiskReport {
            checks: NodeRiskChecks {
                exit_ip: true,
                address_scope: true,
                network_identity: true,
                network_class: true,
                route_security: true,
                tor: true,
                privacy: true,
                abuse: false,
            },
            exit_ip: Some(ExitIpResult {
                status: CheckStatus::Success,
                ip: Some("203.0.113.10".to_string()),
                port: Some(443),
                family: Some(AddressFamily::Ipv4),
                source: "stun".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: None,
            }),
            address_scope: Some(AddressScopeResult {
                status: CheckStatus::Success,
                classification: Some(AddressScopeKind::Documentation),
                globally_reachable: Some(false),
                source: "iana".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: None,
            }),
            network_identity: Some(NetworkIdentityResult {
                status: CheckStatus::Unavailable,
                prefix: None,
                origin_asns: Vec::new(),
                source: "ripe".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: Some("unavailable".to_string()),
            }),
            network_class: Some(NetworkClassResult {
                status: CheckStatus::Success,
                verdict: NetworkClassVerdict::Residential,
                user_type: Some("residential".to_string()),
                is_hosting_provider: Some(false),
                connection_type: Some("Cable/DSL".to_string()),
                isp: Some("Example ISP".to_string()),
                organization: Some("Example ISP".to_string()),
                autonomous_system_number: Some(64500),
                network: Some("203.0.113.0/24".to_string()),
                user_count: Some(1),
                source: "maxmind".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: None,
            }),
            route_security: Some(RpkiResult {
                status: CheckStatus::Unavailable,
                validity: None,
                prefix: None,
                origins: Vec::new(),
                source: "ripe".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: Some("unavailable".to_string()),
            }),
            tor: Some(TorResult {
                status: CheckStatus::Success,
                verdict: TorVerdict::NotDetected,
                relays: Vec::new(),
                source: "tor".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: None,
            }),
            privacy: Some(IpPrivacyResult {
                status: CheckStatus::NotConfigured,
                signals: Vec::new(),
                service: None,
                confidence: None,
                first_seen: None,
                last_seen: None,
                source: "ipinfo".to_string(),
                checked_at: "2026-01-01T00:00:00Z".to_string(),
                error: Some("not configured".to_string()),
            }),
            abuse: None,
            assessed_at: "2026-01-01T00:00:00Z".to_string(),
        };

        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["exitIp"]["status"], "success");
        assert_eq!(value["exitIp"]["family"], "ipv4");
        assert_eq!(value["addressScope"]["classification"], "documentation");
        assert_eq!(value["networkClass"]["verdict"], "residential");
        assert_eq!(value["routeSecurity"]["status"], "unavailable");
        assert_eq!(value["privacy"]["status"], "not_configured");
        assert_eq!(value["checks"]["abuse"], false);
        assert_eq!(value["abuse"], serde_json::Value::Null);
    }
}
