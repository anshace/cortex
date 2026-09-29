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

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
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
    let http = client()?;
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
    let text = res.text().await.map_err(|e| format!("MCP response body: {e}"))?;
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
