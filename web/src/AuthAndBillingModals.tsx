import React, { useState } from "react";
import type { PlanDefinition, PlanTier, UserProfile } from "./types";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  resolveUrl: (rel: string) => string;
  onAuthenticated: (user: UserProfile, token?: string) => void;
  notice?: string | null;
}

export function AuthModal({ open, onClose, resolveUrl, onAuthenticated, notice }: AuthModalProps) {
  const [method, setMethod] = useState<"otp" | "password">("otp");
  const [isRegister, setIsRegister] = useState<boolean>(false);
  const [email, setEmail] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [inviteCode, setInviteCode] = useState<string>("");

  const [otpSent, setOtpSent] = useState<boolean>(false);
  const [otpCode, setOtpCode] = useState<string>("");
  const [devCodeHint, setDevCodeHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(resolveUrl("/api/auth/email/send-code"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not send code.");
        return;
      }
      setOtpSent(true);
      if (data.dev_code_hint) {
        setDevCodeHint(String(data.dev_code_hint));
      }
    } catch {
      setError("Could not reach the Cloudflare Edge relay.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(resolveUrl("/api/auth/email/verify-code"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, code: otpCode, display_name: displayName || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invalid verification code.");
        return;
      }
      onAuthenticated(data.user, data.token);
    } catch {
      setError("Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordAuth(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const res = await fetch(resolveUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          email,
          password,
          display_name: displayName || undefined,
          invite_code: inviteCode || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Authentication failed.");
        return;
      }
      onAuthenticated(data.user, data.token);
    } catch {
      setError("Could not reach authentication server.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDemoLogin(handle: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(resolveUrl("/api/auth/demo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ handle }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        onAuthenticated(data.user, data.token);
      } else {
        setError(data.error || "Could not switch sandbox user.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/f-dot-mark.png" alt="f." style={{ height: 26, width: "auto" }} />
            <strong style={{ fontSize: "1.12rem" }}>Log in to fyde.</strong>
          </div>
          <button className="pill" onClick={onClose}>
            ✕
          </button>
        </div>

        {notice && (
          <div
            style={{
              background: "var(--terracotta-soft)",
              color: "var(--terracotta)",
              padding: "9px 12px",
              borderRadius: 10,
              fontSize: "0.82rem",
              marginBottom: 14,
              fontWeight: 500,
            }}
          >
            {notice}
          </div>
        )}

        {error && (
          <div
            style={{
              background: "rgba(191,81,52,0.12)",
              border: "1px solid rgba(191,81,52,0.35)",
              color: "var(--terracotta)",
              padding: "9px 12px",
              borderRadius: 10,
              fontSize: "0.83rem",
              marginBottom: 14,
            }}
          >
            {error}
          </div>
        )}

        {/* OAuth Providers: Apple + Google */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <a className="oauth-btn apple" href={resolveUrl("/api/auth/apple/start")}>
            <span style={{ fontSize: "1.05rem" }}></span>
            <span>Sign in with Apple</span>
          </a>
          <a className="oauth-btn" href={resolveUrl("/api/auth/google/start")}>
            <span style={{ fontWeight: 800, color: "#BF5134" }}>G</span>
            <span>Continue with Google</span>
          </a>
        </div>

        <div className="divider-line">or continue with email</div>

        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <div className="segmented">
            <button
              type="button"
              className={method === "otp" ? "active" : ""}
              onClick={() => {
                setMethod("otp");
                setError(null);
              }}
            >
              6-Digit Email Code
            </button>
            <button
              type="button"
              className={method === "password" ? "active" : ""}
              onClick={() => {
                setMethod("password");
                setError(null);
              }}
            >
              Email & Password
            </button>
          </div>
        </div>

        {method === "otp" ? (
          !otpSent ? (
            <form onSubmit={handleSendOtp} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                className="field"
                type="email"
                placeholder="you@domain.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button className="btn btn-forest" type="submit" disabled={busy}>
                {busy ? "Sending 6-digit code…" : "Send Sign-In Code"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: "0.84rem", color: "var(--muted)" }}>
                Enter the 6-digit code sent to <strong>{email}</strong>
              </div>
              {devCodeHint && (
                <div
                  style={{
                    background: "var(--surface-warm)",
                    border: "1px dashed var(--border-strong)",
                    padding: "8px 12px",
                    borderRadius: 10,
                    fontSize: "0.8rem",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>
                    Local Preview Code: <strong>{devCodeHint}</strong>
                  </span>
                  <button
                    type="button"
                    className="pill terracotta"
                    onClick={() => setOtpCode(devCodeHint)}
                  >
                    Autofill
                  </button>
                </div>
              )}
              <input
                className="field"
                placeholder="6-digit code (e.g. 482910)"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                maxLength={6}
                required
              />
              <input
                className="field"
                placeholder="Your name (if new account)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-forest" style={{ flex: 1 }} type="submit" disabled={busy}>
                  {busy ? "Verifying…" : "Verify & Enter fyde."}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    setOtpSent(false);
                    setDevCodeHint(null);
                  }}
                >
                  Back
                </button>
              </div>
            </form>
          )
        ) : (
          <form onSubmit={handlePasswordAuth} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {isRegister && (
              <input
                className="field"
                placeholder="Display Name (e.g. Mehmet)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            )}
            <input
              className="field"
              placeholder="Email or @handle"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="field"
              type="password"
              placeholder="Password (6+ characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {isRegister && (
              <input
                className="field"
                placeholder="Waitlist Invite Code (optional, e.g. FYDE-8A2C)"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
              />
            )}
            <button className="btn btn-forest" type="submit" disabled={busy}>
              {busy ? "Please wait…" : isRegister ? "Create fyde. Account" : "Sign In"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ fontSize: "0.82rem" }}
              onClick={() => setIsRegister((v) => !v)}
            >
              {isRegister ? "Already have an account? Sign in" : "Need an account? Create one with password"}
            </button>
          </form>
        )}

        <div className="divider-line">instant P2P preview accounts</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" className="pill" onClick={() => handleDemoLogin("mehmet")}>
            Mehmet (Pro • Library Owner)
          </button>
          <button type="button" className="pill" onClick={() => handleDemoLogin("maya")}>
            Maya (Wife • Trusted Access)
          </button>
          <button type="button" className="pill" onClick={() => handleDemoLogin("alex")}>
            Alex (China Smart Scope)
          </button>
        </div>
      </div>
    </div>
  );
}

interface BillingModalProps {
  open: boolean;
  onClose: () => void;
  user: UserProfile | null;
  plans: PlanDefinition[];
  authToken: string | null;
  resolveUrl: (rel: string) => string;
  onPlanUpdated: (tier: PlanTier, message: string) => void;
}

export function BillingModal({
  open,
  onClose,
  user,
  plans,
  authToken,
  resolveUrl,
  onPlanUpdated,
}: BillingModalProps) {
  const [interval, setIntervalState] = useState<"monthly" | "yearly">("yearly");
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  async function startCheckout(tier: PlanTier) {
    if (tier === "starter") {
      setBusyTier("starter");
      try {
        const res = await fetch(resolveUrl("/api/billing/portal"), {
          method: "POST",
          headers,
          credentials: "include",
          body: JSON.stringify({ downgrade_to_starter: true }),
        });
        const data = await res.json();
        if (res.ok && data.downgraded) {
          onPlanUpdated("starter", "Switched plan to Starter ($0).");
          onClose();
        } else if (data.portal_url) {
          window.location.href = data.portal_url;
        }
      } finally {
        setBusyTier(null);
      }
      return;
    }

    setError(null);
    setBusyTier(tier);
    try {
      const res = await fetch(resolveUrl("/api/billing/checkout"), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ tier, interval }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not start checkout.");
        return;
      }
      if (data.mode === "stripe_redirect" && data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      onPlanUpdated(tier, data.message || `Upgraded to ${tier.toUpperCase()}!`);
      onClose();
    } catch {
      setError("Failed to contact Cloudflare Edge billing endpoint.");
    } finally {
      setBusyTier(null);
    }
  }

  async function openCustomerPortal() {
    setBusyTier("portal");
    try {
      const res = await fetch(resolveUrl("/api/billing/portal"), {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.portal_url) {
        window.location.href = data.portal_url;
      } else {
        setError(data.error || "Billing portal available once live STRIPE_SECRET_KEY is configured.");
      }
    } finally {
      setBusyTier(null);
    }
  }

  const currentTier = user?.plan_tier || "starter";

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src="/logo.png" alt="fyde." style={{ height: 26 }} />
              <strong>Plans & Zero-Egress Edge Relay</strong>
            </div>
            <div style={{ fontSize: "0.84rem", color: "var(--muted)", marginTop: 4 }}>
              Apple Pay, Google Pay, Link, and all major cards via Stripe Checkout.
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div className="segmented">
              <button
                type="button"
                className={interval === "monthly" ? "active" : ""}
                onClick={() => setIntervalState("monthly")}
              >
                Monthly
              </button>
              <button
                type="button"
                className={interval === "yearly" ? "active" : ""}
                onClick={() => setIntervalState("yearly")}
              >
                Yearly • Save 31%
              </button>
            </div>
            <button className="pill" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 14px",
              borderRadius: 12,
              background: "var(--terracotta-soft)",
              color: "var(--terracotta)",
              fontSize: "0.84rem",
            }}
          >
            {error}
          </div>
        )}

        <div className="feature-grid-3" style={{ marginTop: 22 }}>
          {plans.map((p) => {
            const isCurrent = currentTier === p.tier;
            const price = interval === "yearly" && p.yearly_usd > 0 ? `$${p.yearly_usd}` : `$${p.monthly_usd}`;
            const suffix = p.monthly_usd === 0 ? "forever" : interval === "yearly" ? "/year" : "/month";
            return (
              <div key={p.tier} className={`editorial-card ${p.highlighted ? "highlighted" : ""}`}>
                {p.highlighted && <span className="plan-badge">Most Popular</span>}
                <div style={{ fontWeight: 700, fontSize: "1.08rem" }}>{p.name}</div>
                <div style={{ fontSize: "0.82rem", color: "var(--muted)", minHeight: 34 }}>{p.tagline}</div>
                <div>
                  <span className="price-figure">{price}</span>{" "}
                  <span style={{ fontSize: "0.84rem", color: "var(--muted)" }}>{suffix}</span>
                </div>
                <ul className="feature-list">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={`btn ${p.highlighted ? "btn-terracotta" : "btn-forest"}`}
                  style={{ marginTop: "auto" }}
                  disabled={isCurrent || busyTier !== null}
                  onClick={() => startCheckout(p.tier)}
                >
                  {isCurrent
                    ? "Current Plan"
                    : busyTier === p.tier
                      ? "Starting Checkout…"
                      : p.tier === "starter"
                        ? "Switch to Starter"
                        : `Upgrade to ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 10,
            fontSize: "0.8rem",
            color: "var(--muted)",
          }}
        >
          <span>Accepted:  Apple Pay • Google Pay • Stripe Link • Visa / Mastercard / Amex</span>
          {currentTier !== "starter" && (
            <button type="button" className="pill" onClick={openCustomerPortal}>
              Manage Subscription / Invoices
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
