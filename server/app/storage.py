from __future__ import annotations

from datetime import datetime, timezone
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import uuid

from PIL import Image, ImageDraw

from .embedder import MultimodalEmbedder, cosine_similarity
from .models import (
    AccessRequest,
    ChatMessage,
    ContactPermission,
    IndexedAsset,
    MediaType,
    SearchHit,
    SmartScopeRule,
    TransferBundle,
    UserProfile,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _make_minimal_pdf(title: str, body_lines: list[str]) -> bytes:
    """Creates a clean, valid single-page PDF readable by pypdf, Preview, Safari, and iOS PDFKit."""
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    text_ops = ["BT", "/F1 18 Tf", "50 740 Td", f"({esc(title)}) Tj", "/F1 12 Tf"]
    for line in body_lines:
        text_ops.append("0 -24 Td")
        text_ops.append(f"({esc(line)}) Tj")
    text_ops.append("ET")
    stream_bytes = "\n".join(text_ops).encode("latin-1", errors="replace")

    objs: list[bytes] = [
        b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
        b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        f"5 0 obj\n<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
        + stream_bytes
        + b"\nendstream\nendobj\n",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for obj in objs:
        offsets.append(len(out))
        out.extend(obj)
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for off in offsets:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))
    out.extend(
        f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
    )
    return bytes(out)


def _make_sample_jpeg(
    top_rgb: tuple[int, int, int],
    bottom_rgb: tuple[int, int, int],
    headline: str,
    subline: str,
) -> bytes:
    w, h = 800, 600
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top_rgb[0] * (1 - t) + bottom_rgb[0] * t)
        g = int(top_rgb[1] * (1 - t) + bottom_rgb[1] * t)
        b = int(top_rgb[2] * (1 - t) + bottom_rgb[2] * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    # Decorative sun/circle + card banner
    draw.ellipse([(580, 70), (700, 190)], fill=(255, 240, 200))
    draw.rectangle([(40, 440), (760, 560)], fill=(20, 24, 36))
    draw.text((64, 468), headline, fill=(255, 255, 255))
    draw.text((64, 508), subline, fill=(190, 205, 235))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def _make_sample_mp4(target_path: Path, color_hex: str = "0x1E88E5") -> bool:
    """Generates a real playable H.264 MP4 video using ffmpeg if installed."""
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color_hex}:s=640x360:d=4:r=15",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(target_path),
        ]
        res = subprocess.run(cmd, capture_output=True, timeout=10)
        return res.returncode == 0 and target_path.exists() and target_path.stat().st_size > 0
    except Exception:
        return False


class FydeStorage:
    def __init__(self, data_dir: Path, embedder: MultimodalEmbedder) -> None:
        self.data_dir = data_dir
        self.blobs_dir = data_dir / "blobs"
        self.db_path = data_dir / "fyde.db"
        self.embedder = embedder

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.blobs_dir.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._conn() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS permissions (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    contact_user_id TEXT,
                    contact_name_lower TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bundles (
                    id TEXT PRIMARY KEY,
                    sender_id TEXT NOT NULL,
                    recipient_id TEXT,
                    created_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS access_requests (
                    id TEXT PRIMARY KEY,
                    requester_id TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                """
            )

    # ---------- Users ----------
    def upsert_user(self, user: UserProfile) -> UserProfile:
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO users (id, data) VALUES (?, ?)",
                (user.id, user.model_dump_json()),
            )
        return user

    def get_user(self, user_id_or_handle: str) -> UserProfile | None:
        key = user_id_or_handle.strip().lower().lstrip("@")
        with self._conn() as conn:
            row = conn.execute("SELECT data FROM users WHERE id = ?", (user_id_or_handle,)).fetchone()
            if row:
                return UserProfile.model_validate_json(row["data"])
            for r in conn.execute("SELECT data FROM users").fetchall():
                u = UserProfile.model_validate_json(r["data"])
                if u.handle.lower() == key or u.display_name.lower() == key:
                    return u
        return None

    def list_users(self) -> list[UserProfile]:
        with self._conn() as conn:
            rows = conn.execute("SELECT data FROM users").fetchall()
        return [UserProfile.model_validate_json(r["data"]) for r in rows]

    # ---------- Permissions ----------
    def upsert_permission(self, perm: ContactPermission) -> ContactPermission:
        if not perm.updated_at:
            perm.updated_at = utc_now_iso()
        with self._conn() as conn:
            # Check existing by owner_id + contact_name_lower or contact_user_id
            existing = None
            if perm.contact_user_id:
                existing = conn.execute(
                    "SELECT id FROM permissions WHERE owner_id = ? AND contact_user_id = ?",
                    (perm.owner_id, perm.contact_user_id),
                ).fetchone()
            if not existing:
                existing = conn.execute(
                    "SELECT id FROM permissions WHERE owner_id = ? AND contact_name_lower = ?",
                    (perm.owner_id, perm.contact_name.lower()),
                ).fetchone()
            if existing:
                perm.id = existing["id"]
            conn.execute(
                """
                INSERT OR REPLACE INTO permissions
                (id, owner_id, contact_user_id, contact_name_lower, data)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    perm.id,
                    perm.owner_id,
                    perm.contact_user_id,
                    perm.contact_name.lower(),
                    perm.model_dump_json(),
                ),
            )
        return perm

    def list_permissions(self, owner_id: str) -> list[ContactPermission]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT data FROM permissions WHERE owner_id = ?",
                (owner_id,),
            ).fetchall()
        return [ContactPermission.model_validate_json(r["data"]) for r in rows]

    def find_permission_for_requester(self, owner_id: str, requester_id_or_name: str) -> ContactPermission | None:
        requester_user = self.get_user(requester_id_or_name)
        perms = self.list_permissions(owner_id)
        target_lower = requester_id_or_name.strip().lower().lstrip("@")
        for p in perms:
            if requester_user and p.contact_user_id == requester_user.id:
                return p
            if p.contact_handle and p.contact_handle.lower().lstrip("@") == target_lower:
                return p
            if p.contact_name.lower() == target_lower:
                return p
            if p.relationship and p.relationship.lower() == target_lower:
                return p
            if requester_user and p.contact_name.lower() == requester_user.display_name.lower():
                return p
        return None

    # ---------- Blobs & Assets ----------
    def save_blob(self, raw_bytes: bytes, ext: str = "") -> tuple[str, Path]:
        blob_id = f"blob_{uuid.uuid4().hex[:12]}{ext}"
        path = self.blobs_dir / blob_id
        path.write_bytes(raw_bytes)
        return blob_id, path

    def get_blob_path(self, blob_id: str | None) -> Path | None:
        if not blob_id:
            return None
        safe_name = Path(blob_id).name
        p = self.blobs_dir / safe_name
        return p if p.exists() else None

    def upsert_asset(self, asset: IndexedAsset) -> IndexedAsset:
        if not asset.download_url and asset.blob_id:
            asset.download_url = f"/api/blobs/{asset.blob_id}"
        if not asset.thumbnail_url and asset.media_type == "photo" and asset.blob_id:
            asset.thumbnail_url = f"/api/blobs/{asset.blob_id}"
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO assets (id, owner_id, media_type, created_at, data) VALUES (?, ?, ?, ?, ?)",
                (asset.id, asset.owner_id, asset.media_type, asset.created_at, asset.model_dump_json()),
            )
        return asset

    def get_asset(self, asset_id: str) -> IndexedAsset | None:
        with self._conn() as conn:
            row = conn.execute("SELECT data FROM assets WHERE id = ?", (asset_id,)).fetchone()
        return IndexedAsset.model_validate_json(row["data"]) if row else None

    def list_assets(self, owner_id: str, media_type: MediaType | None = None) -> list[IndexedAsset]:
        with self._conn() as conn:
            if media_type:
                rows = conn.execute(
                    "SELECT data FROM assets WHERE owner_id = ? AND media_type = ? ORDER BY created_at DESC",
                    (owner_id, media_type),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT data FROM assets WHERE owner_id = ? ORDER BY created_at DESC",
                    (owner_id,),
                ).fetchall()
        return [IndexedAsset.model_validate_json(r["data"]) for r in rows]

    def search_owner_assets(
        self,
        owner_id: str,
        query: str,
        media_type: MediaType | None = None,
        limit: int = 20,
    ) -> list[SearchHit]:
        assets = self.list_assets(owner_id=owner_id, media_type=media_type)
        return self._rank_assets(assets, query, limit)

    def search_library(
        self,
        user_id: str,
        query: str,
        media_type: MediaType | None = None,
        limit: int = 20,
        *,
        include_own: bool = True,
        include_received: bool = True,
        contact_owner_id: str | None = None,
    ) -> list[SearchHit]:
        assets = self.list_assets(owner_id=user_id, media_type=media_type) if include_own else []
        seen = {asset.id for asset in assets}
        own_sources = {asset.download_url for asset in assets if asset.download_url and asset.download_url != "#"}
        received_at: dict[str, str] = {}
        if include_received:
            # Bundles are newest first, so a repeated delivery contributes one result.
            for bundle in self.list_received_bundles(user_id):
                if bundle.sender_id == user_id:
                    continue
                if contact_owner_id and bundle.sender_id != contact_owner_id:
                    continue
                for item in bundle.items:
                    if (item.asset_id in seen or item.download_url in own_sources
                            or (media_type and item.media_type != media_type)):
                        continue
                    seen.add(item.asset_id)
                    folder = bundle.accepted_destination or f"Received/{bundle.title}"
                    original = self.get_asset(item.asset_id)
                    if original:
                        asset = original.model_copy(update={
                            "owner_name": bundle.sender_name or original.owner_name,
                            "folder_path": folder,
                        })
                    else:
                        asset = IndexedAsset(
                            id=item.asset_id,
                            owner_id=bundle.sender_id,
                            owner_name=bundle.sender_name,
                            filename=item.filename,
                            title=item.title,
                            media_type=item.media_type,
                            mime_type=item.mime_type,
                            size_bytes=item.size_bytes,
                            created_at=bundle.created_at,
                            location=item.location,
                            people=item.people,
                            folder_path=folder,
                            summary=bundle.message,
                            download_url=item.download_url,
                            thumbnail_url=item.thumbnail_url,
                        )
                    assets.append(asset)
                    received_at[asset.id] = bundle.created_at

        if not query.strip():
            assets.sort(key=lambda asset: received_at.get(asset.id, asset.created_at), reverse=True)
        hits = self._rank_assets(assets, query, limit)
        for hit in hits:
            if hit.asset.id in received_at:
                sender = f"Received from {hit.asset.owner_name}"
                hit.match_reason = sender if hit.match_reason == "Recent item" else f"{sender} • {hit.match_reason}"
        return hits

    def _rank_assets(self, assets: list[IndexedAsset], query: str, limit: int) -> list[SearchHit]:
        q_clean = query.strip()
        if not q_clean:
            return [SearchHit(asset=a, score=1.0, match_reason="Recent item") for a in assets[:limit]]

        q_vec = self.embedder.embed_query(q_clean)
        q_lower = q_clean.lower()
        stop_words = {
            "the", "and", "for", "with", "from", "all", "my", "our", "your", "his", "her",
            "files", "file", "photos", "photo", "pictures", "picture", "videos", "video",
            "documents", "docs", "send", "get", "find", "show", "me", "in", "of", "to", "a", "an",
        }
        q_tokens = [w for w in q_lower.replace(",", " ").split() if len(w) > 1 and w not in stop_words]

        hits: list[SearchHit] = []
        for asset in assets:
            base_sim = cosine_similarity(q_vec, asset.embedding)

            # Check video moments for frame/timestamp hits!
            best_moment_sec: float | None = None
            best_moment_label: str | None = None
            best_moment_sim = -1.0
            for m in asset.video_moments:
                m_sim = cosine_similarity(q_vec, m.embedding)
                if any(tok in m.label.lower() for tok in q_tokens):
                    m_sim += 0.22
                if m_sim > best_moment_sim:
                    best_moment_sim = m_sim
                    best_moment_sec = m.timestamp_sec
                    best_moment_label = m.label

            haystack = " ".join(
                [
                    asset.title,
                    asset.filename,
                    asset.location,
                    " ".join(asset.people),
                    " ".join(asset.tags),
                    asset.ocr_text,
                    asset.summary,
                    " ".join(m.label for m in asset.video_moments),
                ]
            ).lower()

            lexical_boost = 0.0
            matched_terms: list[str] = []
            for tok in q_tokens:
                if tok in haystack:
                    lexical_boost += 0.18
                    matched_terms.append(tok)

            score = max(base_sim, best_moment_sim) + min(0.45, lexical_boost)
            if score < 0.16 and not matched_terms:
                continue

            reason_parts: list[str] = []
            if matched_terms:
                reason_parts.append(f"Matched {', '.join(matched_terms[:3])}")
            else:
                reason_parts.append("Multimodal vector similarity")
            if asset.location and any(t in asset.location.lower() for t in q_tokens):
                reason_parts.append(f"Location: {asset.location}")
            if best_moment_sec is not None and best_moment_sim >= 0.18:
                reason_parts.append(f"Video moment @ {best_moment_sec:.1f}s")
            else:
                best_moment_sec = None
                best_moment_label = None

            hits.append(
                SearchHit(
                    asset=asset,
                    score=round(min(0.99, score), 4),
                    matched_moment_sec=best_moment_sec,
                    matched_moment_label=best_moment_label,
                    match_reason=" • ".join(reason_parts),
                )
            )

        hits.sort(key=lambda h: h.score, reverse=True)
        return hits[:limit]

    # ---------- Bundles ----------
    def save_bundle(self, bundle: TransferBundle) -> TransferBundle:
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO bundles (id, sender_id, recipient_id, created_at, data) VALUES (?, ?, ?, ?, ?)",
                (bundle.id, bundle.sender_id, bundle.recipient_id, bundle.created_at, bundle.model_dump_json()),
            )
        return bundle

    def get_bundle(self, bundle_id: str) -> TransferBundle | None:
        with self._conn() as conn:
            row = conn.execute("SELECT data FROM bundles WHERE id = ?", (bundle_id,)).fetchone()
        return TransferBundle.model_validate_json(row["data"]) if row else None

    def list_received_bundles(self, user_id: str) -> list[TransferBundle]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT data FROM bundles WHERE recipient_id = ? ORDER BY created_at DESC, rowid DESC",
                (user_id,),
            ).fetchall()
        return [TransferBundle.model_validate_json(r["data"]) for r in rows]

    def list_sent_bundles(self, user_id: str) -> list[TransferBundle]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT data FROM bundles WHERE sender_id = ? ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
        return [TransferBundle.model_validate_json(r["data"]) for r in rows]

    # ---------- Access Requests ----------
    def save_access_request(self, req: AccessRequest) -> AccessRequest:
        with self._conn() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO access_requests
                (id, requester_id, owner_id, status, created_at, data)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (req.id, req.requester_id, req.owner_id, req.status, req.created_at, req.model_dump_json()),
            )
        return req

    def get_access_request(self, req_id: str) -> AccessRequest | None:
        with self._conn() as conn:
            row = conn.execute("SELECT data FROM access_requests WHERE id = ?", (req_id,)).fetchone()
        return AccessRequest.model_validate_json(row["data"]) if row else None

    def list_incoming_access_requests(self, owner_id: str) -> list[AccessRequest]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT data FROM access_requests WHERE owner_id = ? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
        return [AccessRequest.model_validate_json(r["data"]) for r in rows]

    # ---------- Chat History ----------
    def append_chat_message(self, msg: ChatMessage) -> ChatMessage:
        with self._conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO chat_messages (id, user_id, created_at, data) VALUES (?, ?, ?, ?)",
                (msg.id, msg.user_id, msg.created_at, msg.model_dump_json()),
            )
        return msg

    def list_chat_messages(self, user_id: str, limit: int = 80) -> list[ChatMessage]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT data FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT ?",
                (user_id, limit),
            ).fetchall()
        return [ChatMessage.model_validate_json(r["data"]) for r in rows]

    # ---------- Initial Demo Seed ----------
    def seed_if_empty(self) -> None:
        if self.list_users():
            return

        users = [
            UserProfile(
                id="mehmet",
                handle="mehmet",
                display_name="Mehmet",
                email="mehmet@fyde.local",
                phone="+14155550101",
                avatar_color="#4F46E5",
                auto_save_trusted_to_photos=True,
            ),
            UserProfile(
                id="maya",
                handle="maya",
                display_name="Maya",
                email="maya@fyde.local",
                phone="+14155550102",
                avatar_color="#EC4899",
                auto_save_trusted_to_photos=True,
            ),
            UserProfile(
                id="alex",
                handle="alex",
                display_name="Alex",
                email="alex@fyde.local",
                phone="+14155550103",
                avatar_color="#0EA5E9",
                auto_save_trusted_to_photos=False,
            ),
            UserProfile(
                id="sarah",
                handle="sarah",
                display_name="Sarah",
                email="sarah@taxfirm.local",
                phone="+14155550104",
                avatar_color="#10B981",
                auto_save_trusted_to_photos=False,
            ),
        ]
        for u in users:
            self.upsert_user(u)

        # Default permissions demonstrating Trusted (Wife), Folderless Smart Scope (Alex), and Ask-First (Sarah)
        self.upsert_permission(
            ContactPermission(
                id="perm_mehmet_maya",
                owner_id="mehmet",
                contact_user_id="maya",
                contact_name="Maya",
                contact_handle="maya",
                email="maya@fyde.local",
                phone="+14155550102",
                relationship="Wife",
                tier="trusted",
                excluded_tags=["private", "hidden"],
            )
        )
        self.upsert_permission(
            ContactPermission(
                id="perm_maya_mehmet",
                owner_id="maya",
                contact_user_id="mehmet",
                contact_name="Mehmet",
                contact_handle="mehmet",
                email="mehmet@fyde.local",
                phone="+14155550101",
                relationship="Husband",
                tier="trusted",
                excluded_tags=["private", "hidden"],
            )
        )
        self.upsert_permission(
            ContactPermission(
                id="perm_mehmet_alex",
                owner_id="mehmet",
                contact_user_id="alex",
                contact_name="Alex",
                contact_handle="alex",
                email="alex@fyde.local",
                phone="+14155550103",
                relationship="Friend",
                tier="smart_scope",
                smart_scopes=[
                    SmartScopeRule(
                        id="scope_china_alex",
                        label="All China trip photos & videos with Alex (no folder required)",
                        locations=["China", "Shanghai", "Beijing", "Hangzhou"],
                        people=["Alex"],
                        media_types=["photo", "video"],
                        semantic_query="China trip",
                    )
                ],
            )
        )
        self.upsert_permission(
            ContactPermission(
                id="perm_mehmet_sarah",
                owner_id="mehmet",
                contact_user_id="sarah",
                contact_name="Sarah",
                contact_handle="sarah",
                email="sarah@taxfirm.local",
                phone="+14155550104",
                relationship="Accountant",
                tier="ask_first",
            )
        )

        # Seed real JPEG, MP4, and PDF files on disk + compute multimodal 256-D vectors
        self._seed_photo(
            asset_id="asset_china_wall_maya",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="IMG_8412_Great_Wall_Sunset.jpg",
            title="Great Wall Sunset Selfie",
            location="Beijing, China",
            people=["Maya", "Mehmet"],
            tags=["china", "trip", "sunset", "great wall", "photos"],
            summary="Golden hour photo on the Mutianyu Great Wall during our China trip with Maya.",
            top_rgb=(215, 92, 54),
            bottom_rgb=(88, 42, 72),
            created_at="2026-05-14T10:30:00+00:00",
        )
        self._seed_photo(
            asset_id="asset_shanghai_bund_group",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="IMG_8490_Shanghai_Bund_Night.jpg",
            title="Shanghai Bund Skyline Dinner",
            location="Shanghai, China",
            people=["Maya", "Alex", "Mehmet"],
            tags=["china", "trip", "shanghai", "skyline", "dinner", "photos"],
            summary="Group photo overlooking the Bund skyline in Shanghai with Maya and Alex.",
            top_rgb=(198, 72, 92),
            bottom_rgb=(24, 34, 78),
            created_at="2026-05-17T13:15:00+00:00",
        )
        self._seed_photo(
            asset_id="asset_hangzhou_temple_alex",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="IMG_8521_Hangzhou_West_Lake.jpg",
            title="West Lake Pagoda Walk",
            location="Hangzhou, China",
            people=["Alex", "Mehmet"],
            tags=["china", "trip", "hangzhou", "temple", "pagoda", "photos"],
            summary="Walking by West Lake pagoda in China with Alex.",
            top_rgb=(210, 120, 68),
            bottom_rgb=(42, 85, 76),
            created_at="2026-05-19T08:00:00+00:00",
        )
        self._seed_video(
            asset_id="asset_surfing_pacifica",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="VID_9014_Pacifica_Surfing.mp4",
            title="Surfing Waves at Pacifica Beach",
            location="Pacifica, California",
            people=["Mehmet", "Maya"],
            tags=["beach", "surfing", "ocean", "waves", "summer"],
            summary="Action clip catching waves at Pacifica Beach at sunset.",
            color_hex="0x0284C7",
            moments=[
                (0.8, "Paddling out through ocean surf"),
                (2.2, "Standing up on surfboard riding a clean wave"),
                (3.5, "Waving toward the beach camera at sunset"),
            ],
            created_at="2026-08-22T01:10:00+00:00",
        )
        self._seed_video(
            asset_id="asset_china_train_video",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="VID_8502_Bullet_Train_Shanghai.mp4",
            title="Bullet Train to Shanghai",
            location="Shanghai, China",
            people=["Maya", "Mehmet"],
            tags=["china", "trip", "train", "travel", "video"],
            summary="High-speed rail ride arriving into Shanghai station with Maya.",
            color_hex="0x7C3AED",
            moments=[
                (0.9, "Speedometer showing 350 km/h inside cabin"),
                (2.6, "Maya pointing at Shanghai skyline out the window"),
            ],
            created_at="2026-05-16T06:45:00+00:00",
        )
        self._seed_pdf(
            asset_id="asset_passports_2026",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="Family_Passports_Scan_2026.pdf",
            title="Mehmet & Maya Passport Scans",
            tags=["passport", "id", "travel", "official"],
            summary="High-resolution color scan of Mehmet and Maya passports for international flights.",
            body_lines=[
                "PASSENGER PASSPORT RECORD",
                "Holders: Mehmet Uzgoren & Maya Uzgoren",
                "Document Type: Passport ID Scan (Verified)",
                "Valid Through: October 2034",
            ],
            created_at="2026-02-10T18:00:00+00:00",
        )
        self._seed_pdf(
            asset_id="asset_tax_return_2025",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="2025_Joint_Tax_Return_Package.pdf",
            title="2025 Joint Federal & State Tax Return",
            tags=["tax", "finance", "w2", "1099", "filing"],
            summary="Joint 2025 tax return summary, W-2 forms, and deductions worksheet.",
            body_lines=[
                "FORM 1040 JOINT TAX RETURN SUMMARY",
                "Taxpayers: Mehmet & Maya",
                "Includes W-2, 1099-INT, and Property Tax Receipts",
                "Prepared for CPA review",
            ],
            created_at="2026-04-12T16:20:00+00:00",
        )
        self._seed_pdf(
            asset_id="asset_private_work_deck",
            owner_id="mehmet",
            owner_name="Mehmet",
            filename="Confidential_Stealth_Architecture.pdf",
            title="Confidential Work Architecture Notes",
            tags=["private", "work", "confidential"],
            summary="Private internal engineering roadmap excluded from shared access.",
            body_lines=[
                "STRICTLY CONFIDENTIAL - PRIVATE VAULT",
                "Excluded from automatic contact retrieval.",
            ],
            created_at="2026-09-01T19:00:00+00:00",
        )

        # Seed assets owned by Maya (Wife) so Mehmet can pull from Maya's files too!
        self._seed_pdf(
            asset_id="asset_maya_vet_invoice",
            owner_id="maya",
            owner_name="Maya",
            filename="Golden_Gate_Vet_Invoice_Milo.pdf",
            title="Milo Annual Vet Checkup Invoice",
            tags=["invoice", "receipt", "vet", "pet", "dog"],
            summary="Paid veterinary receipt and vaccination record for Milo from Golden Gate Vet Clinic.",
            body_lines=[
                "GOLDEN GATE VETERINARY CLINIC - PAID INVOICE",
                "Patient: Milo (Golden Retriever)",
                "Owner: Maya & Mehmet",
                "Services: Annual wellness exam & rabies booster - $245.00",
            ],
            created_at="2026-10-03T20:15:00+00:00",
        )
        self._seed_photo(
            asset_id="asset_maya_kyoto_shrine",
            owner_id="maya",
            owner_name="Maya",
            filename="IMG_4201_Fushimi_Inari_Gates.jpg",
            title="Kyoto Torii Gates Morning Walk",
            location="Kyoto, Japan",
            people=["Maya", "Mehmet"],
            tags=["japan", "kyoto", "trip", "shrine", "photos"],
            summary="Walking under vermilion torii gates at Fushimi Inari in Kyoto.",
            top_rgb=(225, 82, 46),
            bottom_rgb=(60, 32, 28),
            created_at="2026-03-28T23:40:00+00:00",
        )

        # Welcome system message in Chat for Mehmet & Maya
        self.append_chat_message(
            ChatMessage(
                id=f"msg_{uuid.uuid4().hex[:10]}",
                user_id="mehmet",
                role="assistant",
                text=(
                    "Welcome to Fyde! Ask me to send photos, videos, or files via Direct Fyde, iMessage, or Email, "
                    "pull files from trusted contacts (e.g. \"Get the vet invoice from Maya's files\"), "
                    "or configure flexible permissions (e.g. \"Share all my China trip photos with Alex\")."
                ),
                created_at=utc_now_iso(),
            )
        )
        self.append_chat_message(
            ChatMessage(
                id=f"msg_{uuid.uuid4().hex[:10]}",
                user_id="maya",
                role="assistant",
                text=(
                    "Hi Maya! You have Trusted Access to Mehmet's library. "
                    "Try asking: \"Get our passport scans from Mehmet's files\" or \"Get all China trip photos from Mehmet\"."
                ),
                created_at=utc_now_iso(),
            )
        )

    def _seed_photo(
        self,
        *,
        asset_id: str,
        owner_id: str,
        owner_name: str,
        filename: str,
        title: str,
        location: str,
        people: list[str],
        tags: list[str],
        summary: str,
        top_rgb: tuple[int, int, int],
        bottom_rgb: tuple[int, int, int],
        created_at: str,
    ) -> None:
        raw = _make_sample_jpeg(top_rgb, bottom_rgb, title, f"{location} • {', '.join(people)}")
        blob_id, path = self.save_blob(raw, ".jpg")
        vec, moments, ocr, _ = self.embedder.embed_asset(
            filename=filename,
            title=title,
            media_type="photo",
            location=location,
            people=people,
            tags=tags,
            summary=summary,
            raw_bytes=raw,
            file_path=path,
        )
        self.upsert_asset(
            IndexedAsset(
                id=asset_id,
                owner_id=owner_id,
                owner_name=owner_name,
                filename=filename,
                title=title,
                media_type="photo",
                mime_type="image/jpeg",
                size_bytes=len(raw),
                created_at=created_at,
                location=location,
                people=people,
                tags=tags,
                ocr_text=ocr,
                summary=summary,
                embedding=vec,
                embedder_name=self.embedder.active_provider_name,
                blob_id=blob_id,
            )
        )

    def _seed_video(
        self,
        *,
        asset_id: str,
        owner_id: str,
        owner_name: str,
        filename: str,
        title: str,
        location: str,
        people: list[str],
        tags: list[str],
        summary: str,
        color_hex: str,
        moments: list[tuple[float, str]],
        created_at: str,
    ) -> None:
        blob_id = f"blob_{uuid.uuid4().hex[:12]}.mp4"
        path = self.blobs_dir / blob_id
        ok = _make_sample_mp4(path, color_hex=color_hex)
        if not ok:
            path.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
        raw = path.read_bytes()
        vec, v_moments, _, dur = self.embedder.embed_asset(
            filename=filename,
            title=title,
            media_type="video",
            location=location,
            people=people,
            tags=tags,
            summary=summary,
            file_path=path if ok else None,
            preset_moments=moments,
        )
        self.upsert_asset(
            IndexedAsset(
                id=asset_id,
                owner_id=owner_id,
                owner_name=owner_name,
                filename=filename,
                title=title,
                media_type="video",
                mime_type="video/mp4",
                size_bytes=len(raw),
                created_at=created_at,
                location=location,
                people=people,
                tags=tags,
                summary=summary,
                duration_sec=dur or 4.0,
                video_moments=v_moments,
                embedding=vec,
                embedder_name=self.embedder.active_provider_name,
                blob_id=blob_id,
            )
        )

    def _seed_pdf(
        self,
        *,
        asset_id: str,
        owner_id: str,
        owner_name: str,
        filename: str,
        title: str,
        tags: list[str],
        summary: str,
        body_lines: list[str],
        created_at: str,
    ) -> None:
        raw = _make_minimal_pdf(title, body_lines)
        blob_id, path = self.save_blob(raw, ".pdf")
        vec, _, ocr, _ = self.embedder.embed_asset(
            filename=filename,
            title=title,
            media_type="document",
            tags=tags,
            summary=summary,
            raw_bytes=raw,
            file_path=path,
        )
        self.upsert_asset(
            IndexedAsset(
                id=asset_id,
                owner_id=owner_id,
                owner_name=owner_name,
                filename=filename,
                title=title,
                media_type="document",
                mime_type="application/pdf",
                size_bytes=len(raw),
                created_at=created_at,
                tags=tags,
                ocr_text=ocr,
                summary=summary,
                embedding=vec,
                embedder_name=self.embedder.active_provider_name,
                blob_id=blob_id,
            )
        )
