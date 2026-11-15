from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path
from typing import Any
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .channels import send_email_background, send_imessage_via_local_mac
from .chat_agent import parse_chat_intent
from .embedder import MultimodalEmbedder
from .image_summary import summarize_image
from .models import (
    AcceptBundleRequest,
    AccessRequest,
    BundleItem,
    ChatActionCard,
    ChatMessage,
    ChatTurnRequest,
    ContactPermission,
    DeviceNode,
    IndexedAsset,
    MediaType,
    PeerPullRequest,
    PlatformType,
    ResolveAccessRequestPayload,
    SearchHit,
    SearchRequest,
    SendChannel,
    SendFilesRequest,
    SetPermissionRequest,
    SmartScopeRule,
    TransferBundle,
    UserProfile,
)
from .permissions import evaluate_asset_permission
from .storage import FydeStorage, utc_now_iso


class ConnectionHub:
    """Tracks live WebSocket peer connections across iPhone, macOS, and Web nodes."""

    def __init__(self) -> None:
        # user_id -> {device_id: (WebSocket, DeviceNode)}
        self.connections: dict[str, dict[str, tuple[WebSocket, DeviceNode]]] = {}

    async def register(self, ws: WebSocket, node: DeviceNode) -> None:
        await ws.accept()
        node.online = True
        node.last_seen = utc_now_iso()
        self.connections.setdefault(node.user_id, {})[node.device_id] = (ws, node)

    def unregister(self, user_id: str, device_id: str) -> None:
        user_map = self.connections.get(user_id)
        if user_map and device_id in user_map:
            del user_map[device_id]

    def list_online_devices(self, user_id: str | None = None) -> list[DeviceNode]:
        out: list[DeviceNode] = []
        for uid, dev_map in self.connections.items():
            if user_id and uid != user_id:
                continue
            for _, node in dev_map.values():
                out.append(node)
        return out

    def has_online_mac_bridge(self, user_id: str) -> DeviceNode | None:
        for _, node in self.connections.get(user_id, {}).values():
            if node.platform == "macos" or "imessage_bridge" in node.capabilities:
                return node
        return None

    async def notify_user(self, user_id: str, event_type: str, payload: dict[str, Any]) -> int:
        delivered = 0
        dead: list[str] = []
        for dev_id, (ws, _) in list(self.connections.get(user_id, {}).items()):
            try:
                await ws.send_json({"event": event_type, "payload": payload})
                delivered += 1
            except Exception:
                dead.append(dev_id)
        for d in dead:
            self.unregister(user_id, d)
        return delivered


def create_app(data_dir: Path | None = None) -> FastAPI:
    resolved_dir = data_dir or Path(os.getenv("FYDE_DATA_DIR", str(Path(__file__).resolve().parent.parent / "data")))
    embedder = MultimodalEmbedder()
    storage = FydeStorage(data_dir=resolved_dir, embedder=embedder)
    hub = ConnectionHub()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        storage.seed_if_empty()
        yield

    app = FastAPI(
        title="Fyde Multimodal P2P File Sharing Relay",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.storage = storage
    app.state.embedder = embedder
    app.state.hub = hub

    def _asset_to_bundle_item(asset: IndexedAsset, matched_ts: float | None = None) -> BundleItem:
        return BundleItem(
            asset_id=asset.id,
            filename=asset.filename,
            title=asset.title,
            media_type=asset.media_type,
            mime_type=asset.mime_type,
            size_bytes=asset.size_bytes,
            download_url=asset.download_url or (f"/api/blobs/{asset.blob_id}" if asset.blob_id else ""),
            thumbnail_url=asset.thumbnail_url or (f"/api/blobs/{asset.blob_id}" if asset.media_type == "photo" and asset.blob_id else ""),
            location=asset.location,
            people=asset.people,
            matched_timestamp_sec=matched_ts,
        )

    # ---------- Health & Users ----------
    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "embedder": embedder.active_provider_name,
            "online_devices": [d.model_dump() for d in hub.list_online_devices()],
        }

    @app.get("/api/users", response_model=list[UserProfile])
    async def list_users() -> list[UserProfile]:
        return storage.list_users()

    @app.post("/api/users", response_model=UserProfile)
    async def upsert_user(user: UserProfile) -> UserProfile:
        return storage.upsert_user(user)

    @app.get("/api/devices/{user_id}", response_model=list[DeviceNode])
    async def get_user_devices(user_id: str) -> list[DeviceNode]:
        return hub.list_online_devices(user_id)

    # ---------- Assets & Multimodal Upload Indexing ----------
    @app.get("/api/assets/{owner_id}", response_model=list[IndexedAsset])
    async def list_owner_assets(owner_id: str, media_type: MediaType | None = None) -> list[IndexedAsset]:
        return storage.list_assets(owner_id=owner_id, media_type=media_type)

    @app.post("/api/assets/upload", response_model=IndexedAsset)
    async def upload_and_index_asset(
        owner_id: str = Form(...),
        title: str = Form(""),
        location: str = Form(""),
        people: str = Form(""),  # comma-separated
        tags: str = Form(""),  # comma-separated
        summary: str = Form(""),
        device_id: str = Form("local"),
        file: UploadFile = File(...),
        preview: UploadFile | None = File(None),
    ) -> IndexedAsset:
        raw = await file.read()
        fname = file.filename or f"upload_{uuid.uuid4().hex[:8]}"
        ext = Path(fname).suffix.lower()
        mime = file.content_type or "application/octet-stream"

        if mime.startswith("image/") or ext in (".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif"):
            mtype: MediaType = "photo"
        elif mime.startswith("video/") or ext in (".mp4", ".mov", ".m4v", ".webm"):
            mtype = "video"
        elif mime.startswith("audio/") or ext in (".mp3", ".wav", ".m4a"):
            mtype = "audio"
        else:
            mtype = "document"

        blob_id, blob_path = storage.save_blob(raw, ext or ".bin")
        people_list = [p.strip() for p in people.split(",") if p.strip()]
        tags_list = [t.strip() for t in tags.split(",") if t.strip()]
        owner = storage.get_user(owner_id)
        resolved_title = title.strip() or Path(fname).stem.replace("_", " ").replace("-", " ")
        resolved_summary = summary.strip()
        if mtype == "photo":
            image = raw
            image_mime = mime
            if preview is not None:
                preview_bytes = await preview.read(10 * 1024 * 1024 + 1)
                if 0 < len(preview_bytes) <= 10 * 1024 * 1024:
                    image, image_mime = preview_bytes, preview.content_type or "image/jpeg"
            description = await summarize_image(image, image_mime)
            if description:
                resolved_title = description["title"]
                resolved_summary = description["summary"]

        vec, moments, ocr_text, dur = embedder.embed_asset(
            filename=fname,
            title=resolved_title,
            media_type=mtype,
            location=location.strip(),
            people=people_list,
            tags=tags_list,
            summary=resolved_summary,
            raw_bytes=raw,
            file_path=blob_path,
        )

        asset = IndexedAsset(
            id=f"asset_{uuid.uuid4().hex[:10]}",
            owner_id=owner_id,
            owner_name=owner.display_name if owner else owner_id,
            device_id=device_id,
            filename=fname,
            title=resolved_title,
            media_type=mtype,
            mime_type=mime,
            size_bytes=len(raw),
            created_at=utc_now_iso(),
            location=location.strip(),
            people=people_list,
            tags=tags_list,
            ocr_text=ocr_text,
            summary=resolved_summary,
            duration_sec=dur,
            video_moments=moments,
            embedding=vec,
            embedder_name=embedder.active_provider_name,
            blob_id=blob_id,
        )
        saved = storage.upsert_asset(asset)
        await hub.notify_user(owner_id, "asset_indexed", saved.model_dump())
        return saved

    @app.get("/api/blobs/{blob_id}")
    async def download_blob(blob_id: str) -> FileResponse:
        path = storage.get_blob_path(blob_id)
        if not path:
            raise HTTPException(status_code=404, detail="Blob not found")
        return FileResponse(path)

    # ---------- Unified Multimodal Search (Own, Received & Permitted Contacts) ----------
    @app.post("/api/search", response_model=list[SearchHit])
    async def multimodal_search(req: SearchRequest) -> list[SearchHit]:
        results = storage.search_library(
            user_id=req.user_id,
            query=req.query,
            media_type=req.media_type,
            limit=req.limit,
            include_own=req.scope != "contacts",
            include_received=req.scope != "mine",
            contact_owner_id=req.contact_owner_id,
        )

        if req.scope in ("contacts", "all"):
            # Search across contacts who granted `trusted` or `smart_scope` access to `req.user_id`
            for owner in storage.list_users():
                if owner.id == req.user_id:
                    continue
                if req.contact_owner_id and owner.id != req.contact_owner_id:
                    continue
                perm = storage.find_permission_for_requester(owner.id, req.user_id)
                if not perm or perm.tier not in ("trusted", "smart_scope"):
                    continue
                peer_hits = storage.search_owner_assets(
                    owner_id=owner.id,
                    query=req.query,
                    media_type=req.media_type,
                    limit=req.limit,
                )
                for hit in peer_hits:
                    decision = evaluate_asset_permission(hit.asset, perm, embedder)
                    if decision in ("allow_trusted", "allow_smart_scope"):
                        badge = "Trusted Access" if decision == "allow_trusted" else "Smart Scope"
                        hit.match_reason = f"{owner.display_name}'s Library ({badge}) • {hit.match_reason}"
                        results.append(hit)

        results.sort(key=lambda h: h.score, reverse=True)
        unique: list[SearchHit] = []
        seen_ids: set[str] = set()
        seen_sources: set[str] = set()
        for hit in results:
            source = hit.asset.download_url if hit.asset.download_url != "#" else ""
            if hit.asset.id in seen_ids or (source and source in seen_sources):
                continue
            seen_ids.add(hit.asset.id)
            if source:
                seen_sources.add(source)
            unique.append(hit)
        return unique[: req.limit]

    # ---------- Permissions ----------
    @app.get("/api/permissions/{owner_id}", response_model=list[ContactPermission])
    async def get_permissions(owner_id: str) -> list[ContactPermission]:
        return storage.list_permissions(owner_id)

    @app.post("/api/permissions", response_model=ContactPermission)
    async def set_permission(req: SetPermissionRequest) -> ContactPermission:
        matched_user = storage.get_user(req.contact_user_id or req.contact_handle or req.contact_name)
        perm = ContactPermission(
            id=f"perm_{uuid.uuid4().hex[:10]}",
            owner_id=req.owner_id,
            contact_user_id=matched_user.id if matched_user else req.contact_user_id,
            contact_name=matched_user.display_name if matched_user else req.contact_name,
            contact_handle=matched_user.handle if matched_user else req.contact_handle,
            email=req.email or (matched_user.email if matched_user else ""),
            phone=req.phone or (matched_user.phone if matched_user else ""),
            relationship=req.relationship,
            tier=req.tier,
            excluded_tags=req.excluded_tags,
            smart_scopes=req.smart_scopes,
            updated_at=utc_now_iso(),
        )
        saved = storage.upsert_permission(perm)
        await hub.notify_user(req.owner_id, "permission_updated", saved.model_dump())
        if saved.contact_user_id:
            await hub.notify_user(saved.contact_user_id, "peer_permission_granted", saved.model_dump())
        return saved

    # ---------- Automatic Background Sending (Direct Fyde, Email, iMessage) ----------
    async def _execute_send(req: SendFilesRequest) -> TransferBundle:
        sender = storage.get_user(req.sender_id)
        sender_name = sender.display_name if sender else req.sender_id
        recipient_user = storage.get_user(req.recipient_user_id or req.recipient_name)
        perm = storage.find_permission_for_requester(req.sender_id, req.recipient_user_id or req.recipient_name)

        assets: list[IndexedAsset] = []
        for aid in req.asset_ids:
            a = storage.get_asset(aid)
            if a:
                assets.append(a)
        if not assets:
            raise HTTPException(status_code=400, detail="No valid assets selected to send")

        items = [_asset_to_bundle_item(a) for a in assets]
        bundle_id = f"bundle_{uuid.uuid4().hex[:10]}"
        base_url = os.getenv("FYDE_PUBLIC_URL", "http://127.0.0.1:8765")
        share_link = f"{base_url}/api/bundles/{bundle_id}"
        bundle_title = req.title.strip() or (
            assets[0].title if len(assets) == 1 else f"{assets[0].title} + {len(assets) - 1} more"
        )

        status: str = "delivered"
        detail = ""
        recipient_addr = req.recipient_address.strip()

        if req.channel == "fyde_direct":
            status = "delivered"
            target_label = recipient_user.display_name if recipient_user else req.recipient_name
            detail = f"Delivered directly over Fyde P2P to {target_label}'s Received inbox"
            # Check if recipient opted into auto-saving Trusted contacts' photos directly to Photos!
            if (
                recipient_user
                and recipient_user.auto_save_trusted_to_photos
                and all(i.media_type in ("photo", "video") for i in items)
            ):
                rec_perm = storage.find_permission_for_requester(recipient_user.id, req.sender_id)
                if rec_perm and rec_perm.tier == "trusted":
                    detail += " (Auto-Save to Apple Photos eligible)"

        elif req.channel == "email":
            if not recipient_addr:
                recipient_addr = (
                    (perm.email if perm and perm.email else "")
                    or (recipient_user.email if recipient_user else "")
                    or f"{req.recipient_name.lower().replace(' ', '.')}@example.com"
                )
            attachment_pairs = [(it, storage.get_blob_path(a.blob_id)) for it, a in zip(items, assets)]
            status, detail = send_email_background(
                recipient_email=recipient_addr,
                sender_name=sender_name,
                subject=f"Fyde: {bundle_title}",
                body_text=req.message or f"{sender_name} sent you {len(items)} item(s) via Fyde.",
                attachments=attachment_pairs,
                share_link=share_link,
            )

        elif req.channel == "imessage":
            if not recipient_addr:
                recipient_addr = (
                    (perm.phone if perm and perm.phone else "")
                    or (recipient_user.phone if recipient_user else "")
                    or req.recipient_name
                )
            file_paths = [p for a in assets if (p := storage.get_blob_path(a.blob_id)) is not None]
            mac_node = hub.has_online_mac_bridge(req.sender_id)
            if req.sender_platform == "macos" or mac_node is not None:
                status, detail = send_imessage_via_local_mac(
                    recipient_handle=recipient_addr,
                    message_text=req.message or f"Shared via Fyde: {bundle_title}",
                    file_paths=file_paths,
                    share_link=share_link,
                )
                if mac_node is not None:
                    await hub.notify_user(
                        req.sender_id,
                        "imessage_bridge_job",
                        {
                            "bundle_id": bundle_id,
                            "recipient_handle": recipient_addr,
                            "message": req.message or bundle_title,
                            "items": [i.model_dump() for i in items],
                        },
                    )
            else:
                # iOS standalone without an online Mac node: notify iOS client to present 1-tap MFMessageComposeViewController if needed, while staging the link!
                status, detail = send_imessage_via_local_mac(
                    recipient_handle=recipient_addr,
                    message_text=req.message or f"Shared via Fyde: {bundle_title}",
                    file_paths=file_paths,
                    share_link=share_link,
                )

        bundle = TransferBundle(
            id=bundle_id,
            sender_id=req.sender_id,
            sender_name=sender_name,
            recipient_id=recipient_user.id if recipient_user else req.recipient_user_id,
            recipient_name=recipient_user.display_name if recipient_user else req.recipient_name,
            recipient_address=recipient_addr,
            channel=req.channel,
            title=bundle_title,
            message=req.message,
            items=items,
            origin="pushed",
            status=status,  # type: ignore[arg-type]
            delivery_detail=detail,
            share_link=share_link,
            created_at=utc_now_iso(),
        )
        storage.save_bundle(bundle)
        await hub.notify_user(req.sender_id, "bundle_sent", bundle.model_dump())
        if bundle.recipient_id:
            await hub.notify_user(bundle.recipient_id, "bundle_received", bundle.model_dump())
        return bundle

    @app.post("/api/send", response_model=TransferBundle)
    async def send_files_endpoint(req: SendFilesRequest) -> TransferBundle:
        return await _execute_send(req)

    # ---------- Cross-Peer Pull / Request ("Wife requests from Husband's files") ----------
    async def _execute_peer_pull(req: PeerPullRequest) -> tuple[TransferBundle | None, AccessRequest | None, str]:
        owner = storage.get_user(req.owner_id)
        requester = storage.get_user(req.requester_id)
        if not owner:
            raise HTTPException(status_code=404, detail=f"Contact '{req.owner_id}' not found on Fyde")
        requester_name = requester.display_name if requester else req.requester_id

        # Notify owner's live connected P2P devices that an authenticated query arrived
        await hub.notify_user(
            owner.id,
            "peer_query_incoming",
            {"requester_id": req.requester_id, "requester_name": requester_name, "query": req.query},
        )

        perm = storage.find_permission_for_requester(owner.id, req.requester_id)
        raw_hits = storage.search_owner_assets(owner_id=owner.id, query=req.query, limit=12)

        allowed_hits: list[ tuple[SearchHit, str] ] = []
        ask_owner_hits: list[SearchHit] = []

        for hit in raw_hits:
            decision = evaluate_asset_permission(hit.asset, perm, embedder)
            if decision in ("allow_trusted", "allow_smart_scope"):
                allowed_hits.append((hit, decision))
            elif decision == "ask_owner":
                ask_owner_hits.append(hit)

        if allowed_hits:
            used_smart = any(d == "allow_smart_scope" for _, d in allowed_hits)
            origin = "pulled_by_smart_scope" if used_smart else "pulled_by_trusted"
            items = [_asset_to_bundle_item(h.asset, h.matched_moment_sec) for h, _ in allowed_hits]
            bundle_id = f"bundle_{uuid.uuid4().hex[:10]}"
            base_url = os.getenv("FYDE_PUBLIC_URL", "http://127.0.0.1:8765")
            title = (
                f"{owner.display_name}: {allowed_hits[0][0].asset.title}"
                if len(items) == 1
                else f"From {owner.display_name}: {req.query.title()} ({len(items)} items)"
            )
            bundle = TransferBundle(
                id=bundle_id,
                sender_id=owner.id,
                sender_name=owner.display_name,
                recipient_id=requester.id if requester else req.requester_id,
                recipient_name=requester_name,
                channel="fyde_direct",
                title=title,
                message=f"Auto-retrieved via {'Smart Scope' if used_smart else 'Trusted Access'} for query: \"{req.query}\"",
                items=items,
                origin=origin,  # type: ignore[arg-type]
                status="delivered",
                delivery_detail=f"Pulled {len(items)} permitted item(s) from {owner.display_name}'s library into Received",
                share_link=f"{base_url}/api/bundles/{bundle_id}",
                created_at=utc_now_iso(),
            )
            storage.save_bundle(bundle)
            await hub.notify_user(bundle.recipient_id or req.requester_id, "bundle_received", bundle.model_dump())
            await hub.notify_user(owner.id, "peer_pull_audit", bundle.model_dump())
            return bundle, None, bundle.delivery_detail

        if ask_owner_hits or (perm is None or perm.tier in ("ask_first", "smart_scope", "send_only")):
            # Do NOT expose filenames/previews to the requester; store previews ONLY for the owner's approval card!
            owner_previews = [_asset_to_bundle_item(h.asset, h.matched_moment_sec) for h in ask_owner_hits]
            access_req = AccessRequest(
                id=f"req_{uuid.uuid4().hex[:10]}",
                requester_id=requester.id if requester else req.requester_id,
                requester_name=requester_name,
                owner_id=owner.id,
                owner_name=owner.display_name,
                query=req.query,
                matched_asset_ids=[h.asset.id for h in ask_owner_hits],
                matched_previews=owner_previews,
                status="pending",
                created_at=utc_now_iso(),
            )
            storage.save_access_request(access_req)
            await hub.notify_user(owner.id, "access_request_created", access_req.model_dump())
            return (
                None,
                access_req,
                f"Sent an access request to {owner.display_name} for \"{req.query}\". Once they tap Approve, it will appear in your Received tab.",
            )

        return None, None, f"No matching accessible files found in {owner.display_name}'s library for \"{req.query}\"."

    @app.post("/api/peer/pull")
    async def peer_pull_endpoint(req: PeerPullRequest) -> dict[str, Any]:
        bundle, access_req, msg = await _execute_peer_pull(req)
        return {
            "message": msg,
            "bundle": bundle.model_dump() if bundle else None,
            "access_request": (
                # Redact private previews from requester response!
                access_req.model_copy(update={"matched_previews": [], "matched_asset_ids": []}).model_dump()
                if access_req
                else None
            ),
        }

    # ---------- Received Tab, Access Request Approvals & Bundle Acceptance ----------
    @app.get("/api/received/{user_id}")
    async def get_received_inbox(user_id: str) -> dict[str, Any]:
        return {
            "bundles": [b.model_dump() for b in storage.list_received_bundles(user_id)],
            "sent_bundles": [b.model_dump() for b in storage.list_sent_bundles(user_id)],
            "incoming_requests": [r.model_dump() for r in storage.list_incoming_access_requests(user_id)],
        }

    @app.get("/api/bundles/{bundle_id}", response_model=TransferBundle)
    async def get_bundle(bundle_id: str) -> TransferBundle:
        b = storage.get_bundle(bundle_id)
        if not b:
            raise HTTPException(status_code=404, detail="Bundle not found")
        return b

    @app.post("/api/requests/{request_id}/resolve")
    async def resolve_access_request(request_id: str, payload: ResolveAccessRequestPayload) -> dict[str, Any]:
        access_req = storage.get_access_request(request_id)
        if not access_req:
            raise HTTPException(status_code=404, detail="Access request not found")
        if access_req.owner_id != payload.owner_id:
            raise HTTPException(status_code=403, detail="Only the file owner can resolve this request")

        if payload.decision == "deny":
            access_req.status = "denied"
            storage.save_access_request(access_req)
            await hub.notify_user(access_req.requester_id, "access_request_resolved", {"id": access_req.id, "status": "denied"})
            return {"access_request": access_req.model_dump(), "bundle": None}

        access_req.status = "approved"
        bundle: TransferBundle | None = None
        if access_req.matched_asset_ids:
            bundle = await _execute_send(
                SendFilesRequest(
                    sender_id=access_req.owner_id,
                    asset_ids=access_req.matched_asset_ids,
                    recipient_name=access_req.requester_name,
                    recipient_user_id=access_req.requester_id,
                    channel="fyde_direct",
                    title=f"Approved: {access_req.query}",
                    message=f"Approved your request for \"{access_req.query}\"",
                )
            )
            bundle.origin = "approved_request"
            storage.save_bundle(bundle)
            access_req.bundle_id = bundle.id
        storage.save_access_request(access_req)
        await hub.notify_user(access_req.requester_id, "access_request_resolved", {"id": access_req.id, "status": "approved", "bundle": bundle.model_dump() if bundle else None})
        return {"access_request": access_req.model_dump(), "bundle": bundle.model_dump() if bundle else None}

    async def _accept_bundle_into_library(bundle: TransferBundle, req: AcceptBundleRequest) -> TransferBundle:
        dest_label = (
            f"Apple Photos → Album '{req.album_or_folder or bundle.title}'"
            if req.destination_type == "photos"
            else f"Files → {req.album_or_folder or 'Received/' + bundle.title}"
        )
        bundle.status = "accepted_photos" if req.destination_type == "photos" else "accepted_files"
        bundle.accepted_destination = dest_label
        storage.save_bundle(bundle)

        # Also index accepted items into the recipient's own searchable Fyde library!
        recipient = storage.get_user(req.user_id)
        for item in bundle.items:
            orig = storage.get_asset(item.asset_id)
            if orig:
                cloned = orig.model_copy(
                    update={
                        "id": f"asset_{uuid.uuid4().hex[:10]}",
                        "owner_id": req.user_id,
                        "owner_name": recipient.display_name if recipient else req.user_id,
                        "folder_path": dest_label,
                        "created_at": utc_now_iso(),
                    }
                )
                storage.upsert_asset(cloned)

        await hub.notify_user(req.user_id, "bundle_accepted", bundle.model_dump())
        return bundle

    @app.post("/api/bundles/{bundle_id}/accept", response_model=TransferBundle)
    async def accept_bundle_endpoint(bundle_id: str, req: AcceptBundleRequest) -> TransferBundle:
        bundle = storage.get_bundle(bundle_id)
        if not bundle:
            raise HTTPException(status_code=404, detail="Bundle not found")
        return await _accept_bundle_into_library(bundle, req)

    # ---------- Middle Tab (Landing): Conversational Fyde Chat ----------
    @app.get("/api/chat/{user_id}", response_model=list[ChatMessage])
    async def get_chat_history(user_id: str) -> list[ChatMessage]:
        return storage.list_chat_messages(user_id)

    @app.post("/api/chat", response_model=ChatMessage)
    async def post_chat_turn(req: ChatTurnRequest) -> ChatMessage:
        user = storage.get_user(req.user_id) or UserProfile(
            id=req.user_id, handle=req.user_id, display_name=req.user_id.title()
        )
        user_msg = ChatMessage(
            id=f"msg_{uuid.uuid4().hex[:10]}",
            user_id=user.id,
            role="user",
            text=req.text,
            created_at=utc_now_iso(),
        )
        storage.append_chat_message(user_msg)

        # Gather known contacts + all users for natural language contact resolution
        perms = storage.list_permissions(user.id)
        known_contacts: list[dict[str, str]] = [
            {
                "name": p.contact_name,
                "handle": p.contact_handle or "",
                "relationship": p.relationship,
                "email": p.email,
            }
            for p in perms
        ]
        for u in storage.list_users():
            if u.id != user.id and not any(c["handle"] == u.handle for c in known_contacts):
                known_contacts.append({"name": u.display_name, "handle": u.handle, "relationship": "", "email": u.email})

        parsed = parse_chat_intent(req.text, user, known_contacts)
        reply_text = ""
        card: ChatActionCard | None = None

        if parsed.intent == "set_permission":
            scopes: list[SmartScopeRule] = []
            if parsed.permission_tier == "smart_scope":
                label_parts: list[str] = []
                if parsed.locations:
                    label_parts.append(f"in {', '.join(parsed.locations)}")
                if parsed.media_types:
                    label_parts.append("/".join(parsed.media_types))
                if parsed.people_filter:
                    label_parts.append(f"with {', '.join(parsed.people_filter)}")
                if parsed.query:
                    label_parts.append(f"matching '{parsed.query}'")
                scopes.append(
                    SmartScopeRule(
                        id=f"scope_{uuid.uuid4().hex[:8]}",
                        label="Smart Scope: " + (" ".join(label_parts) or "Selected topic"),
                        locations=parsed.locations,
                        people=parsed.people_filter,
                        media_types=parsed.media_types,
                        semantic_query=parsed.query or None,
                    )
                )
            saved_perm = await set_permission(
                SetPermissionRequest(
                    owner_id=user.id,
                    contact_name=parsed.target_person,
                    tier=parsed.permission_tier,  # type: ignore[arg-type]
                    smart_scopes=scopes,
                )
            )
            if saved_perm.tier == "trusted":
                reply_text = (
                    f"Updated **{saved_perm.contact_name}** to **Trusted (Full Access)**. "
                    f"They can now ask their own Fyde Chat for any of your non-private files, photos, or videos automatically."
                )
            elif saved_perm.tier == "smart_scope":
                rule_desc = saved_perm.smart_scopes[0].label if saved_perm.smart_scopes else "Smart Scope"
                reply_text = (
                    f"Updated **{saved_perm.contact_name}** to **Flexible Smart Scope** ({rule_desc}) — "
                    "no manual folder organization required."
                )
            else:
                reply_text = f"Updated **{saved_perm.contact_name}**'s permission tier to **{saved_perm.tier}**."

            card = ChatActionCard(
                action_type="permission_updated",
                summary=reply_text,
                recipient_name=saved_perm.contact_name,
                permission=saved_perm,
            )

        elif parsed.intent == "peer_pull":
            target_owner = storage.get_user(parsed.target_person)
            if not target_owner:
                # Resolve via relationship (e.g., "my husband" or "my wife")
                rel_perm = storage.find_permission_for_requester(user.id, parsed.target_person)
                if rel_perm and rel_perm.contact_user_id:
                    target_owner = storage.get_user(rel_perm.contact_user_id)
            if not target_owner:
                reply_text = f"I couldn't find a connected Fyde user matching '{parsed.target_person}'."
            else:
                bundle, access_req, detail = await _execute_peer_pull(
                    PeerPullRequest(requester_id=user.id, owner_id=target_owner.id, query=parsed.query)
                )
                reply_text = detail
                if bundle:
                    card = ChatActionCard(
                        action_type="peer_pull_completed",
                        summary=detail,
                        recipient_name=target_owner.display_name,
                        previews=bundle.items,
                        bundle=bundle,
                    )
                elif access_req:
                    redacted = access_req.model_copy(update={"matched_previews": [], "matched_asset_ids": []})
                    card = ChatActionCard(
                        action_type="peer_request_pending",
                        summary=detail,
                        recipient_name=target_owner.display_name,
                        access_request=redacted,
                    )

        elif parsed.intent == "accept_bundle":
            inbox = storage.list_received_bundles(user.id)
            pending = [b for b in inbox if b.status == "delivered"] or inbox
            chosen: TransferBundle | None = None
            ql = req.text.lower()
            for b in pending:
                if (
                    (parsed.target_person and parsed.target_person.lower() in b.sender_name.lower())
                    or any(tok in b.title.lower() for tok in ql.split() if len(tok) > 3)
                ):
                    chosen = b
                    break
            if not chosen and pending:
                chosen = pending[0]

            if not chosen:
                reply_text = "You don't have any received bundles waiting in your Received tab yet."
            else:
                accepted = await _accept_bundle_into_library(
                    chosen,
                    AcceptBundleRequest(
                        user_id=user.id,
                        destination_type=parsed.destination_type,  # type: ignore[arg-type]
                        album_or_folder=parsed.album_or_folder,
                    ),
                )
                reply_text = (
                    f"Accepted **{accepted.title}** ({len(accepted.items)} item(s)) into **{accepted.accepted_destination}** "
                    "and indexed it into your Fyde library."
                )
                card = ChatActionCard(
                    action_type="bundle_accepted",
                    summary=reply_text,
                    bundle=accepted,
                    previews=accepted.items,
                )

        elif parsed.intent == "send":
            hits = storage.search_owner_assets(owner_id=user.id, query=parsed.query, limit=6)
            if not hits:
                reply_text = f"I couldn't find any files, photos, or videos in your library matching \"{parsed.query}\"."
            else:
                selected_ids = [h.asset.id for h in hits]
                previews = [_asset_to_bundle_item(h.asset, h.matched_moment_sec) for h in hits]
                if req.auto_send:
                    bundle = await _execute_send(
                        SendFilesRequest(
                            sender_id=user.id,
                            asset_ids=selected_ids,
                            recipient_name=parsed.target_person,
                            channel=parsed.channel,
                            message=f"Sent via Fyde Chat: {parsed.query}",
                            sender_platform=req.platform,
                        )
                    )
                    channel_label = {
                        "fyde_direct": "Direct over Fyde",
                        "imessage": "iMessage",
                        "email": "Email",
                    }[bundle.channel]
                    reply_text = (
                        f"Sent **{len(bundle.items)} item(s)** to **{bundle.recipient_name}** via **{channel_label}** "
                        f"automatically in the background.\n\n_{bundle.delivery_detail}_"
                    )
                    card = ChatActionCard(
                        action_type="send_completed",
                        summary=reply_text,
                        channel=bundle.channel,
                        recipient_name=bundle.recipient_name,
                        asset_ids=selected_ids,
                        previews=bundle.items,
                        bundle=bundle,
                    )
                else:
                    reply_text = (
                        f"Ready to send **{len(previews)} item(s)** to **{parsed.target_person}** via **{parsed.channel}**."
                    )
                    card = ChatActionCard(
                        action_type="send_confirmation",
                        summary=reply_text,
                        channel=parsed.channel,
                        recipient_name=parsed.target_person,
                        asset_ids=selected_ids,
                        previews=previews,
                        requires_confirmation=True,
                    )

        else:
            # Multimodal Search inside Chat
            hits = await multimodal_search(SearchRequest(user_id=user.id, query=parsed.query, scope="all", limit=6))
            if not hits:
                reply_text = f"No files, photos, or videos matched \"{parsed.query}\"."
            else:
                previews = [_asset_to_bundle_item(h.asset, h.matched_moment_sec) for h in hits]
                lines = [f"Found **{len(hits)}** multimodal match(es) for \"{parsed.query}\":"]
                for h in hits[:4]:
                    ts_note = f" *(video moment @ {h.matched_moment_sec:.1f}s: {h.matched_moment_label})*" if h.matched_moment_sec is not None else ""
                    lines.append(f"- **{h.asset.title}** ({h.asset.media_type}, owner: {h.asset.owner_name}){ts_note}")
                reply_text = "\n".join(lines)
                card = ChatActionCard(
                    action_type="search_results",
                    summary=f"{len(hits)} matches",
                    asset_ids=[h.asset.id for h in hits],
                    previews=previews,
                )

        assistant_msg = ChatMessage(
            id=f"msg_{uuid.uuid4().hex[:10]}",
            user_id=user.id,
            role="assistant",
            text=reply_text,
            action_card=card,
            created_at=utc_now_iso(),
        )
        storage.append_chat_message(assistant_msg)
        await hub.notify_user(user.id, "chat_message", assistant_msg.model_dump())
        return assistant_msg

    # ---------- Real-Time P2P WebSocket Endpoint ----------
    @app.websocket("/ws/{user_id}")
    async def websocket_peer_endpoint(
        websocket: WebSocket,
        user_id: str,
        device_id: str = "dev_default",
        platform: PlatformType = "ios",
        device_name: str = "Fyde Device",
    ) -> None:
        caps: list[str] = ["local_index"]
        if platform == "macos":
            caps.append("imessage_bridge")
        if platform in ("ios", "macos"):
            caps.append("photokit")

        node = DeviceNode(
            device_id=device_id,
            user_id=user_id,
            platform=platform,
            device_name=device_name,
            capabilities=caps,
        )
        await hub.register(websocket, node)
        try:
            await websocket.send_json(
                {
                    "event": "connected",
                    "payload": {
                        "device": node.model_dump(),
                        "online_peers": [d.model_dump() for d in hub.list_online_devices()],
                    },
                }
            )
            while True:
                msg = await websocket.receive_json()
                msg_type = msg.get("type")
                if msg_type == "ping":
                    await websocket.send_json({"event": "pong", "payload": {"ts": utc_now_iso()}})
                elif msg_type == "imessage_bridge_ack":
                    bundle_id = msg.get("bundle_id", "")
                    b = storage.get_bundle(bundle_id)
                    if b:
                        b.status = "sent_background"
                        b.delivery_detail = msg.get("detail", "Sent automatically via macOS Messages.app bridge")
                        storage.save_bundle(b)
                        await hub.notify_user(user_id, "bundle_updated", b.model_dump())
        except WebSocketDisconnect:
            hub.unregister(user_id, device_id)
        except Exception:
            hub.unregister(user_id, device_id)

    return app


app = create_app()
