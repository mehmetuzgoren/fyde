import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthModal, BillingModal } from "./AuthAndBillingModals";
import { LandingView } from "./LandingView";
import type {
  AccessRequest,
  ActiveTab,
  ChatMessage,
  ContactPermission,
  MediaType,
  PermissionTier,
  PlanDefinition,
  PlanTier,
  SearchHit,
  SendChannel,
  TransferBundle,
  UserProfile,
} from "./types";

const API_BASE = import.meta.env.VITE_FYDE_RELAY_URL || "";

const DEFAULT_PLANS: PlanDefinition[] = [
  {
    tier: "starter",
    name: "Starter",
    tagline: "Private on-device search & peer transfers",
    monthly_usd: 0,
    yearly_usd: 0,
    features: [
      "Local EmbeddingGemma 2 / Apple Neural Engine search",
      "Up to 2 GB Direct Fyde transfers per month",
      "Up to 3 Contact Permission rules",
      "iPhone, macOS & Web access",
    ],
  },
  {
    tier: "pro",
    name: "fyde. Pro",
    tagline: "Always-on edge relay & zero-egress 4K video sharing",
    monthly_usd: 12,
    yearly_usd: 99,
    highlighted: true,
    features: [
      "Unlimited zero-egress R2 photo & 4K video relays",
      "Unlimited Folderless Smart Scopes (location, people, topic)",
      "Always-On Edge Index for instant trusted pulls while asleep",
      "Automatic background Email + macOS Messages.app bridge",
    ],
  },
  {
    tier: "family",
    name: "fyde. Household",
    tagline: "Shared trust & Direct-to-Photos across up to 6 members",
    monthly_usd: 19,
    yearly_usd: 159,
    features: [
      "Everything in fyde. Pro for up to 6 family members",
      "Mutual Trusted Spouse / Partner auto-pulling",
      "AirDrop-style automatic PhotoKit album syncing",
      "Priority video keyframe & multimodal cloud indexing",
    ],
  },
];

export default function App() {
  const resolveUrl = useCallback((rel: string): string => {
    if (!rel) return "";
    if (rel.startsWith("http://") || rel.startsWith("https://")) return rel;
    return `${API_BASE}${rel.startsWith("/") ? rel : `/${rel}`}`;
  }, []);

  // Start on the Waitlist + Landing Page at `/` unless returning from OAuth/Checkout (`?view=app`)
  const initialViewIsApp = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "app";
  }, []);

  const [showLanding, setShowLanding] = useState<boolean>(!initialViewIsApp);
  const [authUser, setAuthUser] = useState<UserProfile | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem("fyde_token"));
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [billingModalOpen, setBillingModalOpen] = useState<boolean>(false);
  const [pendingPlan, setPendingPlan] = useState<{ tier: PlanTier; interval: "monthly" | "yearly" } | null>(null);
  const [plans, setPlans] = useState<PlanDefinition[]>(DEFAULT_PLANS);

  // Inside App: Default landing tab is the MIDDLE Fyde Chat tab!
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string>("mehmet");
  const [connected, setConnected] = useState<boolean>(false);
  const [embedderLabel, setEmbedderLabel] = useState<string>("");
  const [toast, setToast] = useState<string | null>(null);

  // Search tab state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchScope, setSearchScope] = useState<"all" | "mine" | "contacts">("all");
  const [mediaFilter, setMediaFilter] = useState<MediaType | "">("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [playingHit, setPlayingHit] = useState<SearchHit | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Chat & Permissions state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [sendingChat, setSendingChat] = useState<boolean>(false);
  const [permissions, setPermissions] = useState<ContactPermission[]>([]);
  const [showPermDrawer, setShowPermDrawer] = useState<boolean>(false);

  // Permission form
  const [permContact, setPermContact] = useState<string>("Alex");
  const [permRelation, setPermRelation] = useState<string>("Friend");
  const [permEmail, setPermEmail] = useState<string>("");
  const [permPhone, setPermPhone] = useState<string>("");
  const [permTier, setPermTier] = useState<PermissionTier>("smart_scope");
  const [scopeLocations, setScopeLocations] = useState<string>("China, Shanghai");
  const [scopePeople, setScopePeople] = useState<string>("Alex");
  const [scopeTopic, setScopeTopic] = useState<string>("China trip");

  // Received tab state
  const [receivedBundles, setReceivedBundles] = useState<TransferBundle[]>([]);
  const [sentBundles, setSentBundles] = useState<TransferBundle[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<AccessRequest[]>([]);

  // Check URL query notices (OAuth setup hints / Stripe checkout status) + restore session
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notice = params.get("auth_notice");
    const authErr = params.get("auth_error");
    const checkout = params.get("checkout");

    if (notice === "google_not_configured") {
      setAuthNotice(
        "Google OAuth redirect is ready — add GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET via wrangler secret put for live Google login, or use Email Code / Password below."
      );
      setAuthModalOpen(true);
    } else if (notice === "apple_not_configured") {
      setAuthNotice(
        "Sign in with Apple OIDC is wired — add APPLE_CLIENT_ID via wrangler secret put for live web Apple login, or sign in via 6-digit Email Code below."
      );
      setAuthModalOpen(true);
    } else if (authErr) {
      setAuthNotice(`Authentication error: ${authErr.replaceAll("_", " ")}`);
      setAuthModalOpen(true);
    }

    if (checkout === "success") {
      setToast("Subscription activated! Welcome to fyde. zero-egress edge.");
    }

    const headers: Record<string, string> = {};
    const savedToken = localStorage.getItem("fyde_token");
    if (savedToken) headers["Authorization"] = `Bearer ${savedToken}`;

    Promise.all([
      fetch(resolveUrl("/api/auth/me"), { headers, credentials: "include" }).then((r) => (r.ok ? r.json() : null)),
      fetch(resolveUrl("/api/billing/plans")).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([meData, plansData]) => {
        if (plansData?.plans?.length) {
          setPlans(plansData.plans);
        }
        if (meData?.authenticated && meData.user) {
          setAuthUser(meData.user);
          setCurrentUserId(meData.user.id);
          if (params.get("view") === "app") {
            setShowLanding(false);
          }
        } else if (params.get("view") === "app") {
          setShowLanding(true);
          setAuthModalOpen(true);
        }
      })
      .catch(() => {});
  }, [resolveUrl]);

  const unreadCount = useMemo(() => {
    const reqs = incomingRequests.filter((r) => r.status === "pending").length;
    const unaccepted = receivedBundles.filter((b) => b.status === "delivered").length;
    return reqs + unaccepted;
  }, [incomingRequests, receivedBundles]);

  const suggestionChips = useMemo(() => {
    if (currentUserId === "maya") {
      return [
        "Get our passport scans from Mehmet's files",
        "Get all China trip photos from Mehmet",
        "Accept Mehmet's bundle into my Photos",
      ];
    }
    if (currentUserId === "alex") {
      return ["Get China trip photos from Mehmet", "Get 2025 tax return from Mehmet"];
    }
    return [
      "Send China trip photos to Maya",
      "iMessage Maya the Pacifica surfing video",
      "Send 2025 tax return to Sarah via email",
      "Allow Alex to access all my China trip photos with him",
      "Get the vet invoice from Maya's files",
    ];
  }, [currentUserId]);

  const runSearch = useCallback(
    async (
      uid: string,
      q: string,
      scope: "all" | "mine" | "contacts",
      mtype: MediaType | ""
    ) => {
      try {
        const res = await fetch(resolveUrl("/api/search"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: uid,
            query: q,
            scope,
            media_type: mtype || null,
            limit: 24,
          }),
        });
        if (res.ok) setSearchHits(await res.json());
      } catch {
        // ignore offline
      }
    },
    [resolveUrl]
  );

  const refreshAll = useCallback(
    async (uid: string = currentUserId) => {
      try {
        const [hRes, uRes, cRes, pRes, rRes] = await Promise.all([
          fetch(resolveUrl("/api/health")),
          fetch(resolveUrl("/api/users")),
          fetch(resolveUrl(`/api/chat/${uid}`)),
          fetch(resolveUrl(`/api/permissions/${uid}`)),
          fetch(resolveUrl(`/api/received/${uid}`)),
        ]);
        if (hRes.ok) {
          const h = await hRes.json();
          setConnected(true);
          setEmbedderLabel(h.embedder || "");
        }
        if (uRes.ok) {
          const loadedUsers: UserProfile[] = await uRes.json();
          setUsers(loadedUsers);
          const matching = loadedUsers.find((u) => u.id === uid);
          if (matching && authUser && matching.id === authUser.id) {
            setAuthUser(matching);
          }
        }
        if (cRes.ok) setChatMessages(await cRes.json());
        if (pRes.ok) setPermissions(await pRes.json());
        if (rRes.ok) {
          const inbox = await rRes.json();
          setReceivedBundles(inbox.bundles || []);
          setSentBundles(inbox.sent_bundles || []);
          setIncomingRequests(inbox.incoming_requests || []);
        }
        await runSearch(uid, searchQuery, searchScope, mediaFilter);
      } catch {
        setConnected(false);
      }
    },
    [authUser, currentUserId, mediaFilter, resolveUrl, runSearch, searchQuery, searchScope]
  );

  useEffect(() => {
    if (showLanding) return;
    void refreshAll(currentUserId);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = API_BASE
      ? `${API_BASE.replace(/^http/, "ws")}/ws/${currentUserId}?device_id=web_${currentUserId}&platform=web&device_name=Fyde+Web`
      : `${proto}//${window.location.host}/ws/${currentUserId}?device_id=web_${currentUserId}&platform=web&device_name=Fyde+Web`;

    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (
          msg.event === "bundle_received" ||
          msg.event === "access_request_created" ||
          msg.event === "access_request_resolved" ||
          msg.event === "permission_updated"
        ) {
          setToast(`Live Edge event: ${msg.event.replaceAll("_", " ")}`);
          void refreshAll(currentUserId);
        }
      } catch {
        // ignore
      }
    };
    return () => ws.close();
  }, [currentUserId, refreshAll, showLanding]);

  useEffect(() => {
    if (!showLanding) {
      void runSearch(currentUserId, searchQuery, searchScope, mediaFilter);
    }
  }, [currentUserId, mediaFilter, runSearch, searchQuery, searchScope, showLanding]);

  useEffect(() => {
    if (playingHit && videoRef.current && playingHit.matched_moment_sec != null) {
      videoRef.current.currentTime = playingHit.matched_moment_sec;
      void videoRef.current.play();
    }
  }, [playingHit]);

  function handleAuthenticated(user: UserProfile, token?: string) {
    setAuthUser(user);
    setCurrentUserId(user.id);
    if (token) {
      setAuthToken(token);
      localStorage.setItem("fyde_token", token);
    }
    setAuthModalOpen(false);
    setAuthNotice(null);
    setShowLanding(false);
    setActiveTab("chat");

    if (pendingPlan) {
      setPendingPlan(null);
      setBillingModalOpen(true);
    }
  }

  async function handleLogout() {
    await fetch(resolveUrl("/api/auth/logout"), { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.removeItem("fyde_token");
    setAuthToken(null);
    setAuthUser(null);
    setShowLanding(true);
  }

  async function handleQuickPeerSwitch(nextUserId: string) {
    setCurrentUserId(nextUserId);
    const res = await fetch(resolveUrl("/api/auth/demo"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ handle: nextUserId }),
    }).catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      if (data.user) setAuthUser(data.user);
      if (data.token) {
        setAuthToken(data.token);
        localStorage.setItem("fyde_token", data.token);
      }
    }
  }

  async function submitChat(textOverride?: string) {
    const text = (textOverride ?? draft).trim();
    if (!text) return;
    if (!textOverride) setDraft("");
    setSendingChat(true);
    try {
      const res = await fetch(resolveUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          text,
          platform: "web",
          auto_send: true,
        }),
      });
      if (res.ok) {
        await refreshAll(currentUserId);
      }
    } finally {
      setSendingChat(false);
    }
  }

  async function savePermissionRule(e: React.FormEvent) {
    e.preventDefault();
    const smartScopes =
      permTier === "smart_scope"
        ? [
            {
              id: `scope_${Date.now()}`,
              label: `Auto-access ${scopeTopic || "items"} (${scopeLocations}) with ${scopePeople || "anyone"}`,
              locations: scopeLocations
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              people: scopePeople
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              media_types: ["photo", "video"],
              semantic_query: scopeTopic || null,
            },
          ]
        : [];
    const res = await fetch(resolveUrl("/api/permissions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner_id: currentUserId,
        contact_name: permContact,
        relationship: permRelation,
        email: permEmail,
        phone: permPhone,
        tier: permTier,
        smart_scopes: smartScopes,
      }),
    });
    if (res.ok) {
      setToast(`Saved ${permTier} permission for ${permContact}`);
      setShowPermDrawer(false);
      await refreshAll(currentUserId);
    }
  }

  async function quickSend(assetId: string, title: string, recipientName: string, channel: SendChannel) {
    const res = await fetch(resolveUrl("/api/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_id: currentUserId,
        asset_ids: [assetId],
        recipient_name: recipientName,
        channel,
        title,
        sender_platform: "web",
      }),
    });
    if (res.ok) {
      setToast(`Sent "${title}" to ${recipientName} via ${channel}`);
      await refreshAll(currentUserId);
    }
  }

  async function acceptBundle(bundleId: string, destinationType: "photos" | "files") {
    const res = await fetch(resolveUrl(`/api/bundles/${bundleId}/accept`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUserId,
        destination_type: destinationType,
      }),
    });
    if (res.ok) {
      setToast(`Accepted bundle into ${destinationType === "photos" ? "Apple Photos" : "Files"}`);
      await refreshAll(currentUserId);
    }
  }

  async function resolveRequest(reqId: string, decision: "approve" | "deny") {
    const res = await fetch(resolveUrl(`/api/requests/${reqId}/resolve`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: currentUserId, decision }),
    });
    if (res.ok) {
      setToast(`Request ${decision === "approve" ? "approved & delivered" : "denied"}`);
      await refreshAll(currentUserId);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("owner_id", currentUserId);
    form.append("device_id", "web_browser");
    form.append("file", file);
    const res = await fetch(resolveUrl("/api/assets/upload"), { method: "POST", body: form });
    if (res.ok) {
      setToast(`Uploaded & indexed "${file.name}" into zero-egress R2`);
      await refreshAll(currentUserId);
    }
  }

  const activePlanTier: PlanTier = authUser?.plan_tier || "starter";

  if (showLanding) {
    return (
      <>
        <LandingView
          resolveUrl={resolveUrl}
          plans={plans}
          authenticatedUser={authUser}
          onOpenLogin={(planChoice) => {
            if (planChoice) setPendingPlan(planChoice);
            setAuthModalOpen(true);
          }}
          onEnterApp={() => setShowLanding(false)}
          onSelectPlanWhileAuthed={() => {
            setShowLanding(false);
            setBillingModalOpen(true);
          }}
        />
        <AuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          resolveUrl={resolveUrl}
          onAuthenticated={handleAuthenticated}
          notice={authNotice}
        />
      </>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src="/logo.png"
            alt="fyde."
            style={{ height: 26, cursor: "pointer" }}
            onClick={() => setShowLanding(true)}
            title="View fyde.izbirakin.com Landing Page"
          />
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          <span style={{ fontSize: "0.76rem", color: "var(--muted)", fontWeight: 500 }}>
            {connected ? `Cloudflare Edge Live • ${embedderLabel}` : "Connecting to Edge…"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className="pill terracotta"
            onClick={() => setBillingModalOpen(true)}
          >
            {activePlanTier === "family"
              ? "✦ Household Plan"
              : activePlanTier === "pro"
                ? "✦ fyde. Pro"
                : "Starter • Upgrade"}
          </button>

          <select
            className="select-pill"
            value={currentUserId}
            onChange={(e) => handleQuickPeerSwitch(e.target.value)}
            title="Switch account to test live P2P permissions"
          >
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name} (@{u.handle})
              </option>
            ))}
          </select>

          <button type="button" className="pill" onClick={() => setShowLanding(true)}>
            Landing
          </button>
          <button type="button" className="pill" onClick={handleLogout}>
            Log out
          </button>
        </div>
      </header>

      {toast && (
        <div className="toast-banner">
          <span>{toast}</span>
          <button
            style={{ background: "none", border: "none", color: "var(--cream)", cursor: "pointer" }}
            onClick={() => setToast(null)}
          >
            ✕
          </button>
        </div>
      )}

      <main className="main-stage">
        {/* LEFT TAB: MULTIMODAL SEARCH */}
        {activeTab === "search" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <input
                className="chat-input"
                placeholder="Search photos, exact video moments, or PDFs by memory…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <label className="btn btn-outline" style={{ display: "inline-flex", alignItems: "center" }}>
                + Upload to R2 & Index
                <input type="file" hidden onChange={handleFileUpload} />
              </label>
            </div>

            <div className="ribbon">
              {(["all", "mine", "contacts"] as const).map((sc) => (
                <button
                  key={sc}
                  className={`pill ${searchScope === sc ? "primary" : ""}`}
                  onClick={() => setSearchScope(sc)}
                >
                  {sc === "all" ? "All Accessible" : sc === "mine" ? "My Library" : "Contacts' Shared"}
                </button>
              ))}
              <span style={{ borderLeft: "1px solid var(--border)", height: 18, margin: "0 4px" }} />
              {(["", "photo", "video", "document"] as const).map((mt) => (
                <button
                  key={mt || "any"}
                  className={`pill ${mediaFilter === mt ? "primary" : ""}`}
                  onClick={() => setMediaFilter(mt)}
                >
                  {mt === "" ? "All Types" : mt === "photo" ? "Photos" : mt === "video" ? "Videos" : "Files & PDFs"}
                </button>
              ))}
            </div>

            {playingHit && (
              <div className="drawer-modal">
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <strong>
                    {playingHit.asset.title}{" "}
                    {playingHit.matched_moment_sec != null &&
                      `(Seeked to ${playingHit.matched_moment_sec.toFixed(1)}s — ${playingHit.matched_moment_label})`}
                  </strong>
                  <button className="pill" onClick={() => setPlayingHit(null)}>
                    Close Video
                  </button>
                </div>
                <video
                  ref={videoRef}
                  controls
                  src={resolveUrl(playingHit.asset.download_url)}
                  style={{ width: "100%", maxHeight: 340, borderRadius: 12, background: "#000" }}
                />
              </div>
            )}

            <div className="card-grid">
              {searchHits.map((hit) => (
                <div key={`${hit.asset.id}_${hit.matched_moment_sec}`} className="card">
                  {hit.asset.media_type === "photo" && hit.asset.thumbnail_url && (
                    <img
                      className="thumb-img"
                      src={resolveUrl(hit.asset.thumbnail_url)}
                      alt={hit.asset.title}
                    />
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong>{hit.asset.title}</strong>
                    <span className="pill" style={{ fontSize: "0.72rem" }}>
                      {hit.asset.owner_id === currentUserId ? "Mine" : hit.asset.owner_name}
                    </span>
                  </div>
                  {(hit.asset.location || hit.asset.people.length > 0) && (
                    <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                      {hit.asset.location && `📍 ${hit.asset.location} `}
                      {hit.asset.people.length > 0 && `• 👥 ${hit.asset.people.join(", ")}`}
                    </div>
                  )}
                  <div style={{ fontSize: "0.76rem", color: "var(--muted)" }}>{hit.match_reason}</div>

                  {hit.matched_moment_sec != null && (
                    <button className="btn btn-terracotta" onClick={() => setPlayingHit(hit)}>
                      ▶ Jump to {hit.matched_moment_sec.toFixed(1)}s — {hit.matched_moment_label}
                    </button>
                  )}

                  <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 6, flexWrap: "wrap" }}>
                    <button
                      className="pill"
                      onClick={() => quickSend(hit.asset.id, hit.asset.title, "Maya", "fyde_direct")}
                    >
                      Fyde → Maya
                    </button>
                    <button
                      className="pill"
                      onClick={() => quickSend(hit.asset.id, hit.asset.title, "Maya", "imessage")}
                    >
                      iMessage
                    </button>
                    <button
                      className="pill"
                      onClick={() => quickSend(hit.asset.id, hit.asset.title, "Sarah", "email")}
                    >
                      Email
                    </button>
                    <a
                      className="pill"
                      href={resolveUrl(hit.asset.download_url)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "none" }}
                    >
                      Open
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* MIDDLE TAB (DEFAULT LANDING): FYDE CHAT & INLINE PERMISSIONS */}
        {activeTab === "chat" && (
          <>
            <div className="ribbon">
              <button className="pill primary" onClick={() => setShowPermDrawer((v) => !v)}>
                ⚙ Contact Permissions ({permissions.length})
              </button>
              {permissions.map((p) => (
                <button key={p.id} className="pill" onClick={() => setShowPermDrawer(true)}>
                  {p.contact_name}: <strong>{p.tier.replace("_", " ")}</strong>
                </button>
              ))}
            </div>

            {showPermDrawer && (
              <form className="drawer-modal" onSubmit={savePermissionRule}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Flexible Contact Trust & Folderless Smart Scopes</strong>
                  <button type="button" className="pill" onClick={() => setShowPermDrawer(false)}>
                    Close
                  </button>
                </div>
                <div className="form-grid">
                  <input
                    className="field"
                    placeholder="Contact Name (e.g. Maya, Alex)"
                    value={permContact}
                    onChange={(e) => setPermContact(e.target.value)}
                    required
                  />
                  <input
                    className="field"
                    placeholder="Relationship (e.g. Wife, Friend)"
                    value={permRelation}
                    onChange={(e) => setPermRelation(e.target.value)}
                  />
                  <select
                    className="field"
                    value={permTier}
                    onChange={(e) => setPermTier(e.target.value as PermissionTier)}
                  >
                    <option value="trusted">Trusted (Full Access)</option>
                    <option value="smart_scope">Flexible Smart Scope (No Folder Needed)</option>
                    <option value="ask_first">Ask First (1-Tap Approval)</option>
                    <option value="send_only">Send Only</option>
                  </select>
                  <input
                    className="field"
                    placeholder="Email (optional)"
                    value={permEmail}
                    onChange={(e) => setPermEmail(e.target.value)}
                  />
                  <input
                    className="field"
                    placeholder="iMessage Phone / Apple ID"
                    value={permPhone}
                    onChange={(e) => setPermPhone(e.target.value)}
                  />
                </div>

                {permTier === "smart_scope" && (
                  <div className="form-grid" style={{ marginTop: 10 }}>
                    <input
                      className="field"
                      placeholder="Photo/Video Locations (e.g. China, Shanghai)"
                      value={scopeLocations}
                      onChange={(e) => setScopeLocations(e.target.value)}
                    />
                    <input
                      className="field"
                      placeholder="With People (e.g. Alex)"
                      value={scopePeople}
                      onChange={(e) => setScopePeople(e.target.value)}
                    />
                    <input
                      className="field"
                      placeholder="Semantic Topic (e.g. China trip)"
                      value={scopeTopic}
                      onChange={(e) => setScopeTopic(e.target.value)}
                    />
                  </div>
                )}

                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <button type="submit" className="btn btn-forest">
                    Save Permission Rule
                  </button>
                </div>
              </form>
            )}

            <div className="chat-feed">
              {chatMessages.length === 0 && (
                <div className="drawer-modal" style={{ margin: "auto", maxWidth: 580, textAlign: "center" }}>
                  <img src="/logo.png" alt="fyde." style={{ height: 34, margin: "0 auto 8px" }} />
                  <h3 style={{ margin: "4px 0 8px" }}>Ask fyde. to send, pull, or set permissions</h3>
                  <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.55 }}>
                    Send automatically over <strong>Direct Fyde</strong>, <strong>iMessage</strong>, or{" "}
                    <strong>Email</strong>, set flexible permissions (e.g. <em>“Maya is my wife — full access”</em> or{" "}
                    <em>“Allow Alex to access all my China trip photos with him”</em>), pull files from contacts who
                    trust you, or accept received folders into Photos.
                  </p>
                </div>
              )}

              {chatMessages.map((msg) => (
                <div key={msg.id} className={`msg-row ${msg.role === "user" ? "user" : "assistant"}`}>
                  <div className="msg-bubble">{msg.text}</div>

                  {msg.action_card && (
                    <div className="action-card">
                      <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "var(--terracotta)" }}>
                        {msg.action_card.action_type.replaceAll("_", " ").toUpperCase()}
                      </div>
                      {msg.action_card.bundle && (
                        <div style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 4 }}>
                          {msg.action_card.bundle.delivery_detail}
                        </div>
                      )}
                      {msg.action_card.previews?.length > 0 && (
                        <div className="preview-strip">
                          {msg.action_card.previews.map((item) => (
                            <div key={item.asset_id} className="preview-chip">
                              <span>
                                {item.media_type === "photo" ? "🖼️" : item.media_type === "video" ? "🎬" : "📄"}
                              </span>
                              <span>{item.title}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="ribbon">
              {suggestionChips.map((chip) => (
                <button key={chip} className="pill" onClick={() => submitChat(chip)}>
                  ✨ {chip}
                </button>
              ))}
            </div>

            <form
              className="composer-bar"
              onSubmit={(e) => {
                e.preventDefault();
                void submitChat();
              }}
            >
              <input
                className="chat-input"
                placeholder="Ask fyde. to send files, pull from a trusted contact, or update permissions…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sendingChat}
              />
              <button className="btn btn-forest" type="submit" disabled={sendingChat || !draft.trim()}>
                {sendingChat ? "Sending…" : "Send"}
              </button>
            </form>
          </>
        )}

        {/* RIGHT TAB: RECEIVED & APPROVALS */}
        {activeTab === "received" && (
          <>
            {incomingRequests.filter((r) => r.status === "pending").length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h3 style={{ margin: "0 0 10px", fontSize: "1rem" }}>Pending Access Approvals (Ask-First Tier)</h3>
                <div className="card-grid">
                  {incomingRequests
                    .filter((r) => r.status === "pending")
                    .map((req) => (
                      <div key={req.id} className="card" style={{ borderColor: "var(--terracotta)" }}>
                        <strong>{req.requester_name} requested files</strong>
                        <div style={{ fontSize: "0.86rem", color: "var(--muted)" }}>Query: “{req.query}”</div>
                        <div style={{ fontSize: "0.8rem" }}>
                          Matched {req.matched_previews.length} item(s):{" "}
                          {req.matched_previews.map((p) => p.title).join(", ") || "None"}
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button className="btn btn-forest" onClick={() => resolveRequest(req.id, "approve")}>
                            Approve & Send
                          </button>
                          <button className="btn btn-outline" onClick={() => resolveRequest(req.id, "deny")}>
                            Deny
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
              Received Direct over fyde. ({receivedBundles.length})
            </h3>
            {receivedBundles.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>
                No received bundles yet. Switch to Maya or send files from Fyde Chat!
              </p>
            ) : (
              <div className="card-grid" style={{ marginBottom: 24 }}>
                {receivedBundles.map((b) => (
                  <div key={b.id} className="card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong>{b.title}</strong>
                      <span className="pill terracotta" style={{ fontSize: "0.72rem" }}>
                        {b.origin.replaceAll("_", " ")}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                      From <strong>{b.sender_name}</strong> • {b.items.length} item(s)
                    </div>
                    <div className="preview-strip">
                      {b.items.map((it) => (
                        <a
                          key={it.asset_id}
                          className="preview-chip"
                          href={resolveUrl(it.download_url)}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: "none" }}
                        >
                          <span>{it.media_type === "photo" ? "🖼️" : it.media_type === "video" ? "🎬" : "📄"}</span>
                          <span>{it.title}</span>
                        </a>
                      ))}
                    </div>

                    {b.accepted_destination ? (
                      <div style={{ fontSize: "0.8rem", color: "var(--green-ok)", marginTop: 6, fontWeight: 600 }}>
                        ✓ Saved to {b.accepted_destination}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <button className="btn btn-forest" onClick={() => acceptBundle(b.id, "photos")}>
                          Save to Photos
                        </button>
                        <button className="btn btn-outline" onClick={() => acceptBundle(b.id, "files")}>
                          Save to Files
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {sentBundles.length > 0 && (
              <>
                <h3 style={{ margin: "0 0 12px", fontSize: "1rem" }}>
                  Background Sent & Auto-Pulled Audit ({sentBundles.length})
                </h3>
                <div className="card-grid">
                  {sentBundles.map((b) => (
                    <div key={b.id} className="card">
                      <strong>
                        To {b.recipient_name}: {b.title}
                      </strong>
                      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                        Channel: <strong>{b.channel}</strong> • {b.delivery_detail}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {/* THREE-TAB BOTTOM BAR: Search (Left) | Fyde Chat (Middle Landing) | Received (Right) */}
      <nav className="bottom-tabs">
        <button
          className={`tab-btn ${activeTab === "search" ? "active" : ""}`}
          onClick={() => setActiveTab("search")}
        >
          <span>🔍</span>
          <span>Search</span>
        </button>

        <button
          className={`tab-btn ${activeTab === "chat" ? "active" : ""}`}
          onClick={() => setActiveTab("chat")}
        >
          <span>💬</span>
          <span>fyde. Chat</span>
        </button>

        <button
          className={`tab-btn ${activeTab === "received" ? "active" : ""}`}
          onClick={() => setActiveTab("received")}
        >
          <span>📥</span>
          <span>Received</span>
          {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
        </button>
      </nav>

      <BillingModal
        open={billingModalOpen}
        onClose={() => setBillingModalOpen(false)}
        user={authUser}
        plans={plans}
        authToken={authToken}
        resolveUrl={resolveUrl}
        onPlanUpdated={(tier, message) => {
          if (authUser) setAuthUser({ ...authUser, plan_tier: tier });
          setToast(message);
          void refreshAll(currentUserId);
        }}
      />
    </div>
  );
}
