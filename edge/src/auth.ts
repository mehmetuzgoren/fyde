import {
  generateOtpCode,
  hashPasswordPBKDF2,
  randomId,
  signSessionJWT,
  verifyAppleIdentityToken,
  verifyPasswordPBKDF2,
  verifySessionJWT,
} from "./crypto";
import type { Env, PlanTier, UserProfile } from "./types";

const SESSION_COOKIE = "fyde_session";

export function rowToUserProfile(row: Record<string, unknown>): UserProfile {
  return {
    id: String(row.id),
    handle: String(row.handle),
    display_name: String(row.display_name),
    email: String(row.email),
    phone: String(row.phone || ""),
    avatar_color: String(row.avatar_color || "#293022"),
    auth_provider: String(row.auth_provider || "email"),
    plan_tier: (String(row.plan_tier || "starter") as PlanTier),
    billing_interval: String(row.billing_interval || "monthly"),
    subscription_status: String(row.subscription_status || "active"),
    auto_save_trusted_to_photos: Boolean(row.auto_save_trusted_to_photos ?? 1),
  };
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

export function buildSessionCookie(token: string, requestUrl: string): string {
  const isSecure = requestUrl.startsWith("https://");
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ];
  if (isSecure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function getAuthenticatedUser(request: Request, env: Env): Promise<UserProfile | null> {
  let token = "";
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    const cookies = parseCookies(request.headers.get("Cookie"));
    token = cookies[SESSION_COOKIE] || "";
  }
  if (!token) return null;

  const claims = await verifySessionJWT(token, env);
  if (!claims) return null;

  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(claims.sub).first();
  return row ? rowToUserProfile(row) : null;
}

async function sendTransactionalEmail(
  env: Env,
  to: string,
  subject: string,
  html: string
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "fyde. <hello@izbirakin.com>",
      to: [to],
      subject,
      html,
    }),
  });
  return res.ok;
}

async function issueAuthResponse(user: UserProfile, request: Request, env: Env, extra: Record<string, unknown> = {}): Promise<Response> {
  const token = await signSessionJWT(
    { sub: user.id, email: user.email, handle: user.handle },
    env
  );
  return new Response(
    JSON.stringify({ user, token, ...extra }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildSessionCookie(token, request.url),
      },
    }
  );
}

async function findOrCreateOAuthUser(
  env: Env,
  opts: { email: string; displayName: string; provider: "google" | "apple"; providerSub: string }
): Promise<UserProfile> {
  const emailLower = opts.email.toLowerCase().trim();
  const subCol = opts.provider === "apple" ? "apple_sub" : "google_sub";

  let row = await env.DB.prepare(`SELECT * FROM users WHERE ${subCol} = ? OR email = ?`)
    .bind(opts.providerSub, emailLower)
    .first();

  if (row) {
    await env.DB.prepare(`UPDATE users SET ${subCol} = ? WHERE id = ?`)
      .bind(opts.providerSub, String(row.id))
      .run();
    return rowToUserProfile(row);
  }

  const baseHandle = (emailLower.split("@")[0] || "user").replace(/[^a-z0-9_]/g, "").slice(0, 16) || "fydeuser";
  const handle = `${baseHandle}_${Math.floor(100 + Math.random() * 900)}`;
  const id = randomId("usr", 10);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO users (id, handle, display_name, email, avatar_color, auth_provider, ${subCol}, plan_tier, created_at)
     VALUES (?, ?, ?, ?, '#293022', ?, ?, 'starter', ?)`
  )
    .bind(id, handle, opts.displayName || baseHandle, emailLower, opts.provider, opts.providerSub, now)
    .run();

  row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  return rowToUserProfile(row!);
}

export async function handleWaitlistAndAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  // ---------- Waitlist Endpoints (`fyde.izbirakin.com`) ----------
  if (path === "/api/waitlist/stats" && request.method === "GET") {
    const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM waitlist_entries").first<{ cnt: number }>();
    const baseOffset = 340; // Early community launch queue base
    return Response.json({ total_waitlist: baseOffset + Number(countRow?.cnt || 0) });
  }

  if (path === "/api/waitlist" && request.method === "POST") {
    const body = (await request.json()) as {
      email?: string;
      name?: string;
      platform_interest?: string;
      referred_by?: string;
    };
    const email = (body.email || "").toLowerCase().trim();
    if (!email || !email.includes("@")) {
      return Response.json({ error: "Please enter a valid email address." }, { status: 400 });
    }

    const existing = await env.DB.prepare("SELECT * FROM waitlist_entries WHERE email = ?").bind(email).first();
    if (existing) {
      return Response.json({
        already_joined: true,
        entry: existing,
        message: `You're already on the fyde. waitlist at spot #${existing.position}!`,
      });
    }

    const countRow = await env.DB.prepare("SELECT COUNT(*) as cnt FROM waitlist_entries").first<{ cnt: number }>();
    const position = 341 + Number(countRow?.cnt || 0);
    const referralCode = randomId("fyde", 6).replace("fyde_", "").toUpperCase();
    const inviteCode = `FYDE-${referralCode}`;
    const id = randomId("wl", 10);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO waitlist_entries
       (id, email, name, platform_interest, referral_code, referred_by, position, invite_status, invite_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
      .bind(
        id,
        email,
        (body.name || "").trim(),
        body.platform_interest || "ios_macos",
        referralCode,
        (body.referred_by || "").trim(),
        position,
        inviteCode,
        now
      )
      .run();

    await sendTransactionalEmail(
      env,
      email,
      `You're #${position} on the fyde. waitlist`,
      `<div style="font-family:sans-serif;color:#293022;background:#F8F9F4;padding:28px;border-radius:14px">
        <h2 style="margin:0 0 12px">fyde<span style="color:#BF5134">.</span></h2>
        <p>You're officially <strong>#${position}</strong> in line for early access on iPhone, Mac, and Web.</p>
        <p>Share your referral code <strong>${referralCode}</strong> to move up the queue.</p>
      </div>`
    );

    const saved = await env.DB.prepare("SELECT * FROM waitlist_entries WHERE id = ?").bind(id).first();
    return Response.json({
      already_joined: false,
      entry: saved,
      message: `You're in! Reserved spot #${position} on fyde.izbirakin.com.`,
    });
  }

  // ---------- Session Inspection & Logout ----------
  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await getAuthenticatedUser(request, env);
    return Response.json({
      authenticated: Boolean(user),
      user,
      oauth_configured: {
        google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        apple: Boolean(env.APPLE_CLIENT_ID),
        stripe_live: Boolean(env.STRIPE_SECRET_KEY),
      },
    });
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearSessionCookie(),
      },
    });
  }

  // ---------- Email + Password Register & Login ----------
  if (path === "/api/auth/register" && request.method === "POST") {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      display_name?: string;
      handle?: string;
      invite_code?: string;
    };
    const email = (body.email || "").toLowerCase().trim();
    const password = body.password || "";
    if (!email.includes("@") || password.length < 6) {
      return Response.json({ error: "Valid email and 6+ character password required." }, { status: 400 });
    }

    if (env.REQUIRE_INVITE_CODE === "true") {
      const code = (body.invite_code || "").trim();
      const wl = await env.DB.prepare("SELECT * FROM waitlist_entries WHERE invite_code = ? AND invite_status = 'invited'")
        .bind(code)
        .first();
      if (!wl) {
        return Response.json(
          { error: "Early access requires a valid waitlist invite code. Join the waitlist first!" },
          { status: 403 }
        );
      }
    }

    const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (exists) {
      return Response.json({ error: "An account with this email already exists. Please log in." }, { status: 409 });
    }

    const rawHandle = (body.handle || email.split("@")[0]).toLowerCase().replace(/[^a-z0-9_]/g, "");
    const handleExists = await env.DB.prepare("SELECT id FROM users WHERE handle = ?").bind(rawHandle).first();
    const handle = handleExists ? `${rawHandle}_${Math.floor(10 + Math.random() * 89)}` : rawHandle;
    const displayName = (body.display_name || rawHandle).trim();
    const pwHash = await hashPasswordPBKDF2(password);
    const id = randomId("usr", 10);
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO users (id, handle, display_name, email, password_hash, auth_provider, plan_tier, created_at)
       VALUES (?, ?, ?, ?, ?, 'email', 'starter', ?)`
    )
      .bind(id, handle, displayName, email, pwHash, now)
      .run();

    const created = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return issueAuthResponse(rowToUserProfile(created!), request, env);
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    const body = (await request.json()) as { email?: string; password?: string };
    const email = (body.email || "").toLowerCase().trim();
    const row = await env.DB.prepare("SELECT * FROM users WHERE email = ? OR handle = ?")
      .bind(email, email.replace(/^@/, ""))
      .first();
    if (!row || !row.password_hash) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    const valid = await verifyPasswordPBKDF2(body.password || "", String(row.password_hash));
    if (!valid) {
      return Response.json({ error: "Invalid email or password." }, { status: 401 });
    }
    return issueAuthResponse(rowToUserProfile(row), request, env);
  }

  // ---------- Passwordless 6-Digit Email Code (OTP) ----------
  if (path === "/api/auth/email/send-code" && request.method === "POST") {
    const body = (await request.json()) as { email?: string };
    const email = (body.email || "").toLowerCase().trim();
    if (!email.includes("@")) {
      return Response.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    const code = generateOtpCode();
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes
    await env.DB.prepare(
      "INSERT OR REPLACE INTO email_otps (email, code, expires_at) VALUES (?, ?, ?)"
    )
      .bind(email, code, expiresAt)
      .run();

    const sentLive = await sendTransactionalEmail(
      env,
      email,
      `${code} is your fyde. sign-in code`,
      `<div style="font-family:sans-serif;color:#293022;background:#F8F9F4;padding:28px;border-radius:14px">
        <h2 style="margin:0 0 12px">fyde<span style="color:#BF5134">.</span></h2>
        <p>Your 6-digit verification code is:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:14px 0">${code}</div>
        <p style="font-size:12px;color:#5C6454">Expires in 10 minutes.</p>
      </div>`
    );

    return Response.json({
      sent: true,
      delivery: sentLive ? "email" : "preview",
      // Only include preview hint when RESEND_API_KEY is not yet configured in local dev
      dev_code_hint: sentLive ? undefined : code,
    });
  }

  if (path === "/api/auth/email/verify-code" && request.method === "POST") {
    const body = (await request.json()) as { email?: string; code?: string; display_name?: string };
    const email = (body.email || "").toLowerCase().trim();
    const code = (body.code || "").trim();

    const otpRow = await env.DB.prepare("SELECT * FROM email_otps WHERE email = ?").bind(email).first();
    if (
      !otpRow ||
      String(otpRow.code) !== code ||
      Number(otpRow.expires_at) < Math.floor(Date.now() / 1000)
    ) {
      return Response.json({ error: "Invalid or expired 6-digit code." }, { status: 401 });
    }
    await env.DB.prepare("DELETE FROM email_otps WHERE email = ?").bind(email).run();

    let userRow = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
    if (!userRow) {
      const baseHandle = email.split("@")[0].replace(/[^a-z0-9_]/g, "") || "member";
      const handle = `${baseHandle}_${Math.floor(10 + Math.random() * 89)}`;
      const id = randomId("usr", 10);
      await env.DB.prepare(
        `INSERT INTO users (id, handle, display_name, email, auth_provider, plan_tier, created_at)
         VALUES (?, ?, ?, ?, 'email_otp', 'starter', ?)`
      )
        .bind(id, handle, body.display_name || baseHandle, email, new Date().toISOString())
        .run();
      userRow = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    }
    return issueAuthResponse(rowToUserProfile(userRow!), request, env);
  }

  // ---------- Google OAuth 2.0 ----------
  if (path === "/api/auth/google/start" && request.method === "GET") {
    const appOrigin = env.PUBLIC_APP_URL || url.origin;
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return Response.redirect(`${appOrigin}/?auth_notice=google_not_configured`, 302);
    }
    const state = randomId("st", 16);
    await env.DB.prepare("INSERT INTO oauth_states (state, provider, expires_at) VALUES (?, 'google', ?)")
      .bind(state, Math.floor(Date.now() / 1000) + 600)
      .run();

    const redirectUri = `${url.origin}/api/auth/google/callback`;
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "openid email profile");
    authUrl.searchParams.set("state", state);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (path === "/api/auth/google/callback" && request.method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const stRow = await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = 'google'")
      .bind(state)
      .first();
    if (!stRow || !code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return Response.redirect(`${url.origin}/?auth_error=google_state_invalid`, 302);
    }
    await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      return Response.redirect(`${url.origin}/?auth_error=google_token_exchange`, 302);
    }
    const tokens = (await tokenRes.json()) as { access_token: string };
    const profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = (await profileRes.json()) as { sub: string; email: string; name?: string };
    const user = await findOrCreateOAuthUser(env, {
      email: profile.email,
      displayName: profile.name || profile.email.split("@")[0],
      provider: "google",
      providerSub: profile.sub,
    });
    const jwt = await signSessionJWT({ sub: user.id, email: user.email, handle: user.handle }, env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/?view=app`,
        "Set-Cookie": buildSessionCookie(jwt, request.url),
      },
    });
  }

  // ---------- Sign in with Apple (Web OIDC & Native iOS/macOS `SignInWithAppleButton`) ----------
  if (path === "/api/auth/apple/start" && request.method === "GET") {
    const appOrigin = env.PUBLIC_APP_URL || url.origin;
    if (!env.APPLE_CLIENT_ID) {
      return Response.redirect(`${appOrigin}/?auth_notice=apple_not_configured`, 302);
    }
    const state = randomId("st", 16);
    await env.DB.prepare("INSERT INTO oauth_states (state, provider, expires_at) VALUES (?, 'apple', ?)")
      .bind(state, Math.floor(Date.now() / 1000) + 600)
      .run();

    const authUrl = new URL("https://appleid.apple.com/auth/authorize");
    authUrl.searchParams.set("client_id", env.APPLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", `${url.origin}/api/auth/apple/callback`);
    authUrl.searchParams.set("response_type", "code id_token");
    authUrl.searchParams.set("response_mode", "form_post");
    authUrl.searchParams.set("scope", "name email");
    authUrl.searchParams.set("state", state);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (path === "/api/auth/apple/callback" && request.method === "POST") {
    const form = await request.formData();
    const idToken = String(form.get("id_token") || "");
    const verified = await verifyAppleIdentityToken(idToken, env.APPLE_CLIENT_ID);
    if (!verified) {
      return Response.redirect(`${url.origin}/?auth_error=apple_token_invalid`, 302);
    }
    const email = verified.email || `${verified.sub.slice(0, 10)}@privaterelay.appleid.com`;
    const user = await findOrCreateOAuthUser(env, {
      email,
      displayName: email.split("@")[0],
      provider: "apple",
      providerSub: verified.sub,
    });
    const jwt = await signSessionJWT({ sub: user.id, email: user.email, handle: user.handle }, env);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/?view=app`,
        "Set-Cookie": buildSessionCookie(jwt, request.url),
      },
    });
  }

  if (path === "/api/auth/apple/native" && request.method === "POST") {
    const body = (await request.json()) as {
      identity_token?: string;
      full_name?: string;
      email?: string;
    };
    const verified = await verifyAppleIdentityToken(body.identity_token || "");
    if (!verified) {
      return Response.json({ error: "Unable to verify Apple identity token." }, { status: 401 });
    }
    const email = body.email || verified.email || `${verified.sub.slice(0, 10)}@privaterelay.appleid.com`;
    const user = await findOrCreateOAuthUser(env, {
      email,
      displayName: body.full_name || email.split("@")[0],
      provider: "apple",
      providerSub: verified.sub,
    });
    return issueAuthResponse(user, request, env);
  }

  // ---------- Sandbox / Founder Quick Switch (`Mehmet`, `Maya`, `Alex`, `Sarah`) ----------
  if (path === "/api/auth/demo" && request.method === "POST") {
    const body = (await request.json()) as { handle?: string };
    const handle = (body.handle || "mehmet").toLowerCase();
    const row = await env.DB.prepare("SELECT * FROM users WHERE handle = ? OR id = ?")
      .bind(handle, handle)
      .first();
    if (!row) {
      return Response.json({ error: "Demo account not found." }, { status: 404 });
    }
    return issueAuthResponse(rowToUserProfile(row), request, env);
  }

  return null;
}
