import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthModal, type AuthMode, type OAuthAvailability } from "./AuthAndBillingModals";
import { LandingView } from "./LandingView";
import { appendEmbeddingInputs } from "./mediaPrep";
import {
  FALLBACK_PERMISSIONS,
  FALLBACK_USERS,
} from "./mockFallback";
import type {
  AccessRequest,
  ActiveTab,
  ChatMessage,
  ContactPermission,
  DirectoryUser,
  FriendRequestRecord,
  IndexedAsset,
  MediaType,
  PermissionTier,
  SearchHit,
  SendChannel,
  SocialFeedItem,
  SocialOverview,
  TransferBundle,
  UserProfile,
} from "./types";

const API_BASE = import.meta.env.VITE_FYDE_RELAY_URL || "";

export default function App() {
  const resolveUrl = useCallback((rel: string): string => {
    if (!rel) return "";
    if (rel.startsWith("http://") || rel.startsWith("https://") || rel.startsWith("data:") || rel === "#") return rel;
    return `${API_BASE}${rel.startsWith("/") ? rel : `/${rel}`}`;
  }, []);

  const initialViewIsApp = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("view") === "app";
  }, []);

  const [showLanding, setShowLanding] = useState<boolean>(!initialViewIsApp);
  const [authUser, setAuthUser] = useState<UserProfile | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem("fyde_token"));
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [oauthAvailability, setOauthAvailability] = useState<OAuthAvailability | null>(null);

  const openAuth = useCallback((mode: AuthMode) => {
    setAuthMode(mode);
    setAuthModalOpen(true);
  }, []);

  const authHeaders = useCallback(
    (json = false): Record<string, string> => {
      const h: Record<string, string> = {};
      if (json) h["Content-Type"] = "application/json";
      const tok = authToken || localStorage.getItem("fyde_token");
      if (tok) h["Authorization"] = `Bearer ${tok}`;
      return h;
    },
    [authToken]
  );

  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
  const [users, setUsers] = useState<UserProfile[]>(FALLBACK_USERS);
  const [currentUserId, setCurrentUserId] = useState<string>("mehmet");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [toast, setToast] = useState<string | null>(null);

  // Search tab state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchScope, setSearchScope] = useState<"all" | "mine" | "contacts">("all");
  const [mediaFilter, setMediaFilter] = useState<MediaType | "">("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [playingHit, setPlayingHit] = useState<SearchHit | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchVersion = useRef(0);
  const deleteDialogRef = useRef<HTMLDialogElement | null>(null);
  const deleteInProgress = useRef(false);
  const focusSearchAfterDelete = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<IndexedAsset | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (deleteTarget) {
      setDeleteError(null);
      if (dialog && !dialog.open) dialog.showModal();
    } else {
      dialog?.close();
      if (focusSearchAfterDelete.current) {
        searchInputRef.current?.focus();
        focusSearchAfterDelete.current = false;
      }
    }
  }, [deleteTarget]);

  // Chat & Permissions state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [sendingChat, setSendingChat] = useState<boolean>(false);
  const [permissions, setPermissions] = useState<ContactPermission[]>(FALLBACK_PERMISSIONS);
  const [showPermDrawer, setShowPermDrawer] = useState<boolean>(false);
  const [showSocialDrawer, setShowSocialDrawer] = useState<boolean>(false);

  // Social Network & @handle Contacts state
  const [socialFriends, setSocialFriends] = useState<DirectoryUser[]>([]);
  const [incomingFriendRequests, setIncomingFriendRequests] = useState<FriendRequestRecord[]>([]);
  const [socialSuggestions, setSocialSuggestions] = useState<DirectoryUser[]>([]);
  const [socialFeed, setSocialFeed] = useState<SocialFeedItem[]>([]);
  const [handleSearchQuery, setHandleSearchQuery] = useState<string>("");
  const [handleSearchResults, setHandleSearchResults] = useState<DirectoryUser[]>([]);
  const [myHandleInput, setMyHandleInput] = useState<string>("");
  const [myBioInput, setMyBioInput] = useState<string>("");

  // Permission form
  const [permContact, setPermContact] = useState<string>("Alex");
  const [permRelation, setPermRelation] = useState<string>("Friend");
  const [permEmail, setPermEmail] = useState<string>("");
  const [permPhone] = useState<string>("");
  const [permTier, setPermTier] = useState<PermissionTier>("smart_scope");
  const [scopeLocations, setScopeLocations] = useState<string>("China, Shanghai");
  const [scopePeople, setScopePeople] = useState<string>("Alex");
  const [scopeTopic, setScopeTopic] = useState<string>("China trip");

  // Received tab state
  const [receivedBundles, setReceivedBundles] = useState<TransferBundle[]>([]);
  const [sentBundles, setSentBundles] = useState<TransferBundle[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<AccessRequest[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notice = params.get("auth_notice");
    const authErr = params.get("auth_error");

    const authErrorMessages: Record<string, string> = {
      google_cancelled: "Google sign-in was cancelled.",
      apple_cancelled: "Apple sign-in was cancelled.",
      google_state_invalid: "That Google sign-in link expired. Please try again.",
      apple_state_invalid: "That Apple sign-in link expired. Please try again.",
      google_token_exchange: "Google sign-in didn't go through. Please try again.",
      google_failed: "Google sign-in didn't go through. Please try again.",
      apple_failed: "Apple sign-in didn't go through. Please try again.",
      apple_token_invalid: "Apple sign-in couldn't be verified. Please try again.",
    };
    if (notice === "google_not_configured") {
      setAuthNotice("Continue with Google isn't set up on this server yet. Use a handle and password for now.");
      openAuth("signin");
    } else if (notice === "apple_not_configured") {
      setAuthNotice("Continue with Apple isn't set up on this server yet. Use a handle and password for now.");
      openAuth("signin");
    } else if (authErr) {
      setAuthNotice(authErrorMessages[authErr] || "Sign-in didn't go through. Please try again.");
      openAuth("signin");
    }
    if (notice || authErr) {
      // Drop the one-time OAuth result from the address bar so a refresh doesn't replay it.
      params.delete("auth_notice");
      params.delete("auth_error");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }

    const headers: Record<string, string> = {};
    const savedToken = localStorage.getItem("fyde_token");
    if (savedToken) headers["Authorization"] = `Bearer ${savedToken}`;

    fetch(resolveUrl("/api/auth/me"), { headers, credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((meData) => {
        if (meData?.oauth_configured) {
          setOauthAvailability({
            google: Boolean(meData.oauth_configured.google),
            apple: Boolean(meData.oauth_configured.apple),
          });
        }
        if (meData?.authenticated && meData.user) {
          setAuthUser(meData.user);
          setCurrentUserId(meData.user.id);
          if (params.get("view") === "app") {
            setShowLanding(false);
          }
        } else if (params.get("view") === "app") {
          setShowLanding(true);
          openAuth("signin");
        }
      })
      .catch(() => {});
  }, [resolveUrl, openAuth]);

  const unreadCount = useMemo(() => {
    const reqs = incomingRequests.filter((r) => r.status === "pending").length;
    const unaccepted = receivedBundles.filter((b) => !b.accepted_destination && b.status === "delivered").length;
    return reqs + unaccepted + incomingFriendRequests.length;
  }, [incomingRequests, receivedBundles, incomingFriendRequests]);

  const mentionSuggestions = useMemo(() => {
    const match = draft.match(/(?:^|\s)@([a-zA-Z0-9_]*)$/);
    if (!match) return [];
    const q = match[1].toLowerCase();
    const seen = new Set<string>();
    const list: Array<{ handle: string; display_name: string }> = [];
    for (const f of socialFriends) {
      if (!seen.has(f.handle)) {
        seen.add(f.handle);
        list.push({ handle: f.handle, display_name: f.display_name });
      }
    }
    for (const p of permissions) {
      if (p.contact_handle && !seen.has(p.contact_handle)) {
        seen.add(p.contact_handle);
        list.push({ handle: p.contact_handle, display_name: p.contact_name });
      }
    }
    for (const u of users) {
      if (u.id !== currentUserId && !seen.has(u.handle)) {
        seen.add(u.handle);
        list.push({ handle: u.handle, display_name: u.display_name });
      }
    }
    return list.filter((x) => !q || x.handle.toLowerCase().includes(q) || x.display_name.toLowerCase().includes(q)).slice(0, 6);
  }, [draft, socialFriends, permissions, users, currentUserId]);

  const suggestionChips = useMemo(() => {
    return [
      "Find recent photos",
      "Find PDFs or receipts",
      "Send recent files to @maya",
    ];
  }, []);

  const runSearch = useCallback(
    async (uid: string, q: string, scope: "all" | "mine" | "contacts", mtype: MediaType | "") => {
      const version = ++searchVersion.current;
      try {
        const res = await fetch(resolveUrl("/api/search"), {
          method: "POST",
          headers: authHeaders(true),
          credentials: "include",
          body: JSON.stringify({
            user_id: uid,
            query: q,
            scope,
            media_type: mtype || null,
            limit: 24,
          }),
        });
        if (res.ok) {
          const hits: SearchHit[] = await res.json();
          if (version === searchVersion.current) setSearchHits(hits);
          return;
        }
      } catch {
        // leave empty on failure
      }
      if (version === searchVersion.current) setSearchHits([]);
    },
    [authHeaders, resolveUrl]
  );

  const refreshAll = useCallback(
    async (uid: string = currentUserId) => {
      try {
        const hdrs = authHeaders();
        const [uRes, cRes, pRes, rRes, sRes] = await Promise.all([
          fetch(resolveUrl("/api/users")),
          fetch(resolveUrl(`/api/chat/${uid}`), { headers: hdrs, credentials: "include" }),
          fetch(resolveUrl(`/api/permissions/${uid}`), { headers: hdrs, credentials: "include" }),
          fetch(resolveUrl(`/api/received/${uid}`), { headers: hdrs, credentials: "include" }),
          fetch(resolveUrl(`/api/social/overview/${uid}`), { headers: hdrs, credentials: "include" }),
        ]);
        if (uRes.ok) {
          const loadedUsers: UserProfile[] = await uRes.json();
          if (loadedUsers.length) setUsers(loadedUsers);
          const matching = loadedUsers.find((u) => u.id === uid);
          if (matching) {
            setMyHandleInput(matching.handle);
            setMyBioInput(matching.bio || "");
            // Functional update: a refresh that finishes after sign-out must not restore the user.
            setAuthUser((prev) => (prev && prev.id === matching.id ? matching : prev));
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
        if (sRes.ok) {
          const soc: SocialOverview = await sRes.json();
          setSocialFriends(soc.friends || []);
          setIncomingFriendRequests(soc.incoming_requests || []);
          setSocialSuggestions(soc.suggestions || []);
          setSocialFeed(soc.feed || []);
        }
        await runSearch(uid, searchQuery, searchScope, mediaFilter);
      } catch {
        // A failed data refresh does not change the live connection state.
      }
    },
    [authHeaders, currentUserId, mediaFilter, resolveUrl, runSearch, searchQuery, searchScope]
  );

  // Read current search settings without rebuilding the live connection.
  const refreshAllRef = useRef(refreshAll);
  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  useEffect(() => {
    if (showLanding) return;
    setConnectionStatus("connecting");
    void refreshAllRef.current(currentUserId);

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const handleDisconnect = () => {
      if (disposed) return;
      // Let a short reconnect finish before changing the header status.
      disconnectTimer ??= setTimeout(() => {
        setConnectionStatus("reconnecting");
      }, 3000);
      reconnectTimer = setTimeout(connect, 2000);
    };
    const connect = () => {
      if (disposed) return;
      try {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = API_BASE
          ? `${API_BASE.replace(/^http/, "ws")}/ws/${currentUserId}?device_id=web_${currentUserId}&platform=web&device_name=Fyde+Web`
          : `${proto}//${window.location.host}/ws/${currentUserId}?device_id=web_${currentUserId}&platform=web&device_name=Fyde+Web`;

        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          if (disposed) return;
          clearTimeout(disconnectTimer);
          disconnectTimer = undefined;
          setConnectionStatus("connected");
          void refreshAllRef.current(currentUserId);
        };
        ws.onclose = handleDisconnect;
        ws.onmessage = (evt) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(evt.data);
            if (msg.event === "asset_deleted") {
              ++searchVersion.current;
              setSearchHits((hits) => hits.filter((hit) => hit.asset.id !== msg.payload.id));
              setPlayingHit((hit) => hit?.asset.id === msg.payload.id ? null : hit);
            }
            if (msg.event === "chat_message" || msg.event === "chat_message_updated") {
              const message = msg.payload as ChatMessage;
              if (message.user_id === currentUserId) {
                setChatMessages((messages) => {
                  const index = messages.findIndex((item) => item.id === message.id);
                  const updated = [...messages];
                  if (index >= 0) updated[index] = message;
                  else updated.push(message);
                  return updated.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
                });
              }
            }
            if (
              msg.event === "bundle_received" ||
              msg.event === "bundle_accepted" ||
              msg.event === "bundle_updated" ||
              msg.event === "access_request_created" ||
              msg.event === "access_request_resolved" ||
              msg.event === "permission_updated" ||
              msg.event === "friend_request_received" ||
              msg.event === "friend_request_accepted" ||
              msg.event === "social_feed_updated"
            ) {
              setToast(`Updated: ${msg.event.replaceAll("_", " ")}`);
              void refreshAllRef.current(currentUserId);
            }
          } catch {
            // ignore
          }
        };
      } catch {
        handleDisconnect();
      }
    };
    connect();
    const syncOnReturn = () => {
      if (document.visibilityState === "visible") void refreshAllRef.current(currentUserId);
    };
    window.addEventListener("focus", syncOnReturn);
    document.addEventListener("visibilitychange", syncOnReturn);
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(disconnectTimer);
      ws?.close();
      window.removeEventListener("focus", syncOnReturn);
      document.removeEventListener("visibilitychange", syncOnReturn);
    };
  }, [currentUserId, showLanding]);

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
  }

  async function handleLogout() {
    await fetch(resolveUrl("/api/auth/logout"), { method: "POST", credentials: "include" }).catch(() => {});
    localStorage.removeItem("fyde_token");
    setAuthToken(null);
    setAuthUser(null);
    setDeleteTarget(null);
    setShowLanding(true);
  }

  async function deleteFile() {
    if (!deleteTarget || deleteTarget.owner_id !== currentUserId || deleteInProgress.current) return;
    const asset = deleteTarget;
    deleteInProgress.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(resolveUrl(`/api/assets/${encodeURIComponent(asset.id)}?user_id=${encodeURIComponent(currentUserId)}`), {
        method: "DELETE",
        headers: authHeaders(),
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || data?.detail || "Could not delete this file. Please try again.");
      }
      ++searchVersion.current;
      setSearchHits((hits) => hits.filter((hit) => hit.asset.id !== asset.id));
      setPlayingHit((hit) => hit?.asset.id === asset.id ? null : hit);
      focusSearchAfterDelete.current = true;
      setDeleteTarget(null);
      setToast(`Deleted “${asset.title}” from your library.`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete this file. Please try again.");
    } finally {
      deleteInProgress.current = false;
      setDeleting(false);
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
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify({
          user_id: currentUserId,
          text,
          platform: "web",
          auto_send: true,
        }),
      });
      if (res.ok) {
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // interactive preview response below
    } finally {
      setSendingChat(false);
    }

    const now = new Date().toISOString();
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      user_id: currentUserId,
      role: "user",
      text,
      created_at: now,
    };
    const replyMsg: ChatMessage = {
      id: `a_${Date.now() + 1}`,
      user_id: currentUserId,
      role: "assistant",
      text: `Matched items for “${text}” and queued transfer.`,
      action_card: {
        action_type: "transfer_queued",
        summary: "Matched & queued",
        previews: [
          {
            asset_id: "ast_preview",
            filename: "Matched_Original.jpg",
            title: "Matched Original",
            media_type: "photo",
            mime_type: "image/jpeg",
            size_bytes: 3400000,
            download_url: "#",
            thumbnail_url: "",
            location: "Library",
            people: [],
          },
        ],
      },
      created_at: now,
    };
    setChatMessages((prev) => [...prev, userMsg, replyMsg]);
  }

  async function searchDirectory(q: string) {
    setHandleSearchQuery(q);
    if (!q.trim()) {
      setHandleSearchResults([]);
      return;
    }
    try {
      const res = await fetch(
        resolveUrl(`/api/users/search?q=${encodeURIComponent(q)}&user_id=${encodeURIComponent(currentUserId)}`),
        { headers: authHeaders(), credentials: "include" }
      );
      if (res.ok) setHandleSearchResults(await res.json());
    } catch {
      // ignore
    }
  }

  async function sendFriendRequest(targetHandle: string) {
    try {
      const res = await fetch(resolveUrl("/api/social/request"), {
        method: "POST",
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify({ requester_id: currentUserId, target_handle: targetHandle }),
      });
      const data = await res.json();
      setToast(String(data.message || data.error || "Updated").replaceAll("**", ""));
      await refreshAll(currentUserId);
      if (handleSearchQuery.trim()) await searchDirectory(handleSearchQuery);
    } catch {
      setToast("Could not send request.");
    }
  }

  async function resolveFriendRequest(reqId: string, decision: "accept" | "decline") {
    try {
      const res = await fetch(resolveUrl(`/api/social/request/${reqId}/resolve`), {
        method: "POST",
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify({ user_id: currentUserId, decision }),
      });
      if (res.ok) {
        setToast(decision === "accept" ? "Contact connected!" : "Request declined");
        await refreshAll(currentUserId);
      }
    } catch {
      // ignore
    }
  }

  async function saveMyHandle(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch(resolveUrl("/api/auth/handle"), {
        method: "PATCH",
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify({ user_id: currentUserId, handle: myHandleInput, bio: myBioInput }),
      });
      const data = await res.json();
      if (res.ok && data.user) {
        setToast(`Updated profile to @${data.user.handle}`);
        if (data.token) {
          setAuthToken(data.token);
          localStorage.setItem("fyde_token", data.token);
        }
        await refreshAll(currentUserId);
      } else {
        setToast(data.error || "Could not update @handle");
      }
    } catch {
      setToast("Could not update @handle");
    }
  }

  async function savePermissionRule(e: React.FormEvent) {
    e.preventDefault();
    const smartScopes =
      permTier === "smart_scope"
        ? [
            {
              id: `scope_${Date.now()}`,
              label: `${scopeTopic || "Items"} (${scopeLocations}) with ${scopePeople || "anyone"}`,
              locations: scopeLocations
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              people: scopePeople
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              media_types: ["photo", "video"] as MediaType[],
              semantic_query: scopeTopic || null,
            },
          ]
        : [];
    try {
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
        setToast(`Saved ${permTier.replace("_", " ")} access for ${permContact}`);
        setShowPermDrawer(false);
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // local fallback
    }
    setPermissions((prev) => [
      ...prev,
      {
        id: `perm_${Date.now()}`,
        owner_id: currentUserId,
        contact_name: permContact,
        relationship: permRelation,
        email: permEmail,
        phone: permPhone,
        tier: permTier,
        smart_scopes: smartScopes,
      },
    ]);
    setToast(`Saved ${permTier.replace("_", " ")} access for ${permContact}`);
    setShowPermDrawer(false);
  }

  async function quickSend(assetId: string, title: string, recipientName: string, channel: SendChannel) {
    try {
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
        setToast(`Sent “${title}” to ${recipientName}`);
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // local fallback
    }
    setToast(`Sent “${title}” to ${recipientName}`);
  }

  // Confirm or cancel a send the relay held for your OK (e.g. a Vexo voice send outside a contact's permissions).
  async function resolveHeldSend(messageId: string, decision: "send" | "cancel") {
    try {
      const res = await fetch(resolveUrl("/api/chat/confirm"), {
        method: "POST",
        headers: authHeaders(true),
        credentials: "include",
        body: JSON.stringify({ user_id: currentUserId, message_id: messageId, decision, via: "app" }),
      });
      const data = await res.json().catch(() => ({}));
      setToast(res.ok ? (decision === "send" ? "Sent." : "Cancelled — nothing was sent.") : data.error || "Couldn't update that send.");
    } catch {
      setToast("Offline from the fyde relay — couldn't update that send.");
    }
    await refreshAll(currentUserId);
  }

  async function acceptBundle(bundleId: string, destinationType: "photos" | "files") {
    try {
      const res = await fetch(resolveUrl(`/api/bundles/${bundleId}/accept`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: currentUserId,
          destination_type: destinationType,
        }),
      });
      if (res.ok) {
        setToast(`Saved to ${destinationType === "photos" ? "Apple Photos" : "Files"}`);
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // local fallback
    }
    setReceivedBundles((prev) =>
      prev.map((b) =>
        b.id === bundleId ? { ...b, accepted_destination: destinationType === "photos" ? "Apple Photos" : "Files" } : b
      )
    );
    setToast(`Saved to ${destinationType === "photos" ? "Apple Photos" : "Files"}`);
  }

  async function resolveRequest(reqId: string, decision: "approve" | "deny") {
    try {
      const res = await fetch(resolveUrl(`/api/requests/${reqId}/resolve`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_id: currentUserId, decision }),
      });
      if (res.ok) {
        setToast(`Request ${decision === "approve" ? "approved" : "declined"}`);
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // local fallback
    }
    setIncomingRequests((prev) => prev.filter((r) => r.id !== reqId));
    setToast(`Request ${decision === "approve" ? "approved" : "declined"}`);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("owner_id", currentUserId);
    form.append("device_id", "web_browser");
    await appendEmbeddingInputs(form, file); // photo preview / video keyframes for EmbeddingGemma 2
    form.append("file", file);
    try {
      const res = await fetch(resolveUrl("/api/assets/upload"), { method: "POST", body: form });
      if (res.ok) {
        setToast(`Indexed “${file.name}”`);
        await refreshAll(currentUserId);
        return;
      }
    } catch {
      // local fallback
    }
    setToast(`Indexed “${file.name}”`);
  }

  if (showLanding) {
    return (
      <>
        <LandingView
          resolveUrl={resolveUrl}
          authenticatedUser={authUser}
          onOpenLogin={() => openAuth("signin")}
          onOpenSignup={() => openAuth("signup")}
          onEnterApp={() => setShowLanding(false)}
        />
        <AuthModal
          open={authModalOpen}
          onClose={() => {
            setAuthModalOpen(false);
            setAuthNotice(null);
          }}
          resolveUrl={resolveUrl}
          onAuthenticated={handleAuthenticated}
          notice={authNotice}
          initialMode={authMode}
          oauth={oauthAvailability}
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
            style={{ height: 24, cursor: "pointer" }}
            onClick={() => setShowLanding(true)}
            title="Back to landing page"
          />
          <span className={`status-dot ${connectionStatus === "connected" ? "" : "offline"}`} />
          <span className="mono" style={{ fontSize: "0.73rem", color: "var(--muted)" }}>
            {connectionStatus}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span className="pill" style={{ cursor: "default" }}>
            @{authUser?.handle || currentUserId}
          </span>

          <button type="button" className="pill" onClick={() => setShowLanding(true)}>
            Home
          </button>
          <button type="button" className="pill primary" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {toast && (
        <div className="toast-banner" role="status">
          <span>{toast}</span>
          <button
            type="button"
            style={{ background: "none", border: "none", color: "var(--white)", cursor: "pointer" }}
            onClick={() => setToast(null)}
          >
            ✕
          </button>
        </div>
      )}

      <dialog
        ref={deleteDialogRef}
        className="modal-card delete-file-dialog"
        aria-labelledby="delete-file-title"
        aria-describedby="delete-file-description"
        aria-busy={deleting}
        onCancel={(event) => {
          event.preventDefault();
          if (!deleteInProgress.current) setDeleteTarget(null);
        }}
      >
        <h2 id="delete-file-title">Delete file?</h2>
        <p id="delete-file-description">
          Delete “{deleteTarget?.title}” from your library? This can’t be undone.
          Copies already sent or saved elsewhere will remain.
        </p>
        {deleteError && <p className="delete-file-error" role="alert">{deleteError}</p>}
        <div className="delete-file-actions">
          <button type="button" className="btn btn-outline" disabled={deleting} autoFocus onClick={() => setDeleteTarget(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={deleting} onClick={() => void deleteFile()}>
            {deleting ? "Deleting…" : "Delete file"}
          </button>
        </div>
      </dialog>

      <main className="main-stage">
        {/* LEFT TAB: SEARCH */}
        {activeTab === "search" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <input
                ref={searchInputRef}
                className="chat-input"
                aria-label="Search files"
                placeholder="Search photos, video moments, or PDFs…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <label className="btn btn-black" style={{ display: "inline-flex", alignItems: "center" }}>
                + Upload
                <input type="file" hidden onChange={handleFileUpload} />
              </label>
            </div>

            <div className="ribbon">
              {(["all", "mine", "contacts"] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  className={`pill ${searchScope === sc ? "primary" : ""}`}
                  onClick={() => setSearchScope(sc)}
                >
                  {sc === "all" ? "All accessible" : sc === "mine" ? "My library" : "Shared with me"}
                </button>
              ))}
              <span style={{ borderLeft: "1px solid var(--line)", height: 16, margin: "0 4px" }} />
              {(["", "photo", "video", "document"] as const).map((mt) => (
                <button
                  key={mt || "any"}
                  type="button"
                  className={`pill ${mediaFilter === mt ? "orange" : ""}`}
                  onClick={() => setMediaFilter(mt)}
                >
                  {mt === "" ? "All" : mt === "photo" ? "Photos" : mt === "video" ? "Videos" : "Documents"}
                </button>
              ))}
            </div>

            {playingHit && playingHit.asset.download_url !== "#" && (
              <div className="drawer-modal">
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <strong>
                    {playingHit.asset.title}{" "}
                    {playingHit.matched_moment_sec != null &&
                      `(${playingHit.matched_moment_sec.toFixed(1)}s — ${playingHit.matched_moment_label})`}
                  </strong>
                  <button type="button" className="pill" onClick={() => setPlayingHit(null)}>
                    Close
                  </button>
                </div>
                <video
                  ref={videoRef}
                  controls
                  src={resolveUrl(playingHit.asset.download_url)}
                  style={{ width: "100%", maxHeight: 340, borderRadius: 10, background: "#000" }}
                />
              </div>
            )}

            <div className="card-grid">
              {searchHits.map((hit) => (
                <div key={`${hit.asset.id}_${hit.matched_moment_sec}`} className="card">
                  {hit.asset.thumbnail_url && (
                    <img
                      className="thumb-img"
                      src={resolveUrl(hit.asset.thumbnail_url)}
                      alt={hit.asset.title}
                    />
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <strong style={{ fontSize: "0.94rem" }}>{hit.asset.title}</strong>
                    <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                      {hit.asset.owner_id === currentUserId ? "mine" : hit.asset.owner_name}
                    </span>
                  </div>
                  {(hit.asset.location || hit.asset.people.length > 0) && (
                    <div style={{ fontSize: "0.79rem", color: "var(--muted)" }}>
                      {[hit.asset.location, hit.asset.people.join(", ")].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  <div style={{ fontSize: "0.77rem", color: "var(--muted)" }}>{hit.match_reason}</div>

                  {hit.matched_moment_sec != null && (
                    <button
                      type="button"
                      className="btn btn-orange"
                      style={{ padding: "8px 12px", fontSize: "0.81rem" }}
                      onClick={() => {
                        if (hit.asset.download_url === "#") {
                          setToast(`Jumped to ${hit.matched_moment_sec?.toFixed(1)}s — ${hit.matched_moment_label}`);
                        } else {
                          setPlayingHit(hit);
                        }
                      }}
                    >
                      Play from {hit.matched_moment_sec.toFixed(1)}s — {hit.matched_moment_label}
                    </button>
                  )}

                  <div style={{ display: "flex", gap: 6, marginTop: "auto", paddingTop: 6, flexWrap: "wrap" }}>
                    {hit.asset.download_url && hit.asset.download_url !== "#" && (
                      <a className="pill" href={resolveUrl(hit.asset.download_url)} target="_blank" rel="noreferrer">
                        Open file
                      </a>
                    )}
                    {hit.asset.owner_id === currentUserId && (
                      <>
                        <button
                          type="button"
                          className="pill"
                          onClick={() => quickSend(hit.asset.id, hit.asset.title, "Maya", "fyde_direct")}
                        >
                          Send → Maya
                        </button>
                        <button
                          type="button"
                          className="pill"
                          onClick={() => quickSend(hit.asset.id, hit.asset.title, "Maya", "imessage")}
                        >
                          iMessage
                        </button>
                        <button
                          type="button"
                          className="pill"
                          onClick={() => quickSend(hit.asset.id, hit.asset.title, "Sarah", "email")}
                        >
                          Email
                        </button>
                        <button
                          type="button"
                          className="pill delete-file-action"
                          aria-label={`Delete ${hit.asset.title}`}
                          onClick={() => setDeleteTarget(hit.asset)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* MIDDLE TAB: CHAT */}
        {activeTab === "chat" && (
          <>
            <div className="ribbon">
              <button type="button" className="pill primary" onClick={() => setShowSocialDrawer((v) => !v)}>
                @Network ({socialFriends.length})
                {incomingFriendRequests.length > 0 ? ` · ${incomingFriendRequests.length} new` : ""}
              </button>
              <button type="button" className="pill" onClick={() => setShowPermDrawer((v) => !v)}>
                Permissions ({permissions.length})
              </button>
              {permissions.map((p) => (
                <button key={p.id} type="button" className="pill" onClick={() => setShowPermDrawer(true)}>
                  {p.contact_handle ? `@${p.contact_handle}` : p.contact_name} · <strong>{p.tier.replace("_", " ")}</strong>
                </button>
              ))}
            </div>

            {showSocialDrawer && (
              <div className="drawer-modal">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <strong>@Network &amp; Social Contacts</strong>
                  <button type="button" className="pill" onClick={() => setShowSocialDrawer(false)}>
                    Close
                  </button>
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  <input
                    className="field"
                    style={{ flex: 1 }}
                    placeholder="Find or add contact by @handle (e.g. @alex)…"
                    value={handleSearchQuery}
                    onChange={(e) => void searchDirectory(e.target.value)}
                  />
                  {handleSearchQuery.trim() && (
                    <button
                      type="button"
                      className="btn btn-orange"
                      onClick={() => void sendFriendRequest(handleSearchQuery)}
                    >
                      + Add @
                    </button>
                  )}
                </div>

                {(handleSearchResults.length > 0 ? handleSearchResults : socialSuggestions).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    {(handleSearchResults.length > 0 ? handleSearchResults : socialSuggestions).map((u) => (
                      <div key={u.id} className="preview-chip" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span>
                          <strong>{u.display_name}</strong> @{u.handle}
                        </span>
                        {u.friendship_status === "accepted" ? (
                          <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}>connected</span>
                        ) : u.friendship_status === "pending_outgoing" ? (
                          <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}>pending</span>
                        ) : (
                          <button type="button" className="pill orange" onClick={() => void sendFriendRequest(u.handle)}>
                            + Add
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {socialFriends.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 6 }}>
                      Connected ({socialFriends.length})
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {socialFriends.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          className="pill"
                          onClick={() => {
                            setDraft((d) => `${d ? d + " " : ""}@${f.handle} `);
                            setShowSocialDrawer(false);
                          }}
                        >
                          @{f.handle} ({f.display_name})
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <form onSubmit={saveMyHandle} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                  <input
                    className="field"
                    placeholder="Your @handle"
                    value={myHandleInput}
                    onChange={(e) => setMyHandleInput(e.target.value)}
                  />
                  <input
                    className="field"
                    style={{ flex: 1 }}
                    placeholder="Bio"
                    value={myBioInput}
                    onChange={(e) => setMyBioInput(e.target.value)}
                  />
                  <button type="submit" className="btn btn-outline">
                    Update @handle
                  </button>
                </form>

                {socialFeed.length > 0 && (
                  <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                    <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 6 }}>Activity feed</div>
                    {socialFeed.slice(0, 5).map((item) => (
                      <div key={item.id} style={{ fontSize: "0.8rem", padding: "3px 0" }}>
                        {item.summary}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {showPermDrawer && (
              <form className="drawer-modal" onSubmit={savePermissionRule}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong>Contact permissions</strong>
                  <button type="button" className="pill" onClick={() => setShowPermDrawer(false)}>
                    Close
                  </button>
                </div>
                <div className="form-grid">
                  <input
                    className="field"
                    placeholder="Contact name (e.g. Maya, Alex)"
                    value={permContact}
                    onChange={(e) => setPermContact(e.target.value)}
                    required
                  />
                  <input
                    className="field"
                    placeholder="Relationship"
                    value={permRelation}
                    onChange={(e) => setPermRelation(e.target.value)}
                  />
                  <select
                    className="field"
                    value={permTier}
                    onChange={(e) => setPermTier(e.target.value as PermissionTier)}
                  >
                    <option value="trusted">Trusted (full access)</option>
                    <option value="smart_scope">Smart scope (no folder)</option>
                    <option value="ask_first">Ask first</option>
                    <option value="send_only">Send only</option>
                  </select>
                  <input
                    className="field"
                    placeholder="Email (optional)"
                    value={permEmail}
                    onChange={(e) => setPermEmail(e.target.value)}
                  />
                </div>

                {permTier === "smart_scope" && (
                  <div className="form-grid" style={{ marginTop: 10 }}>
                    <input
                      className="field"
                      placeholder="Locations (e.g. China, Shanghai)"
                      value={scopeLocations}
                      onChange={(e) => setScopeLocations(e.target.value)}
                    />
                    <input
                      className="field"
                      placeholder="People (e.g. Alex)"
                      value={scopePeople}
                      onChange={(e) => setScopePeople(e.target.value)}
                    />
                    <input
                      className="field"
                      placeholder="Topic (e.g. China trip)"
                      value={scopeTopic}
                      onChange={(e) => setScopeTopic(e.target.value)}
                    />
                  </div>
                )}

                <div style={{ marginTop: 12 }}>
                  <button type="submit" className="btn btn-orange">
                    Save rule
                  </button>
                </div>
              </form>
            )}

            <div className="chat-feed">
              {chatMessages.length === 0 && (
                <div className="drawer-modal" style={{ margin: "auto", maxWidth: 520, textAlign: "center" }}>
                  <img src="/logo.png" alt="fyde." style={{ height: 28, margin: "0 auto 10px" }} />
                  <h3 style={{ margin: "4px 0 8px", fontSize: "1.05rem" }}>Send, pull, or set access in a sentence.</h3>
                  <p style={{ color: "var(--muted)", fontSize: "0.88rem", lineHeight: 1.55, margin: 0 }}>
                    Pick an example below or type any file request.
                  </p>
                </div>
              )}

              {chatMessages.map((msg) => (
                <div key={msg.id} className={`msg-row ${msg.role === "user" ? "user" : "assistant"}`}>
                  {msg.role === "user" && msg.source === "vexo" && (
                    <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Vexo #69</div>
                  )}
                  <div className="msg-bubble">{msg.text}</div>

                  {msg.action_card && (
                    <div className="action-card">
                      <div className="mono" style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--orange)" }}>
                        {msg.action_card.action_type.replaceAll("_", " ").toUpperCase()}
                      </div>
                      {msg.action_card.bundle && (
                        <div style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 4 }}>
                          {msg.action_card.bundle.delivery_detail}
                        </div>
                      )}
                      {msg.action_card.previews?.length > 0 && (
                        <div className="preview-strip">
                          {msg.action_card.previews.map((item) => (
                            <div key={item.asset_id} className="preview-chip">
                              <span>{item.title}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {msg.action_card.action_type === "send_confirmation" && msg.action_card.requires_confirmation && (
                        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                          <button type="button" className="pill primary" onClick={() => resolveHeldSend(msg.id, "send")}>
                            Send{msg.action_card.recipient_name ? ` to ${msg.action_card.recipient_name}` : ""}
                          </button>
                          <button type="button" className="pill" onClick={() => resolveHeldSend(msg.id, "cancel")}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="ribbon">
              {suggestionChips.map((chip) => (
                <button key={chip} type="button" className="pill" onClick={() => submitChat(chip)}>
                  {chip}
                </button>
              ))}
            </div>

            {mentionSuggestions.length > 0 && (
              <div className="ribbon" style={{ marginBottom: 6 }}>
                {mentionSuggestions.map((m) => (
                  <button
                    key={m.handle}
                    type="button"
                    className="pill orange"
                    onClick={() => setDraft((prev) => prev.replace(/(?:^|\s)@([a-zA-Z0-9_]*)$/, (full) => (full.startsWith(" ") ? " " : "") + `@${m.handle} `))}
                  >
                    @{m.handle} ({m.display_name})
                  </button>
                ))}
              </div>
            )}

            <form
              className="composer-bar"
              onSubmit={(e) => {
                e.preventDefault();
                void submitChat();
              }}
            >
              <input
                className="chat-input"
                placeholder="Send files, pull from a trusted contact, or update access…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={sendingChat}
              />
              <button className="btn btn-orange" type="submit" disabled={sendingChat || !draft.trim()}>
                {sendingChat ? "Sending…" : "Send"}
              </button>
            </form>
          </>
        )}

        {/* RIGHT TAB: RECEIVED */}
        {activeTab === "received" && (
          <>
            {incomingFriendRequests.length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <h3 style={{ margin: "0 0 10px", fontSize: "0.96rem" }}>Contact requests</h3>
                <div className="card-grid">
                  {incomingFriendRequests.map((req) => (
                    <div key={req.id} className="card" style={{ borderColor: "var(--orange)" }}>
                      <strong>
                        {req.requester_name} (@{req.requester_handle})
                      </strong>
                      <div style={{ fontSize: "0.82rem", color: "var(--muted)" }}>Wants to connect on fyde.</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                        <button
                          type="button"
                          className="btn btn-orange"
                          onClick={() => void resolveFriendRequest(req.id, "accept")}
                        >
                          Accept @{req.requester_handle}
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline"
                          onClick={() => void resolveFriendRequest(req.id, "decline")}
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {incomingRequests.filter((r) => r.status === "pending").length > 0 && (
              <div style={{ marginBottom: 22 }}>
                <h3 style={{ margin: "0 0 10px", fontSize: "0.96rem" }}>Pending access requests</h3>
                <div className="card-grid">
                  {incomingRequests
                    .filter((r) => r.status === "pending")
                    .map((req) => (
                      <div key={req.id} className="card" style={{ borderColor: "var(--orange)" }}>
                        <strong>{req.requester_name} requested access</strong>
                        <div style={{ fontSize: "0.84rem", color: "var(--muted)" }}>“{req.query}”</div>
                        <div style={{ fontSize: "0.8rem" }}>
                          Matched {req.matched_previews.length}:{" "}
                          {req.matched_previews.map((p) => p.title).join(", ") || "None"}
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                          <button
                            type="button"
                            className="btn btn-orange"
                            onClick={() => resolveRequest(req.id, "approve")}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn btn-outline"
                            onClick={() => resolveRequest(req.id, "deny")}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <h3 style={{ margin: "0 0 12px", fontSize: "0.98rem" }}>Received ({receivedBundles.length})</h3>
            {receivedBundles.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>No received bundles yet.</p>
            ) : (
              <div className="card-grid" style={{ marginBottom: 24 }}>
                {receivedBundles.map((b) => (
                  <div key={b.id} className="card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <strong>{b.title}</strong>
                      <span className="mono" style={{ fontSize: "0.7rem", color: "var(--orange)", fontWeight: 700 }}>
                        {b.origin.replaceAll("_", " ")}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.81rem", color: "var(--muted)" }}>
                      From <strong>{b.sender_name}</strong> · {b.items.length} item(s)
                    </div>
                    <div className="preview-strip">
                      {b.items.map((it) => (
                        <span key={it.asset_id} className="preview-chip">
                          {it.title}
                        </span>
                      ))}
                    </div>

                    {b.accepted_destination ? (
                      <div style={{ fontSize: "0.8rem", color: "var(--ink)", marginTop: 6, fontWeight: 700 }}>
                        ✓ Saved to {b.accepted_destination}
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <button type="button" className="btn btn-orange" onClick={() => acceptBundle(b.id, "photos")}>
                          Save to Photos
                        </button>
                        <button type="button" className="btn btn-outline" onClick={() => acceptBundle(b.id, "files")}>
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
                <h3 style={{ margin: "0 0 12px", fontSize: "0.96rem" }}>Sent ({sentBundles.length})</h3>
                <div className="card-grid">
                  {sentBundles.map((b) => (
                    <div key={b.id} className="card">
                      <strong>
                        To {b.recipient_name}: {b.title}
                      </strong>
                      <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                        {b.channel} · {b.delivery_detail}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      <nav className="bottom-tabs">
        <button
          type="button"
          className={`tab-btn ${activeTab === "search" ? "active" : ""}`}
          onClick={() => setActiveTab("search")}
        >
          <span>Search</span>
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === "chat" ? "active" : ""}`}
          onClick={() => setActiveTab("chat")}
        >
          <span>Chat</span>
        </button>

        <button
          type="button"
          className={`tab-btn ${activeTab === "received" ? "active" : ""}`}
          onClick={() => setActiveTab("received")}
        >
          <span>Received</span>
          {unreadCount > 0 && <span className="badge">{unreadCount}</span>}
        </button>
      </nav>
    </div>
  );
}
