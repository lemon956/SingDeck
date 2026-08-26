use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::Local;
use tokio::{net::UdpSocket, time::timeout};

use super::types::{AddressFamily, CheckStatus, ExitIpResult};

pub const DEFAULT_STUN_SERVER: &str = "stun.l.google.com:19302";
const SOURCE_NAME: &str = "Google STUN (RFC 5389 XOR-MAPPED-ADDRESS)";
const STUN_BINDING_REQUEST: u16 = 0x0001;
const STUN_BINDING_SUCCESS: u16 = 0x0101;
const STUN_MAGIC_COOKIE: u32 = 0x2112_A442;
const STUN_MAPPED_ADDRESS: u16 = 0x0001;
const STUN_XOR_MAPPED_ADDRESS: u16 = 0x0020;
const STUN_HEADER_LEN: usize = 20;

static TRANSACTION_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn detect(probe_timeout: Duration) -> ExitIpResult {
    let checked_at = Local::now().to_rfc3339();
    let resolved = match timeout(probe_timeout, tokio::net::lookup_host(DEFAULT_STUN_SERVER)).await
    {
        Ok(Ok(addresses)) => prefer_ipv4(addresses.collect()),
        Ok(Err(error)) => {
            return failure(
                CheckStatus::Unavailable,
                checked_at,
                format!("resolve STUN server: {error}"),
            )
        }
        Err(_) => {
            return failure(
                CheckStatus::Unavailable,
                checked_at,
                "resolve STUN server timed out",
            )
        }
    };
    if resolved.is_empty() {
        return failure(
            CheckStatus::Unavailable,
            checked_at,
            "STUN server resolved without addresses",
        );
    }

    let mut errors = Vec::new();
    for server in resolved {
        match observe_at(server, probe_timeout).await {
            Ok(mapped) => {
                return ExitIpResult {
                    status: CheckStatus::Success,
                    ip: Some(mapped.ip().to_string()),
                    port: Some(mapped.port()),
                    family: Some(address_family(mapped.ip())),
                    source: SOURCE_NAME.to_string(),
                    checked_at: Local::now().to_rfc3339(),
                    error: None,
                }
            }
            Err(error) => errors.push(format!("{server}: {error}")),
        }
    }

    failure(
        CheckStatus::Unavailable,
        Local::now().to_rfc3339(),
        if errors.is_empty() {
            "STUN observation failed".to_string()
        } else {
            format!("STUN observation failed: {}", errors.join("; "))
        },
    )
}

fn prefer_ipv4(mut addresses: Vec<SocketAddr>) -> Vec<SocketAddr> {
    addresses.sort_by_key(|address| if address.is_ipv4() { 0 } else { 1 });
    addresses.dedup();
    addresses
}

pub fn unavailable(reason: impl Into<String>) -> ExitIpResult {
    failure(CheckStatus::Unavailable, Local::now().to_rfc3339(), reason)
}

async fn observe_at(server: SocketAddr, probe_timeout: Duration) -> Result<SocketAddr, String> {
    let bind_address = match server {
        SocketAddr::V4(_) => "0.0.0.0:0",
        SocketAddr::V6(_) => "[::]:0",
    };
    let socket = UdpSocket::bind(bind_address)
        .await
        .map_err(|error| format!("bind STUN socket: {error}"))?;
    socket
        .connect(server)
        .await
        .map_err(|error| format!("connect STUN socket: {error}"))?;

    let transaction_id = transaction_id();
    let request = binding_request(transaction_id);
    timeout(probe_timeout, socket.send(&request))
        .await
        .map_err(|_| "send STUN request timed out".to_string())?
        .map_err(|error| format!("send STUN request: {error}"))?;

    let mut response = [0_u8; 2_048];
    let received = timeout(probe_timeout, socket.recv(&mut response))
        .await
        .map_err(|_| "receive STUN response timed out".to_string())?
        .map_err(|error| format!("receive STUN response: {error}"))?;
    parse_binding_response(&response[..received], transaction_id)
}

fn binding_request(transaction_id: [u8; 12]) -> [u8; STUN_HEADER_LEN] {
    let mut request = [0_u8; STUN_HEADER_LEN];
    request[0..2].copy_from_slice(&STUN_BINDING_REQUEST.to_be_bytes());
    request[2..4].copy_from_slice(&0_u16.to_be_bytes());
    request[4..8].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
    request[8..20].copy_from_slice(&transaction_id);
    request
}

fn parse_binding_response(response: &[u8], transaction_id: [u8; 12]) -> Result<SocketAddr, String> {
    if response.len() < STUN_HEADER_LEN {
        return Err("STUN response is shorter than its header".to_string());
    }
    let message_type = u16::from_be_bytes([response[0], response[1]]);
    if message_type != STUN_BINDING_SUCCESS {
        return Err(format!("unexpected STUN message type 0x{message_type:04x}"));
    }
    let payload_len = u16::from_be_bytes([response[2], response[3]]) as usize;
    let message_len = STUN_HEADER_LEN
        .checked_add(payload_len)
        .ok_or_else(|| "STUN response length overflow".to_string())?;
    if response.len() < message_len {
        return Err("STUN response payload is truncated".to_string());
    }
    if response[4..8] != STUN_MAGIC_COOKIE.to_be_bytes() {
        return Err("STUN magic cookie mismatch".to_string());
    }
    if response[8..20] != transaction_id {
        return Err("STUN transaction ID mismatch".to_string());
    }

    let mut offset = STUN_HEADER_LEN;
    while offset + 4 <= message_len {
        let attribute_type = u16::from_be_bytes([response[offset], response[offset + 1]]);
        let attribute_len =
            u16::from_be_bytes([response[offset + 2], response[offset + 3]]) as usize;
        let value_start = offset + 4;
        let value_end = value_start
            .checked_add(attribute_len)
            .ok_or_else(|| "STUN attribute length overflow".to_string())?;
        if value_end > message_len {
            return Err("STUN attribute is truncated".to_string());
        }
        if attribute_type == STUN_XOR_MAPPED_ADDRESS || attribute_type == STUN_MAPPED_ADDRESS {
            return parse_mapped_address(
                &response[value_start..value_end],
                attribute_type == STUN_XOR_MAPPED_ADDRESS,
                transaction_id,
            );
        }
        offset = value_start + ((attribute_len + 3) & !3);
    }
    Err("STUN response has no mapped address".to_string())
}

fn parse_mapped_address(
    value: &[u8],
    xor_encoded: bool,
    transaction_id: [u8; 12],
) -> Result<SocketAddr, String> {
    if value.len() < 4 {
        return Err("STUN mapped address is truncated".to_string());
    }
    let family = value[1];
    let mut port = u16::from_be_bytes([value[2], value[3]]);
    if xor_encoded {
        port ^= (STUN_MAGIC_COOKIE >> 16) as u16;
    }

    match family {
        0x01 if value.len() >= 8 => {
            let mut bytes = [0_u8; 4];
            bytes.copy_from_slice(&value[4..8]);
            if xor_encoded {
                for (byte, mask) in bytes.iter_mut().zip(STUN_MAGIC_COOKIE.to_be_bytes()) {
                    *byte ^= mask;
                }
            }
            Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::from(bytes)), port))
        }
        0x02 if value.len() >= 20 => {
            let mut bytes = [0_u8; 16];
            bytes.copy_from_slice(&value[4..20]);
            if xor_encoded {
                let mut mask = [0_u8; 16];
                mask[0..4].copy_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
                mask[4..16].copy_from_slice(&transaction_id);
                for (byte, mask) in bytes.iter_mut().zip(mask) {
                    *byte ^= mask;
                }
            }
            Ok(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(bytes)), port))
        }
        0x01 | 0x02 => Err("STUN mapped address has an invalid length".to_string()),
        _ => Err(format!("unsupported STUN address family 0x{family:02x}")),
    }
}

fn transaction_id() -> [u8; 12] {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_be_bytes();
    let counter = TRANSACTION_COUNTER
        .fetch_add(1, Ordering::Relaxed)
        .to_be_bytes();
    let mut id = [0_u8; 12];
    id.copy_from_slice(&timestamp[4..16]);
    for (byte, counter_byte) in id[4..12].iter_mut().zip(counter) {
        *byte ^= counter_byte;
    }
    id
}

fn address_family(ip: IpAddr) -> AddressFamily {
    match ip {
        IpAddr::V4(_) => AddressFamily::Ipv4,
        IpAddr::V6(_) => AddressFamily::Ipv6,
    }
}

fn failure(status: CheckStatus, checked_at: String, error: impl Into<String>) -> ExitIpResult {
    ExitIpResult {
        status,
        ip: None,
        port: None,
        family: None,
        source: SOURCE_NAME.to_string(),
        checked_at,
        error: Some(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_xor_mapped_address() {
        let transaction_id = [7_u8; 12];
        let mapped = SocketAddr::from(([203, 0, 113, 8], 51_234));
        let response = binding_response(transaction_id, mapped);

        assert_eq!(
            parse_binding_response(&response, transaction_id).unwrap(),
            mapped
        );
    }

    #[test]
    fn parses_ipv6_xor_mapped_address() {
        let transaction_id = [9_u8; 12];
        let mapped = SocketAddr::new("2001:db8::1234".parse().unwrap(), 44_321);
        let response = binding_response(transaction_id, mapped);

        assert_eq!(
            parse_binding_response(&response, transaction_id).unwrap(),
            mapped
        );
    }

    #[test]
    fn rejects_transaction_mismatch_and_missing_mapping() {
        let transaction_id = [1_u8; 12];
        let response = binding_response(transaction_id, SocketAddr::from(([198, 51, 100, 1], 443)));
        assert!(parse_binding_response(&response, [2_u8; 12])
            .unwrap_err()
            .contains("transaction ID mismatch"));

        let mut empty = binding_request(transaction_id);
        empty[0..2].copy_from_slice(&STUN_BINDING_SUCCESS.to_be_bytes());
        assert!(parse_binding_response(&empty, transaction_id)
            .unwrap_err()
            .contains("no mapped address"));
    }

    #[test]
    fn tries_ipv4_before_ipv6_and_removes_duplicates() {
        let ipv4 = SocketAddr::from(([192, 0, 2, 1], 19302));
        let ipv6 = SocketAddr::new("2001:db8::1".parse().unwrap(), 19302);

        assert_eq!(prefer_ipv4(vec![ipv6, ipv4, ipv4]), vec![ipv4, ipv6]);
    }

    #[tokio::test]
    async fn observes_exit_address_from_udp_server() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let server_address = server.local_addr().unwrap();
        let expected = SocketAddr::from(([198, 51, 100, 42], 32_000));
        tokio::spawn(async move {
            let mut request = [0_u8; 512];
            let (length, peer) = server.recv_from(&mut request).await.unwrap();
            assert_eq!(length, STUN_HEADER_LEN);
            let mut transaction_id = [0_u8; 12];
            transaction_id.copy_from_slice(&request[8..20]);
            server
                .send_to(&binding_response(transaction_id, expected), peer)
                .await
                .unwrap();
        });

        assert_eq!(
            observe_at(server_address, Duration::from_secs(1))
                .await
                .unwrap(),
            expected
        );
    }

    fn binding_response(transaction_id: [u8; 12], mapped: SocketAddr) -> Vec<u8> {
        let (family, address) = match mapped.ip() {
            IpAddr::V4(ip) => (0x01, ip.octets().to_vec()),
            IpAddr::V6(ip) => (0x02, ip.octets().to_vec()),
        };
        let mut mask = STUN_MAGIC_COOKIE.to_be_bytes().to_vec();
        if family == 0x02 {
            mask.extend_from_slice(&transaction_id);
        }
        let encoded_address = address
            .iter()
            .zip(mask)
            .map(|(byte, mask)| byte ^ mask)
            .collect::<Vec<_>>();
        let mut attribute = Vec::with_capacity(4 + 4 + encoded_address.len());
        attribute.extend_from_slice(&STUN_XOR_MAPPED_ADDRESS.to_be_bytes());
        attribute.extend_from_slice(&(4_u16 + encoded_address.len() as u16).to_be_bytes());
        attribute.extend_from_slice(&[0, family]);
        attribute
            .extend_from_slice(&(mapped.port() ^ (STUN_MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        attribute.extend_from_slice(&encoded_address);
        while attribute.len() % 4 != 0 {
            attribute.push(0);
        }

        let mut response = Vec::with_capacity(STUN_HEADER_LEN + attribute.len());
        response.extend_from_slice(&STUN_BINDING_SUCCESS.to_be_bytes());
        response.extend_from_slice(&(attribute.len() as u16).to_be_bytes());
        response.extend_from_slice(&STUN_MAGIC_COOKIE.to_be_bytes());
        response.extend_from_slice(&transaction_id);
        response.extend_from_slice(&attribute);
        response
    }
}
