use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use chrono::Local;

use super::types::{AddressScopeKind, AddressScopeResult, CheckStatus};

const SOURCE_NAME: &str = "IANA IPv4/IPv6 Special-Purpose Address Registries (RFC 6890)";

pub fn classify(ip: IpAddr) -> AddressScopeResult {
    let (classification, globally_reachable) = match ip {
        IpAddr::V4(ip) => classify_ipv4(ip),
        IpAddr::V6(ip) => classify_ipv6(ip),
    };
    AddressScopeResult {
        status: CheckStatus::Success,
        classification: Some(classification),
        globally_reachable,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

pub fn unavailable(reason: impl Into<String>) -> AddressScopeResult {
    AddressScopeResult {
        status: CheckStatus::Unavailable,
        classification: None,
        globally_reachable: None,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: Some(reason.into()),
    }
}

fn classify_ipv4(ip: Ipv4Addr) -> (AddressScopeKind, Option<bool>) {
    if ip.is_unspecified() {
        return (AddressScopeKind::Unspecified, Some(false));
    }
    if ipv4_in(ip, [0, 0, 0, 0], 8) {
        return (AddressScopeKind::OtherSpecial, Some(false));
    }
    if ip.is_private() {
        return (AddressScopeKind::Private, Some(false));
    }
    if ipv4_in(ip, [100, 64, 0, 0], 10) {
        return (AddressScopeKind::Shared, Some(false));
    }
    if ip.is_loopback() {
        return (AddressScopeKind::Loopback, Some(false));
    }
    if ip.is_link_local() {
        return (AddressScopeKind::LinkLocal, Some(false));
    }
    if ip.is_documentation() {
        return (AddressScopeKind::Documentation, Some(false));
    }
    if ipv4_in(ip, [198, 18, 0, 0], 15) {
        return (AddressScopeKind::Benchmark, Some(false));
    }
    if ip.is_broadcast() {
        return (AddressScopeKind::Broadcast, Some(false));
    }
    if ip.is_multicast() {
        return (AddressScopeKind::Multicast, Some(false));
    }
    if ipv4_in(ip, [240, 0, 0, 0], 4) {
        return (AddressScopeKind::Reserved, Some(false));
    }

    // These IANA protocol assignments are special-purpose but explicitly
    // globally reachable. They must not be collapsed into the non-routable
    // 192.0.0.0/24 and 192.88.99.0/24 parent blocks.
    if ip == Ipv4Addr::new(192, 0, 0, 9)
        || ip == Ipv4Addr::new(192, 0, 0, 10)
        || ipv4_in(ip, [192, 31, 196, 0], 24)
        || ipv4_in(ip, [192, 52, 193, 0], 24)
        || ipv4_in(ip, [192, 175, 48, 0], 24)
    {
        return (AddressScopeKind::OtherSpecial, Some(true));
    }
    if ipv4_in(ip, [192, 0, 0, 0], 24) || ip == Ipv4Addr::new(192, 88, 99, 2) {
        return (AddressScopeKind::OtherSpecial, Some(false));
    }
    if ipv4_in(ip, [192, 88, 99, 0], 24) {
        return (AddressScopeKind::OtherSpecial, None);
    }

    (AddressScopeKind::GlobalUnicast, Some(true))
}

fn classify_ipv6(ip: Ipv6Addr) -> (AddressScopeKind, Option<bool>) {
    if ip.is_unspecified() {
        return (AddressScopeKind::Unspecified, Some(false));
    }
    if ip.is_loopback() {
        return (AddressScopeKind::Loopback, Some(false));
    }
    if ip.to_ipv4_mapped().is_some() {
        return (AddressScopeKind::Ipv4Mapped, Some(false));
    }
    if ipv6_in(ip, "64:ff9b::".parse().expect("valid NAT64 prefix"), 96) {
        return (AddressScopeKind::Nat64, Some(true));
    }
    if ipv6_in(
        ip,
        "64:ff9b:1::".parse().expect("valid local NAT64 prefix"),
        48,
    ) {
        return (AddressScopeKind::Nat64, Some(false));
    }
    if ip.is_unique_local() {
        return (AddressScopeKind::UniqueLocal, Some(false));
    }
    if ip.is_unicast_link_local() {
        return (AddressScopeKind::LinkLocal, Some(false));
    }
    if ipv6_in(
        ip,
        "2001:db8::".parse().expect("valid documentation prefix"),
        32,
    ) || ipv6_in(
        ip,
        "3fff::".parse().expect("valid documentation prefix"),
        20,
    ) {
        return (AddressScopeKind::Documentation, Some(false));
    }
    if ipv6_in(ip, "2001:2::".parse().expect("valid benchmark prefix"), 48) {
        return (AddressScopeKind::Benchmark, Some(false));
    }
    if ip.is_multicast() {
        return (AddressScopeKind::Multicast, Some(false));
    }
    if ipv6_in(ip, "100::".parse().expect("valid discard prefix"), 64)
        || ipv6_in(
            ip,
            "100:0:0:1::".parse().expect("valid dummy IPv6 prefix"),
            64,
        )
        || ipv6_in(
            ip,
            "5f00::".parse().expect("valid segment routing prefix"),
            16,
        )
    {
        return (AddressScopeKind::OtherSpecial, Some(false));
    }

    let globally_reachable_ietf_assignments = ip
        == "2001:1::1"
            .parse::<Ipv6Addr>()
            .expect("valid PCP anycast address")
        || ip
            == "2001:1::2"
                .parse::<Ipv6Addr>()
                .expect("valid TURN anycast address")
        || ip
            == "2001:1::3"
                .parse::<Ipv6Addr>()
                .expect("valid DNS-SD anycast address")
        || ipv6_in(ip, "2001:3::".parse().unwrap(), 32)
        || ipv6_in(ip, "2001:4:112::".parse().unwrap(), 48)
        || ipv6_in(ip, "2001:20::".parse().unwrap(), 28)
        || ipv6_in(ip, "2001:30::".parse().unwrap(), 28);
    if globally_reachable_ietf_assignments || ipv6_in(ip, "2620:4f:8000::".parse().unwrap(), 48) {
        return (AddressScopeKind::OtherSpecial, Some(true));
    }
    if ipv6_in(ip, "2001::".parse().expect("valid Teredo prefix"), 32)
        || ipv6_in(
            ip,
            "2001:10::".parse().expect("valid deprecated ORCHID prefix"),
            28,
        )
        || ipv6_in(ip, "2002::".parse().expect("valid 6to4 prefix"), 16)
    {
        return (AddressScopeKind::OtherSpecial, None);
    }
    if ipv6_in(
        ip,
        "2001::".parse().expect("valid IETF assignments prefix"),
        23,
    ) {
        return (AddressScopeKind::OtherSpecial, Some(false));
    }

    (AddressScopeKind::GlobalUnicast, Some(true))
}

fn ipv4_in(ip: Ipv4Addr, network: [u8; 4], prefix_len: u8) -> bool {
    let ip = u32::from(ip);
    let network = u32::from(Ipv4Addr::from(network));
    let mask = if prefix_len == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_len)
    };
    ip & mask == network & mask
}

fn ipv6_in(ip: Ipv6Addr, network: Ipv6Addr, prefix_len: u8) -> bool {
    let ip = u128::from(ip);
    let network = u128::from(network);
    let mask = if prefix_len == 0 {
        0
    } else {
        u128::MAX << (128 - prefix_len)
    };
    ip & mask == network & mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_ipv4_special_purpose_ranges_independently() {
        let cases = [
            ("0.0.0.0", AddressScopeKind::Unspecified, Some(false)),
            ("10.1.2.3", AddressScopeKind::Private, Some(false)),
            ("100.64.1.2", AddressScopeKind::Shared, Some(false)),
            ("127.0.0.1", AddressScopeKind::Loopback, Some(false)),
            ("169.254.1.1", AddressScopeKind::LinkLocal, Some(false)),
            ("192.0.2.1", AddressScopeKind::Documentation, Some(false)),
            ("198.18.0.1", AddressScopeKind::Benchmark, Some(false)),
            ("224.0.0.1", AddressScopeKind::Multicast, Some(false)),
            ("255.255.255.255", AddressScopeKind::Broadcast, Some(false)),
            ("240.0.0.1", AddressScopeKind::Reserved, Some(false)),
            ("192.0.0.9", AddressScopeKind::OtherSpecial, Some(true)),
            ("192.0.0.8", AddressScopeKind::OtherSpecial, Some(false)),
            ("192.88.99.2", AddressScopeKind::OtherSpecial, Some(false)),
            ("192.88.99.1", AddressScopeKind::OtherSpecial, None),
            ("8.8.8.8", AddressScopeKind::GlobalUnicast, Some(true)),
        ];

        for (raw, expected_kind, expected_global) in cases {
            let result = classify(raw.parse().unwrap());
            assert_eq!(result.classification, Some(expected_kind), "{raw}");
            assert_eq!(result.globally_reachable, expected_global, "{raw}");
        }
    }

    #[test]
    fn classifies_ipv6_special_purpose_ranges_independently() {
        let cases = [
            ("::", AddressScopeKind::Unspecified, Some(false)),
            ("::1", AddressScopeKind::Loopback, Some(false)),
            (
                "::ffff:192.0.2.1",
                AddressScopeKind::Ipv4Mapped,
                Some(false),
            ),
            ("64:ff9b::1", AddressScopeKind::Nat64, Some(true)),
            ("64:ff9b:1::1", AddressScopeKind::Nat64, Some(false)),
            ("100:0:0:1::1", AddressScopeKind::OtherSpecial, Some(false)),
            ("fd00::1", AddressScopeKind::UniqueLocal, Some(false)),
            ("fe80::1", AddressScopeKind::LinkLocal, Some(false)),
            ("2001:db8::1", AddressScopeKind::Documentation, Some(false)),
            ("2001:2::1", AddressScopeKind::Benchmark, Some(false)),
            ("2001:1::3", AddressScopeKind::OtherSpecial, Some(true)),
            ("2001:20::1", AddressScopeKind::OtherSpecial, Some(true)),
            ("2001:30::1", AddressScopeKind::OtherSpecial, Some(true)),
            ("2001:100::1", AddressScopeKind::OtherSpecial, Some(false)),
            ("2001::1", AddressScopeKind::OtherSpecial, None),
            ("2001:10::1", AddressScopeKind::OtherSpecial, None),
            ("2002::1", AddressScopeKind::OtherSpecial, None),
            (
                "2620:4f:8000::1",
                AddressScopeKind::OtherSpecial,
                Some(true),
            ),
            ("5f00::1", AddressScopeKind::OtherSpecial, Some(false)),
            ("ff02::1", AddressScopeKind::Multicast, Some(false)),
            (
                "2001:4860:4860::8888",
                AddressScopeKind::GlobalUnicast,
                Some(true),
            ),
        ];

        for (raw, expected_kind, expected_global) in cases {
            let result = classify(raw.parse().unwrap());
            assert_eq!(result.classification, Some(expected_kind), "{raw}");
            assert_eq!(result.globally_reachable, expected_global, "{raw}");
        }
    }

    #[test]
    fn unavailable_is_not_reported_as_globally_reachable() {
        let result = unavailable("exit IP unavailable");
        assert_eq!(result.status, CheckStatus::Unavailable);
        assert_eq!(result.classification, None);
        assert_eq!(result.globally_reachable, None);
    }
}
