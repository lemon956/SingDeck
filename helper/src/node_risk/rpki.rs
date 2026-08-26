use std::{net::IpAddr, time::Duration};

use chrono::Local;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{de::Error as _, Deserialize, Deserializer};
use tokio::time::timeout;

use super::types::{CheckStatus, RpkiOriginResult, RpkiResult, RpkiValidity};

const NETWORK_INFO_ENDPOINT: &str = "https://stat.ripe.net/data/network-info/data.json";
const RPKI_ENDPOINT: &str = "https://stat.ripe.net/data/rpki-validation/data.json";
const SOURCE_NAME: &str = "RIPEstat RPKI Validation (Routinator)";

#[derive(Debug, Deserialize)]
struct RipeResponse<T> {
    status: String,
    data: T,
}

#[derive(Debug, Deserialize)]
struct NetworkInfoData {
    prefix: Option<String>,
    #[serde(default, deserialize_with = "deserialize_asns")]
    asns: Vec<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AsnValue {
    Number(u32),
    String(String),
}

fn deserialize_asns<'de, D>(deserializer: D) -> Result<Vec<u32>, D::Error>
where
    D: Deserializer<'de>,
{
    Vec::<AsnValue>::deserialize(deserializer)?
        .into_iter()
        .map(|value| match value {
            AsnValue::Number(asn) => Ok(asn),
            AsnValue::String(asn) => asn
                .parse::<u32>()
                .map_err(|error| D::Error::custom(format!("invalid ASN {asn:?}: {error}"))),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct RpkiData {
    status: String,
    description: Option<String>,
}

pub async fn detect(client: &Client, ip: IpAddr, request_timeout: Duration) -> RpkiResult {
    detect_at_urls(
        client,
        ip,
        request_timeout,
        NETWORK_INFO_ENDPOINT,
        RPKI_ENDPOINT,
    )
    .await
}

pub fn unavailable(reason: impl Into<String>) -> RpkiResult {
    failure(CheckStatus::Unavailable, reason)
}

async fn detect_at_urls(
    client: &Client,
    ip: IpAddr,
    request_timeout: Duration,
    network_endpoint: &str,
    rpki_endpoint: &str,
) -> RpkiResult {
    let network_response = match get_json::<RipeResponse<NetworkInfoData>>(
        client,
        network_endpoint,
        &[("resource", ip.to_string())],
        request_timeout,
        "network-info",
    )
    .await
    {
        Ok(response) if response.status == "ok" => response,
        Ok(response) => {
            return failure(
                CheckStatus::Unavailable,
                format!("RIPEstat network-info status: {}", response.status),
            )
        }
        Err(error) => return failure(CheckStatus::Unavailable, error),
    };
    let Some(prefix) = network_response.data.prefix else {
        return unrouted();
    };
    if network_response.data.asns.is_empty() {
        return unrouted();
    }

    let mut origins = Vec::with_capacity(network_response.data.asns.len());
    for asn in network_response.data.asns {
        let response = get_json::<RipeResponse<RpkiData>>(
            client,
            rpki_endpoint,
            &[("resource", asn.to_string()), ("prefix", prefix.clone())],
            request_timeout,
            "rpki-validation",
        )
        .await;
        match response {
            Ok(response) if response.status == "ok" => {
                let validity = parse_validity(&response.data.status);
                origins.push(RpkiOriginResult {
                    asn,
                    check_status: CheckStatus::Success,
                    validity,
                    description: response.data.description,
                    error: None,
                });
            }
            Ok(response) => origins.push(RpkiOriginResult {
                asn,
                check_status: CheckStatus::Unavailable,
                validity: RpkiValidity::Unknown,
                description: None,
                error: Some(format!(
                    "RIPEstat rpki-validation status: {}",
                    response.status
                )),
            }),
            Err(error) => origins.push(RpkiOriginResult {
                asn,
                check_status: CheckStatus::Unavailable,
                validity: RpkiValidity::Unknown,
                description: None,
                error: Some(error),
            }),
        }
    }

    let successful = origins
        .iter()
        .filter(|origin| origin.check_status == CheckStatus::Success)
        .map(|origin| origin.validity)
        .collect::<Vec<_>>();
    let status = if successful.len() == origins.len() {
        CheckStatus::Success
    } else if successful.is_empty() {
        CheckStatus::Unavailable
    } else {
        CheckStatus::Error
    };
    let validity = aggregate_validity(&successful);
    let error = (status != CheckStatus::Success)
        .then(|| "one or more RPKI origin lookups were unavailable".to_string());
    RpkiResult {
        status,
        validity,
        prefix: Some(prefix),
        origins,
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error,
    }
}

async fn get_json<T: DeserializeOwned>(
    client: &Client,
    endpoint: &str,
    query: &[(&str, String)],
    request_timeout: Duration,
    operation: &str,
) -> Result<T, String> {
    let response = timeout(request_timeout, client.get(endpoint).query(query).send())
        .await
        .map_err(|_| format!("RIPEstat {operation} request timed out"))?
        .map_err(|error| format!("RIPEstat {operation} request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("RIPEstat {operation} returned HTTP {status}"));
    }
    let body = timeout(request_timeout, response.bytes())
        .await
        .map_err(|_| format!("read RIPEstat {operation} response timed out"))?
        .map_err(|error| format!("read RIPEstat {operation} response: {error}"))?;
    serde_json::from_slice(&body)
        .map_err(|error| format!("decode RIPEstat {operation} response: {error}"))
}

fn parse_validity(value: &str) -> RpkiValidity {
    match value {
        "valid" => RpkiValidity::Valid,
        "invalid_asn" => RpkiValidity::InvalidAsn,
        "invalid_length" => RpkiValidity::InvalidLength,
        _ => RpkiValidity::Unknown,
    }
}

fn aggregate_validity(values: &[RpkiValidity]) -> Option<RpkiValidity> {
    let first = *values.first()?;
    Some(if values.iter().all(|value| *value == first) {
        first
    } else {
        RpkiValidity::Mixed
    })
}

fn unrouted() -> RpkiResult {
    RpkiResult {
        status: CheckStatus::Success,
        validity: Some(RpkiValidity::Unrouted),
        prefix: None,
        origins: Vec::new(),
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: None,
    }
}

fn failure(status: CheckStatus, error: impl Into<String>) -> RpkiResult {
    RpkiResult {
        status,
        validity: None,
        prefix: None,
        origins: Vec::new(),
        source: SOURCE_NAME.to_string(),
        checked_at: Local::now().to_rfc3339(),
        error: Some(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        routing::get,
        Json, Router,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    use tokio::net::TcpListener;

    #[test]
    fn maps_only_documented_rpki_states() {
        assert_eq!(parse_validity("valid"), RpkiValidity::Valid);
        assert_eq!(parse_validity("invalid_asn"), RpkiValidity::InvalidAsn);
        assert_eq!(
            parse_validity("invalid_length"),
            RpkiValidity::InvalidLength
        );
        assert_eq!(parse_validity("future_state"), RpkiValidity::Unknown);
    }

    #[test]
    fn aggregates_different_origins_as_mixed() {
        assert_eq!(
            aggregate_validity(&[RpkiValidity::Valid, RpkiValidity::InvalidAsn]),
            Some(RpkiValidity::Mixed)
        );
        assert_eq!(aggregate_validity(&[]), None);
    }

    #[tokio::test]
    async fn performs_its_own_network_lookup_and_checks_every_origin() {
        let requested_origins = Arc::new(Mutex::new(Vec::<u32>::new()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/network",
                get(|| async {
                    Json(json!({
                        "status": "ok",
                        "data": {"prefix": "203.0.113.0/24", "asns": ["64496", 64497]}
                    }))
                }),
            )
            .route(
                "/rpki",
                get(
                    |State(requested): State<Arc<Mutex<Vec<u32>>>>,
                     Query(query): Query<HashMap<String, String>>| async move {
                        let asn = query["resource"].parse::<u32>().unwrap();
                        requested.lock().unwrap().push(asn);
                        let status = if asn == 64496 { "valid" } else { "invalid_asn" };
                        Json(json!({
                            "status": "ok",
                            "data": {"status": status, "description": format!("AS{asn}")}
                        }))
                    },
                ),
            )
            .with_state(requested_origins.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let result = detect_at_urls(
            &Client::new(),
            "203.0.113.9".parse().unwrap(),
            Duration::from_secs(1),
            &format!("http://{address}/network"),
            &format!("http://{address}/rpki"),
        )
        .await;

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.validity, Some(RpkiValidity::Mixed));
        assert_eq!(result.origins.len(), 2);
        assert_eq!(
            requested_origins.lock().unwrap().as_slice(),
            &[64496, 64497]
        );
    }

    #[tokio::test]
    async fn unrouted_address_does_not_call_validation_endpoint() {
        let rpki_calls = Arc::new(Mutex::new(0_usize));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new()
            .route(
                "/network",
                get(|| async { Json(json!({"status":"ok","data":{"prefix":null,"asns":[]}})) }),
            )
            .route(
                "/rpki",
                get(|State(calls): State<Arc<Mutex<usize>>>| async move {
                    *calls.lock().unwrap() += 1;
                    Json(json!({"status":"ok","data":{"status":"valid"}}))
                }),
            )
            .with_state(rpki_calls.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let result = detect_at_urls(
            &Client::new(),
            "192.0.2.1".parse().unwrap(),
            Duration::from_secs(1),
            &format!("http://{address}/network"),
            &format!("http://{address}/rpki"),
        )
        .await;

        assert_eq!(result.status, CheckStatus::Success);
        assert_eq!(result.validity, Some(RpkiValidity::Unrouted));
        assert_eq!(*rpki_calls.lock().unwrap(), 0);
    }
}
