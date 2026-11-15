import { getAuthenticatedUser, handleWaitlistAndAuthRoutes, normalizeHandle, resolveActorUserId, rowToUserProfile } from "./auth";
import { handleBillingRoutes } from "./billing";
import { randomId } from "./crypto";
import { summarizeImage } from "./imageSummary";
import { UserRelayHub } from "./durableHub";
import { embedQueryEdge, embedTextLocal, evaluateAssetPermission } from "./embedder";
import { computeAssetVectors, EG2_EMBEDDER, embedQueryEg2, isEg2Asset, rankAssets, readMediaParts } from "./mediaIndex";
import { ensureSeeded } from "./seed";
import {
  analyzeItemPhrase,
  assetWordSet,
  countWordMatches,
  describeHoldReason,
  parseSendCommand,
  pickConfidentMatches,
  resolveRecipient,
  stripWakeWord,
  type ItemSpec,
  type RecipientCandidate,
  type RecipientResolution,
  type SendCommand,
} from "./voiceCommands";
import type {
  AccessRequest,
  BundleItem,
  ChatActionCard,
  ChatMessage,
  ContactPermission,
  DirectoryUser,
  Env,
  FriendRequestRecord,
  FriendshipStatus,
  IndexedAsset,
  MediaType,
  PermissionTier,
  SearchHit,
  SendChannel,
  SmartScopeRule,
  SocialFeedItem,
  SocialOverview,
  TransferBundle,
  UserProfile,
} from "./types";

export { UserRelayHub };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response, req?: Request): Response {
  const headers = new Headers(res.headers);
  const origin = req?.headers.get("Origin");
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  } else if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers });
}

async function notifyUserHub(env: Env, userId: string, event: string, payload: unknown): Promise<void> {
  try {
    const id = env.USER_HUB.idFromName(userId);
    const stub = env.USER_HUB.get(id);
    await stub.fetch("https://hub.internal/notify", {
      method: "POST",
      body: JSON.stringify({ event, payload }),
    });
  } catch {
    // non-fatal
  }
}

async function hasOnlineMacBridge(env: Env, userId: string): Promise<boolean> {
  try {
    const id = env.USER_HUB.idFromName(userId);
    const stub = env.USER_HUB.get(id);
    const res = await stub.fetch("https://hub.internal/devices");
    if (!res.ok) return false;
    const data = (await res.json()) as { has_mac_bridge?: boolean };
    return Boolean(data.has_mac_bridge);
  } catch {
    return false;
  }
}

function assetToBundleItem(asset: IndexedAsset, matchedTs?: number | null): BundleItem {
  return {
    asset_id: asset.id,
    filename: asset.filename,
    title: asset.title,
    media_type: asset.media_type,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    download_url: asset.download_url || (asset.blob_id ? `/api/blobs/${asset.blob_id}` : ""),
    thumbnail_url: asset.thumbnail_url || (asset.media_type === "photo" && asset.blob_id ? `/api/blobs/${asset.blob_id}` : ""),
    location: asset.location,
    people: asset.people,
    matched_timestamp_sec: matchedTs ?? null,
  };
}

async function recordActivity(
  env: Env,
  actorId: string,
  targetUserId: string | null,
  kind: string,
  summary: string,
  bundleId: string | null = null
): Promise<void> {
  try {
    const id = randomId("act", 10);
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO activity_feed (id, actor_id, target_user_id, kind, summary, bundle_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, actorId, targetUserId, kind, summary, bundleId, createdAt)
      .run();
    await notifyUserHub(env, actorId, "social_feed_updated", { id, kind, summary });
    if (targetUserId && targetUserId !== actorId) {
      await notifyUserHub(env, targetUserId, "social_feed_updated", { id, kind, summary });
    }
  } catch {
    // non-fatal if table not yet migrated
  }
}

async function ensureContactPermission(
  env: Env,
  ownerId: string,
  contact: UserProfile,
  defaultTier: PermissionTier = "ask_first"
): Promise<ContactPermission> {
  const existing = await findPermissionForRequester(env, ownerId, contact.id);
  if (existing) return existing;

  const perm: ContactPermission = {
    id: randomId("perm", 10),
    owner_id: ownerId,
    contact_user_id: contact.id,
    contact_name: contact.display_name,
    contact_handle: contact.handle,
    email: contact.email,
    phone: contact.phone,
    relationship: "Contact",
    tier: defaultTier,
    excluded_tags: ["private", "hidden"],
    smart_scopes: [],
    updated_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO permissions (id, owner_id, contact_user_id, contact_name_lower, data) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(perm.id, perm.owner_id, perm.contact_user_id, perm.contact_name.toLowerCase(), JSON.stringify(perm))
    .run();
  await notifyUserHub(env, ownerId, "permission_updated", perm);
  return perm;
}

async function sendOrAcceptFriendRequest(
  env: Env,
  requesterId: string,
  targetQuery: string,
  requestedTier: PermissionTier = "ask_first"
): Promise<{
  status: "accepted" | "pending" | "already_connected" | "not_found" | "self";
  target?: UserProfile;
  request?: FriendRequestRecord;
  message: string;
}> {
  const requester = await findUser(env, requesterId);
  const target = await findUser(env, targetQuery);
  if (!target) {
    return { status: "not_found", message: `No fyde. member found matching "${targetQuery}".` };
  }
  if (target.id === requesterId) {
    return { status: "self", target, message: "That's your own @handle!" };
  }

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT * FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
     LIMIT 1`
  )
    .bind(requesterId, target.id, target.id, requesterId)
    .first<Record<string, unknown>>();

  if (existing && String(existing.status) === "accepted") {
    return {
      status: "already_connected",
      target,
      message: `You're already connected with ${target.display_name} (@${target.handle}).`,
    };
  }

  // If target already sent us a pending request, auto-accept!
  if (existing && String(existing.requester_id) === target.id && String(existing.status) === "pending") {
    const fid = String(existing.id);
    await env.DB.prepare("UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?")
      .bind(now, fid)
      .run();
    if (requester) {
      await ensureContactPermission(env, requester.id, target, requestedTier);
      await ensureContactPermission(env, target.id, requester, "ask_first");
      await recordActivity(env, requester.id, target.id, "connected", `@${requester.handle} and @${target.handle} connected on fyde.`);
    }
    const rec: FriendRequestRecord = {
      id: fid,
      requester_id: target.id,
      requester_handle: target.handle,
      requester_name: target.display_name,
      requester_avatar_color: target.avatar_color,
      addressee_id: requesterId,
      addressee_handle: requester?.handle || requesterId,
      addressee_name: requester?.display_name || requesterId,
      addressee_avatar_color: requester?.avatar_color || "#FF5500",
      status: "accepted",
      created_at: String(existing.created_at),
      updated_at: now,
    };
    await notifyUserHub(env, target.id, "friend_request_accepted", rec);
    await notifyUserHub(env, requesterId, "friend_request_accepted", rec);
    return {
      status: "accepted",
      target,
      request: rec,
      message: `Connected with **${target.display_name}** (@${target.handle})! You can now send or set access for @${target.handle}.`,
    };
  }

  if (existing && String(existing.requester_id) === requesterId && String(existing.status) === "pending") {
    const rec: FriendRequestRecord = {
      id: String(existing.id),
      requester_id: requesterId,
      requester_handle: requester?.handle || requesterId,
      requester_name: requester?.display_name || requesterId,
      requester_avatar_color: requester?.avatar_color || "#FF5500",
      addressee_id: target.id,
      addressee_handle: target.handle,
      addressee_name: target.display_name,
      addressee_avatar_color: target.avatar_color,
      status: "pending",
      created_at: String(existing.created_at),
      updated_at: now,
    };
    return {
      status: "pending",
      target,
      request: rec,
      message: `Contact request to **${target.display_name}** (@${target.handle}) is already pending.`,
    };
  }

  const fid = existing ? String(existing.id) : randomId("fr", 10);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  )
    .bind(fid, requesterId, target.id, now, now)
    .run();

  const rec: FriendRequestRecord = {
    id: fid,
    requester_id: requesterId,
    requester_handle: requester?.handle || requesterId,
    requester_name: requester?.display_name || requesterId,
    requester_avatar_color: requester?.avatar_color || "#FF5500",
    addressee_id: target.id,
    addressee_handle: target.handle,
    addressee_name: target.display_name,
    addressee_avatar_color: target.avatar_color,
    status: "pending",
    created_at: now,
    updated_at: now,
  };
  await notifyUserHub(env, target.id, "friend_request_received", rec);
  return {
    status: "pending",
    target,
    request: rec,
    message: `Sent a contact request to **${target.display_name}** (@${target.handle}).`,
  };
}

async function getFriendshipMapForUser(
  env: Env,
  userId: string
): Promise<Map<string, { id: string; status: FriendshipStatus; row: Record<string, unknown> }>> {
  const map = new Map<string, { id: string; status: FriendshipStatus; row: Record<string, unknown> }>();
  const { results } = await env.DB.prepare(
    "SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?"
  )
    .bind(userId, userId)
    .all();

  for (const r of results || []) {
    const reqId = String(r.requester_id);
    const addId = String(r.addressee_id);
    const rawStatus = String(r.status);
    if (rawStatus === "declined") continue;
    const otherId = reqId === userId ? addId : reqId;
    const status: FriendshipStatus =
      rawStatus === "accepted"
        ? "accepted"
        : reqId === userId
          ? "pending_outgoing"
          : "pending_incoming";
    map.set(otherId, { id: String(r.id), status, row: r });
  }
  return map;
}

async function findUser(env: Env, idOrHandleOrName: string): Promise<UserProfile | null> {
  const key = idOrHandleOrName.trim().toLowerCase().replace(/^@/, "");
  if (!key) return null;
  const row = await env.DB.prepare(
    "SELECT * FROM users WHERE LOWER(id) = ? OR LOWER(handle) = ? OR LOWER(display_name) = ? OR LOWER(email) = ?"
  )
    .bind(key, key, key, key)
    .first();
  return row ? rowToUserProfile(row) : null;
}

async function listPermissions(env: Env, ownerId: string): Promise<ContactPermission[]> {
  const { results } = await env.DB.prepare("SELECT data FROM permissions WHERE owner_id = ?").bind(ownerId).all();
  return (results || []).map((r) => JSON.parse(String(r.data)) as ContactPermission);
}

async function findPermissionForRequester(env: Env, ownerId: string, requesterKey: string): Promise<ContactPermission | null> {
  const reqUser = await findUser(env, requesterKey);
  const perms = await listPermissions(env, ownerId);
  const k = requesterKey.trim().toLowerCase().replace(/^@/, "");
  for (const p of perms) {
    if (reqUser && p.contact_user_id === reqUser.id) return p;
    if (p.contact_handle && p.contact_handle.toLowerCase().replace(/^@/, "") === k) return p;
    if (p.contact_name.toLowerCase() === k) return p;
    if (p.relationship && p.relationship.toLowerCase() === k) return p;
    if (reqUser && p.contact_name.toLowerCase() === reqUser.display_name.toLowerCase()) return p;
  }
  return null;
}

async function searchOwnerAssets(
  env: Env,
  ownerId: string,
  query: string,
  mediaType?: MediaType | null,
  limit = 20
): Promise<SearchHit[]> {
  const sql = mediaType
    ? "SELECT data FROM assets WHERE owner_id = ? AND media_type = ? ORDER BY created_at DESC"
    : "SELECT data FROM assets WHERE owner_id = ? ORDER BY created_at DESC";
  const stmt = mediaType ? env.DB.prepare(sql).bind(ownerId, mediaType) : env.DB.prepare(sql).bind(ownerId);
  const { results } = await stmt.all();
  const assets = (results || []).map((r) => JSON.parse(String(r.data)) as IndexedAsset);
  return rankForQuery(env, assets, query, limit);
}

/**
 * Files other people sent you (your Received tab) as searchable assets. They stay under the
 * sender's ownership so clients show "From <sender>"; folder_path points at the received bundle.
 */
async function loadReceivedAssets(
  env: Env,
  userId: string,
  mediaType?: MediaType | null
): Promise<Array<{ asset: IndexedAsset; receivedAt: string }>> {
  const { results } = await env.DB.prepare("SELECT data FROM bundles WHERE recipient_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all();
  // Newest bundle wins when the same file was received more than once.
  const latest = new Map<string, { bundle: TransferBundle; item: BundleItem }>();
  for (const r of results || []) {
    const bundle = JSON.parse(String(r.data)) as TransferBundle;
    if (bundle.sender_id === userId) continue;
    for (const item of bundle.items || []) {
      if (!item.asset_id || latest.has(item.asset_id)) continue;
      if (mediaType && item.media_type !== mediaType) continue;
      latest.set(item.asset_id, { bundle, item });
    }
  }
  if (latest.size === 0) return [];

  const ids = [...latest.keys()];
  const originals = new Map<string, IndexedAsset>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results: rows } = await env.DB.prepare(
      `SELECT data FROM assets WHERE id IN (${chunk.map(() => "?").join(", ")})`
    )
      .bind(...chunk)
      .all();
    for (const row of rows || []) {
      const a = JSON.parse(String(row.data)) as IndexedAsset;
      originals.set(a.id, a);
    }
  }

  return ids.map((id) => {
    const { bundle, item } = latest.get(id)!;
    const folder = bundle.accepted_destination || `Received/${bundle.title}`;
    const orig = originals.get(id);
    const asset: IndexedAsset = orig
      ? { ...orig, owner_name: bundle.sender_name || orig.owner_name, folder_path: folder }
      : {
          // The sender's original is gone: fall back to what the bundle itself carries.
          id,
          owner_id: bundle.sender_id,
          owner_name: bundle.sender_name,
          device_id: "",
          filename: item.filename,
          title: item.title,
          media_type: item.media_type,
          mime_type: item.mime_type,
          size_bytes: item.size_bytes,
          created_at: bundle.created_at,
          location: item.location,
          people: item.people || [],
          tags: [],
          folder_path: folder,
          ocr_text: "",
          summary: bundle.message || "",
          duration_sec: null,
          video_moments: [],
          embedding: [],
          embedder_name: "",
          blob_id: null,
          download_url: item.download_url,
          thumbnail_url: item.thumbnail_url,
        };
    return { asset, receivedAt: bundle.created_at };
  });
}

/** Your own files and/or the files people sent you, ranked as one pool. */
async function searchLibrary(
  env: Env,
  userId: string,
  query: string,
  mediaType: MediaType | null | undefined,
  limit: number,
  include: { own: boolean; received: boolean }
): Promise<SearchHit[]> {
  const [own, received] = await Promise.all([
    include.own ? loadOwnedAssets(env, userId) : Promise.resolve([] as IndexedAsset[]),
    include.received ? loadReceivedAssets(env, userId, mediaType) : Promise.resolve([]),
  ]);
  const ownPool = mediaType ? own.filter((a) => a.media_type === mediaType) : own;
  const ownIds = new Set(ownPool.map((a) => a.id));
  const receivedAt = new Map<string, string>();
  for (const r of received) {
    if (!ownIds.has(r.asset.id)) receivedAt.set(r.asset.id, r.receivedAt);
  }
  const pool = [...ownPool, ...received.filter((r) => receivedAt.has(r.asset.id)).map((r) => r.asset)];
  if (!query.trim()) {
    // No query lists recent items: a file counts as recent from when it reached you.
    const when = (a: IndexedAsset) => receivedAt.get(a.id) || a.created_at;
    pool.sort((a, b) => when(b).localeCompare(when(a)));
  }

  const hits = await rankForQuery(env, pool, query, limit);
  for (const h of hits) {
    if (!receivedAt.has(h.asset.id)) continue;
    const from = `Received from ${h.asset.owner_name}`;
    h.match_reason = h.match_reason === "Recent item" ? from : `${from} • ${h.match_reason}`;
  }
  return hits;
}

async function rankForQuery(env: Env, assets: IndexedAsset[], query: string, limit: number): Promise<SearchHit[]> {
  const qClean = query.trim();
  if (!qClean) {
    return assets.slice(0, limit).map((asset) => ({ asset, score: 1.0, match_reason: "Recent item" }));
  }

  // EmbeddingGemma 2 (768-D, photos/frames embedded from pixels) for re-indexed assets; the
  // legacy hashed query vector only for assets indexed before the switch (mediaIndex.ts).
  const needsEg2 = assets.some(isEg2Asset);
  const needsLegacy = assets.some((a) => !isEg2Asset(a));
  const [eg2, legacy] = await Promise.all([
    needsEg2 ? embedQueryEg2(env, qClean) : Promise.resolve(null),
    Promise.resolve(needsLegacy ? embedTextLocal(qClean) : null),
  ]);
  return rankAssets(assets, qClean, { eg2, legacy }, limit);
}

class SendBundleError extends Error {
  constructor(message: string, readonly status: 400 | 403) {
    super(message);
  }
}

async function executeSendBundle(
  env: Env,
  originUrl: string,
  params: {
    senderId: string;
    assetIds: string[];
    recipientName: string;
    recipientUserId?: string | null;
    recipientAddress?: string;
    channel: SendChannel;
    title?: string;
    message?: string;
  }
): Promise<TransferBundle> {
  if (
    !Array.isArray(params.assetIds) ||
    params.assetIds.length === 0 ||
    params.assetIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new SendBundleError("asset_ids must be a non-empty array of non-empty strings.", 400);
  }

  // Authorize the entire selection before creating a bundle or dispatching any delivery.
  const assets: IndexedAsset[] = [];
  for (const aid of params.assetIds) {
    const r = await env.DB.prepare("SELECT data FROM assets WHERE id = ? AND owner_id = ?")
      .bind(aid, params.senderId)
      .first<{ data: string }>();
    if (!r?.data) {
      throw new SendBundleError("One or more selected assets are unavailable or not owned by you.", 403);
    }
    assets.push(JSON.parse(r.data) as IndexedAsset);
  }

  const sender = await findUser(env, params.senderId);
  const senderName = sender?.display_name || params.senderId;
  const recipientUser = await findUser(env, params.recipientUserId || params.recipientName);
  const perm = await findPermissionForRequester(env, params.senderId, params.recipientUserId || params.recipientName);

  const items = assets.map((a) => assetToBundleItem(a));
  const bundleId = randomId("bundle", 10);
  const shareLink = `${env.PUBLIC_APP_URL || originUrl}/api/bundles/${bundleId}`;
  const title =
    (params.title || "").trim() ||
    (assets.length === 1 ? assets[0].title : `${assets[0].title} + ${assets.length - 1} more`);

  let status = "delivered";
  let detail = "";
  let recipientAddr = (params.recipientAddress || "").trim();

  if (params.channel === "fyde_direct") {
    status = "delivered";
    detail = `Delivered directly over Fyde Edge (R2 zero-egress) to ${recipientUser?.display_name || params.recipientName}'s Received tab`;
  } else if (params.channel === "email") {
    recipientAddr =
      recipientAddr ||
      perm?.email ||
      recipientUser?.email ||
      `${params.recipientName.toLowerCase().replace(/\s+/g, ".")}@example.com`;

    if (env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || "fyde. <hello@izbirakin.com>",
          to: [recipientAddr],
          subject: `fyde.: ${title}`,
          html: `<p><strong>${senderName}</strong> shared <strong>${items.length} item(s)</strong> with you on fyde.:</p><p><a href="${shareLink}">${title}</a></p>`,
        }),
      });
      status = "sent_background";
      detail = `Sent silently in background via Cloudflare Edge + Resend to ${recipientAddr}`;
    } else {
      status = "sent_background";
      detail = `Dispatched in background Email queue to ${recipientAddr} (add RESEND_API_KEY secret for live external email)`;
    }
  } else if (params.channel === "imessage") {
    recipientAddr = recipientAddr || perm?.phone || recipientUser?.phone || params.recipientName;
    const macOnline = await hasOnlineMacBridge(env, params.senderId);
    status = macOnline ? "sent_background" : "relayed_to_mac";
    detail = macOnline
      ? `Relayed live via Durable Object WebSocket to your online macOS Messages.app bridge (${recipientAddr})`
      : `Queued for your macOS Messages.app bridge (${recipientAddr}) with 1-tap iOS Messages fallback ready`;
    await notifyUserHub(env, params.senderId, "imessage_bridge_job", {
      bundle_id: bundleId,
      recipient_handle: recipientAddr,
      message: params.message || `${title} — ${shareLink}`,
      items,
    });
  }

  const bundle: TransferBundle = {
    id: bundleId,
    sender_id: params.senderId,
    sender_name: senderName,
    recipient_id: recipientUser?.id || params.recipientUserId || null,
    recipient_name: recipientUser?.display_name || params.recipientName,
    recipient_address: recipientAddr,
    channel: params.channel,
    title,
    message: params.message || "",
    items,
    origin: "pushed",
    status,
    delivery_detail: detail,
    share_link: shareLink,
    created_at: new Date().toISOString(),
  };

  await env.DB.prepare(
    "INSERT OR REPLACE INTO bundles (id, sender_id, recipient_id, created_at, data) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(bundle.id, bundle.sender_id, bundle.recipient_id, bundle.created_at, JSON.stringify(bundle))
    .run();

  await notifyUserHub(env, params.senderId, "bundle_sent", bundle);
  if (bundle.recipient_id) {
    await notifyUserHub(env, bundle.recipient_id, "bundle_received", bundle);
  }
  const senderHandle = sender?.handle || params.senderId;
  const recLabel = recipientUser ? `@${recipientUser.handle}` : params.recipientName;
  await recordActivity(
    env,
    params.senderId,
    bundle.recipient_id || null,
    "shared_bundle",
    `@${senderHandle} shared "${bundle.title}" with ${recLabel}`,
    bundle.id
  );
  return bundle;
}

async function executePeerPull(
  env: Env,
  originUrl: string,
  requesterId: string,
  ownerKey: string,
  query: string
): Promise<{ bundle: TransferBundle | null; accessRequest: AccessRequest | null; message: string }> {
  const owner = await findUser(env, ownerKey);
  const requester = await findUser(env, requesterId);
  if (!owner) {
    return { bundle: null, accessRequest: null, message: `Couldn't find a connected fyde. user matching "${ownerKey}".` };
  }
  const requesterName = requester?.display_name || requesterId;
  await notifyUserHub(env, owner.id, "peer_query_incoming", { requester_id: requesterId, requester_name: requesterName, query });

  const perm = await findPermissionForRequester(env, owner.id, requesterId);
  const rawHits = await searchOwnerAssets(env, owner.id, query, null, 12);

  const allowed: Array<{ hit: SearchHit; decision: string }> = [];
  const askOwner: SearchHit[] = [];

  for (const hit of rawHits) {
    const decision = evaluateAssetPermission(hit.asset, perm);
    if (decision === "allow_trusted" || decision === "allow_smart_scope") {
      allowed.push({ hit, decision });
    } else if (decision === "ask_owner") {
      askOwner.push(hit);
    }
  }

  if (allowed.length > 0) {
    const usedSmart = allowed.some((a) => a.decision === "allow_smart_scope");
    const items = allowed.map((a) => assetToBundleItem(a.hit.asset, a.hit.matched_moment_sec));
    const bundleId = randomId("bundle", 10);
    const bundle: TransferBundle = {
      id: bundleId,
      sender_id: owner.id,
      sender_name: owner.display_name,
      recipient_id: requester?.id || requesterId,
      recipient_name: requesterName,
      recipient_address: "",
      channel: "fyde_direct",
      title: items.length === 1 ? `${owner.display_name}: ${items[0].title}` : `From ${owner.display_name}: ${query} (${items.length} items)`,
      message: `Auto-retrieved via ${usedSmart ? "Smart Scope" : "Trusted Access"} for "${query}"`,
      items,
      origin: usedSmart ? "pulled_by_smart_scope" : "pulled_by_trusted",
      status: "delivered",
      delivery_detail: `Pulled ${items.length} permitted item(s) from ${owner.display_name}'s library into Received`,
      share_link: `${env.PUBLIC_APP_URL || originUrl}/api/bundles/${bundleId}`,
      created_at: new Date().toISOString(),
    };
    await env.DB.prepare(
      "INSERT OR REPLACE INTO bundles (id, sender_id, recipient_id, created_at, data) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(bundle.id, bundle.sender_id, bundle.recipient_id, bundle.created_at, JSON.stringify(bundle))
      .run();
    await notifyUserHub(env, bundle.recipient_id || requesterId, "bundle_received", bundle);
    await notifyUserHub(env, owner.id, "peer_pull_audit", bundle);
    return { bundle, accessRequest: null, message: bundle.delivery_detail };
  }

  const previews = askOwner.map((h) => assetToBundleItem(h.asset, h.matched_moment_sec));
  const reqObj: AccessRequest = {
    id: randomId("req", 10),
    requester_id: requester?.id || requesterId,
    requester_name: requesterName,
    owner_id: owner.id,
    owner_name: owner.display_name,
    query,
    matched_asset_ids: askOwner.map((h) => h.asset.id),
    matched_previews: previews,
    status: "pending",
    created_at: new Date().toISOString(),
  };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO access_requests (id, requester_id, owner_id, status, created_at, data) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(reqObj.id, reqObj.requester_id, reqObj.owner_id, reqObj.status, reqObj.created_at, JSON.stringify(reqObj))
    .run();
  await notifyUserHub(env, owner.id, "access_request_created", reqObj);

  return {
    bundle: null,
    accessRequest: { ...reqObj, matched_asset_ids: [], matched_previews: [] },
    message: `Sent an approval request to ${owner.display_name} for "${query}". Once approved, it will arrive in your Received tab.`,
  };
}

// ---------- Natural-language sends ("Vexo, send that to John" / "send my cat picture to John") ----------

const CHANNEL_LABEL: Record<SendChannel, string> = { fyde_direct: "fyde", imessage: "iMessage", email: "Email" };

// Assistant cards whose files "that" / "it" / "those" can refer back to.
const CONTEXT_CARD_TYPES = new Set([
  "search_results",
  "send_completed",
  "send_confirmation",
  "send_cancelled",
  "peer_pull_completed",
  "bundle_accepted",
]);

interface ChatSendOutcome {
  replyText: string;
  card: ChatActionCard | null;
}

async function loadRecipientCandidates(env: Env, userId: string): Promise<RecipientCandidate[]> {
  const perms = await listPermissions(env, userId);
  const friendships = await getFriendshipMapForUser(env, userId);
  const { results } = await env.DB.prepare("SELECT * FROM users").all();
  const users = (results || [])
    .map((r) => rowToUserProfile(r as Record<string, unknown>))
    .filter((u) => u.id !== userId);
  const byId = new Map(users.map((u) => [u.id, u]));

  const out: RecipientCandidate[] = [];
  for (const p of perms) {
    const u = p.contact_user_id ? byId.get(p.contact_user_id) : undefined;
    out.push({
      name: p.contact_name,
      handle: p.contact_handle || u?.handle || null,
      userId: p.contact_user_id || null,
      email: p.email || u?.email || "",
      phone: p.phone || u?.phone || "",
      relationship: p.relationship,
      perm: p,
      isContact: true,
    });
  }
  for (const [otherId, f] of friendships) {
    if (f.status !== "accepted" || out.some((c) => c.userId === otherId)) continue;
    const u = byId.get(otherId);
    if (u) {
      out.push({ name: u.display_name, handle: u.handle, userId: u.id, email: u.email, phone: u.phone, perm: null, isContact: true });
    }
  }
  for (const u of users) {
    if (out.some((c) => c.userId === u.id)) continue;
    out.push({ name: u.display_name, handle: u.handle, userId: u.id, email: u.email, phone: u.phone, perm: null, isContact: false });
  }
  return out;
}

function cardItems(card: ChatActionCard): BundleItem[] {
  if (card.bundle?.items?.length) return card.bundle.items;
  return card.previews || [];
}

async function findConversationContext(env: Env, userId: string): Promise<ChatActionCard | null> {
  const { results } = await env.DB.prepare(
    "SELECT data FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 40"
  )
    .bind(userId)
    .all();
  for (const r of results || []) {
    const msg = JSON.parse(String(r.data)) as ChatMessage;
    const card = msg.action_card;
    if (msg.role !== "assistant" || !card || !CONTEXT_CARD_TYPES.has(card.action_type)) continue;
    if (cardItems(card).length === 0 && (card.asset_ids || []).length === 0) continue;
    return card;
  }
  return null;
}

/** Resolves "that" / "it" / "those videos" against the most recent files in the conversation. */
function pickFromContext(card: ChatActionCard, spec: ItemSpec): string[] {
  const items = cardItems(card);
  let ids = items.length > 0 ? items.map((i) => i.asset_id) : [...(card.asset_ids || [])];
  if (spec.mediaTypes.length > 0 && items.length > 0) {
    ids = items.filter((i) => spec.mediaTypes.includes(i.media_type)).map((i) => i.asset_id);
  }
  if (card.action_type !== "search_results") {
    // A bundle that was just sent/received is one unit: "send that to Alex too" means all of it.
    return ids;
  }
  if (spec.count === "one") return ids.slice(0, 1);
  const focus = (card.focus_asset_ids || []).filter((id) => ids.includes(id));
  if (focus.length > 0) return focus;
  return spec.count === "many" ? ids : ids.slice(0, 1);
}

async function loadOwnedAssets(env: Env, ownerId: string): Promise<IndexedAsset[]> {
  const { results } = await env.DB.prepare("SELECT data FROM assets WHERE owner_id = ? ORDER BY created_at DESC")
    .bind(ownerId)
    .all();
  return (results || []).map((r) => JSON.parse(String(r.data)) as IndexedAsset);
}

/** Strong matches inside a search result list, so "send those to …" only takes the relevant ones. */
function focusIdsForSearch(queryText: string, hits: SearchHit[]): string[] {
  if (hits.length === 0) return [];
  const cleaned = queryText.replace(/^(?:find|search(?: for)?|show(?: me)?|look for|where(?:'s| is| are)|get)\s+/i, "");
  const spec = analyzeItemPhrase(cleaned);
  const ranked = hits.map((h) => ({
    asset: h.asset,
    matched: countWordMatches(spec.contentTokens, assetWordSet(h.asset)),
    vectorScore: h.score,
  }));
  const focus = pickConfidentMatches(ranked, spec.contentTokens, "many").map((a) => a.id);
  return focus.length > 0 ? focus : [hits[0].asset.id];
}

async function handleChatSendCommand(
  env: Env,
  originUrl: string,
  userId: string,
  cmd: SendCommand,
  opts: { voice: boolean }
): Promise<ChatSendOutcome> {
  const candidates = await loadRecipientCandidates(env, userId);

  // 1) Who
  let recipientPhrase = cmd.recipientPhrase;
  let itemPhrase = cmd.itemPhrase;
  let resolution: RecipientResolution = recipientPhrase ? resolveRecipient(recipientPhrase, candidates) : { kind: "none" };
  if (resolution.kind === "none" && cmd.alternative) {
    const alt = resolveRecipient(cmd.alternative.recipientPhrase, candidates);
    if (alt.kind !== "none") {
      resolution = alt;
      recipientPhrase = cmd.alternative.recipientPhrase;
      itemPhrase = cmd.alternative.itemPhrase;
    }
  }
  if (!recipientPhrase) {
    return { replyText: "Who should I send it to? Try “Vexo, send that to Maya.”", card: null };
  }
  if (resolution.kind === "ambiguous") {
    const names = resolution.options
      .slice(0, 3)
      .map((c) => `**${c.name}**${c.handle ? ` (@${c.handle})` : ""}`)
      .join(" or ");
    return { replyText: `Which “${recipientPhrase}” did you mean — ${names}? Say their full name or @handle.`, card: null };
  }
  if (resolution.kind === "none") {
    return {
      replyText: `I don't know who “${recipientPhrase}” is on fyde yet, so nothing was sent. Add them first (“add @handle”) or say their email address.`,
      card: null,
    };
  }
  let recipient: RecipientCandidate;
  if (resolution.kind === "email") {
    const email = resolution.email;
    recipient = candidates.find((c) => (c.email || "").toLowerCase() === email) ?? {
      name: email,
      email,
      perm: null,
      isContact: false,
    };
  } else {
    recipient = resolution.candidate;
  }

  // 2) What
  const spec = analyzeItemPhrase(itemPhrase);
  const owned = await loadOwnedAssets(env, userId);
  const ownedById = new Map(owned.map((a) => [a.id, a]));
  let assets: IndexedAsset[] = [];
  let contextNote = "";

  if (spec.mode === "reference") {
    const ctx = await findConversationContext(env, userId);
    if (!ctx) {
      return {
        replyText: `I'm not sure what “${itemPhrase || "that"}” refers to yet. Say what to send — e.g. “send my Kyoto photos to ${recipient.name}.”`,
        card: null,
      };
    }
    const ids = pickFromContext(ctx, spec);
    if (ids.length === 0) {
      return {
        replyText: `There's no ${spec.mediaTypes.join("/") || "file"} in what we were just looking at. Say what to send — e.g. “send my surfing video to ${recipient.name}.”`,
        card: null,
      };
    }
    assets = ids.map((id) => ownedById.get(id)).filter((a): a is IndexedAsset => !!a);
    if (assets.length === 0) {
      const from = ctx.bundle && ctx.bundle.sender_id !== userId ? ctx.bundle.sender_name : "someone else";
      return {
        replyText: `That came from ${from}'s library, so I can't forward it to ${recipient.name}. Ask ${from} to share it with them directly.`,
        card: null,
      };
    }
    if (ctx.action_type === "search_results") contextNote = " from your last search";
  } else if (spec.mode === "recent") {
    const pool = spec.mediaTypes.length > 0 ? owned.filter((a) => spec.mediaTypes.includes(a.media_type)) : owned;
    assets = pool.slice(0, spec.count === "many" ? 5 : 1);
    if (assets.length === 0) {
      return { replyText: `You don't have any ${spec.mediaTypes.join("/") || "files"} in your library yet.`, card: null };
    }
  } else {
    // Lexical signal = whole-word matches; semantic signal = the calibrated SearchHit.score from
    // searchOwnerAssets (never raw cosine — unrelated photos can reach ~0.6 raw with EmbeddingGemma).
    const hits = await searchOwnerAssets(env, userId, spec.query, null, 50);
    const searchScore = new Map(hits.map((h) => [h.asset.id, h.score]));
    const rank = (list: IndexedAsset[]) =>
      list.map((a) => ({
        asset: a,
        matched: countWordMatches(spec.contentTokens, assetWordSet(a)),
        vectorScore: searchScore.get(a.id) ?? 0,
      }));
    const typed = spec.mediaTypes.length > 0 ? owned.filter((a) => spec.mediaTypes.includes(a.media_type)) : owned;
    assets = pickConfidentMatches(rank(typed), spec.contentTokens, spec.count);
    if (assets.length === 0 && typed.length !== owned.length) {
      // "my surfing picture" when the surfing item is actually a video.
      assets = pickConfidentMatches(rank(owned), spec.contentTokens, spec.count);
    }
    if (assets.length === 0) {
      return {
        replyText: `I couldn't find “${itemPhrase.trim()}” in your library, so nothing was sent to ${recipient.name}.`,
        card: null,
      };
    }
  }

  // 3) How
  const channel: SendChannel =
    cmd.channel ?? (recipient.userId ? "fyde_direct" : recipient.email ? "email" : recipient.phone ? "imessage" : "fyde_direct");
  if (channel === "fyde_direct" && !recipient.userId) {
    return {
      replyText: `${recipient.name} isn't on fyde yet. Say “by email” or “by iMessage”, or add their email to their contact.`,
      card: null,
    };
  }
  const recipientAddress = channel === "email" ? recipient.email || "" : channel === "imessage" ? recipient.phone || "" : "";

  // 4) Permissions: a voice send goes out on its own only when the recipient's
  // permissions already cover every file; anything else waits for a confirmation tap.
  const perm =
    recipient.perm ?? (recipient.userId ? await findPermissionForRequester(env, userId, recipient.userId) : null);
  const decisions = assets.map((a) => ({ asset: a, decision: evaluateAssetPermission(a, perm) }));
  const privateTitles = decisions.filter((d) => d.decision === "deny").map((d) => d.asset.title);
  const notCovered = decisions.filter((d) => d.decision === "ask_owner").length;
  const needsConfirmation = opts.voice && (privateTitles.length > 0 || notCovered > 0);

  const assetIds = assets.map((a) => a.id);
  const label = assets.length === 1 ? `**${assets[0].title}**` : `**${assets.length} items**`;

  if (needsConfirmation) {
    const reason = describeHoldReason(recipient.name, perm, privateTitles, notCovered, assets.length);
    const bandConfirmable = privateTitles.length === 0;
    const how = bandConfirmable ? "Tap Vexo once or press **Send** to confirm." : "Confirm in fyde to send it anyway.";
    const replyText = `Ready to send ${label}${contextNote} to **${recipient.name}**, but ${reason}. ${how}`;
    return {
      replyText,
      card: {
        action_type: "send_confirmation",
        summary: replyText,
        channel,
        recipient_name: recipient.name,
        recipient_id: recipient.userId || null,
        recipient_address: recipientAddress || null,
        asset_ids: assetIds,
        previews: assets.map((a) => assetToBundleItem(a)),
        requires_confirmation: true,
        hold_reason: reason,
        band_confirmable: bandConfirmable,
        source: opts.voice ? "vexo" : null,
      },
    };
  }

  const bundle = await executeSendBundle(env, originUrl, {
    senderId: userId,
    assetIds,
    recipientName: recipient.name,
    recipientUserId: recipient.userId || null,
    recipientAddress,
    channel,
    message: opts.voice ? "Shared via fyde (Vexo voice)" : "Shared via fyde. Chat",
  });
  let why = "";
  if (opts.voice) {
    if (perm?.tier === "trusted") why = ` — ${recipient.name} is Trusted`;
    else if (decisions.every((d) => d.decision === "allow_smart_scope")) why = ` — within ${recipient.name}'s Smart Scope`;
  }
  const replyText = `Sent ${label}${contextNote} to **${bundle.recipient_name}** via **${CHANNEL_LABEL[channel]}**${why}.\n\n_${bundle.delivery_detail}_`;
  return {
    replyText,
    card: {
      action_type: "send_completed",
      summary: replyText,
      channel,
      recipient_name: bundle.recipient_name,
      recipient_id: bundle.recipient_id || null,
      asset_ids: assetIds,
      previews: bundle.items,
      bundle,
      requires_confirmation: false,
      source: opts.voice ? "vexo" : null,
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    await ensureSeeded(env);

    // 1. Real-Time Durable Object WebSocket Route (`/ws/:userId`)
    if (path.startsWith("/ws/")) {
      const userId = decodeURIComponent(path.slice(4));
      const id = env.USER_HUB.idFromName(userId);
      const stub = env.USER_HUB.get(id);
      return stub.fetch(request);
    }

    // 2. Waitlist & Authentication Routes
    const authRes = await handleWaitlistAndAuthRoutes(request, env, url);
    if (authRes) return withCors(authRes);

    // 3. Stripe & Subscription Billing Routes
    const billingRes = await handleBillingRoutes(request, env, url);
    if (billingRes) return withCors(billingRes);

    // 4. Core Fyde P2P & Multimodal API Routes
    if (path === "/api/health" && request.method === "GET") {
      return withCors(
        Response.json({
          status: "ok",
          architecture: "cloudflare-workers-do-d1-r2",
          domain: "fyde.izbirakin.com",
          embedder: env.AI ? EG2_EMBEDDER : "fyde-edge-mrl256",
        })
      );
    }

    if (path === "/api/users" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
      return withCors(Response.json((results || []).map(rowToUserProfile)), request);
    }

    // Search directory by @handle, display name, or email
    if (path === "/api/users/search" && request.method === "GET") {
      const authUser = await getAuthenticatedUser(request, env);
      const viewerId = authUser?.id || url.searchParams.get("user_id") || "";
      const rawQuery = (url.searchParams.get("q") || "").trim().toLowerCase().replace(/^@+/, "");
      const { results } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at ASC LIMIT 200").all();
      const fMap = viewerId ? await getFriendshipMapForUser(env, viewerId) : new Map();

      const matches: DirectoryUser[] = [];
      for (const row of results || []) {
        const u = rowToUserProfile(row);
        if (viewerId && u.id === viewerId) continue;
        if (rawQuery) {
          const hay = `${u.handle} ${u.display_name} ${u.email}`.toLowerCase();
          if (!hay.includes(rawQuery)) continue;
        }
        const rel = fMap.get(u.id);
        matches.push({
          id: u.id,
          handle: u.handle,
          display_name: u.display_name,
          avatar_color: u.avatar_color,
          bio: u.bio || "",
          friendship_status: rel?.status || "none",
          friendship_id: rel?.id || null,
        });
      }
      // Prioritize exact / prefix handle match
      if (rawQuery) {
        matches.sort((a, b) => {
          const aExact = a.handle.toLowerCase() === rawQuery ? 2 : a.handle.toLowerCase().startsWith(rawQuery) ? 1 : 0;
          const bExact = b.handle.toLowerCase() === rawQuery ? 2 : b.handle.toLowerCase().startsWith(rawQuery) ? 1 : 0;
          return bExact - aExact;
        });
      }
      return withCors(Response.json(matches.slice(0, 30)), request);
    }

    // Social Graph Overview (friends, requests, suggestions, activity feed)
    if (path.startsWith("/api/social/overview") && request.method === "GET") {
      const pathUser = path.startsWith("/api/social/overview/")
        ? decodeURIComponent(path.slice("/api/social/overview/".length))
        : url.searchParams.get("user_id");
      const actor = await resolveActorUserId(request, env, pathUser);
      if ("error" in actor) return withCors(actor.error, request);
      const userId = actor.userId;

      const { results: userRows } = await env.DB.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
      const usersById = new Map<string, UserProfile>();
      for (const r of userRows || []) {
        const u = rowToUserProfile(r);
        usersById.set(u.id, u);
      }

      const fMap = await getFriendshipMapForUser(env, userId);
      const friends: DirectoryUser[] = [];
      const incoming_requests: FriendRequestRecord[] = [];
      const outgoing_requests: FriendRequestRecord[] = [];
      const suggestions: DirectoryUser[] = [];

      for (const [, u] of usersById) {
        if (u.id === userId) continue;
        const rel = fMap.get(u.id);
        const dirItem: DirectoryUser = {
          id: u.id,
          handle: u.handle,
          display_name: u.display_name,
          avatar_color: u.avatar_color,
          bio: u.bio || "",
          friendship_status: rel?.status || "none",
          friendship_id: rel?.id || null,
        };
        if (rel?.status === "accepted") {
          friends.push(dirItem);
        } else if (rel?.status === "pending_incoming" && rel.row) {
          incoming_requests.push({
            id: String(rel.row.id),
            requester_id: u.id,
            requester_handle: u.handle,
            requester_name: u.display_name,
            requester_avatar_color: u.avatar_color,
            addressee_id: userId,
            addressee_handle: usersById.get(userId)?.handle || userId,
            addressee_name: usersById.get(userId)?.display_name || userId,
            addressee_avatar_color: usersById.get(userId)?.avatar_color || "#FF5500",
            status: "pending",
            created_at: String(rel.row.created_at),
            updated_at: String(rel.row.updated_at),
          });
        } else if (rel?.status === "pending_outgoing" && rel.row) {
          outgoing_requests.push({
            id: String(rel.row.id),
            requester_id: userId,
            requester_handle: usersById.get(userId)?.handle || userId,
            requester_name: usersById.get(userId)?.display_name || userId,
            requester_avatar_color: usersById.get(userId)?.avatar_color || "#FF5500",
            addressee_id: u.id,
            addressee_handle: u.handle,
            addressee_name: u.display_name,
            addressee_avatar_color: u.avatar_color,
            status: "pending",
            created_at: String(rel.row.created_at),
            updated_at: String(rel.row.updated_at),
          });
        } else {
          suggestions.push(dirItem);
        }
      }

      const networkIds = new Set<string>([userId, ...friends.map((f) => f.id)]);
      const { results: rawFeed } = await env.DB.prepare(
        "SELECT * FROM activity_feed ORDER BY created_at DESC LIMIT 60"
      ).all();
      const feed: SocialFeedItem[] = [];
      for (const row of rawFeed || []) {
        const actorId = String(row.actor_id);
        const targetId = row.target_user_id ? String(row.target_user_id) : null;
        if (!networkIds.has(actorId) && (!targetId || targetId !== userId)) continue;
        const actorUser = usersById.get(actorId);
        const targetUser = targetId ? usersById.get(targetId) : undefined;
        feed.push({
          id: String(row.id),
          actor_id: actorId,
          actor_handle: actorUser?.handle || actorId,
          actor_name: actorUser?.display_name || actorId,
          actor_avatar_color: actorUser?.avatar_color || "#FF5500",
          target_user_id: targetId,
          target_handle: targetUser?.handle || null,
          target_name: targetUser?.display_name || null,
          kind: String(row.kind),
          summary: String(row.summary),
          bundle_id: row.bundle_id ? String(row.bundle_id) : null,
          created_at: String(row.created_at),
        });
      }

      const overview: SocialOverview = {
        friends,
        incoming_requests,
        outgoing_requests,
        suggestions: suggestions.slice(0, 12),
        feed: feed.slice(0, 25),
      };
      return withCors(Response.json(overview), request);
    }

    if (path === "/api/social/request" && request.method === "POST") {
      const body = (await request.json()) as {
        requester_id?: string;
        target_handle?: string;
        target_user_id?: string;
        tier?: PermissionTier;
      };
      const actor = await resolveActorUserId(request, env, body.requester_id);
      if ("error" in actor) return withCors(actor.error, request);

      const query = (body.target_user_id || body.target_handle || "").trim();
      if (!query) return withCors(Response.json({ error: "Provide a @handle to add." }, { status: 400 }), request);

      const res = await sendOrAcceptFriendRequest(env, actor.userId, query, body.tier || "ask_first");
      if (res.status === "not_found") {
        return withCors(Response.json({ error: res.message }, { status: 404 }), request);
      }
      if (res.status === "self") {
        return withCors(Response.json({ error: res.message }, { status: 400 }), request);
      }
      return withCors(Response.json(res), request);
    }

    const socialResolveMatch = path.match(/^\/api\/social\/request\/([^/]+)\/resolve$/);
    if (socialResolveMatch && request.method === "POST") {
      const reqId = socialResolveMatch[1];
      const body = (await request.json()) as {
        user_id?: string;
        decision: "accept" | "decline";
        tier?: PermissionTier;
      };
      const actor = await resolveActorUserId(request, env, body.user_id);
      if ("error" in actor) return withCors(actor.error, request);

      const row = await env.DB.prepare("SELECT * FROM friendships WHERE id = ?").bind(reqId).first<Record<string, unknown>>();
      if (!row) return withCors(Response.json({ error: "Friend request not found." }, { status: 404 }), request);
      if (String(row.addressee_id) !== actor.userId) {
        return withCors(Response.json({ error: "Only the recipient can respond to this request." }, { status: 403 }), request);
      }

      const now = new Date().toISOString();
      const nextStatus = body.decision === "accept" ? "accepted" : "declined";
      await env.DB.prepare("UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?")
        .bind(nextStatus, now, reqId)
        .run();

      const requester = await findUser(env, String(row.requester_id));
      const addressee = await findUser(env, actor.userId);
      if (body.decision === "accept" && requester && addressee) {
        await ensureContactPermission(env, addressee.id, requester, body.tier || "ask_first");
        await ensureContactPermission(env, requester.id, addressee, "ask_first");
        await recordActivity(
          env,
          addressee.id,
          requester.id,
          "connected",
          `@${addressee.handle} and @${requester.handle} are now connected`
        );
        await notifyUserHub(env, requester.id, "friend_request_accepted", {
          id: reqId,
          addressee_id: addressee.id,
          addressee_handle: addressee.handle,
          addressee_name: addressee.display_name,
        });
      }
      return withCors(Response.json({ ok: true, id: reqId, status: nextStatus }), request);
    }

    if (path.startsWith("/api/social/friends/") && request.method === "DELETE") {
      const targetId = decodeURIComponent(path.slice("/api/social/friends/".length));
      const actor = await resolveActorUserId(request, env, url.searchParams.get("user_id"));
      if ("error" in actor) return withCors(actor.error, request);

      await env.DB.prepare(
        "DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)"
      )
        .bind(actor.userId, targetId, targetId, actor.userId)
        .run();
      return withCors(Response.json({ ok: true }), request);
    }

    if (path.startsWith("/api/assets/") && path !== "/api/assets/upload" && request.method === "GET") {
      const ownerId = decodeURIComponent(path.slice("/api/assets/".length));
      const { results } = await env.DB.prepare("SELECT data FROM assets WHERE owner_id = ? ORDER BY created_at DESC")
        .bind(ownerId)
        .all();
      return withCors(Response.json((results || []).map((r) => JSON.parse(String(r.data)))));
    }

    // Re-embed an existing asset with EmbeddingGemma 2. Optional multipart `preview` / `frame` /
    // `frame_times` / `frame_labels` / `duration_sec` (see mediaIndex.readMediaParts); otherwise the
    // original is read back from R2.
    const reindexMatch = path.match(/^\/api\/assets\/([^/]+)\/reindex$/);
    if (reindexMatch && request.method === "POST") {
      const isMultipart = (request.headers.get("Content-Type") || "").includes("multipart/form-data");
      const form = isMultipart ? await request.formData() : null;
      const user = await getAuthenticatedUser(request, env);
      if (!user) return withCors(Response.json({ error: "Sign in to reindex files." }, { status: 401 }), request);
      const assetId = decodeURIComponent(reindexMatch[1]);
      const row = await env.DB.prepare("SELECT data FROM assets WHERE id = ?").bind(assetId).first<{ data: string }>();
      if (!row?.data) return withCors(Response.json({ error: "Asset not found" }, { status: 404 }), request);
      const asset = JSON.parse(row.data) as IndexedAsset;
      if (asset.owner_id !== user.id) {
        return withCors(Response.json({ error: "Only the owner can re-index this asset." }, { status: 403 }), request);
      }
      const loadOriginal = async () => {
        if (!asset.blob_id) return null;
        const obj = await env.BLOBS.get(asset.blob_id);
        return obj ? { bytes: await obj.arrayBuffer(), mime: asset.mime_type } : null;
      };
      const original = asset.media_type === "photo" && env.GEMINI_API_KEY ? await loadOriginal() : null;
      const description = original ? await summarizeImage(env, original, form?.get("preview")) : null;
      if (description) Object.assign(asset, description);
      const vectors = await computeAssetVectors(env, asset, original ? async () => original : loadOriginal, await readMediaParts(form));
      if (vectors.embedder_name !== EG2_EMBEDDER) {
        return withCors(Response.json({ error: "Visual indexing is unavailable. The existing index was kept." }, { status: 503 }), request);
      }
      Object.assign(asset, vectors);
      await env.DB.prepare("UPDATE assets SET data = ? WHERE id = ?").bind(JSON.stringify(asset), asset.id).run();
      await notifyUserHub(env, asset.owner_id, "asset_indexed", asset);
      return withCors(
        Response.json({
          id: asset.id,
          title: asset.title,
          summary: asset.summary,
          media_type: asset.media_type,
          embedder_name: asset.embedder_name,
          dims: asset.embedding.length,
          video_moments: asset.video_moments.map((m) => ({ timestamp_sec: m.timestamp_sec, label: m.label })),
        }),
        request
      );
    }

    // Upload directly into Zero-Egress Cloudflare R2 + Index in D1
    if (path === "/api/assets/upload" && request.method === "POST") {
      const form = await request.formData();
      const ownerId = String(form.get("owner_id") || "mehmet");
      const file = form.get("file") as File | null;
      if (!file) return withCors(Response.json({ error: "Missing file" }, { status: 400 }));

      const fname = file.name || `upload_${Date.now()}`;
      const mime = file.type || "application/octet-stream";
      const mtype: MediaType = mime.startsWith("image/")
        ? "photo"
        : mime.startsWith("video/")
          ? "video"
          : mime.startsWith("audio/")
            ? "audio"
            : "document";

      const blobKey = `${randomId("r2", 12)}_${fname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const bytes = await file.arrayBuffer();
      await env.BLOBS.put(blobKey, bytes, { httpMetadata: { contentType: mime } });

      const location = String(form.get("location") || "").trim();
      const people = String(form.get("people") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const tags = String(form.get("tags") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const description = mtype === "photo" ? await summarizeImage(env, { bytes, mime }, form.get("preview")) : null;
      const summary = description?.summary || String(form.get("summary") || "").trim();
      const title = description?.title || String(form.get("title") || "").trim() || fname.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
      const owner = await findUser(env, ownerId);

      const asset: IndexedAsset = {
        id: randomId("asset", 10),
        owner_id: ownerId,
        owner_name: owner?.display_name || ownerId,
        device_id: String(form.get("device_id") || "edge"),
        filename: fname,
        title,
        media_type: mtype,
        mime_type: mime,
        size_bytes: bytes.byteLength,
        created_at: new Date().toISOString(),
        location,
        people,
        tags,
        folder_path: "",
        ocr_text: String(form.get("ocr_text") || "").trim(),
        summary,
        video_moments: [],
        embedding: embedTextLocal(`${title} ${fname} ${location} ${people.join(" ")} ${tags.join(" ")} ${summary}`),
        embedder_name: "fyde-edge-mrl256",
        blob_id: blobKey,
        download_url: `/api/blobs/${blobKey}`,
        thumbnail_url: mtype === "photo" ? `/api/blobs/${blobKey}` : "",
      };
      // EmbeddingGemma 2: embed the photo's pixels / the video's keyframes (client preview + frames when sent).
      Object.assign(asset, await computeAssetVectors(env, asset, async () => ({ bytes, mime }), await readMediaParts(form)));

      await env.DB.prepare(
        "INSERT OR REPLACE INTO assets (id, owner_id, media_type, created_at, data) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(asset.id, asset.owner_id, asset.media_type, asset.created_at, JSON.stringify(asset))
        .run();
      await notifyUserHub(env, ownerId, "asset_indexed", asset);
      await recordActivity(
        env,
        ownerId,
        null,
        "asset_uploaded",
        `@${owner?.handle || ownerId} added "${asset.title}" to their library`
      );
      return withCors(Response.json(asset), request);
    }

    // Stream zero-egress R2 blobs (with HTTP Byte-Range support for instant video timestamp seeking)
    if (path.startsWith("/api/blobs/") && request.method === "GET") {
      const key = decodeURIComponent(path.slice("/api/blobs/".length));
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader && rangeHeader.startsWith("bytes=")) {
        const head = await env.BLOBS.head(key);
        if (!head) return withCors(new Response("Not found", { status: 404 }), request);
        const total = head.size;
        const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
        const start = Math.max(0, parseInt(startStr, 10) || 0);
        const end = endStr ? Math.min(total - 1, parseInt(endStr, 10)) : total - 1;
        const length = Math.max(1, end - start + 1);
        const rangedObj = await env.BLOBS.get(key, { range: { offset: start, length } });
        if (!rangedObj) return withCors(new Response("Not found", { status: 404 }), request);
        const headers = new Headers(CORS_HEADERS);
        rangedObj.writeHttpMetadata(headers);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
        headers.set("Content-Length", String(length));
        headers.set("etag", rangedObj.httpEtag);
        return withCors(new Response(rangedObj.body, { status: 206, headers }), request);
      }

      const obj = await env.BLOBS.get(key);
      if (!obj) return withCors(new Response("Not found", { status: 404 }), request);
      const headers = new Headers(CORS_HEADERS);
      obj.writeHttpMetadata(headers);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Length", String(obj.size));
      headers.set("etag", obj.httpEtag);
      headers.set("Cache-Control", "public, max-age=3600");
      return withCors(new Response(obj.body, { headers }), request);
    }

    // Multimodal Search across own + permitted contacts
    if (path === "/api/search" && request.method === "POST") {
      const body = (await request.json()) as {
        user_id?: string;
        query: string;
        media_type?: MediaType | null;
        scope?: "mine" | "contacts" | "all";
        limit?: number;
      };
      const actor = await resolveActorUserId(request, env, body.user_id);
      if ("error" in actor) return withCors(actor.error, request);
      const userId = actor.userId;
      const scope = body.scope || "all";
      const limit = body.limit || 24;
      const results: SearchHit[] = [];

      // "mine" = your library; "contacts" (Shared with me) = files sent to you + permitted libraries.
      results.push(
        ...(await searchLibrary(env, userId, body.query || "", body.media_type, limit, {
          own: scope !== "contacts",
          received: scope !== "mine",
        }))
      );
      if (scope === "contacts" || scope === "all") {
        const { results: allUsers } = await env.DB.prepare("SELECT * FROM users").all();
        for (const uRow of allUsers || []) {
          const owner = rowToUserProfile(uRow);
          if (owner.id === userId) continue;
          const perm = await findPermissionForRequester(env, owner.id, userId);
          if (!perm || (perm.tier !== "trusted" && perm.tier !== "smart_scope")) continue;
          const peerHits = await searchOwnerAssets(env, owner.id, body.query || "", body.media_type, limit);
          for (const h of peerHits) {
            const dec = evaluateAssetPermission(h.asset, perm);
            if (dec === "allow_trusted" || dec === "allow_smart_scope") {
              h.match_reason = `${owner.display_name}'s Library (${dec === "allow_trusted" ? "Trusted" : "Smart Scope"}) • ${h.match_reason}`;
              results.push(h);
            }
          }
        }
      }
      results.sort((a, b) => b.score - a.score);
      // A file you received may also be in that contact's permitted library: list it once.
      const seen = new Set<string>();
      const unique = results.filter((h) => !seen.has(h.asset.id) && (seen.add(h.asset.id), true));
      return withCors(Response.json(unique.slice(0, limit)), request);
    }

    // Permissions
    if (path.startsWith("/api/permissions/") && request.method === "GET") {
      const ownerId = decodeURIComponent(path.slice("/api/permissions/".length));
      return withCors(Response.json(await listPermissions(env, ownerId)), request);
    }

    if (path === "/api/permissions" && request.method === "POST") {
      const body = (await request.json()) as {
        owner_id?: string;
        contact_user_id?: string | null;
        contact_name: string;
        contact_handle?: string | null;
        email?: string;
        phone?: string;
        relationship?: string;
        tier: PermissionTier;
        excluded_tags?: string[];
        smart_scopes?: SmartScopeRule[];
      };
      const actor = await resolveActorUserId(request, env, body.owner_id);
      if ("error" in actor) return withCors(actor.error, request);
      const ownerId = actor.userId;

      const matched = await findUser(env, body.contact_user_id || body.contact_handle || body.contact_name);
      const displayName = matched?.display_name || body.contact_name.replace(/^@+/, "");
      const existingRow = await env.DB.prepare(
        "SELECT id FROM permissions WHERE owner_id = ? AND contact_name_lower = ?"
      )
        .bind(ownerId, displayName.toLowerCase())
        .first<{ id: string }>();

      const perm: ContactPermission = {
        id: existingRow?.id || randomId("perm", 10),
        owner_id: ownerId,
        contact_user_id: matched?.id || body.contact_user_id || null,
        contact_name: displayName,
        contact_handle: matched?.handle || (body.contact_handle ? normalizeHandle(body.contact_handle) : null),
        email: body.email || matched?.email || "",
        phone: body.phone || matched?.phone || "",
        relationship: body.relationship || "",
        tier: body.tier,
        excluded_tags: body.excluded_tags || ["private", "hidden"],
        smart_scopes: body.smart_scopes || [],
        updated_at: new Date().toISOString(),
      };
      await env.DB.prepare(
        "INSERT OR REPLACE INTO permissions (id, owner_id, contact_user_id, contact_name_lower, data) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(perm.id, perm.owner_id, perm.contact_user_id, perm.contact_name.toLowerCase(), JSON.stringify(perm))
        .run();
      await notifyUserHub(env, perm.owner_id, "permission_updated", perm);
      if (perm.contact_user_id) await notifyUserHub(env, perm.contact_user_id, "peer_permission_granted", perm);
      const owner = await findUser(env, ownerId);
      await recordActivity(
        env,
        ownerId,
        perm.contact_user_id || null,
        "permission_granted",
        `@${owner?.handle || ownerId} set ${perm.contact_handle ? "@" + perm.contact_handle : perm.contact_name} to ${perm.tier.replace("_", " ")}`
      );
      return withCors(Response.json(perm), request);
    }

    // Send & Peer Pull
    if (path === "/api/send" && request.method === "POST") {
      const body = (await request.json()) as {
        sender_id?: string;
        asset_ids: string[];
        recipient_name: string;
        recipient_user_id?: string;
        recipient_address?: string;
        channel?: SendChannel;
        title?: string;
        message?: string;
      };
      const actor = await resolveActorUserId(request, env, body.sender_id);
      if ("error" in actor) return withCors(actor.error, request);
      try {
        const bundle = await executeSendBundle(env, url.origin, {
          senderId: actor.userId,
          assetIds: body.asset_ids,
          recipientName: body.recipient_name,
          recipientUserId: body.recipient_user_id,
          recipientAddress: body.recipient_address,
          channel: body.channel || "fyde_direct",
          title: body.title,
          message: body.message,
        });
        return withCors(Response.json(bundle), request);
      } catch (err) {
        if (err instanceof SendBundleError) {
          return withCors(Response.json({ error: err.message }, { status: err.status }), request);
        }
        throw err;
      }
    }

    if (path === "/api/peer/pull" && request.method === "POST") {
      const body = (await request.json()) as { requester_id?: string; owner_id: string; query: string };
      const actor = await resolveActorUserId(request, env, body.requester_id);
      if ("error" in actor) return withCors(actor.error, request);
      const res = await executePeerPull(env, url.origin, actor.userId, body.owner_id, body.query);
      return withCors(
        Response.json({
          message: res.message,
          bundle: res.bundle,
          access_request: res.accessRequest,
        }),
        request
      );
    }

    // Received Inbox & Approvals
    if (path.startsWith("/api/received/") && request.method === "GET") {
      const userId = decodeURIComponent(path.slice("/api/received/".length));
      const [recRes, sentRes, reqRes] = await Promise.all([
        env.DB.prepare("SELECT data FROM bundles WHERE recipient_id = ? ORDER BY created_at DESC").bind(userId).all(),
        env.DB.prepare("SELECT data FROM bundles WHERE sender_id = ? ORDER BY created_at DESC").bind(userId).all(),
        env.DB.prepare("SELECT data FROM access_requests WHERE owner_id = ? ORDER BY created_at DESC").bind(userId).all(),
      ]);
      return withCors(
        Response.json({
          bundles: (recRes.results || []).map((r) => JSON.parse(String(r.data))),
          sent_bundles: (sentRes.results || []).map((r) => JSON.parse(String(r.data))),
          incoming_requests: (reqRes.results || []).map((r) => JSON.parse(String(r.data))),
        }),
        request
      );
    }

    const resolveMatch = path.match(/^\/api\/requests\/([^/]+)\/resolve$/);
    if (resolveMatch && request.method === "POST") {
      const reqId = resolveMatch[1];
      const body = (await request.json()) as { owner_id?: string; decision: "approve" | "deny" };
      const actor = await resolveActorUserId(request, env, body.owner_id);
      if ("error" in actor) return withCors(actor.error, request);

      const row = await env.DB.prepare("SELECT data FROM access_requests WHERE id = ?").bind(reqId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Not found" }, { status: 404 }), request);
      const accessReq = JSON.parse(row.data) as AccessRequest;
      if (accessReq.owner_id !== actor.userId) return withCors(Response.json({ error: "Forbidden" }, { status: 403 }), request);

      if (body.decision === "deny") {
        accessReq.status = "denied";
        await env.DB.prepare("UPDATE access_requests SET status = 'denied', data = ? WHERE id = ?")
          .bind(JSON.stringify(accessReq), reqId)
          .run();
        await notifyUserHub(env, accessReq.requester_id, "access_request_resolved", { id: reqId, status: "denied" });
        return withCors(Response.json({ access_request: accessReq, bundle: null }), request);
      }

      accessReq.status = "approved";
      let bundle: TransferBundle | null = null;
      if (accessReq.matched_asset_ids.length > 0) {
        bundle = await executeSendBundle(env, url.origin, {
          senderId: accessReq.owner_id,
          assetIds: accessReq.matched_asset_ids,
          recipientName: accessReq.requester_name,
          recipientUserId: accessReq.requester_id,
          channel: "fyde_direct",
          title: `Approved: ${accessReq.query}`,
          message: `Approved your request for "${accessReq.query}"`,
        });
        bundle.origin = "approved_request";
        await env.DB.prepare("UPDATE bundles SET data = ? WHERE id = ?").bind(JSON.stringify(bundle), bundle.id).run();
        accessReq.bundle_id = bundle.id;
      }
      await env.DB.prepare("UPDATE access_requests SET status = 'approved', data = ? WHERE id = ?")
        .bind(JSON.stringify(accessReq), reqId)
        .run();
      await notifyUserHub(env, accessReq.requester_id, "access_request_resolved", { id: reqId, status: "approved", bundle });
      return withCors(Response.json({ access_request: accessReq, bundle }), request);
    }

    const acceptMatch = path.match(/^\/api\/bundles\/([^/]+)\/accept$/);
    if (acceptMatch && request.method === "POST") {
      const bundleId = acceptMatch[1];
      const body = (await request.json()) as { user_id?: string; destination_type?: "photos" | "files"; album_or_folder?: string };
      const actor = await resolveActorUserId(request, env, body.user_id);
      if ("error" in actor) return withCors(actor.error, request);

      const row = await env.DB.prepare("SELECT data FROM bundles WHERE id = ?").bind(bundleId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Not found" }, { status: 404 }), request);
      const bundle = JSON.parse(row.data) as TransferBundle;
      const intoPhotos = body.destination_type !== "files";
      bundle.status = intoPhotos ? "accepted_photos" : "accepted_files";
      bundle.accepted_destination = intoPhotos
        ? `Apple Photos → Album '${body.album_or_folder || bundle.title}'`
        : `Files → ${body.album_or_folder || "Received/" + bundle.title}`;
      await env.DB.prepare("UPDATE bundles SET data = ? WHERE id = ?").bind(JSON.stringify(bundle), bundleId).run();
      await notifyUserHub(env, actor.userId, "bundle_accepted", bundle);
      return withCors(Response.json(bundle), request);
    }

    if (path.startsWith("/api/bundles/") && request.method === "GET") {
      const bundleId = decodeURIComponent(path.slice("/api/bundles/".length));
      const row = await env.DB.prepare("SELECT data FROM bundles WHERE id = ?").bind(bundleId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Not found" }, { status: 404 }));
      return withCors(Response.json(JSON.parse(row.data)));
    }

    // Conversational Fyde Chat (`/api/chat`)
    if (path.startsWith("/api/chat/") && request.method === "GET") {
      const userId = decodeURIComponent(path.slice("/api/chat/".length));
      const { results } = await env.DB.prepare("SELECT data FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 80")
        .bind(userId)
        .all();
      return withCors(Response.json((results || []).reverse().map((r) => JSON.parse(String(r.data)))));
    }

    // Band taps only confirm the newest fresh hold, including when the iPhone sends
    // its message_id. The app can also act on an older send from its chat card.
    if (path === "/api/chat/confirm" && request.method === "POST") {
      const body = (await request.json()) as { user_id?: string; message_id?: string; decision?: string; via?: string };
      const actor = await resolveActorUserId(request, env, body.user_id);
      if ("error" in actor) return withCors(actor.error, request);
      const userId = actor.userId;
      const messageId = (body.message_id || "").trim();

      let original: string | null = null;
      if (messageId && body.via !== "band") {
        const row = await env.DB.prepare("SELECT data FROM chat_messages WHERE id = ? AND user_id = ?")
          .bind(messageId, userId)
          .first<{ data: string }>();
        original = row?.data ?? null;
      } else {
        // "Confirm the latest" only reaches sends held in the last 10 minutes, so a stray tap
        // can't fire off something said hours ago. Older holds stay confirmable from the card.
        const freshAfter = Date.now() - 10 * 60 * 1000;
        const { results } = await env.DB.prepare(
          "SELECT data FROM chat_messages WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 40"
        )
          .bind(userId)
          .all();
        for (const r of results || []) {
          const m = JSON.parse(String(r.data)) as ChatMessage;
          const createdAt = Date.parse(m.created_at);
          if (!Number.isFinite(createdAt) || createdAt < freshAfter) break;
          // Only the most recent hold counts (resolved holds keep hold_reason); a second tap
          // must not walk back to an older request the band is no longer signalling.
          if (m.role === "assistant" && m.action_card?.hold_reason) {
            if (
              m.action_card.action_type === "send_confirmation" &&
              m.action_card.requires_confirmation &&
              (!messageId || m.id === messageId)
            ) {
              original = String(r.data);
            }
            break;
          }
        }
      }
      if (!original) {
        return withCors(Response.json({ error: "No pending send to confirm." }, { status: 404 }), request);
      }

      const msg = JSON.parse(original) as ChatMessage;
      const held = msg.action_card;
      if (!held || held.action_type !== "send_confirmation" || !held.requires_confirmation) {
        return withCors(Response.json({ error: "That send was already handled.", message: msg }, { status: 409 }), request);
      }
      if (body.via === "band" && held.band_confirmable !== true) {
        return withCors(
          Response.json({ error: "This send includes private items — confirm it in fyde instead.", message: msg }, { status: 403 }),
          request
        );
      }

      const recipientName = held.recipient_name || "your contact";
      const cancel = body.decision === "cancel";
      const claimed: ChatMessage = cancel
        ? {
            ...msg,
            text: `Cancelled — nothing was sent to **${recipientName}**.`,
            action_card: { ...held, action_type: "send_cancelled", requires_confirmation: false, summary: "Cancelled" },
          }
        : { ...msg, action_card: { ...held, action_type: "send_in_progress", requires_confirmation: false } };
      // Compare-and-swap on the stored JSON so a double tap can never send twice.
      const claim = await env.DB.prepare("UPDATE chat_messages SET data = ? WHERE id = ? AND data = ?")
        .bind(JSON.stringify(claimed), msg.id, original)
        .run();
      if (!claim.meta.changes) {
        return withCors(Response.json({ error: "That send was already handled." }, { status: 409 }), request);
      }
      if (cancel) {
        await notifyUserHub(env, userId, "chat_message_updated", claimed);
        return withCors(Response.json(claimed), request);
      }

      try {
        if (body.via === "band") {
          const perm = await findPermissionForRequester(env, userId, held.recipient_id || recipientName);
          for (const id of held.asset_ids || []) {
            const row = await env.DB.prepare("SELECT data FROM assets WHERE id = ? AND owner_id = ?")
              .bind(id, userId)
              .first<{ data: string }>();
            if (!row) {
              throw new SendBundleError("One or more selected assets are unavailable or not owned by you.", 403);
            }
            if (evaluateAssetPermission(JSON.parse(row.data) as IndexedAsset, perm) === "deny") {
              throw new SendBundleError("This send includes private items. Confirm it in fyde instead.", 403);
            }
          }
        }
        const channel: SendChannel = held.channel || "fyde_direct";
        const bundle = await executeSendBundle(env, url.origin, {
          senderId: userId,
          assetIds: held.asset_ids || [],
          recipientName,
          recipientUserId: held.recipient_id || null,
          recipientAddress: held.recipient_address || "",
          channel,
          message: held.source === "vexo" ? "Shared via fyde (Vexo voice)" : "Shared via fyde. Chat",
        });
        const label = bundle.items.length === 1 ? `**${bundle.items[0].title}**` : `**${bundle.items.length} items**`;
        const doneText = `Sent ${label} to **${bundle.recipient_name}** via **${CHANNEL_LABEL[channel]}** (confirmed${body.via === "band" ? " on Vexo" : ""}).\n\n_${bundle.delivery_detail}_`;
        const done: ChatMessage = {
          ...msg,
          text: doneText,
          action_card: {
            ...held,
            action_type: "send_completed",
            summary: doneText,
            requires_confirmation: false,
            previews: bundle.items,
            bundle,
          },
        };
        await env.DB.prepare("UPDATE chat_messages SET data = ? WHERE id = ?").bind(JSON.stringify(done), msg.id).run();
        await notifyUserHub(env, userId, "chat_message_updated", done);
        return withCors(Response.json(done), request);
      } catch (err) {
        // Put the card back so the user can retry.
        await env.DB.prepare("UPDATE chat_messages SET data = ? WHERE id = ?").bind(original, msg.id).run();
        return withCors(
          Response.json(
            { error: err instanceof Error ? err.message : "Send failed." },
            { status: err instanceof SendBundleError ? err.status : 400 }
          ),
          request
        );
      }
    }

    if (path === "/api/chat" && request.method === "POST") {
      const body = (await request.json()) as { user_id?: string; text: string; source?: string; platform?: string; client_message_id?: string };
      const actor = await resolveActorUserId(request, env, body.user_id);
      if ("error" in actor) return withCors(actor.error, request);
      const userId = actor.userId;
      const spokenText = (body.text || "").trim();
      // "Vexo, send that to John" -> "send that to John"
      const wake = stripWakeWord(spokenText);
      const text = wake.text || spokenText;
      const tl = text.toLowerCase();
      const fromVexo =
        wake.wake || (body.source || "").toLowerCase() === "vexo" || (body.platform || "").toLowerCase().startsWith("vexo");

      const userMsg: ChatMessage = {
        id: randomId("msg", 10),
        user_id: userId,
        role: "user",
        text: spokenText,
        source: fromVexo ? "vexo" : null,
        client_message_id: body.client_message_id || null,
        created_at: new Date().toISOString(),
      };
      await env.DB.prepare("INSERT INTO chat_messages (id, user_id, created_at, data) VALUES (?, ?, ?, ?)")
        .bind(userMsg.id, userId, userMsg.created_at, JSON.stringify(userMsg))
        .run();
      await notifyUserHub(env, userId, "chat_message", userMsg);

      const perms = await listPermissions(env, userId);
      const { results: allUsers } = await env.DB.prepare("SELECT * FROM users").all();
      const atHandles = [...text.matchAll(/@([a-zA-Z0-9_]+)/g)].map((m) => normalizeHandle(m[1]));
      let mentioned = "";
      if (atHandles.length > 0) {
        const matchedAt = await findUser(env, atHandles[0]);
        if (matchedAt && matchedAt.id !== userId) {
          mentioned = matchedAt.handle;
        } else {
          const permAt = perms.find((p) => p.contact_handle && normalizeHandle(p.contact_handle) === atHandles[0]);
          mentioned = permAt?.contact_handle || permAt?.contact_name || atHandles[0];
        }
      }
      if (!mentioned) {
        const names = [
          ...perms.map((p) => p.contact_name),
          ...(allUsers || []).map((u) => String(u.display_name)).filter((n) => n.toLowerCase() !== userId.toLowerCase()),
        ];
        mentioned = names.find((n) => new RegExp(`\\b${n.toLowerCase()}(?:'s)?\\b`).test(tl)) || "";
      }

      let replyText = "";
      let card: ChatActionCard | null = null;
      const sendCommand = parseSendCommand(text);

      // Send: "send that to John", "Vexo send my cat picture to John", "text Maya the surfing video".
      // Checked first so phrases like "forward that to my friend Alex" are never read as friend requests.
      if (sendCommand) {
        try {
          const outcome = await handleChatSendCommand(env, url.origin, userId, sendCommand, { voice: fromVexo });
          replyText = outcome.replyText;
          card = outcome.card;
        } catch (err) {
          replyText = `Couldn't send that: ${err instanceof Error ? err.message : "unexpected error"}.`;
          card = null;
        }
      }
      // 0) Add / Connect contact via @handle in Chat ("Add @sarah", "Connect with @alex")
      else if ((atHandles.length > 0 || mentioned) && /\b(add|connect|friend|follow|invite)\b/.test(tl) && !/\b(send|get|pull|allow|permission)\b/.test(tl)) {
        const targetHandle = atHandles[0] || mentioned;
        const addRes = await sendOrAcceptFriendRequest(env, userId, targetHandle, "ask_first");
        replyText = addRes.message;
        card = {
          action_type: addRes.status === "accepted" || addRes.status === "already_connected" ? "friend_connected" : "friend_request_sent",
          summary: replyText,
          recipient_name: addRes.target?.display_name || targetHandle,
          recipient_id: addRes.target?.id || null,
          asset_ids: [],
          previews: [],
          requires_confirmation: false,
        };
      }
      // A) Accept received bundle
      else if (/\b(accept|save received|import received)\b/.test(tl)) {
        const { results } = await env.DB.prepare("SELECT data FROM bundles WHERE recipient_id = ? ORDER BY created_at DESC")
          .bind(userId)
          .all();
        const bundles = (results || []).map((r) => JSON.parse(String(r.data)) as TransferBundle);
        const target = bundles.find((b) => b.status === "delivered") || bundles[0];
        if (!target) {
          replyText = "You don't have any received bundles waiting in your Received tab yet.";
        } else {
          const intoPhotos = !/\b(document|documents|folder|files)\b/.test(tl) || /\bphotos\b/.test(tl);
          target.status = intoPhotos ? "accepted_photos" : "accepted_files";
          target.accepted_destination = intoPhotos ? `Apple Photos → Album '${target.title}'` : `Files → Received/${target.title}`;
          await env.DB.prepare("UPDATE bundles SET data = ? WHERE id = ?").bind(JSON.stringify(target), target.id).run();
          replyText = `Accepted **${target.title}** into **${target.accepted_destination}**.`;
          card = {
            action_type: "bundle_accepted",
            summary: replyText,
            asset_ids: target.items.map((i) => i.asset_id),
            previews: target.items,
            bundle: target,
            requires_confirmation: false,
          };
        }
      }
      // B) Permission update
      else if (mentioned && /\b(permission|trusted|full access|allow|let|ask first|smart scope)\b/.test(tl)) {
        const tier: PermissionTier = /\b(trusted|full access|anything)\b/.test(tl)
          ? "trusted"
          : /\b(ask first|approval)\b/.test(tl)
            ? "ask_first"
            : "smart_scope";
        const locs = ["China", "Shanghai", "Beijing", "Kyoto", "Japan"].filter((l) => tl.includes(l.toLowerCase()));
        const scopes: SmartScopeRule[] =
          tier === "smart_scope"
            ? [
                {
                  id: randomId("scope", 8),
                  label: `Smart Scope: ${locs.length ? locs.join("/") + " " : ""}items${tl.includes("with") ? ` with ${mentioned}` : ""}`,
                  locations: locs,
                  people: tl.includes("with") ? [mentioned] : [],
                  media_types: ["photo", "video"],
                  semantic_query: locs.length ? `${locs[0]} trip` : text,
                  similarity_threshold: 0.24,
                  excluded_tags: ["private", "hidden"],
                },
              ]
            : [];
        const matchedUser = await findUser(env, mentioned);
        const perm: ContactPermission = {
          id: randomId("perm", 10),
          owner_id: userId,
          contact_user_id: matchedUser?.id || null,
          contact_name: matchedUser?.display_name || mentioned,
          contact_handle: matchedUser?.handle || null,
          email: matchedUser?.email || "",
          phone: matchedUser?.phone || "",
          relationship: "",
          tier,
          excluded_tags: ["private", "hidden"],
          smart_scopes: scopes,
          updated_at: new Date().toISOString(),
        };
        await env.DB.prepare(
          "INSERT OR REPLACE INTO permissions (id, owner_id, contact_user_id, contact_name_lower, data) VALUES (?, ?, ?, ?, ?)"
        )
          .bind(perm.id, perm.owner_id, perm.contact_user_id, perm.contact_name.toLowerCase(), JSON.stringify(perm))
          .run();
        replyText =
          tier === "trusted"
            ? `Updated **${perm.contact_name}** to **Trusted (Full Access)**.`
            : `Updated **${perm.contact_name}** to **${tier.replace("_", " ")}** (${scopes[0]?.label || "custom rule"}).`;
        card = {
          action_type: "permission_updated",
          summary: replyText,
          recipient_name: perm.contact_name,
          asset_ids: [],
          previews: [],
          permission: perm,
          requires_confirmation: false,
        };
      }
      // C) Cross-Peer Pull ("Get ... from Mehmet's files" or "Get ... from @mehmet")
      else if (mentioned && /\b(get|pull|fetch|request|grab)\b/.test(tl) && /\bfrom\b/.test(tl)) {
        const cleaned = tl
          .replace(new RegExp(`(?:@?${mentioned.toLowerCase()}(?:'s)?|\\b(get|pull|fetch|request|grab|from|files|our|my)\\b)`, "g"), " ")
          .replace(/\s+/g, " ")
          .trim();
        const pullRes = await executePeerPull(env, url.origin, userId, mentioned, cleaned || text);
        replyText = pullRes.message;
        card = {
          action_type: pullRes.bundle ? "peer_pull_completed" : "peer_request_pending",
          summary: replyText,
          recipient_name: mentioned,
          asset_ids: pullRes.bundle ? pullRes.bundle.items.map((i) => i.asset_id) : [],
          previews: pullRes.bundle ? pullRes.bundle.items : [],
          bundle: pullRes.bundle,
          access_request: pullRes.accessRequest,
          requires_confirmation: false,
        };
      }
      // D) Outbound sends are handled up front by handleChatSendCommand.
      // E) Multimodal Search in Chat
      else {
        const hits = await searchOwnerAssets(env, userId, text, null, 6);
        if (hits.length === 0) {
          replyText = `No multimodal matches found for "${text}".`;
        } else {
          const previews = hits.map((h) => assetToBundleItem(h.asset, h.matched_moment_sec));
          replyText =
            `Found **${hits.length}** match(es):\n` +
            hits.map((h) => `- **${h.asset.title}** (${h.asset.media_type})`).join("\n");
          card = {
            action_type: "search_results",
            summary: `${hits.length} matches`,
            asset_ids: hits.map((h) => h.asset.id),
            previews,
            requires_confirmation: false,
            focus_asset_ids: focusIdsForSearch(text, hits),
          };
        }
      }

      const assistantMsg: ChatMessage = {
        id: randomId("msg", 10),
        user_id: userId,
        role: "assistant",
        text: replyText,
        source: fromVexo ? "vexo" : null,
        action_card: card,
        created_at: new Date().toISOString(),
      };
      await env.DB.prepare("INSERT INTO chat_messages (id, user_id, created_at, data) VALUES (?, ?, ?, ?)")
        .bind(assistantMsg.id, userId, assistantMsg.created_at, JSON.stringify(assistantMsg))
        .run();
      await notifyUserHub(env, userId, "chat_message", assistantMsg);
      return withCors(Response.json(assistantMsg));
    }

    // 5. Serve `fyde.izbirakin.com` Static Assets (`web/dist` SPA: Landing + Waitlist + Login + App)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return withCors(new Response("fyde. edge worker running", { status: 200 }));
  },
};
