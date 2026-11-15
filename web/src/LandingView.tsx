import React, { useEffect, useRef, useState } from "react";
import { saveLocalWaitlistEntry } from "./mockFallback";
import type { UserProfile, WaitlistEntry } from "./types";

interface LandingViewProps {
  resolveUrl: (rel: string) => string;
  authenticatedUser: UserProfile | null;
  onOpenLogin: () => void;
  onOpenSignup: () => void;
  onEnterApp: () => void;
}

interface DemoExchange {
  id: string;
  label: string;
  prompt: string;
  status: string;
  file: string;
  detail: string;
  videoStamp?: string;
}

const PRESET_EXCHANGES: DemoExchange[] = [
  {
    id: "surf",
    label: "01 Pacifica video",
    prompt: "iMessage Maya the Pacifica surf wipeout",
    status: "SENT VIA MESSAGES",
    file: "Pacifica_Sunset_4K.mp4",
    detail: "Matched visual moment at 00:14 · “Wave wipeout”",
    videoStamp: "00:14 / 01:12",
  },
  {
    id: "china",
    label: "02 China trip",
    prompt: "Let Alex access all our China trip photos with him",
    status: "SMART ACCESS GRANTED",
    file: "48 photos & videos · Shanghai, Beijing",
    detail: "Shared dynamically with @alex",
  },
  {
    id: "passport",
    label: "03 Passports",
    prompt: "Get our passport scans from Mehmet's files",
    status: "PULLED AUTOMATICALLY",
    file: "Family_Passport_Scans.pdf",
    detail: "Delivered via trusted partner access · 1.8 MB original",
  },
];

const DEMO_SEARCH_ITEMS = [
  {
    id: "s1",
    title: "Pacifica_Sunset_4K.mp4",
    meta: "Pacifica, CA · Maya, Mehmet",
    badge: "00:14",
    keywords: "surf wipeout wave pacifica video beach",
  },
  {
    id: "s2",
    title: "Shanghai_Bund_Rooftop.jpg",
    meta: "Shanghai · Maya, Alex, Mehmet",
    badge: "RAW",
    keywords: "shanghai china trip rooftop night alex photo",
  },
  {
    id: "s3",
    title: "Family_Passport_Scans.pdf",
    meta: "2 pages · Verified PDF",
    badge: "PDF",
    keywords: "passport scan travel document id mehmet maya",
  },
];

function sanitizeHandle(raw: string): string {
  return raw
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase()
    .slice(0, 24);
}

export function LandingView({
  resolveUrl,
  authenticatedUser,
  onOpenLogin,
  onOpenSignup,
  onEnterApp,
}: LandingViewProps) {
  const [wlHandle, setWlHandle] = useState<string>("");
  const [emailStepOpen, setEmailStepOpen] = useState<boolean>(false);
  const [wlEmail, setWlEmail] = useState<string>("");
  const [wlSubmitting, setWlSubmitting] = useState<boolean>(false);
  const [wlResult, setWlResult] = useState<{ alreadyJoined: boolean; entry: WaitlistEntry } | null>(null);
  const [wlError, setWlError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  const handleInputRef = useRef<HTMLInputElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);

  // Interactive right-hand product preview state
  const [previewTab, setPreviewTab] = useState<"search" | "chat" | "received">("chat");
  const [activeExchange, setActiveExchange] = useState<DemoExchange>(PRESET_EXCHANGES[0]);
  const [customDraft, setCustomDraft] = useState<string>("");
  const [demoSearchQuery, setDemoSearchQuery] = useState<string>("surf wipeout");
  const [savedToPhotos, setSavedToPhotos] = useState<boolean>(false);

  useEffect(() => {
    if (!emailStepOpen) return;
    const timer = window.setTimeout(() => {
      emailInputRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [emailStepOpen]);

  const cleanHandle = sanitizeHandle(wlHandle);
  const reservedHandle = sanitizeHandle(wlResult?.entry?.name || cleanHandle);

  function handleRevealEmailStep(e: React.FormEvent) {
    e.preventDefault();
    setWlError(null);

    if (!cleanHandle) {
      setWlError("Choose a handle first.");
      handleInputRef.current?.focus();
      return;
    }
    if (cleanHandle.length < 2) {
      setWlError("Handles must be at least 2 characters.");
      handleInputRef.current?.focus();
      return;
    }

    setEmailStepOpen(true);
  }

  async function submitWaitlist(e: React.FormEvent) {
    e.preventDefault();
    setWlError(null);

    if (!cleanHandle || cleanHandle.length < 2) {
      setWlError("Handles must be at least 2 characters.");
      handleInputRef.current?.focus();
      return;
    }

    const trimmedEmail = wlEmail.trim();
    if (!trimmedEmail || !trimmedEmail.includes("@")) {
      setWlError("Enter a valid email address.");
      emailInputRef.current?.focus();
      return;
    }

    setWlSubmitting(true);
    try {
      const res = await fetch(resolveUrl("/api/waitlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: trimmedEmail,
          name: cleanHandle,
          platform_interest: "ios_macos",
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setWlResult({ alreadyJoined: Boolean(data.already_joined), entry: data.entry });
        return;
      }
      const errData = await res.json().catch(() => null);
      if (errData?.error) {
        setWlError(errData.error);
        return;
      }
      const fallback = saveLocalWaitlistEntry(trimmedEmail, cleanHandle, "ios_macos");
      setWlResult({ alreadyJoined: fallback.already_joined, entry: fallback.entry });
    } catch {
      const fallback = saveLocalWaitlistEntry(trimmedEmail, cleanHandle, "ios_macos");
      setWlResult({ alreadyJoined: fallback.already_joined, entry: fallback.entry });
    } finally {
      setWlSubmitting(false);
    }
  }

  function handleCopyInvite(code: string) {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  }

  function focusHandleBar() {
    document.getElementById("waitlist")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => handleInputRef.current?.focus(), 180);
  }

  function handleCustomDemoSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = customDraft.trim();
    if (!text) return;
    setActiveExchange({
      id: "custom",
      label: "Custom",
      prompt: text,
      status: "MATCHED & QUEUED",
      file: "3 matching originals",
      detail: `Indexed locally and ready to send for “${text}”`,
    });
    setCustomDraft("");
  }

  const filteredDemoSearch = DEMO_SEARCH_ITEMS.filter((item) => {
    const q = demoSearchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      item.title.toLowerCase().includes(q) ||
      item.meta.toLowerCase().includes(q) ||
      item.keywords.includes(q)
    );
  });

  return (
    <div className="landing-root">
      {/* Top Bar: Clean Wordmark Left, Login Top-Right */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <a href="#top" className="brand-lockup" aria-label="fyde. home">
            <img src="/logo.png" alt="fyde." className="brand-logo-img" />
          </a>

          <div className="nav-actions">
            {authenticatedUser ? (
              <>
                <span className="mono" style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                  @{authenticatedUser.handle}
                </span>
                <button type="button" className="login-top-btn" onClick={onEnterApp}>
                  <span>Open app</span>
                  <span aria-hidden="true">→</span>
                </button>
              </>
            ) : (
              <>
                <button type="button" className="login-top-btn ghost" onClick={onOpenLogin}>
                  <span>Log in</span>
                </button>
                <button type="button" className="login-top-btn" onClick={onOpenSignup}>
                  <span>Sign up</span>
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Split Stage */}
      <section id="top" className="hero-section">
        <div>
          <h1 className="hero-title">
            Find it by memory<span className="accent-dot">.</span>
            <br />
            Send it in a sentence<span className="accent-dot">.</span>
          </h1>

          <p className="hero-subtitle">
            Ask for “China trip photos with Alex” or “the surfing wipeout in Pacifica.”{" "}
            <strong>fyde.</strong> locates the exact photo, PDF, or second inside a video and sends the original over
            Fyde, iMessage, or email.
          </p>

          {/* Two-Step Inline Handle Reservation -> Email Waitlist */}
          <div id="waitlist" className="waitlist-box">
            {!wlResult ? (
              <form onSubmit={emailStepOpen ? submitWaitlist : handleRevealEmailStep} noValidate>
                <label htmlFor="reserve-handle-input" className="reserve-label">
                  Reserve your handle
                </label>

                <div className="handle-bar">
                  <span className="handle-bar-prefix" aria-hidden="true">
                    @
                  </span>
                  <input
                    id="reserve-handle-input"
                    ref={handleInputRef}
                    className="handle-bar-input"
                    type="text"
                    placeholder="yourhandle"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={wlHandle}
                    onChange={(e) => {
                      setWlHandle(sanitizeHandle(e.target.value));
                      if (wlError) setWlError(null);
                    }}
                    onKeyDown={(e) => {
                      if (!emailStepOpen && e.key === "Tab" && !e.shiftKey && cleanHandle.length >= 2) {
                        e.preventDefault();
                        setEmailStepOpen(true);
                        return;
                      }
                      if (emailStepOpen && e.key === "Enter") {
                        e.preventDefault();
                        emailInputRef.current?.focus();
                      }
                    }}
                  />
                  {!emailStepOpen ? (
                    <button className="waitlist-submit-btn" type="submit">
                      Reserve handle
                    </button>
                  ) : (
                    <span className="handle-status-tag">
                      <span style={{ color: "var(--orange)" }}>✓</span>
                      <span>Holding</span>
                    </span>
                  )}
                </div>

                {emailStepOpen && (
                  <div className="email-step-wrap">
                    <p className="email-step-caption">
                      Enter your email to lock{" "}
                      <strong className="mono" style={{ color: "var(--black)" }}>
                        @{cleanHandle || "handle"}
                      </strong>{" "}
                      and join the waitlist.
                    </p>

                    <div className="email-bar">
                      <input
                        ref={emailInputRef}
                        className="email-bar-input"
                        type="email"
                        placeholder="name@domain.com"
                        value={wlEmail}
                        onChange={(e) => {
                          setWlEmail(e.target.value);
                          if (wlError) setWlError(null);
                        }}
                        aria-label="Email address"
                        required
                      />
                      <button className="waitlist-submit-btn" type="submit" disabled={wlSubmitting}>
                        {wlSubmitting ? "Joining…" : "Join waitlist"}
                      </button>
                    </div>
                  </div>
                )}

                {wlError && (
                  <div style={{ color: "var(--orange)", fontWeight: 700, fontSize: "0.82rem", marginTop: 9 }}>
                    {wlError}
                  </div>
                )}
              </form>
            ) : (
              <div>
                <div className="pass-stub">
                  <div className="pass-stub-left">
                    <span className="mono" style={{ fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.08em" }}>
                      QUEUE NO.
                    </span>
                    <span
                      className="mono"
                      style={{ fontSize: "1.75rem", fontWeight: 700, lineHeight: 1, letterSpacing: "-0.03em" }}
                    >
                      #{String(wlResult.entry.position).padStart(4, "0")}
                    </span>
                  </div>

                  <div className="pass-stub-right">
                    <div>
                      <div
                        className="mono"
                        style={{ fontSize: "0.68rem", color: "#999999", letterSpacing: "0.08em" }}
                      >
                        {wlResult.alreadyJoined ? "ALREADY ON THE LIST" : "HANDLE RESERVED"}
                      </div>
                      <div className="mono" style={{ fontWeight: 700, fontSize: "0.96rem", marginTop: 3 }}>
                        <span style={{ color: "var(--orange)" }}>@</span>
                        {reservedHandle}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "#a3a3a3", marginTop: 2 }}>
                        {wlResult.entry.email}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <code style={{ fontSize: "0.78rem", color: "var(--orange)", fontWeight: 700 }}>
                        {wlResult.entry.invite_code}
                      </code>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="plat-btn"
                          style={{ background: "var(--white)", color: "var(--black)", borderColor: "var(--white)" }}
                          onClick={() => handleCopyInvite(wlResult.entry.invite_code)}
                        >
                          {copiedCode ? "Copied" : "Copy pass"}
                        </button>
                        <button
                          type="button"
                          className="plat-btn"
                          style={{ background: "transparent", color: "#bbbbbb", borderColor: "#333333" }}
                          onClick={() => {
                            setWlResult(null);
                            setEmailStepOpen(false);
                            setWlEmail("");
                            setWlHandle("");
                          }}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Clean Interactive Fyde Interface */}
        <div className="demo-shell">
          <div className="demo-topbar">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src="/f-dot-mark-white.png" alt="f." style={{ height: 22 }} />
              <span className="mono" style={{ fontSize: "0.74rem", color: "#a3a3a3" }}>
                fyde. interactive preview
              </span>
            </div>

            <div className="demo-tabs" role="tablist" aria-label="App tabs">
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === "search"}
                className={previewTab === "search" ? "active" : ""}
                onClick={() => setPreviewTab("search")}
              >
                Search
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === "chat"}
                className={previewTab === "chat" ? "active" : ""}
                onClick={() => setPreviewTab("chat")}
              >
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={previewTab === "received"}
                className={previewTab === "received" ? "active" : ""}
                onClick={() => setPreviewTab("received")}
              >
                Received
              </button>
            </div>
          </div>

          <div className="demo-canvas">
            {previewTab === "chat" && (
              <>
                <div className="prompt-selector">
                  {PRESET_EXCHANGES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`prompt-tab ${activeExchange.id === item.id ? "active" : ""}`}
                      onClick={() => setActiveExchange(item)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="demo-msg-user">{activeExchange.prompt}</div>

                <div className="demo-result-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--orange)" }}>
                      {activeExchange.status}
                    </span>
                    {activeExchange.videoStamp && (
                      <span className="mono" style={{ fontSize: "0.68rem", color: "var(--muted)" }}>
                        {activeExchange.videoStamp}
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 800, fontSize: "0.92rem" }}>{activeExchange.file}</div>
                  <div style={{ fontSize: "0.81rem", color: "var(--ink-soft)" }}>{activeExchange.detail}</div>
                  {activeExchange.videoStamp && (
                    <div className="scrubber-bar" aria-hidden="true">
                      <div className="scrubber-fill" />
                    </div>
                  )}
                </div>

                <form className="demo-input-row" onSubmit={handleCustomDemoSubmit}>
                  <input
                    className="demo-mini-input"
                    placeholder="Try typing a request (e.g. Send tax PDF to Sarah)…"
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                  />
                  <button type="submit" className="demo-mini-send">
                    Run
                  </button>
                </form>
              </>
            )}

            {previewTab === "search" && (
              <>
                <input
                  className="demo-mini-input"
                  style={{ flex: "none", padding: "10px 12px" }}
                  value={demoSearchQuery}
                  onChange={(e) => setDemoSearchQuery(e.target.value)}
                  placeholder="Search by scene, location, person, or text…"
                />

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {filteredDemoSearch.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "11px 13px",
                        borderRadius: 10,
                        border: "1px solid var(--line)",
                        background: "var(--off-white)",
                        gap: 10,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: "0.86rem" }}>{item.title}</div>
                        <div style={{ fontSize: "0.76rem", color: "var(--muted)", marginTop: 2 }}>{item.meta}</div>
                      </div>
                      <span
                        className="mono"
                        style={{
                          fontSize: "0.7rem",
                          fontWeight: 700,
                          padding: "3px 8px",
                          borderRadius: 6,
                          background: item.badge === "00:14" ? "var(--orange)" : "var(--black)",
                          color: "var(--white)",
                        }}
                      >
                        {item.badge}
                      </span>
                    </div>
                  ))}
                  {filteredDemoSearch.length === 0 && (
                    <div style={{ fontSize: "0.82rem", color: "var(--muted)", padding: "14px 4px" }}>
                      Try “surf”, “Shanghai”, or “passport”.
                    </div>
                  )}
                </div>
              </>
            )}

            {previewTab === "received" && (
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1 }}>
                <div className="demo-result-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="mono" style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--orange)" }}>
                      INCOMING BUNDLE
                    </span>
                    <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                      18.4 MB
                    </span>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: "0.96rem" }}>Shanghai Film Scans (4 photos)</div>
                  <div style={{ fontSize: "0.82rem", color: "var(--ink-soft)" }}>
                    From <strong>@mehmet</strong> · Uncompressed originals ready for Photos.
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {savedToPhotos ? (
                      <button
                        type="button"
                        className="btn btn-black"
                        style={{ padding: "8px 14px", fontSize: "0.8rem" }}
                        onClick={() => setSavedToPhotos(false)}
                      >
                        ✓ Saved to Apple Photos
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-orange"
                          style={{ padding: "8px 14px", fontSize: "0.8rem" }}
                          onClick={() => setSavedToPhotos(true)}
                        >
                          Save to Photos
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline"
                          style={{ padding: "8px 14px", fontSize: "0.8rem" }}
                          onClick={() => setSavedToPhotos(true)}
                        >
                          Save to Files
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingTop: 12,
                    borderTop: "1px solid var(--line)",
                    fontSize: "0.78rem",
                    color: "var(--muted)",
                  }}
                >
                  <span>Already have an account?</span>
                  <button
                    type="button"
                    className="text-link-btn"
                    onClick={authenticatedUser ? onEnterApp : onOpenLogin}
                  >
                    {authenticatedUser ? "Enter workspace →" : "Sign in →"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Crisp Architectural 3-Column Strip */}
      <section className="ledger-band" aria-label="Core workflow">
        <div className="ledger-grid">
          <div className="ledger-cell">
            <span className="ledger-index">01 / SEARCH</span>
            <h3>Recall moments, not filenames.</h3>
            <p>
              Find photos, PDFs, and the exact timestamp inside a video by describing where it was, who was there, or
              what happened.
            </p>
          </div>

          <div className="ledger-cell">
            <span className="ledger-index">02 / CHAT</span>
            <h3>Share or delegate in one line.</h3>
            <p>
              Send files over Fyde, iMessage, or email, or grant a partner or friend scoped access to a trip.
            </p>
          </div>

          <div className="ledger-cell">
            <span className="ledger-index">03 / RECEIVED</span>
            <h3>Originals straight to Photos.</h3>
            <p>
              Incoming transfers keep full resolution and metadata, saving directly into your iPhone or Mac library in
              a single tap.
            </p>
          </div>
        </div>
      </section>

      {/* Clean Single-Line Footer */}
      <footer className="landing-footer">
        <div style={{ display: "flex", alignItems: "center" }}>
          <img src="/logo.png" alt="fyde." style={{ height: 20 }} />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: 0, border: "none", fontWeight: 600, fontSize: "0.82rem", cursor: "pointer" }}
            onClick={focusHandleBar}
          >
            Reserve handle
          </button>
          <button
            type="button"
            className="text-link-btn"
            onClick={authenticatedUser ? onEnterApp : onOpenLogin}
          >
            {authenticatedUser ? "Open app" : "Log in"}
          </button>
        </div>
      </footer>
    </div>
  );
}
