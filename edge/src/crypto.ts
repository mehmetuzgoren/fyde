import type { Env } from "./types";

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function randomId(prefix: string, len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(len / 2) + 2));
  return `${prefix}_${bytesToHex(bytes).slice(0, len)}`;
}

export function generateOtpCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

export async function hashPasswordPBKDF2(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMat = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    keyMat,
    256
  );
  return `pbkdf2$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

export async function verifyPasswordPBKDF2(password: string, stored: string): Promise<boolean> {
  if (!stored.startsWith("pbkdf2$")) return false;
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  const saltHex = parts[1];
  const expectedHex = parts[2];
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((h) => parseInt(h, 16)));
  const keyMat = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 },
    keyMat,
    256
  );
  const actualHex = bytesToHex(new Uint8Array(bits));
  if (actualHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < actualHex.length; i++) diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

async function getJwtHmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.JWT_SECRET || "fyde-dev-edge-secret-change-in-prod-via-wrangler-secret";
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface SessionClaims {
  sub: string;
  email: string;
  handle: string;
  exp: number;
}

export async function signSessionJWT(claims: Omit<SessionClaims, "exp">, env: Env, ttlSec = 60 * 60 * 24 * 30): Promise<string> {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const fullClaims: SessionClaims = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(fullClaims)));
  const signingInput = `${header}.${payload}`;
  const key = await getJwtHmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

export async function verifySessionJWT(token: string, env: Env): Promise<SessionClaims | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const key = await getJwtHmacKey(env);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const decoded: SessionClaims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export async function verifyAppleIdentityToken(idToken: string, expectedAudience?: string): Promise<{ sub: string; email?: string } | null> {
  try {
    const [hB64, pB64, sB64] = idToken.split(".");
    if (!hB64 || !pB64 || !sB64) return null;
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(hB64))) as { kid: string; alg: string };
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(pB64))) as {
      iss: string;
      aud: string;
      exp: number;
      sub: string;
      email?: string;
    };
    if (payload.iss !== "https://appleid.apple.com") return null;
    if (expectedAudience && payload.aud !== expectedAudience) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    const jwksRes = await fetch("https://appleid.apple.com/auth/keys");
    if (!jwksRes.ok) return null;
    const jwks = (await jwksRes.json()) as { keys: Array<JsonWebKey & { kid: string }> };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const pubKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pubKey,
      base64UrlToBytes(sB64),
      encoder.encode(`${hB64}.${pB64}`)
    );
    return ok ? { sub: payload.sub, email: payload.email } : null;
  } catch {
    return null;
  }
}

export async function verifyStripeWebhookSignature(
  rawBody: string,
  sigHeader: string,
  webhookSecret: string
): Promise<boolean> {
  try {
    const kv = Object.fromEntries(sigHeader.split(",").map((p) => p.trim().split("=")));
    const timestamp = kv["t"];
    const v1 = kv["v1"];
    if (!timestamp || !v1) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
    const expected = bytesToHex(new Uint8Array(signed));
    if (expected.length !== v1.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
