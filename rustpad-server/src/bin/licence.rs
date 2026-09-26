//! Issue and inspect licence tokens. Deliberately a separate binary: the private
//! key must never exist on a deployment that only verifies, so nothing about this
//! tool is reachable from the server.
//!
//! ```text
//! cortex-licence keygen                      # prints a key pair once
//! cortex-licence sign --key licence.key --org 7 --plan team --seats 25 \
//!     --storage 100GB --features whiteboard,chat --exp 2027-01-01
//! ```
//!
//! Put the printed public key in `CORTEX_LICENCE_PUB` and the token in
//! `CORTEX_LICENCE` (comma-separated for several orgs).
use base64::Engine;
use ring::signature::KeyPair;
use rustpad_server::licence::Claims;

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("keygen") => keygen(),
        Some("sign") => match sign(&args.collect::<Vec<_>>()) {
            Ok(token) => println!("{token}"),
            Err(e) => {
                eprintln!("licence: {e}");
                std::process::exit(1);
            }
        },
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("usage: cortex-licence keygen | sign --key <file> --org <id> --plan <name> --seats <n> --storage <bytes|10GB> [--features a,b] [--exp YYYY-MM-DD]");
    std::process::exit(2);
}

fn keygen() {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).expect("generate");
    let pair =
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("round-trip sign key");
    let private = base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref());
    let public = pair
        .public_key()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    println!("# private key (keep this off the server; save as licence.key):");
    println!("{private}");
    println!("# public key for CORTEX_LICENCE_PUB:");
    println!("{public}");
}

/// Parse a small `--flag value` list without pulling in an argument crate.
fn flags(args: &[String]) -> Result<std::collections::HashMap<String, String>, String> {
    let mut out = std::collections::HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .ok_or_else(|| format!("expected --flag, got '{}'", args[i]))?
            .to_string();
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("--{key} needs a value"))?
            .clone();
        out.insert(key, value);
        i += 2;
    }
    Ok(out)
}

fn sign(args: &[String]) -> Result<String, String> {
    let flags = flags(args)?;
    let key_file = flags.get("key").ok_or("missing --key")?;
    let raw = std::fs::read_to_string(key_file)
        .map_err(|e| format!("cannot read {key_file}: {e}"))?
        .trim()
        .to_string();
    let pkcs8 = base64::engine::general_purpose::STANDARD
        .decode(&raw)
        .map_err(|_| "the key file must hold base64 PKCS#8 from `keygen`".to_string())?;
    let claims = Claims {
        org: flags
            .get("org")
            .ok_or("missing --org")?
            .parse()
            .map_err(|_| "--org must be a number".to_string())?,
        plan: flags.get("plan").cloned().unwrap_or_else(|| "team".into()),
        seats: flags
            .get("seats")
            .map(|s| s.parse())
            .transpose()
            .map_err(|_| "--seats must be a number".to_string())?
            .unwrap_or(i64::MAX),
        storage_bytes: flags
            .get("storage")
            .map(|raw| parse_size(raw))
            .transpose()?
            .unwrap_or(i64::MAX),
        features: flags
            .get("features")
            .map(|s| {
                s.split(',')
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        exp: match flags.get("exp") {
            Some(date) => epoch_from_date(date)?,
            None => 0,
        },
    };
    claims.sign(&pkcs8)
}

/// `100GB`, `512MB`, `1024` — an unadorned number is bytes.
fn parse_size(raw: &str) -> Result<i64, String> {
    let upper = raw.to_ascii_uppercase();
    let (digits, multiplier) = match upper.strip_suffix("KB").map(|n| (n, 1 << 10)) {
        Some(v) => v,
        None => match upper.strip_suffix("MB").map(|n| (n, 1 << 20)) {
            Some(v) => v,
            None => match upper.strip_suffix("GB").map(|n| (n, 1 << 30)) {
                Some(v) => v,
                None => match upper.strip_suffix("TB").map(|n| (n, 1i64 << 40)) {
                    Some(v) => v,
                    None => (upper.as_str(), 1),
                },
            },
        },
    };
    digits
        .trim()
        .parse::<f64>()
        .map(|value| (value * multiplier as f64) as i64)
        .map_err(|_| format!("--storage is not a size: {raw}"))
}

fn epoch_from_date(raw: &str) -> Result<i64, String> {
    let mut parts = raw.split('-');
    let (Some(y), Some(m), Some(d)) = (parts.next(), parts.next(), parts.next()) else {
        return Err("--exp must be YYYY-MM-DD".to_string());
    };
    let (year, month, day) = (
        y.parse::<i64>().map_err(|_| "bad year")?,
        m.parse::<i64>().map_err(|_| "bad month")?,
        d.parse::<i64>().map_err(|_| "bad day")?,
    );
    // Days from the civil calendar (Howard Hinnant's algorithm), so no chrono.
    let days = {
        let y = if month <= 2 { year - 1 } else { year };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    };
    Ok(days * 86400 + 23 * 3600 + 59 * 60 + 59)
}
