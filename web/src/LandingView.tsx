import React, { useEffect, useState } from "react";
import type { PlanDefinition, PlanTier, UserProfile, WaitlistEntry } from "./types";

interface LandingViewProps {
  resolveUrl: (rel: string) => string;
  plans: PlanDefinition[];
  authenticatedUser: UserProfile | null;
  onOpenLogin: (pendingPlan?: { tier: PlanTier; interval: "monthly" | "yearly" }) => void;
  onEnterApp: () => void;
  onSelectPlanWhileAuthed: (tier: PlanTier, interval: "monthly" | "yearly") => void;
}

export function LandingView({
  resolveUrl,
  plans,
  authenticatedUser,
  onOpenLogin,
  onEnterApp,
  onSelectPlanWhileAuthed,
}: LandingViewProps) {
  const [waitlistCount, setWaitlistCount] = useState<number>(340);
  const [wlEmail, setWlEmail] = useState<string>("");
  const [wlName, setWlName] = useState<string>("");
  const [wlPlatform, setWlPlatform] = useState<string>("ios_macos");
  const [wlSubmitting, setWlSubmitting] = useState<boolean>(false);
  const [wlResult, setWlResult] = useState<{ message: string; entry: WaitlistEntry } | null>(null);
  const [wlError, setWlError] = useState<string | null>(null);

  const [billingInterval, setBillingInterval] = useState<"monthly" | "yearly">("yearly");
  const [previewTab, setPreviewTab] = useState<"search" | "chat" | "received">("chat");

  useEffect(() => {
    fetch(resolveUrl("/api/waitlist/stats"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.total_waitlist) setWaitlistCount(Number(d.total_waitlist));
      })
      .catch(() => {});
  }, [resolveUrl]);

  async function submitWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setWlError(null);
    setWlSubmitting(true);
    try {
      const res = await fetch(resolveUrl("/api/waitlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: wlEmail,
          name: wlName,
          platform_interest: wlPlatform,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setWlError(data.error || "Could not join waitlist.");
        return;
      }
      setWlResult({ message: data.message, entry: data.entry });
      if (!data.already_joined) setWaitlistCount((c) => c + 1);
    } catch {
      setWlError("Could not reach fyde.izbirakin.com waitlist edge.");
    } finally {
      setWlSubmitting(false);
    }
  }

  function handlePlanCta(tier: PlanTier) {
    if (tier === "starter") {
      if (authenticatedUser) onEnterApp();
      else onOpenLogin();
      return;
    }
    if (authenticatedUser) {
      onSelectPlanWhileAuthed(tier, billingInterval);
    } else {
      onOpenLogin({ tier, interval: billingInterval });
    }
  }

  return (
    <div className="landing-root">
      {/* Top Editorial Navigation */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <a href="#top" className="brand-lockup">
            <img src="/logo.png" alt="fyde." className="brand-logo-img" />
            <span className="domain-tag">fyde.izbirakin.com</span>
          </a>

          <div className="nav-links">
            <a href="#how-it-works">3-Tab Workflow</a>
            <a href="#permissions">Smart Trust</a>
            <a href="#edge">Cloudflare Edge</a>
            <a href="#pricing">Pricing</a>
          </div>

          <div className="nav-actions">
            {authenticatedUser ? (
              <>
                <span style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                  Signed in as <strong>@{authenticatedUser.handle}</strong>
                </span>
                <button className="btn btn-forest" onClick={onEnterApp}>
                  Open fyde. App →
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-outline" onClick={() => onOpenLogin()}>
                  Log in
                </button>
                <a className="btn btn-terracotta" href="#waitlist">
                  Join Waitlist
                </a>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Hero + Waitlist Section */}
      <section id="top" className="hero-section">
        <div>
          <div className="eyebrow-pill">
            <span className="terracotta-dot" />
            <span>iPhone First • macOS & Web • EmbeddingGemma 2 Multimodal</span>
          </div>

          <h1 className="hero-title">
            Search by memory<span className="accent-dot">.</span>
            <br />
            Share in a sentence<span className="accent-dot">.</span>
          </h1>

          <p className="hero-subtitle">
            <strong>fyde.</strong> indexes your photos, exact video timestamps, and PDFs privately on-device—letting you
            send anything over <strong>Direct Fyde</strong>, <strong>iMessage</strong>, or <strong>Email</strong> from a
            single chat, or grant trusted contacts folderless access so they can pull what they need themselves.
          </p>

          {/* Waitlist Box */}
          <div id="waitlist" className="waitlist-card">
            {!wlResult ? (
              <form onSubmit={submitWaitlist}>
                <div style={{ fontWeight: 700, fontSize: "0.98rem", marginBottom: 10 }}>
                  Reserve your handle & early access invite
                </div>
                <div className="waitlist-form-row" style={{ marginBottom: 10 }}>
                  <input
                    className="field"
                    style={{ flex: "1 1 210px" }}
                    type="email"
                    placeholder="Enter your email address…"
                    value={wlEmail}
                    onChange={(e) => setWlEmail(e.target.value)}
                    required
                  />
                  <input
                    className="field"
                    style={{ flex: "0.8 1 140px" }}
                    placeholder="First name (optional)"
                    value={wlName}
                    onChange={(e) => setWlName(e.target.value)}
                  />
                </div>
                <div className="waitlist-form-row">
                  <select
                    className="field"
                    style={{ flex: "1 1 170px" }}
                    value={wlPlatform}
                    onChange={(e) => setWlPlatform(e.target.value)}
                  >
                    <option value="ios_macos">iPhone + macOS + Web</option>
                    <option value="ios_only">iPhone + iMessage</option>
                    <option value="web_macos">macOS + Web</option>
                  </select>
                  <button className="btn btn-terracotta" style={{ flex: "1 1 180px" }} type="submit" disabled={wlSubmitting}>
                    {wlSubmitting ? "Reserving…" : "Join the Waitlist →"}
                  </button>
                </div>
                {wlError && (
                  <div style={{ color: "var(--terracotta)", fontSize: "0.82rem", marginTop: 8 }}>{wlError}</div>
                )}
              </form>
            ) : (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span className="terracotta-dot" />
                  <strong style={{ fontSize: "1.02rem" }}>{wlResult.message}</strong>
                </div>
                <div style={{ fontSize: "0.86rem", color: "var(--ink-soft)", lineHeight: 1.5 }}>
                  Queue Spot: <strong>#{wlResult.entry.position}</strong> • Early Invite Token:{" "}
                  <code>{wlResult.entry.invite_code}</code> • Referral Code:{" "}
                  <strong>{wlResult.entry.referral_code}</strong>
                </div>
              </div>
            )}

            <div className="waitlist-meta">
              <span>
                <strong>{waitlistCount.toLocaleString()}</strong> people waiting for TestFlight & Mac Bridge
              </span>
              {!authenticatedUser && (
                <button
                  type="button"
                  className="pill"
                  onClick={() => onOpenLogin()}
                >
                  Have an account or testing? Log in →
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Interactive 3-Tab Live Mockup Card */}
        <div className="hero-device-card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <img src="/f-dot-mark.png" alt="f." style={{ height: 22 }} />
              <span style={{ fontSize: "0.82rem", fontWeight: 700 }}>iPhone • Direct-to-Photos & P2P</span>
            </div>
            <div className="segmented">
              <button
                type="button"
                className={previewTab === "search" ? "active" : ""}
                onClick={() => setPreviewTab("search")}
              >
                Search
              </button>
              <button
                type="button"
                className={previewTab === "chat" ? "active" : ""}
                onClick={() => setPreviewTab("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                className={previewTab === "received" ? "active" : ""}
                onClick={() => setPreviewTab("received")}
              >
                Received
              </button>
            </div>
          </div>

          {previewTab === "chat" && (
            <>
              <div className="preview-chat-bubble user">
                Allow Alex to access all my China trip photos with him — no folder needed.
              </div>
              <div className="preview-chat-bubble fyde">
                <strong>Smart Scope active for Alex</strong>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 4 }}>
                  Matched dynamically across Apple Photos: 📍 China, Shanghai • 👥 Alex • Photos & Videos.
                </div>
              </div>
              <div className="preview-chat-bubble user">
                Get our passport scans from Mehmet's files
              </div>
              <div className="preview-chat-bubble fyde">
                <strong>Auto-pulled via Trusted Spouse Access</strong>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 4 }}>
                  Delivered <code>Family_Passport_Scans.pdf</code> over zero-egress R2 directly to Maya's Received tab.
                </div>
              </div>
            </>
          )}

          {previewTab === "search" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="field" style={{ fontSize: "0.84rem", background: "var(--surface-tint)" }}>
                🔍 “surfing wipeout wave in Pacifica”
              </div>
              <div className="preview-chat-bubble fyde">
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>Pacifica Surfing Session (4K)</strong>
                  <span className="pill terracotta">▶ 0:14s</span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 4 }}>
                  Matched keyframe embedding @ 14.0s — “Big wave wipeout & laugh” • Streamed via R2 Range
                </div>
              </div>
              <div className="preview-chat-bubble fyde">
                <strong>Shanghai Bund Night Skyline</strong>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 4 }}>
                  📍 Shanghai, China • 👥 Mehmet, Maya, Alex
                </div>
              </div>
            </div>
          )}

          {previewTab === "received" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="preview-chat-bubble fyde">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>China Trip Highlights (4 Photos)</strong>
                  <span className="pill terracotta">Direct Fyde</span>
                </div>
                <div style={{ fontSize: "0.8rem", color: "var(--muted)", margin: "6px 0 10px" }}>
                  AirDrop-style PhotoKit integration saves directly into your iPhone Camera Roll & album.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <span className="pill primary">Save to Apple Photos</span>
                  <span className="pill">Save to Files</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 3-Tab Architecture & Smart Permissions */}
      <section id="how-it-works" className="section-wrap">
        <div className="section-header">
          <span className="eyebrow-pill">Three Tabs. Zero Friction.</span>
          <h2>Designed around how families and close teams actually share.</h2>
        </div>

        <div id="permissions" className="feature-grid-3">
          <div className="editorial-card">
            <span className="pill terracotta" style={{ alignSelf: "flex-start" }}>Left Tab • Search</span>
            <h3 style={{ margin: "6px 0 4px" }}>Multimodal Video, Photo & PDF Recall</h3>
            <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem", lineHeight: 1.55 }}>
              Powered by 256-D Matryoshka embeddings (EmbeddingGemma 2 + Apple Vision OCR & Neural Engine). Search a
              spoken phrase or visual moment and jump straight to the exact second inside a video.
            </p>
          </div>

          <div className="editorial-card">
            <span className="pill primary" style={{ alignSelf: "flex-start" }}>Middle Tab • Fyde Chat</span>
            <h3 style={{ margin: "6px 0 4px" }}>Send & Set Permissions in Plain English</h3>
            <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem", lineHeight: 1.55 }}>
              Land directly in Chat. Send automatically in the background over <strong>Direct Fyde</strong>,{" "}
              <strong>iMessage</strong> (via macOS Messages bridge), or <strong>Email</strong>—and grant{" "}
              <strong>Trusted Spouse</strong> or <strong>Folderless Smart Scopes</strong> inline.
            </p>
          </div>

          <div className="editorial-card">
            <span className="pill terracotta" style={{ alignSelf: "flex-start" }}>Right Tab • Received</span>
            <h3 style={{ margin: "6px 0 4px" }}>AirDrop-Like Direct-to-Photos</h3>
            <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: "0.9rem", lineHeight: 1.55 }}>
              Incoming Direct Fyde bundles land in Received and save straight into your iPhone or Mac{" "}
              <code>PHPhotoLibrary</code> album—or accept them hands-free right from Fyde Chat.
            </p>
          </div>
        </div>
      </section>

      {/* Cloudflare Edge Architecture */}
      <section id="edge" className="section-wrap" style={{ paddingTop: 12 }}>
        <div className="editorial-card" style={{ padding: 32, background: "var(--surface-warm)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
            <div style={{ maxWidth: 640 }}>
              <span className="eyebrow-pill">Global Edge Infrastructure</span>
              <h2 style={{ margin: "12px 0 8px", letterSpacing: "-0.02em" }}>
                Built on Cloudflare Workers, Hibernating Durable Objects & Zero-Egress R2.
              </h2>
              <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.6, fontSize: "0.93rem" }}>
                Every device maintains a near-zero-cost hibernating WebSocket on Cloudflare's global edge, backed by D1
                permission ledgers and encrypted zero-egress R2 transfer relays—so 4K family videos and PDFs transfer
                instantaneously across continents without bandwidth fees.
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 230 }}>
              <div className="pill">⚡ Durable Object WebSocket Hibernation</div>
              <div className="pill">🪣 Cloudflare R2 ($0 Egress Video Streaming)</div>
              <div className="pill">🔐 Web Crypto PBKDF2 + Apple JWKS + D1</div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing & Payment Options */}
      <section id="pricing" className="section-wrap">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 16, marginBottom: 28 }}>
          <div>
            <span className="eyebrow-pill">Simple, Transparent Pricing</span>
            <h2 style={{ margin: "10px 0 4px", fontSize: "2.1rem", letterSpacing: "-0.025em" }}>
              Start free on-device. Scale with zero-egress cloud relay.
            </h2>
          </div>
          <div className="segmented">
            <button
              type="button"
              className={billingInterval === "monthly" ? "active" : ""}
              onClick={() => setBillingInterval("monthly")}
            >
              Monthly
            </button>
            <button
              type="button"
              className={billingInterval === "yearly" ? "active" : ""}
              onClick={() => setBillingInterval("yearly")}
            >
              Yearly (Save 31%)
            </button>
          </div>
        </div>

        <div className="feature-grid-3">
          {plans.map((p) => {
            const price = billingInterval === "yearly" && p.yearly_usd > 0 ? `$${p.yearly_usd}` : `$${p.monthly_usd}`;
            const unit = p.monthly_usd === 0 ? "free forever" : billingInterval === "yearly" ? "/ year" : "/ month";
            return (
              <div key={p.tier} className={`editorial-card ${p.highlighted ? "highlighted" : ""}`}>
                {p.highlighted && <span className="plan-badge">Recommended</span>}
                <div style={{ fontWeight: 700, fontSize: "1.12rem" }}>{p.name}</div>
                <div style={{ fontSize: "0.84rem", color: "var(--muted)", minHeight: 36 }}>{p.tagline}</div>
                <div>
                  <span className="price-figure">{price}</span>{" "}
                  <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>{unit}</span>
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
                  onClick={() => handlePlanCta(p.tier)}
                >
                  {p.tier === "starter" ? "Get Started Free" : `Choose ${p.name}`}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: "0.82rem", color: "var(--muted)" }}>
          Checkout powered by Stripe • Supports <strong> Apple Pay</strong>, <strong>Google Pay</strong>,{" "}
          <strong>Link</strong>, and all credit/debit cards.
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid var(--border)", padding: "28px 24px", marginTop: 24 }}>
        <div
          style={{
            maxWidth: 1160,
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 14,
            fontSize: "0.84rem",
            color: "var(--muted)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/logo.png" alt="fyde." style={{ height: 22 }} />
            <span>© {new Date().getFullYear()} fyde. • Hosted at fyde.izbirakin.com</span>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <a href="#waitlist">Waitlist</a>
            <a href="#pricing">Pricing</a>
            <button
              type="button"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink)", fontWeight: 600 }}
              onClick={() => onOpenLogin()}
            >
              Member Log in →
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
