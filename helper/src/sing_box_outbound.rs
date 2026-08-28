use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

const CONFIG_STDIN_PATH: &str = "/dev/stdin";
const DEFAULT_BINARY: &str = "sing-box";
const STDOUT_LIMIT_BYTES: usize = 16 * 1024;
const STDERR_LIMIT_BYTES: usize = 4 * 1024;
const ERROR_DETAIL_CHARS: usize = 512;

#[derive(Debug, Clone)]
pub struct SingBoxOutboundFetcher {
    binary: PathBuf,
    config: Value,
}

impl SingBoxOutboundFetcher {
    pub fn new(config: Value) -> Self {
        Self {
            binary: PathBuf::from(DEFAULT_BINARY),
            config,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_binary(config: Value, binary: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            config,
        }
    }

    pub async fn fetch(
        &self,
        outbound: &str,
        url: &str,
        request_timeout: Duration,
    ) -> Result<Vec<u8>> {
        let minimal_config = build_minimal_config(&self.config, outbound)?;
        let config_bytes =
            serde_json::to_vec(&minimal_config).context("encode minimal sing-box config")?;
        run_fetch_command(&self.binary, outbound, url, &config_bytes, request_timeout).await
    }
}

pub fn parse_config(content: &str) -> Result<Value> {
    serde_json::from_str(content).context("decode sing-box config JSON")
}

fn build_minimal_config(config: &Value, target: &str) -> Result<Value> {
    let target = target.trim();
    if target.is_empty() {
        bail!("outbound tag is empty");
    }
    let outbounds = config
        .get("outbounds")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("sing-box config has no outbounds array"))?;
    let mut visiting = HashSet::new();
    let mut included = HashSet::new();
    let mut selected = Vec::new();
    collect_outbound(
        outbounds,
        target,
        &mut visiting,
        &mut included,
        &mut selected,
    )?;

    Ok(json!({
        "log": { "disabled": true },
        "dns": {
            "servers": [{ "type": "local", "tag": "singdeck-system" }],
            "strategy": "prefer_ipv4"
        },
        "outbounds": selected,
        "route": { "default_domain_resolver": "singdeck-system" }
    }))
}

fn collect_outbound(
    outbounds: &[Value],
    tag: &str,
    visiting: &mut HashSet<String>,
    included: &mut HashSet<String>,
    selected: &mut Vec<Value>,
) -> Result<()> {
    if included.contains(tag) {
        return Ok(());
    }
    if !visiting.insert(tag.to_string()) {
        bail!("outbound detour cycle detected at {tag:?}");
    }

    let matches = outbounds
        .iter()
        .filter(|outbound| outbound.get("tag").and_then(Value::as_str) == Some(tag))
        .collect::<Vec<_>>();
    let outbound = match matches.as_slice() {
        [] => bail!("outbound not found in configured outbounds: {tag}"),
        [outbound] => *outbound,
        _ => bail!("duplicate outbound tag in sing-box config: {tag}"),
    };
    let outbound_type = outbound
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if is_group_outbound(outbound_type) {
        bail!("outbound {tag:?} is a {outbound_type} group, not a concrete node");
    }

    if let Some(detour) = outbound
        .get("detour")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        collect_outbound(outbounds, detour, visiting, included, selected)?;
    }

    let mut outbound = outbound.clone();
    if let Some(object) = outbound.as_object_mut() {
        if object.contains_key("domain_resolver") {
            object.insert(
                "domain_resolver".to_string(),
                Value::String("singdeck-system".to_string()),
            );
        }
    }
    selected.push(outbound);
    visiting.remove(tag);
    included.insert(tag.to_string());
    Ok(())
}

fn is_group_outbound(outbound_type: &str) -> bool {
    let normalized = outbound_type
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(normalized.as_str(), "selector" | "urltest")
}

async fn run_fetch_command(
    binary: &Path,
    outbound: &str,
    url: &str,
    config: &[u8],
    request_timeout: Duration,
) -> Result<Vec<u8>> {
    let mut command = Command::new(binary);
    command
        .arg("--disable-color")
        .arg("-c")
        .arg(CONFIG_STDIN_PATH)
        .arg("tools")
        .arg("--outbound")
        .arg(outbound)
        .arg("fetch")
        .arg(url)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().with_context(|| {
        format!(
            "start {} tools fetch",
            binary
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("sing-box")
        )
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("open sing-box config stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("open sing-box fetch stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("open sing-box fetch stderr"))?;

    let execution = timeout(request_timeout, async {
        let write_config = async move {
            stdin.write_all(config).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let read_stdout = read_bounded(stdout, STDOUT_LIMIT_BYTES);
        let read_stderr = read_bounded(stderr, STDERR_LIMIT_BYTES);
        let wait = child.wait();
        let (write_result, stdout_result, stderr_result, status_result) =
            tokio::join!(write_config, read_stdout, read_stderr, wait);
        let stdout = stdout_result.context("read sing-box fetch stdout")?;
        let stderr = stderr_result.context("read sing-box fetch stderr")?;
        let status = status_result.context("wait for sing-box tools fetch")?;
        Ok::<_, anyhow::Error>((write_result, stdout, stderr, status))
    })
    .await;

    let (write_result, stdout, stderr, status) = match execution {
        Ok(result) => result?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!(
                "sing-box tools fetch timed out after {} ms",
                request_timeout.as_millis()
            );
        }
    };
    if stdout.truncated {
        bail!("sing-box tools fetch response exceeded {STDOUT_LIMIT_BYTES} bytes");
    }
    if !status.success() {
        let detail = sanitize_error_detail(&stderr.bytes);
        if detail.is_empty() {
            bail!("sing-box tools fetch exited with {status}");
        }
        bail!("sing-box tools fetch exited with {status}: {detail}");
    }
    write_result.context("write minimal sing-box config")?;
    Ok(stdout.bytes)
}

struct BoundedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

async fn read_bounded<R>(mut reader: R, limit: usize) -> std::io::Result<BoundedOutput>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(4096));
    let mut chunk = [0_u8; 4096];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        let keep = remaining.min(read);
        bytes.extend_from_slice(&chunk[..keep]);
        truncated |= keep < read;
    }
    Ok(BoundedOutput { bytes, truncated })
}

fn sanitize_error_detail(bytes: &[u8]) -> String {
    let collapsed = String::from_utf8_lossy(bytes)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(ERROR_DETAIL_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn executable_script(contents: &str) -> (tempfile::TempDir, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sing-box");
        std::fs::write(&path, contents).unwrap();
        let mut permissions = std::fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&path, permissions).unwrap();
        (directory, path)
    }

    #[test]
    fn minimal_config_contains_only_target_and_detour_chain() {
        let config = json!({
            "inbounds": [{"type": "tun", "tag": "tun-in"}],
            "outbounds": [
                {"type": "direct", "tag": "direct-out"},
                {"type": "socks", "tag": "relay", "server": "127.0.0.1", "server_port": 1080},
                {
                    "type": "vless",
                    "tag": "node-a",
                    "server": "node.example",
                    "server_port": 443,
                    "uuid": "secret",
                    "domain_resolver": "remote-dns",
                    "detour": "relay"
                },
                {"type": "vless", "tag": "node-b", "server": "unused.example", "server_port": 443}
            ],
            "route": {"rules": [{"domain": "example.com", "outbound": "node-b"}]}
        });

        let minimal = build_minimal_config(&config, "node-a").unwrap();
        let outbounds = minimal["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 2);
        assert_eq!(outbounds[0]["tag"], "relay");
        assert_eq!(outbounds[1]["tag"], "node-a");
        assert_eq!(outbounds[1]["uuid"], "secret");
        assert_eq!(outbounds[1]["domain_resolver"], "singdeck-system");
        assert!(minimal.get("inbounds").is_none());
        assert_eq!(
            minimal["route"]["default_domain_resolver"],
            "singdeck-system"
        );
    }

    #[test]
    fn minimal_config_rejects_groups_missing_tags_and_cycles() {
        let config = json!({"outbounds": [
            {"type": "selector", "tag": "group", "outbounds": ["node"]},
            {"type": "vless", "tag": "cycle-a", "detour": "cycle-b"},
            {"type": "vless", "tag": "cycle-b", "detour": "cycle-a"}
        ]});

        assert!(build_minimal_config(&config, "group")
            .unwrap_err()
            .to_string()
            .contains("not a concrete node"));
        assert!(build_minimal_config(&config, "missing")
            .unwrap_err()
            .to_string()
            .contains("not found"));
        assert!(build_minimal_config(&config, "cycle-a")
            .unwrap_err()
            .to_string()
            .contains("cycle"));
    }

    #[test]
    fn test_fetcher_can_override_binary_without_exposing_it_publicly() {
        let fetcher = SingBoxOutboundFetcher::with_binary(json!({"outbounds": []}), "/bin/false");
        assert_eq!(fetcher.binary, PathBuf::from("/bin/false"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fetch_pipes_minimal_config_and_returns_stdout() {
        let (_directory, binary) = executable_script(
            "#!/bin/sh\nconfig=$(cat)\ncase \"$config\" in *'\"tag\":\"node-a\"'*) ;; *) exit 9 ;; esac\nprintf '%s' '{\"ip\":\"203.0.113.9\"}'\n",
        );
        let fetcher = SingBoxOutboundFetcher::with_binary(
            json!({"outbounds": [{
                "type": "vless",
                "tag": "node-a",
                "server": "node.example",
                "server_port": 443,
                "uuid": "secret"
            }]}),
            binary,
        );

        let body = fetcher
            .fetch("node-a", "https://example.test/ip", Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(body, br#"{"ip":"203.0.113.9"}"#);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fetch_terminates_a_timed_out_process() {
        let (_directory, binary) = executable_script("#!/bin/sh\ncat >/dev/null\nsleep 2\n");
        let fetcher = SingBoxOutboundFetcher::with_binary(
            json!({"outbounds": [{"type": "direct", "tag": "node-a"}]}),
            binary,
        );

        let error = fetcher
            .fetch(
                "node-a",
                "https://example.test/ip",
                Duration::from_millis(20),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
    }
}
