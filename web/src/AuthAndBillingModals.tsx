import React, { useEffect, useState } from "react";
import type { UserProfile } from "./types";

export type AuthMode = "signin" | "signup";

export interface OAuthAvailability {
  google: boolean;
  apple: boolean;
}

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  resolveUrl: (rel: string) => string;
  onAuthenticated: (user: UserProfile, token?: string) => void;
  notice?: string | null;
  initialMode?: AuthMode;
  /** From /api/auth/me. `null` while unknown — the buttons then just try the redirect. */
  oauth?: OAuthAvailability | null;
}

/** Mirrors the edge's `normalizeHandle`: lowercase a–z, 0–9 and _, max 24 characters. */
function normalizeHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function emailLooksValid(raw: string): boolean {
  const parts = raw.trim().split("@");
  return parts.length === 2 && parts[0].length > 0 && parts[1].includes(".");
}

export function AuthModal({
  open,
  onClose,
  resolveUrl,
  onAuthenticated,
  notice,
  initialMode = "signin",
  oauth,
}: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState<string>("");
  const [handle, setHandle] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Re-open in whichever mode the caller asked for (Log in vs Sign up buttons).
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setError(null);
    }
  }, [open, initialMode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const isSignUp = mode === "signup";
  const canSubmit = isSignUp
    ? emailLooksValid(email) && handle.length >= 3 && password.length >= 6
    : handle.length > 0 && password.length > 0;

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
  }

  function handleOAuthClick(provider: "google" | "apple", e: React.MouseEvent<HTMLAnchorElement>) {
    if (oauth && !oauth[provider]) {
      e.preventDefault();
      const name = provider === "google" ? "Google" : "Apple";
      setError(`Continue with ${name} isn't set up on this server yet. Use a handle and password for now.`);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setError(null);
    setBusy(true);
    try {
      const endpoint = isSignUp ? "/api/auth/register" : "/api/auth/login";
      // /api/auth/login accepts a handle in its `email` field.
      const body = isSignUp
        ? { email: email.trim().toLowerCase(), handle, password }
        : { email: handle, password };
      const res = await fetch(resolveUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.user) {
        onAuthenticated(data.user, data.token);
        return;
      }
      if (data?.error) {
        setError(isSignUp ? data.error : "Wrong handle or password.");
      } else {
        setError(`Something went wrong (HTTP ${res.status}). Please try again.`);
      }
    } catch {
      setError("Couldn't reach fyde. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card auth-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="auth-head">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src="/f-dot-mark.png" alt="" style={{ height: 24, width: "auto" }} />
            <strong id="auth-title" style={{ fontSize: "1.08rem" }}>
              {isSignUp ? "Create your fyde. account" : "Sign in to fyde."}
            </strong>
          </div>
          <button type="button" className="pill" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {notice && <div className="auth-notice">{notice}</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <a
            className="oauth-btn apple"
            href={resolveUrl("/api/auth/apple/start")}
            onClick={(e) => handleOAuthClick("apple", e)}
          >
            <svg width="15" height="18" viewBox="0 0 814 1000" aria-hidden="true" fill="currentColor">
              <path d="M788 341c-6 4-108 62-108 190 0 148 130 200 134 202-1 3-21 72-69 142-43 62-88 124-156 124s-86-40-165-40c-77 0-104 41-166 41s-106-57-156-127C44 791 0 669 0 553c0-186 121-285 240-285 63 0 116 42 156 42 38 0 97-44 169-44 27 0 126 2 191 75zM554 157c30-36 51-85 51-135 0-7-1-14-2-20-48 2-106 32-140 73-27 31-53 80-53 131 0 8 1 15 2 18 3 1 9 1 14 1 43 0 97-29 128-68z" />
            </svg>
            <span>Continue with Apple</span>
          </a>
          <a
            className="oauth-btn"
            href={resolveUrl("/api/auth/google/start")}
            onClick={(e) => handleOAuthClick("google", e)}
          >
            <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
            </svg>
            <span>Continue with Google</span>
          </a>
        </div>

        <div className="divider-line">or</div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }} noValidate>
          {isSignUp && (
            <input
              className="field"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          )}
          <div className="field-with-prefix">
            <span aria-hidden="true">@</span>
            <input
              className="field"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={isSignUp ? "Choose a handle" : "Handle"}
              value={handle}
              onChange={(e) => setHandle(normalizeHandle(e.target.value))}
              autoFocus={!isSignUp}
            />
          </div>
          <input
            className="field"
            type="password"
            name="password"
            autoComplete={isSignUp ? "new-password" : "current-password"}
            placeholder={isSignUp ? "Password (6+ characters)" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <button className="btn btn-orange" type="submit" disabled={busy || !canSubmit}>
            {busy ? (isSignUp ? "Creating account…" : "Signing in…") : isSignUp ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {isSignUp ? "Already have an account?" : "New to fyde?"}{" "}
          <button type="button" onClick={() => switchMode(isSignUp ? "signin" : "signup")}>
            {isSignUp ? "Sign in" : "Sign up"}
          </button>
        </p>
      </div>
    </div>
  );
}
