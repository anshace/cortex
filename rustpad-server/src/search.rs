//! Web search and fetch for the assistant's research tools.
//!
//! Providers: Exa and Brave (API keys in Settings → AI → Research) plus a
//! key-free DuckDuckGo fallback. `web_fetch` reuses the same public-HTTPS SSRF
//! checks as MCP so a workspace cannot probe the host.

use serde_json::{json, Value};

use crate::mcp;

/// Resolved research settings for one turn.
#[derive(Clone, Debug)]
pub struct ResearchCfg {
    /// `exa` | `brave` | `duckduckgo`.
    pub provider: String,
    /// Decrypted API key when the provider needs one.
    pub api_key: Option<String>,
}

/// One search hit, formatted for the model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchHit {
    /// Page title.
    pub title: String,
    /// Canonical URL.
    pub url: String,
    /// Short excerpt when the provider supplies one.
    pub snippet: String,
}

impl ResearchCfg {
    /// Normalize a stored provider name; unknown values become duckduckgo.
    pub fn from_stored(provider: &str, api_key: Option<String>) -> Self {
        let p = provider.trim().to_ascii_lowercase();
        let provider = match p.as_str() {
            "exa" | "brave" | "duckduckgo" => p,
            _ => "duckduckgo".to_string(),
        };
        Self { provider, api_key }
    }
}

/// Search the web. Falls back to DuckDuckGo when the chosen provider has no key.
pub async fn web_search(cfg: &ResearchCfg, query: &str) -> String {
    let q = query.trim();
    if q.is_empty() {
        return "error: web_search needs a non-empty `query`".to_string();
    }
    if q.len() > 400 {
        return "error: query is too long (max 400 characters)".to_string();
    }
    let (used, hits) = match cfg.provider.as_str() {
        "exa" => match cfg.api_key.as_deref() {
            Some(k) => match search_exa(q, k).await {
                Ok(h) if !h.is_empty() => ("exa", h),
                Ok(_) => ("exa (empty) → duckduckgo", search_duckduckgo(q).await.unwrap_or_default()),
                Err(e) => {
                    let fb = search_duckduckgo(q).await.unwrap_or_default();
                    if fb.is_empty() {
                        return format!("error: Exa search failed ({e})");
                    }
                    ("exa failed → duckduckgo", fb)
                }
            },
            None => ("duckduckgo (no Exa key)", search_duckduckgo(q).await.unwrap_or_default()),
        },
        "brave" => match cfg.api_key.as_deref() {
            Some(k) => match search_brave(q, k).await {
                Ok(h) if !h.is_empty() => ("brave", h),
                Ok(_) => ("brave (empty) → duckduckgo", search_duckduckgo(q).await.unwrap_or_default()),
                Err(e) => {
                    let fb = search_duckduckgo(q).await.unwrap_or_default();
                    if fb.is_empty() {
                        return format!("error: Brave search failed ({e})");
                    }
                    ("brave failed → duckduckgo", fb)
                }
            },
            None => ("duckduckgo (no Brave key)", search_duckduckgo(q).await.unwrap_or_default()),
        },
        _ => ("duckduckgo", search_duckduckgo(q).await.unwrap_or_default()),
    };
    if hits.is_empty() {
        return format!(
            "error: no web results for {q:?} via {used}. DuckDuckGo Instant Answer is empty for most product queries — add an Exa or Brave key in Settings → AI → Research, or try a shorter query (e.g. the product name plus 'official docs')."
        );
    }
    format_hits(used, q, &hits)
}

/// Fetch a public HTTPS page and return stripped text (capped). Redirects
/// are followed one hop at a time and every target is re-validated against
/// [`mcp::validate_public_https`] *and* re-pinned, so a public page cannot bounce
/// the fetch to a private address, an http URL, or anything else the initial URL
/// was not - and cannot reach one by answering the check and the connection with
/// different DNS records.
pub async fn web_fetch(url: &str) -> String {
    let mut url = match mcp::validate_public_https(url, "Fetch") {
        Ok(u) => u,
        Err(e) => return format!("error: {e}"),
    };
    for _hop in 0..5 {
        let client = match fetch_client(&url) {
            Ok(c) => c,
            Err(e) => return format!("error: {e}"),
        };
        let res = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => return format!("error: fetch failed - {e}"),
        };
        if res.status().is_redirection() {
            let Some(loc) = res
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
            else {
                return "error: fetch redirect without a location header".to_string();
            };
            // Absolute targets parse directly; relative ones resolve against
            // the current URL (this also handles protocol-relative //host/..).
            let next = match reqwest::Url::parse(loc) {
                Ok(u) => u,
                Err(_) => match reqwest::Url::parse(&url).and_then(|base| base.join(loc)) {
                    Ok(u) => u,
                    Err(e) => return format!("error: bad redirect target - {e}"),
                },
            };
            url = match mcp::validate_public_https(next.as_str(), "Fetch") {
                Ok(u) => u,
                Err(e) => return format!("error: {e}"),
            };
            continue;
        }
        if !res.status().is_success() {
            return format!("error: fetch returned HTTP {}", res.status().as_u16());
        }
        // Capped as it arrives. The old check read `content-length` and then
        // buffered the body anyway, and a chunked response simply does not send a
        // length — so what was bounded was the honest servers, not the ones that
        // matter. One remote streaming forever used to stop the whole container.
        let body = match mcp::read_capped(res, "Fetch").await {
            Ok(b) => b,
            Err(e) => return format!("error: {e}"),
        };
        const MAX_CHARS: usize = 80_000;
        let raw: String = body.chars().take(MAX_CHARS).collect();
        let text = collapse_ws(&strip_html(&raw));
        if text.is_empty() {
            return format!("(no readable text at {url})");
        }
        let clipped: String = text.chars().take(8_000).collect();
        let clipped = if clipped.len() < text.len() {
            format!("{clipped}.(truncated)")
        } else {
            clipped
        };
        return format!("===== URL: {url} =====\n{clipped}");
    }
    "error: too many redirects".to_string()
}

/// A client that does NOT follow redirects on its own - [`web_fetch`] walks
/// them manually so every hop passes the public-HTTPS validation again - and that
/// is pinned to the answers for *this* hop's host, so the connection cannot be
/// pointed somewhere the validation did not look at.
fn fetch_client(url: &str) -> Result<reqwest::Client, String> {
    mcp::pin_client(
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .gzip(true)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(BROWSER_UA),
        url,
        "Fetch",
    )?
    .build()
    .map_err(|e| e.to_string())
}

fn format_hits(provider: &str, query: &str, hits: &[SearchHit]) -> String {
    let mut out = format!("{} result(s) via {provider} for {query:?}:\n", hits.len());
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!("\n{}. {}\n   {}\n", i + 1, h.title, h.url));
        if !h.snippet.is_empty() {
            let snip: String = h.snippet.chars().take(400).collect();
            out.push_str(&format!("   {snip}\n"));
        }
    }
    out
}

const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .gzip(true)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())
}

async fn search_exa(query: &str, key: &str) -> Result<Vec<SearchHit>, String> {
    let client = http()?;
    let res = client
        .post("https://api.exa.ai/search")
        .header("x-api-key", key)
        .header("content-type", "application/json")
        .json(&json!({
            "query": query,
            "type": "auto",
            "numResults": 8,
            "contents": { "text": { "maxCharacters": 1500 } }
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let short: String = body.chars().take(180).collect();
        return Err(format!("HTTP {status} {short}"));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(parse_exa(&v))
}

/// Parse an Exa `/search` JSON body.
pub fn parse_exa(v: &Value) -> Vec<SearchHit> {
    v.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let url = r.get("url").and_then(|u| u.as_str()).unwrap_or("").trim();
                    if url.is_empty() {
                        return None;
                    }
                    let title = r
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or(url)
                        .trim()
                        .to_string();
                    let snippet = r
                        .get("text")
                        .or_else(|| r.get("snippet"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(SearchHit { title, url: url.to_string(), snippet })
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default()
}

async fn search_brave(query: &str, key: &str) -> Result<Vec<SearchHit>, String> {
    let client = http()?;
    let res = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", "8")])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        let short: String = body.chars().take(180).collect();
        return Err(format!("HTTP {status} {short}"));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(parse_brave(&v))
}

/// Parse a Brave web-search JSON body.
pub fn parse_brave(v: &Value) -> Vec<SearchHit> {
    v.get("web")
        .and_then(|w| w.get("results"))
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let url = r.get("url").and_then(|u| u.as_str()).unwrap_or("").trim();
                    if url.is_empty() {
                        return None;
                    }
                    let title = r
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or(url)
                        .trim()
                        .to_string();
                    let snippet = r
                        .get("description")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(SearchHit { title, url: url.to_string(), snippet })
                })
                .take(8)
                .collect()
        })
        .unwrap_or_default()
}

async fn search_duckduckgo(query: &str) -> Result<Vec<SearchHit>, String> {
    let client = http()?;
    let mut hits = ddg_html_search(&client, query).await;
    // Instant Answer is an encyclopedia card, empty for most product queries.
    // Only fill in if HTML returned almost nothing.
    if hits.len() < 3 {
        let ia = client
            .get("https://api.duckduckgo.com/")
            .query(&[
                ("q", query),
                ("format", "json"),
                ("no_html", "1"),
                ("skip_disambig", "1"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if ia.status().is_success() {
            let v: Value = ia.json().await.unwrap_or(json!({}));
            for h in parse_ddg_instant(&v) {
                if hits.iter().any(|e| e.url == h.url) {
                    continue;
                }
                hits.push(h);
                if hits.len() >= 8 {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

/// HTML search is the real web index. POST first — GET often hits a bot wall.
async fn ddg_html_search(client: &reqwest::Client, query: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let form = [("q", query), ("kl", "wt-wt")];
    let send_one = |req: reqwest::RequestBuilder| async {
        match req.send().await {
            Ok(res) if res.status().is_success() => res.text().await.unwrap_or_default(),
            _ => String::new(),
        }
    };
    let bodies = [
        send_one(
            client
                .post("https://html.duckduckgo.com/html/")
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Referer", "https://html.duckduckgo.com/")
                .form(&form),
        )
        .await,
        send_one(
            client
                .get("https://html.duckduckgo.com/html/")
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "en-US,en;q=0.9")
                .query(&form),
        )
        .await,
        send_one(
            client
                .post("https://lite.duckduckgo.com/lite/")
                .header("Accept", "text/html,application/xhtml+xml")
                .header("Accept-Language", "en-US,en;q=0.9")
                .header("Referer", "https://lite.duckduckgo.com/lite/")
                .form(&[("q", query)]),
        )
        .await,
        send_one(
            client
                .get("https://lite.duckduckgo.com/lite/")
                .header("Accept", "text/html,application/xhtml+xml")
                .query(&[("q", query)]),
        )
        .await,
    ];
    for html in bodies {
        if html.is_empty() {
            continue;
        }
        for h in parse_ddg_html(&html) {
            if hits.iter().any(|e: &SearchHit| e.url == h.url) {
                continue;
            }
            hits.push(h);
            if hits.len() >= 8 {
                return hits;
            }
        }
    }
    hits
}

/// Parse DuckDuckGo Instant Answer JSON.
pub fn parse_ddg_instant(v: &Value) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    let abs = v.get("AbstractText").and_then(|t| t.as_str()).unwrap_or("").trim();
    let abs_url = v.get("AbstractURL").and_then(|t| t.as_str()).unwrap_or("").trim();
    let heading = v.get("Heading").and_then(|t| t.as_str()).unwrap_or("").trim();
    if !abs.is_empty() && !abs_url.is_empty() {
        hits.push(SearchHit {
            title: if heading.is_empty() { abs_url.to_string() } else { heading.to_string() },
            url: abs_url.to_string(),
            snippet: abs.to_string(),
        });
    }
    if let Some(arr) = v.get("RelatedTopics").and_then(|t| t.as_array()) {
        for t in arr {
            if hits.len() >= 8 {
                break;
            }
            if let Some(nested) = t.get("Topics").and_then(|x| x.as_array()) {
                for n in nested {
                    if hits.len() >= 8 {
                        break;
                    }
                    push_ddg_topic(&mut hits, n);
                }
            } else {
                push_ddg_topic(&mut hits, t);
            }
        }
    }
    hits
}

fn push_ddg_topic(hits: &mut Vec<SearchHit>, t: &Value) {
    let url = t.get("FirstURL").and_then(|u| u.as_str()).unwrap_or("").trim();
    let text = t.get("Text").and_then(|u| u.as_str()).unwrap_or("").trim();
    if url.is_empty() {
        return;
    }
    hits.push(SearchHit {
        title: if text.is_empty() { url.to_string() } else { text.chars().take(80).collect() },
        url: url.to_string(),
        snippet: text.to_string(),
    });
}

/// Extract result URLs from DuckDuckGo HTML / lite pages.
pub fn parse_ddg_html(html: &str) -> Vec<SearchHit> {
    let html = html.replace("&amp;", "&");
    let mut hits = Vec::new();
    let mut rest = html.as_str();
    while let Some(i) = rest.find("uddg=") {
        let after = &rest[i + 5..];
        // A byte count used as an index panics the moment it lands inside a
        // multi-byte character, which a page with any non-ASCII text eventually
        // guarantees. Bound by characters, over the same string being sliced.
        let limit = after
            .char_indices()
            .nth(500)
            .map(|(byte, _)| byte)
            .unwrap_or(after.len());
        let end = after
            .find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace())
            .unwrap_or(limit);
        let encoded = &after[..end];
        let url = url_decode(encoded);
        let tail = &after[end.min(after.len())..];
        let title = ddg_title_after_href(tail).unwrap_or_else(|| url.clone());
        rest = tail;
        push_hit(&mut hits, url, title);
        if hits.len() >= 8 {
            return hits;
        }
    }
    // Lite / some html layouts use a direct result__a href instead of uddg=.
    for class in ["result__a", "result-link"] {
        collect_class_hrefs(&html, class, &mut hits);
        if hits.len() >= 8 {
            break;
        }
    }
    hits
}

fn push_hit(hits: &mut Vec<SearchHit>, url: String, title: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    if url.contains("duckduckgo.com") {
        return;
    }
    if hits.iter().any(|h: &SearchHit| h.url == url) {
        return;
    }
    hits.push(SearchHit {
        title: if title.is_empty() { url.clone() } else { title },
        url,
        snippet: String::new(),
    });
}

fn collect_class_hrefs(html: &str, class: &str, hits: &mut Vec<SearchHit>) {
    let needle = format!("class=\"{class}\"");
    let mut rest = html;
    while let Some(i) = rest.find(&needle) {
        let start = i.saturating_sub(120);
        let end = (i + 350).min(rest.len());
        let window = &rest[start..end];
        if let Some(href) = href_in(window) {
            let url = unwrap_ddg_href(&href).unwrap_or(href);
            let title = ddg_title_after_href(window).unwrap_or_else(|| url.clone());
            push_hit(hits, url, title);
            if hits.len() >= 8 {
                return;
            }
        }
        rest = &rest[i + needle.len()..];
    }
}

fn href_in(s: &str) -> Option<String> {
    let i = s.find("href=\"")?;
    let after = &s[i + 6..];
    let end = after.find('"')?;
    Some(after[..end].to_string())
}

fn unwrap_ddg_href(href: &str) -> Option<String> {
    if let Some(rest) = href.split("uddg=").nth(1) {
        let enc = rest.split('&').next().unwrap_or(rest);
        let url = url_decode(enc);
        if url.starts_with("http://") || url.starts_with("https://") {
            return Some(url);
        }
    }
    None
}

fn ddg_title_after_href(after_href: &str) -> Option<String> {
    let gt = after_href.find('>')?;
    let rest = &after_href[gt + 1..];
    let lt = rest.find('<')?;
    let t = collapse_ws(&strip_html(&rest[..lt]));
    if t.is_empty() || t.len() > 160 {
        None
    } else {
        Some(t)
    }
}

/// Percent-decode a URL (best-effort; invalid sequences are kept).
pub fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(hex) = std::str::from_utf8(&b[i + 1..i + 3]) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        } else if b[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Drop tags and collapse whitespace so fetched pages fit in a tool result.
pub fn strip_html(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let rest = &lower[i..];
            if rest.starts_with("<script") {
                if let Some(end) = rest.find("</script>") {
                    i += end + 9;
                    continue;
                }
            }
            if rest.starts_with("<style") {
                if let Some(end) = rest.find("</style>") {
                    i += end + 8;
                    continue;
                }
            }
            if let Some(j) = rest.find('>') {
                i += j + 1;
                if !out.ends_with(char::is_whitespace) {
                    out.push(' ');
                }
                continue;
            }
        }
        let ch = s[i..].chars().next().unwrap_or('\0');
        if ch == '&' {
            if rest_starts(&s[i..], "&nbsp;") || rest_starts(&s[i..], "&#160;") {
                out.push(' ');
                i += 6; // "&nbsp;" and "&#160;" are both six characters
                continue;
            }
            if rest_starts(&s[i..], "&amp;") {
                out.push('&');
                i += 5;
                continue;
            }
            if rest_starts(&s[i..], "&lt;") {
                out.push('<');
                i += 4;
                continue;
            }
            if rest_starts(&s[i..], "&gt;") {
                out.push('>');
                i += 4;
                continue;
            }
            if rest_starts(&s[i..], "&quot;") {
                out.push('"');
                i += 6;
                continue;
            }
        }
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn rest_starts(s: &str, p: &str) -> bool {
    s.get(..p.len()).is_some_and(|x| x.eq_ignore_ascii_case(p))
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fetch_client_pins_and_therefore_refuses_a_private_host() {
        // `web_fetch` validates the URL before it gets here, so a test that only
        // drives `web_fetch` cannot tell whether this client is pinned at all —
        // which is precisely the hole: the check looked at one DNS answer and the
        // connection asked again. Un-wrap `fetch_client` from the pin and this
        // fails while every `web_fetch` test still passes.
        let e = fetch_client("http://127.0.0.1:9999/").unwrap_err();
        assert!(e.contains("private or loopback"), "{e}");
    }

    #[test]
    fn a_non_ascii_redirect_target_does_not_panic_the_parser() {
        // The old bound was `after.len().min(500)` — a byte count used as an index.
        // With no delimiter in the target the parser fell back to that bound, and on
        // a multi-byte character it slices mid-codepoint and panics the request
        // worker. So: raw non-ASCII text and nothing to stop at.
        //
        // The 21-byte ASCII prefix is deliberate. Each of these characters is 3
        // bytes, so a 20-byte prefix puts byte 500 exactly on a boundary and the
        // old code passes this test without ever having been safe. One byte over
        // and byte 500 is mid-character, which is what a real page does.
        let target = "https://example.com/x".to_string() + &"日本語".repeat(300);
        let hits = parse_ddg_html(&format!("uddg={target}"));
        assert_eq!(hits.len(), 1, "the link was not parsed at all");
        // Bounded by characters, so the long target is truncated rather than taken
        // whole — and rather than crashing.
        let n = hits[0].url.chars().count();
        assert!(n <= 520, "no bound was applied: {n} chars");
    }

    #[test]
    fn url_decode_percent_and_plus() {
        assert_eq!(url_decode("https%3A%2F%2Fexample.com%2Fa+b"), "https://example.com/a b");
        assert_eq!(url_decode("plain"), "plain");
    }

    #[test]
    fn parse_ddg_html_extracts_uddg() {
        let html = r#"<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=x">Rust</a>
                      <a href="?uddg=https%3A%2F%2Fdocs.rs%2Ffoo">docs</a>
                      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.ghost.org%2F&amp;rut=abc">Ghost Docs</a>"#;
        let hits = parse_ddg_html(html);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].url, "https://rust-lang.org/");
        assert_eq!(hits[0].title, "Rust");
        assert_eq!(hits[1].url, "https://docs.rs/foo");
        assert_eq!(hits[2].url, "https://docs.ghost.org/");
        assert_eq!(hits[2].title, "Ghost Docs");

        let direct = r#"<a class="result__a" href="https://ghost.org/docs/">Ghost Docs</a>"#;
        let hits = parse_ddg_html(direct);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://ghost.org/docs/");
    }

    #[test]
    fn parse_ddg_instant_abstract_and_topics() {
        let v = json!({
            "Heading": "Rust",
            "AbstractText": "A language.",
            "AbstractURL": "https://www.rust-lang.org/",
            "RelatedTopics": [
                { "Text": "Cargo", "FirstURL": "https://doc.rust-lang.org/cargo/" },
                { "Topics": [ { "Text": "Clippy", "FirstURL": "https://github.com/rust-lang/rust-clippy" } ] }
            ]
        });
        let hits = parse_ddg_instant(&v);
        assert_eq!(hits[0].title, "Rust");
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn parse_exa_and_brave() {
        let exa = json!({ "results": [
            { "title": "Exa", "url": "https://exa.ai", "text": "search" },
            { "url": "" }
        ]});
        let hits = parse_exa(&exa);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].snippet, "search");

        let brave = json!({ "web": { "results": [
            { "title": "Brave", "url": "https://brave.com", "description": "browser" }
        ]}});
        let hits = parse_brave(&brave);
        assert_eq!(hits[0].title, "Brave");
    }

    #[test]
    fn strip_html_drops_tags_and_scripts() {
        let html = "<html><script>alert(1)</script><style>p{}</style><p>Hello&nbsp;<b>world</b></p>";
        let t = collapse_ws(&strip_html(html));
        assert_eq!(t, "Hello world");
        assert!(!t.contains("alert"));
    }

    #[test]
    fn research_cfg_normalizes() {
        let c = ResearchCfg::from_stored("EXA", Some("k".into()));
        assert_eq!(c.provider, "exa");
        let c = ResearchCfg::from_stored("nope", None);
        assert_eq!(c.provider, "duckduckgo");
    }

    #[tokio::test]
    #[ignore = "hits DuckDuckGo; skip in CI"]
    async fn ddg_html_search_returns_hits() {
        let hits = search_duckduckgo("Ghost CMS official documentation")
            .await
            .expect("duckduckgo request");
        assert!(
            !hits.is_empty(),
            "DuckDuckGo HTML search returned no hits (gzip/UA/parser regression)"
        );
        assert!(
            hits.iter().any(|h| h.url.contains("ghost.org") || h.url.contains("github.com")),
            "unexpected hits: {hits:?}"
        );
    }
}
