import { getAuthenticatedUser, handleWaitlistAndAuthRoutes, rowToUserProfile } from "./auth";
import { handleBillingRoutes } from "./billing";
import { randomId } from "./crypto";
import { UserRelayHub } from "./durableHub";
import { embedQueryEdge, embedTextLocal, evaluateAssetPermission } from "./embedder";
import { computeAssetVectors, EG2_EMBEDDER, embedQueryEg2, isEg2Asset, rankAssets, readMediaParts } from "./mediaIndex";
import { ensureSeeded } from "./seed";
import type {
  AccessRequest,
  BundleItem,
  ChatActionCard,
  ChatMessage,
  ContactPermission,
  Env,
  IndexedAsset,
  MediaType,
  PermissionTier,
  SearchHit,
  SendChannel,
  SmartScopeRule,
  TransferBundle,
  UserProfile,
} from "./types";

export { UserRelayHub };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

  const qClean = query.trim();
  if (!qClean) {
    return assets.slice(0, limit).map((asset) => ({ asset, score: 1.0, match_reason: "Recent item" }));
  }

  const [eg2, legacy] = await Promise.all([
    assets.some(isEg2Asset) ? embedQueryEg2(env, qClean) : Promise.resolve(null),
    Promise.resolve(assets.some((a) => !isEg2Asset(a)) ? embedTextLocal(qClean) : null),
  ]);
  return rankAssets(assets, qClean, { eg2, legacy }, limit);
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
  const sender = await findUser(env, params.senderId);
  const senderName = sender?.display_name || params.senderId;
  const recipientUser = await findUser(env, params.recipientUserId || params.recipientName);
  const perm = await findPermissionForRequester(env, params.senderId, params.recipientUserId || params.recipientName);

  const assets: IndexedAsset[] = [];
  for (const aid of params.assetIds) {
    const r = await env.DB.prepare("SELECT data FROM assets WHERE id = ?").bind(aid).first<{ data: string }>();
    if (r?.data) assets.push(JSON.parse(r.data) as IndexedAsset);
  }
  if (assets.length === 0) {
    throw new Error("No valid assets selected to send");
  }

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
      return withCors(Response.json((results || []).map(rowToUserProfile)));
    }

    if (path.startsWith("/api/assets/") && path !== "/api/assets/upload" && request.method === "GET") {
      const ownerId = decodeURIComponent(path.slice("/api/assets/".length));
      const { results } = await env.DB.prepare("SELECT data FROM assets WHERE owner_id = ? ORDER BY created_at DESC")
        .bind(ownerId)
        .all();
      return withCors(Response.json((results || []).map((r) => JSON.parse(String(r.data)))));
    }

    // Reindex an existing file without changing its original bytes or metadata.
    const reindexMatch = path.match(/^\/api\/assets\/([^/]+)\/reindex$/);
    if (reindexMatch && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return withCors(Response.json({ error: "Sign in to reindex files." }, { status: 401 }));
      const assetId = decodeURIComponent(reindexMatch[1]);
      const row = await env.DB.prepare("SELECT data FROM assets WHERE id = ?").bind(assetId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Asset not found." }, { status: 404 }));
      const asset = JSON.parse(row.data) as IndexedAsset;
      if (asset.owner_id !== user.id) {
        return withCors(Response.json({ error: "Only the owner can reindex this file." }, { status: 403 }));
      }
      const form = (request.headers.get("Content-Type") || "").includes("multipart/form-data")
        ? await request.formData() : null;
      const vectors = await computeAssetVectors(env, asset, async () => {
        if (!asset.blob_id) return null;
        const blob = await env.BLOBS.get(asset.blob_id);
        return blob ? { bytes: await blob.arrayBuffer(), mime: asset.mime_type } : null;
      }, await readMediaParts(form));
      if (vectors.embedder_name !== EG2_EMBEDDER) {
        return withCors(Response.json({ error: "Visual indexing is unavailable. The existing index was kept." }, { status: 503 }));
      }
      Object.assign(asset, vectors);
      await env.DB.prepare("UPDATE assets SET data = ? WHERE id = ?").bind(JSON.stringify(asset), asset.id).run();
      await notifyUserHub(env, asset.owner_id, "asset_indexed", asset);
      return withCors(Response.json({ id: asset.id, embedder_name: asset.embedder_name, dims: asset.embedding.length,
        video_moments: asset.video_moments.map(({ timestamp_sec, label }) => ({ timestamp_sec, label })) }));
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
      const summary = String(form.get("summary") || "").trim();
      const title = String(form.get("title") || "").trim() || fname.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
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

      Object.assign(asset, await computeAssetVectors(
        env, asset, async () => ({ bytes, mime }), await readMediaParts(form)
      ));

      await env.DB.prepare(
        "INSERT OR REPLACE INTO assets (id, owner_id, media_type, created_at, data) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(asset.id, asset.owner_id, asset.media_type, asset.created_at, JSON.stringify(asset))
        .run();
      await notifyUserHub(env, ownerId, "asset_indexed", asset);
      return withCors(Response.json(asset));
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
        user_id: string;
        query: string;
        media_type?: MediaType | null;
        scope?: "mine" | "contacts" | "all";
        limit?: number;
      };
      const scope = body.scope || "all";
      const limit = body.limit || 24;
      const results: SearchHit[] = [];

      if (scope === "mine" || scope === "all") {
        results.push(...(await searchOwnerAssets(env, body.user_id, body.query || "", body.media_type, limit)));
      }
      if (scope === "contacts" || scope === "all") {
        const { results: allUsers } = await env.DB.prepare("SELECT * FROM users").all();
        for (const uRow of allUsers || []) {
          const owner = rowToUserProfile(uRow);
          if (owner.id === body.user_id) continue;
          const perm = await findPermissionForRequester(env, owner.id, body.user_id);
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
      return withCors(Response.json(results.slice(0, limit)));
    }

    // Permissions
    if (path.startsWith("/api/permissions/") && request.method === "GET") {
      const ownerId = decodeURIComponent(path.slice("/api/permissions/".length));
      return withCors(Response.json(await listPermissions(env, ownerId)));
    }

    if (path === "/api/permissions" && request.method === "POST") {
      const body = (await request.json()) as {
        owner_id: string;
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
      const matched = await findUser(env, body.contact_user_id || body.contact_handle || body.contact_name);
      const existingRow = await env.DB.prepare(
        "SELECT id FROM permissions WHERE owner_id = ? AND contact_name_lower = ?"
      )
        .bind(body.owner_id, (matched?.display_name || body.contact_name).toLowerCase())
        .first<{ id: string }>();

      const perm: ContactPermission = {
        id: existingRow?.id || randomId("perm", 10),
        owner_id: body.owner_id,
        contact_user_id: matched?.id || body.contact_user_id || null,
        contact_name: matched?.display_name || body.contact_name,
        contact_handle: matched?.handle || body.contact_handle || null,
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
      return withCors(Response.json(perm));
    }

    // Send & Peer Pull
    if (path === "/api/send" && request.method === "POST") {
      const body = (await request.json()) as {
        sender_id: string;
        asset_ids: string[];
        recipient_name: string;
        recipient_user_id?: string;
        recipient_address?: string;
        channel?: SendChannel;
        title?: string;
        message?: string;
      };
      const bundle = await executeSendBundle(env, url.origin, {
        senderId: body.sender_id,
        assetIds: body.asset_ids,
        recipientName: body.recipient_name,
        recipientUserId: body.recipient_user_id,
        recipientAddress: body.recipient_address,
        channel: body.channel || "fyde_direct",
        title: body.title,
        message: body.message,
      });
      return withCors(Response.json(bundle));
    }

    if (path === "/api/peer/pull" && request.method === "POST") {
      const body = (await request.json()) as { requester_id: string; owner_id: string; query: string };
      const res = await executePeerPull(env, url.origin, body.requester_id, body.owner_id, body.query);
      return withCors(
        Response.json({
          message: res.message,
          bundle: res.bundle,
          access_request: res.accessRequest,
        })
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
        })
      );
    }

    const resolveMatch = path.match(/^\/api\/requests\/([^/]+)\/resolve$/);
    if (resolveMatch && request.method === "POST") {
      const reqId = resolveMatch[1];
      const body = (await request.json()) as { owner_id: string; decision: "approve" | "deny" };
      const row = await env.DB.prepare("SELECT data FROM access_requests WHERE id = ?").bind(reqId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Not found" }, { status: 404 }));
      const accessReq = JSON.parse(row.data) as AccessRequest;
      if (accessReq.owner_id !== body.owner_id) return withCors(Response.json({ error: "Forbidden" }, { status: 403 }));

      if (body.decision === "deny") {
        accessReq.status = "denied";
        await env.DB.prepare("UPDATE access_requests SET status = 'denied', data = ? WHERE id = ?")
          .bind(JSON.stringify(accessReq), reqId)
          .run();
        await notifyUserHub(env, accessReq.requester_id, "access_request_resolved", { id: reqId, status: "denied" });
        return withCors(Response.json({ access_request: accessReq, bundle: null }));
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
      return withCors(Response.json({ access_request: accessReq, bundle }));
    }

    const acceptMatch = path.match(/^\/api\/bundles\/([^/]+)\/accept$/);
    if (acceptMatch && request.method === "POST") {
      const bundleId = acceptMatch[1];
      const body = (await request.json()) as { user_id: string; destination_type?: "photos" | "files"; album_or_folder?: string };
      const row = await env.DB.prepare("SELECT data FROM bundles WHERE id = ?").bind(bundleId).first<{ data: string }>();
      if (!row) return withCors(Response.json({ error: "Not found" }, { status: 404 }));
      const bundle = JSON.parse(row.data) as TransferBundle;
      const intoPhotos = body.destination_type !== "files";
      bundle.status = intoPhotos ? "accepted_photos" : "accepted_files";
      bundle.accepted_destination = intoPhotos
        ? `Apple Photos → Album '${body.album_or_folder || bundle.title}'`
        : `Files → ${body.album_or_folder || "Received/" + bundle.title}`;
      await env.DB.prepare("UPDATE bundles SET data = ? WHERE id = ?").bind(JSON.stringify(bundle), bundleId).run();
      await notifyUserHub(env, body.user_id, "bundle_accepted", bundle);
      return withCors(Response.json(bundle));
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
      const { results } = await env.DB.prepare("SELECT data FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 80")
        .bind(userId)
        .all();
      return withCors(Response.json((results || []).map((r) => JSON.parse(String(r.data)))));
    }

    if (path === "/api/chat" && request.method === "POST") {
      const body = (await request.json()) as { user_id: string; text: string };
      const userId = body.user_id;
      const text = (body.text || "").trim();
      const tl = text.toLowerCase();

      const userMsg: ChatMessage = {
        id: randomId("msg", 10),
        user_id: userId,
        role: "user",
        text,
        created_at: new Date().toISOString(),
      };
      await env.DB.prepare("INSERT INTO chat_messages (id, user_id, created_at, data) VALUES (?, ?, ?, ?)")
        .bind(userMsg.id, userId, userMsg.created_at, JSON.stringify(userMsg))
        .run();

      const perms = await listPermissions(env, userId);
      const { results: allUsers } = await env.DB.prepare("SELECT * FROM users").all();
      const names = [
        ...perms.map((p) => p.contact_name),
        ...(allUsers || []).map((u) => String(u.display_name)).filter((n) => n.toLowerCase() !== userId.toLowerCase()),
      ];
      const mentioned = names.find((n) => new RegExp(`\\b${n.toLowerCase()}(?:'s)?\\b`).test(tl)) || "";

      let replyText = "";
      let card: ChatActionCard | null = null;

      // A) Accept received bundle
      if (/\b(accept|save received|import received)\b/.test(tl)) {
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
      // C) Cross-Peer Pull ("Get ... from Mehmet's files")
      else if (mentioned && /\b(get|pull|fetch|request|grab)\b/.test(tl) && /\bfrom\b/.test(tl)) {
        const cleaned = tl
          .replace(new RegExp(`\\b(get|pull|fetch|request|grab|from|files|our|my|${mentioned.toLowerCase()}'?s?)\\b`, "g"), " ")
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
      // D) Outbound Send ("Send ... to Maya", "iMessage ...", "Email ...")
      else if (mentioned && /\b(send|imessage|email|share)\b/.test(tl)) {
        const channel: SendChannel = tl.includes("imessage")
          ? "imessage"
          : tl.includes("email")
            ? "email"
            : "fyde_direct";
        const cleaned = tl
          .replace(new RegExp(`\\b(send|imessage|email|share|via|to|the|all|my|${mentioned.toLowerCase()})\\b`, "g"), " ")
          .replace(/\s+/g, " ")
          .trim();
        const hits = await searchOwnerAssets(env, userId, cleaned || text, null, 6);
        if (hits.length === 0) {
          replyText = `Couldn't find matching items in your library for "${cleaned || text}".`;
        } else {
          const bundle = await executeSendBundle(env, url.origin, {
            senderId: userId,
            assetIds: hits.map((h) => h.asset.id),
            recipientName: mentioned,
            channel,
            message: `Shared via fyde. Chat: ${cleaned}`,
          });
          replyText = `Sent **${bundle.items.length} item(s)** to **${bundle.recipient_name}** via **${channel}**.\n\n_${bundle.delivery_detail}_`;
          card = {
            action_type: "send_completed",
            summary: replyText,
            channel,
            recipient_name: bundle.recipient_name,
            asset_ids: hits.map((h) => h.asset.id),
            previews: bundle.items,
            bundle,
            requires_confirmation: false,
          };
        }
      }
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
          };
        }
      }

      const assistantMsg: ChatMessage = {
        id: randomId("msg", 10),
        user_id: userId,
        role: "assistant",
        text: replyText,
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
