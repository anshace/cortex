// App-layer payload encryption for chat/DMs — mirrors the Rust `crypto` module.
// ECDH P-256 against the server's process key -> HKDF-SHA256 -> AES-256-GCM, so
// payloads stay opaque even to a passive TLS-inspecting proxy. The derived key
// lives in memory only (never localStorage), so nothing is left on disk.

const te = new TextEncoder();
const td = new TextDecoder();

function bufToB64(b: ArrayBuffer | Uint8Array): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Session = { epk: string; key: CryptoKey };
let sessionP: Promise<Session> | null = null;

async function handshake(): Promise<Session> {
  const res = await fetch("/api/crypto/pubkey", { credentials: "include" });
  const { pubkey } = await res.json();
  const serverKey = await crypto.subtle.importKey(
    "raw",
    b64ToBuf(pubkey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const kp = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const myRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverKey },
    kp.privateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, [
    "deriveKey",
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: te.encode("cortex-salt-v1"),
      info: te.encode("cortex-payload-v1"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { epk: bufToB64(myRaw), key };
}

function session(): Promise<Session> {
  if (!sessionP)
    sessionP = handshake().catch((e) => ((sessionP = null), Promise.reject(e)));
  return sessionP;
}

async function seal(key: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    te.encode(plaintext),
  );
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}
async function open(
  key: CryptoKey,
  env: { iv: string; ct: string },
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBuf(env.iv) },
    key,
    b64ToBuf(env.ct),
  );
  return td.decode(pt);
}

// Exposed for the collab WebSocket, which reuses the same derived key.
export function getSession(): Promise<Session> {
  return session();
}
export function resetSession(): void {
  sessionP = null;
}
export function wsSeal(
  key: CryptoKey,
  plaintext: string,
): Promise<{ iv: string; ct: string }> {
  return seal(key, plaintext);
}
export function wsOpen(
  key: CryptoKey,
  env: { iv: string; ct: string },
): Promise<string> {
  return open(key, env);
}

class DecryptError extends Error {}

async function run<T>(
  path: string,
  opts: { method: string; body?: unknown },
  s: Session,
): Promise<T> {
  const headers: Record<string, string> = { "X-Cortex-EPK": s.epk };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(await seal(s.key, JSON.stringify(opts.body)));
  }
  const res = await fetch(path, {
    method: opts.method,
    credentials: "include",
    headers,
    body,
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON */
  }
  if (data && typeof data.iv === "string" && typeof data.ct === "string") {
    try {
      data = JSON.parse(await open(s.key, data));
    } catch {
      throw new DecryptError("stale session key");
    }
  }
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data as T;
}

// Encrypted fetch. On a decrypt failure (e.g. the server restarted with a new
// key), re-handshake and retry GETs; POSTs re-handshake and surface the error so
// we never risk sending a message twice.
export async function encFetch<T>(
  path: string,
  opts: { method: string; body?: unknown } = { method: "GET" },
): Promise<T> {
  try {
    return await run<T>(path, opts, await session());
  } catch (e) {
    if (e instanceof DecryptError) {
      sessionP = null;
      if ((opts.method || "GET") === "GET")
        return await run<T>(path, opts, await session());
    }
    throw e;
  }
}
