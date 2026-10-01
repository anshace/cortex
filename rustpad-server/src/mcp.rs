//! Remote MCP (Model Context Protocol) client.
//!
//! Users paste an HTTPS Streamable-HTTP endpoint in Settings → MCP. The
//! orchestrator lists that server's tools each turn and exposes them as
//! `mcp_<name>_<tool>` functions. Tokens are stored encrypted (same box as
//! provider keys). Private/loopback URLs are rejected so a workspace can't
//! probe the host.

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use serde_json::{json, Value};

const PROTOCOL: &str = "2025-03-26";
const CLIENT_NAME: &str = "cortex";
const CLIENT_VERSION: &str = "0.1.0";

/// One tool advertised by a remote MCP server, ready to inject into the
/// provider tool list.
#[derive(Clone, Debug)]
pub struct McpTool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub schema: Value,
}

impl McpTool {
    /// OpenAI/Anthropic function name: `mcp_<server>_<tool>`, sanitised.
    pub fn wire_name(&self) -> String {
        format!("mcp_{}_{}", sanitize(&self.server), sanitize(&self.name))
    }
}

/// Split a wire name `mcp_<server>_<tool>` back into (server, tool). The
/// server slug is the first segment after `mcp_`; the rest is the tool
/// (tools may themselves contain underscores).
pub fn parse_wire_name(wire: &str) -> Option<(&str, &str)> {
    let rest = wire.strip_prefix("mcp_")?;
    let (server, tool) = rest.split_once('_')?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// Reject anything that isn't a public HTTPS URL. DNS is resolved so a name
/// that points at a private address is also blocked. `kind` is used in error
/// messages (`MCP`, `Fetch`, …).
pub fn validate_public_https(raw: &str, kind: &str) -> Result<String, String> {
    let raw = raw.trim();
    let url = reqwest::Url::parse(raw).map_err(|_| "not a valid URL".to_string())?;
    if url.scheme() != "https" {
        return Err(format!("{kind} URLs must be https"));
    }
    if url.username() != "" || url.password().is_some() {
        return Err("put credentials in the token field, not the URL".to_string());
    }
    let host = url.host_str().ok_or_else(|| "URL is missing a host".to_string())?;
    let host_l = host.to_ascii_lowercase();
    if host_l == "localhost" || host_l.ends_with(".localhost") || host_l.ends_with(".local") {
        return Err(format!("localhost {kind} URLs are not allowed"));
    }
    let port = url.port().unwrap_or(443);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|_| format!("could not resolve host '{host}'"))?;
    for addr in addrs {
        if !ip_is_public(addr.ip()) {
            return Err(format!("{kind} URL resolves to a private or loopback address"));
        }
    }
    Ok(url.to_string())
}

/// Reject anything that isn't a public HTTPS URL. DNS is resolved so a name
/// that points at a private address is also blocked.
pub fn validate_remote_url(raw: &str) -> Result<String, String> {
    validate_public_https(raw, "MCP")
}

/// True for an address the server may connect to on behalf of a stored URL
/// without being told where it actually lands. `pub(crate)` because the AI
/// provider path needs the same judgement about a different kind of URL, and a
/// second copy of these rules is how one of them stops being updated.
pub(crate) fn ip_is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !(v.is_loopback()
                || v.is_private()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_documentation())
        }
        IpAddr::V6(v) => {
            // IPv4-mapped addresses (::ffff:a.b.c.d) must be judged by their
            // v4 part: a mapped loopback/private address is just as dangerous
            // as the literal, and Ipv6Addr::is_loopback only knows ::1.
            if let Some(mapped) = v.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(mapped));
            }
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || is_unique_local_v6(v)
                || is_link_local_v6(v))
        }
    }
}

fn is_unique_local_v6(v: std::net::Ipv6Addr) -> bool {
    // fc00::/7
    (v.segments()[0] & 0xfe00) == 0xfc00
}

fn is_link_local_v6(v: std::net::Ipv6Addr) -> bool {
    // fe80::/10
    (v.segments()[0] & 0xffc0) == 0xfe80
}

/// Add the answers a URL resolves to onto a client builder, refusing any answer
/// that is not a public address.
///
/// `validate_public_https` resolves a name in order to decide whether it is safe
/// to connect, and a request built from a plain client resolves it *again*. With a
/// short TTL an attacker-hosted name can answer with a public address to the check
/// and `127.0.0.1` to the connection, which makes the check decorative. Pinning the
/// validated answers is what closes that; checking and then hoping nothing changed
/// in between is not a control.
///
/// This is the shared half of that, because the fetch path has the same shape and a
/// second copy of the address rules is how one of them stops being updated.
pub(crate) fn pin_client(
    builder: reqwest::ClientBuilder,
    raw: &str,
    kind: &str,
) -> Result<reqwest::ClientBuilder, String> {
    pin_client_allowing(builder, raw, kind, false)
}

/// The same, with the private range opened by the caller.
///
/// `allow_private` exists for one legitimate case: a self-hosted install pointing
/// the assistant at a model on localhost, which the operator opted into with
/// `AI_ALLOW_PRIVATE_BASE`. Even then the link-local and unspecified ranges stay
/// closed, because that is where a cloud hands out credentials and no model server
/// lives there.
pub(crate) fn pin_client_allowing(
    builder: reqwest::ClientBuilder,
    raw: &str,
    kind: &str,
    allow_private: bool,
) -> Result<reqwest::ClientBuilder, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "not a valid URL".to_string())?;
    let host = url.host_str().ok_or("URL is missing a host")?;
    let port = url.port_or_known_default().ok_or("URL has no port")?;
    let addrs: Vec<std::net::SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| format!("could not resolve host '{host}'"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("could not resolve host '{host}'"));
    }
    // Re-checked here rather than trusted from the caller, because the pin is the
    // thing that actually decides where the socket goes.
    for addr in &addrs {
        if never_a_host(addr.ip()) {
            return Err(format!("{kind} URL resolves to a link-local or unspecified address"));
        }
        if !allow_private && !ip_is_public(addr.ip()) {
            return Err(format!("{kind} URL resolves to a private or loopback address"));
        }
    }
    Ok(builder.resolve_to_addrs(host, &addrs))
}

/// An address that is never a real server, whatever the operator allowed: the
/// link-local range, where a cloud instance hands out its credentials, and the
/// forms that hide private address space inside an IPv6 literal.
pub(crate) fn never_a_host(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.is_link_local() || v4.is_unspecified(),
            // fe80::/10 is the v6 link-local range, which `IpAddr` has no helper
            // for and which `ip_is_public`'s tests already cover separately.
            None => v6.is_unspecified() || (v6.segments()[0] & 0xffc0) == 0xfe80,
        },
    }
}

fn pinned_client(url: &str) -> Result<reqwest::Client, String> {
    pin_client(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none()),
        url,
        "MCP",
    )?
    .build()
    .map_err(|e| e.to_string())
}

/// The largest remote body this server will hold in memory.
///
/// A small single container is the whole deployment, so an unbounded read is not a
/// performance question but an availability one: one remote that streams forever
/// stops the app for everyone. `search.rs` already capped its fetches; this is the
/// same rule where it was missing.
pub(crate) const MAX_REMOTE_BYTES: u64 = 4 * 1024 * 1024;

/// Fold one chunk into a running byte total, refusing past the cap.
///
/// A body read in one go and a stream consumed piece by piece are the same risk,
/// so they share one rule: an unbounded read is decided by the remote, and on one
/// small container that is one request away from an outage for everyone.
pub(crate) fn add_within_cap(seen: &mut u64, len: usize, kind: &str) -> Result<(), String> {
    *seen += len as u64;
    if *seen > MAX_REMOTE_BYTES {
        return Err(format!(
            "{kind} exceeded the {} MB limit",
            MAX_REMOTE_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// Read a response body, refusing one that exceeds the cap.
///
/// The length is checked while streaming rather than from `content-length` alone,
/// because a chunked response simply does not send one — so a check that trusts it
/// bounds the honest servers and not the attacker.
pub(crate) async fn read_capped(res: reqwest::Response, kind: &str) -> Result<String, String> {
    use futures::StreamExt;
    let mut stream = res.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut seen = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{kind} response body: {e}"))?;
        add_within_cap(&mut seen, chunk.len(), kind)?;
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|_| format!("{kind} response was not valid UTF-8"))
}

fn mcp_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
    })
}

/// JSON-RPC POST. `session` is the optional `Mcp-Session-Id` from initialize.
async fn rpc(
    url: &str,
    token: Option<&str>,
    method: &str,
    params: Value,
    session: Option<&str>,
    mcp_name: Option<&str>,
) -> Result<Value, String> {
    let mut body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    });
    body["_meta"] = mcp_meta();
    let http = pinned_client(url)?;
    let mut req = http
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .header("mcp-protocol-version", PROTOCOL)
        .header("mcp-method", method)
        .json(&body);
    if let Some(name) = mcp_name {
        req = req.header("mcp-name", name);
    }
    if let Some(t) = token.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    if let Some(s) = session.map(str::trim).filter(|s| !s.is_empty()) {
        req = req.header("mcp-session-id", s);
    }
    let res = req.send().await.map_err(|e| format!("MCP request failed: {e}"))?;
    let status = res.status();
    let session_hdr = res
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let ctype = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = read_capped(res, "MCP").await?;
    if !status.is_success() {
        let snippet: String = text.chars().take(240).collect();
        return Err(format!("MCP {method} HTTP {status}: {snippet}"));
    }
    let parsed = parse_rpc_body(&ctype, &text)?;
    if let Some(err) = parsed.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("MCP error");
        return Err(msg.to_string());
    }
    let mut result = parsed.get("result").cloned().unwrap_or(parsed);
    if let Some(s) = session_hdr {
        if let Some(obj) = result.as_object_mut() {
            obj.insert("_session".to_string(), json!(s));
        }
    }
    Ok(result)
}

/// Body may be a JSON object or an SSE stream of `data: {...}` frames.
fn parse_rpc_body(ctype: &str, text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("empty MCP response".to_string());
    }
    if ctype.contains("text/event-stream") || trimmed.starts_with("event:") || trimmed.starts_with("data:") {
        for block in trimmed.split("\n\n") {
            for line in block.lines() {
                let line = line.trim();
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data.is_empty() || data == "[DONE]" {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                        return Ok(v);
                    }
                }
            }
        }
        return Err("MCP SSE stream had no JSON payload".to_string());
    }
    serde_json::from_str(trimmed).map_err(|e| format!("MCP JSON: {e}"))
}

async fn initialize(url: &str, token: Option<&str>) -> Result<Option<String>, String> {
    let result = rpc(
        url,
        token,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": CLIENT_VERSION },
        }),
        None,
        None,
    )
    .await?;
    let session = result.get("_session").and_then(|s| s.as_str()).map(str::to_string);
    let _ = rpc(url, token, "notifications/initialized", json!({}), session.as_deref(), None).await;
    Ok(session)
}

fn looks_like_session_error(err: &str) -> bool {
    let e = err.to_lowercase();
    e.contains("initialize") || e.contains("session") || e.contains("handshake")
}

/// Discover tools on a remote MCP server. Tries a stateless `tools/list`
/// first (2026 spec); falls back to the initialize handshake used by older
/// Streamable HTTP servers.
pub async fn list_tools(url: &str, token: Option<&str>) -> Result<Vec<McpTool>, String> {
    let url = validate_remote_url(url)?;
    match rpc(&url, token, "tools/list", json!({}), None, None).await {
        Ok(v) => parse_tools("", &v),
        Err(e) if looks_like_session_error(&e) => {
            let session = initialize(&url, token).await?;
            let v = rpc(&url, token, "tools/list", json!({}), session.as_deref(), None).await?;
            parse_tools("", &v)
        }
        Err(e) => Err(e),
    }
}

fn parse_tools(server: &str, v: &Value) -> Result<Vec<McpTool>, String> {
    let arr = v
        .get("tools")
        .and_then(|t| t.as_array())
        .ok_or_else(|| "MCP tools/list returned no tools array".to_string())?;
    let mut out = Vec::new();
    for t in arr {
        let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let description = t
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string();
        let schema = t
            .get("inputSchema")
            .cloned()
            .or_else(|| t.get("input_schema").cloned())
            .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
        out.push(McpTool {
            server: server.to_string(),
            name: name.to_string(),
            description,
            schema,
        });
    }
    Ok(out)
}

/// Call one tool on a remote MCP server. `server` is only used to fill the
/// returned `McpTool` identity; the URL is what we actually hit.
pub async fn call_tool(
    url: &str,
    token: Option<&str>,
    tool: &str,
    arguments: Value,
) -> Result<String, String> {
    let url = validate_remote_url(url)?;
    let params = json!({ "name": tool, "arguments": arguments });
    let result = match rpc(&url, token, "tools/call", params.clone(), None, Some(tool)).await {
        Ok(v) => v,
        Err(e) if looks_like_session_error(&e) => {
            let session = initialize(&url, token).await?;
            rpc(&url, token, "tools/call", params, session.as_deref(), Some(tool)).await?
        }
        Err(e) => return Err(e),
    };
    Ok(stringify_call_result(&result))
}

fn stringify_call_result(v: &Value) -> String {
    if let Some(content) = v.get("content").and_then(|c| c.as_array()) {
        let mut parts = Vec::new();
        for block in content {
            let typ = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match typ {
                "text" => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        parts.push(t.to_string());
                    }
                }
                _ => parts.push(block.to_string()),
            }
        }
        if v.get("isError").and_then(|e| e.as_bool()).unwrap_or(false) {
            return format!("error: {}", parts.join("\n"));
        }
        if parts.is_empty() {
            return v.to_string();
        }
        return parts.join("\n");
    }
    v.to_string()
}

/// List tools for one named server (fills in `McpTool.server`).
pub async fn list_tools_for(server: &str, url: &str, token: Option<&str>) -> Result<Vec<McpTool>, String> {
    let mut tools = list_tools(url, token).await?;
    for t in &mut tools {
        t.server = server.to_string();
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_https_and_localhost() {
        assert!(validate_remote_url("http://example.com/mcp").is_err());
        assert!(validate_remote_url("https://localhost/mcp").is_err());
        assert!(validate_remote_url("https://127.0.0.1/mcp").is_err());
        assert!(validate_remote_url("not a url").is_err());
        assert!(validate_remote_url("https://user:pass@example.com/mcp").is_err());
    }

    #[test]
    fn accepts_public_https() {
        // example.com is a reserved public name; resolution may fail offline,
        // but the scheme/host checks must not reject it before DNS.
        let r = validate_remote_url("https://example.com/mcp");
        // Either DNS works and it's accepted, or resolution fails — never a
        // "must be https" / localhost rejection.
        if let Err(e) = r {
            assert!(e.contains("resolve") || e.contains("private"), "{e}");
        }
    }

    #[test]
    fn the_pin_refuses_a_private_answer_even_when_the_caller_vouched() {
        // The pin decides where the socket actually goes, so it re-checks rather
        // than trusting that someone validated first. Take away that loop and the
        // caller's check is once again only about a DNS answer that already
        // expired — which is the whole rebinding bug.
        for bad in [
            "http://127.0.0.1:8080/mcp",
            "http://10.0.0.5/mcp",
            "http://192.168.1.1/mcp",
            "http://[::1]:8080/mcp",
        ] {
            let r = pin_client(reqwest::Client::builder(), bad, "Fetch");
            assert!(r.is_err(), "pinned a private address for {bad:?}");
            assert!(
                r.unwrap_err().contains("private or loopback"),
                "refused {bad:?} for the wrong reason"
            );
        }
    }

    #[test]
    fn the_credential_range_stays_closed_even_when_private_is_allowed() {
        // `allow_private` is a switch for a local model server, not a licence to
        // read the cloud's credentials back. 169.254.0.0/16 and the unspecified
        // address are refused with the flag on, which is the difference between
        // that switch and having no control at all.
        for never in [
            "http://169.254.169.254/latest/meta-data/",
            "http://169.254.1.1/",
            "http://0.0.0.0:11434/v1",
            "http://[fe80::1]:11434/v1",
        ] {
            let r = pin_client_allowing(reqwest::Client::builder(), never, "Provider", true);
            assert!(r.is_err(), "pinned a credential-range address for {never:?}");
            assert!(
                r.unwrap_err().contains("link-local or unspecified"),
                "refused {never:?} for the wrong reason"
            );
        }
    }

    #[test]
    fn the_private_switch_opens_loopback_and_nothing_else() {
        // With the flag on, a localhost model server is reachable — that is the
        // whole point of the switch. Public answers are fine either way.
        assert!(pin_client_allowing(reqwest::Client::builder(), "http://127.0.0.1:11434/v1", "Provider", true).is_ok());
        assert!(pin_client(reqwest::Client::builder(), "http://127.0.0.1:11434/v1", "Provider").is_err());
        assert!(pin_client_allowing(reqwest::Client::builder(), "https://8.8.8.8/v1", "Provider", true).is_ok());
    }

    #[test]
    fn the_pin_keeps_a_public_literal_answer() {
        // The other half: it must not refuse everything, or the pin looks like a
        // working control while no MCP server or page is ever reachable.
        assert!(pin_client(reqwest::Client::builder(), "https://93.184.216.34/mcp", "MCP").is_ok());
    }

    #[test]
    fn the_cap_counts_the_running_total_not_the_chunk_that_arrives() {
        // A remote chooses how to split its body, so the chunk that crosses the
        // line is never the interesting one — the sum is. 8 MB in 8 KB pieces must
        // trip at exactly the point where the total passes 4 MB.
        let mut seen = 0u64;
        let mut tripped = None;
        for i in 0..1000u64 {
            if let Err(e) = add_within_cap(&mut seen, 8 * 1024, "Provider") {
                tripped = Some((i, e));
                break;
            }
        }
        let (i, e) = tripped.expect("8 MB arrived in 8 KB chunks and nothing refused it");
        assert_eq!(i, MAX_REMOTE_BYTES / (8 * 1024), "the total drifted from the chunks");
        assert!(e.contains("exceeded"), "{e}");

        // Exactly at the cap is allowed; one byte over is not.
        let mut at = MAX_REMOTE_BYTES - 1;
        assert!(add_within_cap(&mut at, 1, "Provider").is_ok(), "refused a body exactly at the cap");
        assert!(add_within_cap(&mut at, 1, "Provider").is_err(), "one byte past the cap got through");
    }

    #[tokio::test]
    async fn a_chunked_body_with_no_content_length_is_still_capped() {
        // Trusting `content-length` bounds the honest servers and not the attacker:
        // a chunked response simply never sends one. Serve exactly that and require
        // the read to stop on its own.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || serve_chunked(listener));

        let res = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert!(
            res.content_length().is_none(),
            "the fixture sent a length, so this would not test the streaming path"
        );
        match read_capped(res, "MCP").await {
            Ok(body) => panic!("read the whole {}-byte body; the cap never fired", body.len()),
            Err(e) => assert!(e.contains("exceeded"), "{e}"),
        }
    }

    #[tokio::test]
    async fn a_body_under_the_cap_is_returned_whole() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || serve_chunked_text(listener, "hello world"));

        let res = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .unwrap();
        assert_eq!(read_capped(res, "MCP").await.unwrap(), "hello world");
    }

    /// Answer one request with a chunked body and no `content-length`.
    ///
    /// Write errors are ignored on purpose: the capped read is expected to hang up
    /// mid-body, and a server that panics there would make the test flaky.
    fn serve_chunked(listener: std::net::TcpListener) {
        use std::io::{Read, Write};
        let (mut sock, _) = match listener.accept() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut scratch = [0u8; 4096];
        let _ = sock.read(&mut scratch);
        let head = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n";
        if sock.write_all(head.as_bytes()).is_err() {
            return;
        }
        let body = vec![b'x'; 128 * 1024];
        for _ in 0..40 {
            let _ = write!(sock, "{:X}\r\n", body.len());
            if sock.write_all(&body).is_err() || sock.write_all(b"\r\n").is_err() {
                return;
            }
        }
        let _ = sock.write_all(b"0\r\n\r\n");
    }

    fn serve_chunked_text(listener: std::net::TcpListener, text: &str) {
        use std::io::{Read, Write};
        let (mut sock, _) = match listener.accept() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut scratch = [0u8; 4096];
        let _ = sock.read(&mut scratch);
        let _ = write!(
            sock,
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n{:X}\r\n{text}\r\n0\r\n\r\n",
            text.len()
        );
    }

    #[test]
    fn wire_names_round_trip() {
        let t = McpTool {
            server: "github".into(),
            name: "list_issues".into(),
            description: String::new(),
            schema: json!({}),
        };
        assert_eq!(t.wire_name(), "mcp_github_list_issues");
        assert_eq!(parse_wire_name("mcp_github_list_issues"), Some(("github", "list_issues")));
        assert_eq!(parse_wire_name("mcp_gh_create_issue"), Some(("gh", "create_issue")));
        assert_eq!(parse_wire_name("list_files"), None);
    }

    #[test]
    fn sse_and_json_bodies_parse() {
        let json_body = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
        let v = parse_rpc_body("application/json", json_body).unwrap();
        assert_eq!(v["result"]["ok"], true);

        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]}}\n\n";
        let v = parse_rpc_body("text/event-stream", sse).unwrap();
        assert!(v["result"]["tools"].is_array());
    }

        #[test]
    fn private_and_mapped_addresses_are_rejected() {
        assert!(!ip_is_public("127.0.0.1".parse().unwrap()));
        assert!(!ip_is_public("10.1.2.3".parse().unwrap()));
        assert!(!ip_is_public("169.254.169.254".parse().unwrap()));
        assert!(!ip_is_public("192.168.1.10".parse().unwrap()));
        assert!(!ip_is_public("::1".parse().unwrap()));
        assert!(!ip_is_public("fe80::1".parse().unwrap()));
        assert!(!ip_is_public("fc00::1".parse().unwrap()));
        // IPv4-mapped variants of private/loopback/link-local addresses.
        assert!(!ip_is_public("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!ip_is_public("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!ip_is_public("::ffff:169.254.169.254".parse().unwrap()));
        assert!(!ip_is_public("::ffff:192.168.0.1".parse().unwrap()));
        assert!(ip_is_public("93.184.216.34".parse().unwrap()));
        assert!(ip_is_public("2606:2800:220:1:248:1893:25c8:1946".parse().unwrap()));
    }

    #[test]
    fn call_result_prefers_text_blocks() {
        let v = json!({
            "content": [{ "type": "text", "text": "hello" }, { "type": "text", "text": "world" }]
        });
        assert_eq!(stringify_call_result(&v), "hello\nworld");
        let err = json!({ "isError": true, "content": [{ "type": "text", "text": "nope" }] });
        assert_eq!(stringify_call_result(&err), "error: nope");
    }
}
