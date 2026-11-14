from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


PermissionTier = Literal["trusted", "smart_scope", "ask_first", "send_only"]
MediaType = Literal["photo", "video", "document", "audio", "folder"]
SendChannel = Literal["fyde_direct", "imessage", "email"]
PlatformType = Literal["ios", "macos", "web"]


class UserProfile(BaseModel):
    id: str
    handle: str
    display_name: str
    email: str = ""
    phone: str = ""
    avatar_color: str = "#4F46E5"
    auto_save_trusted_to_photos: bool = True


class DeviceNode(BaseModel):
    device_id: str
    user_id: str
    platform: PlatformType
    device_name: str
    capabilities: list[str] = Field(default_factory=list)
    online: bool = False
    last_seen: str = ""


class SmartScopeRule(BaseModel):
    id: str
    label: str
    locations: list[str] = Field(default_factory=list)
    people: list[str] = Field(default_factory=list)
    media_types: list[MediaType] = Field(default_factory=list)
    date_from: str | None = None
    date_to: str | None = None
    semantic_query: str | None = None
    similarity_threshold: float = 0.24
    excluded_tags: list[str] = Field(default_factory=lambda: ["private", "hidden"])


class ContactPermission(BaseModel):
    id: str
    owner_id: str
    contact_user_id: str | None = None
    contact_name: str
    contact_handle: str | None = None
    email: str = ""
    phone: str = ""
    relationship: str = ""
    tier: PermissionTier = "send_only"
    excluded_tags: list[str] = Field(default_factory=lambda: ["private", "hidden"])
    smart_scopes: list[SmartScopeRule] = Field(default_factory=list)
    updated_at: str = ""


class VideoMoment(BaseModel):
    timestamp_sec: float
    label: str
    embedding: list[float] = Field(default_factory=list)


class IndexedAsset(BaseModel):
    id: str
    owner_id: str
    owner_name: str = ""
    device_id: str = "local"
    filename: str
    title: str
    media_type: MediaType
    mime_type: str
    size_bytes: int = 0
    created_at: str
    location: str = ""
    people: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    folder_path: str = ""
    ocr_text: str = ""
    summary: str = ""
    duration_sec: float | None = None
    video_moments: list[VideoMoment] = Field(default_factory=list)
    embedding: list[float] = Field(default_factory=list)
    embedder_name: str = "fyde-multimodal-256"
    blob_id: str | None = None
    download_url: str = ""
    thumbnail_url: str = ""


class SearchHit(BaseModel):
    asset: IndexedAsset
    score: float
    matched_moment_sec: float | None = None
    matched_moment_label: str | None = None
    match_reason: str = ""


class BundleItem(BaseModel):
    asset_id: str
    filename: str
    title: str
    media_type: MediaType
    mime_type: str
    size_bytes: int
    download_url: str
    thumbnail_url: str = ""
    location: str = ""
    people: list[str] = Field(default_factory=list)
    matched_timestamp_sec: float | None = None


class TransferBundle(BaseModel):
    id: str
    sender_id: str
    sender_name: str
    recipient_id: str | None = None
    recipient_name: str
    recipient_address: str = ""
    channel: SendChannel
    title: str
    message: str = ""
    items: list[BundleItem] = Field(default_factory=list)
    origin: Literal[
        "pushed",
        "pulled_by_trusted",
        "pulled_by_smart_scope",
        "approved_request",
    ] = "pushed"
    status: Literal[
        "delivered",
        "accepted_photos",
        "accepted_files",
        "sent_background",
        "relayed_to_mac",
        "ios_compose_fallback",
        "simulated_outbox",
    ] = "delivered"
    delivery_detail: str = ""
    accepted_destination: str | None = None
    share_link: str = ""
    created_at: str


class AccessRequest(BaseModel):
    id: str
    requester_id: str
    requester_name: str
    owner_id: str
    owner_name: str
    query: str
    matched_asset_ids: list[str] = Field(default_factory=list)
    matched_previews: list[BundleItem] = Field(default_factory=list)
    status: Literal["pending", "approved", "denied"] = "pending"
    bundle_id: str | None = None
    created_at: str


class ChatActionCard(BaseModel):
    action_type: Literal[
        "send_confirmation",
        "send_completed",
        "permission_updated",
        "peer_pull_completed",
        "peer_request_pending",
        "bundle_accepted",
        "search_results",
    ]
    summary: str
    channel: SendChannel | None = None
    recipient_name: str | None = None
    recipient_id: str | None = None
    recipient_address: str | None = None
    asset_ids: list[str] = Field(default_factory=list)
    previews: list[BundleItem] = Field(default_factory=list)
    permission: ContactPermission | None = None
    bundle: TransferBundle | None = None
    access_request: AccessRequest | None = None
    requires_confirmation: bool = False


class ChatMessage(BaseModel):
    id: str
    user_id: str
    role: Literal["user", "assistant", "system"]
    text: str
    action_card: ChatActionCard | None = None
    created_at: str


# Request Payloads
class SearchRequest(BaseModel):
    user_id: str
    query: str
    media_type: MediaType | None = None
    scope: Literal["mine", "contacts", "all"] = "all"
    contact_owner_id: str | None = None
    limit: int = 20


class SetPermissionRequest(BaseModel):
    owner_id: str
    contact_user_id: str | None = None
    contact_name: str
    contact_handle: str | None = None
    email: str = ""
    phone: str = ""
    relationship: str = ""
    tier: PermissionTier
    excluded_tags: list[str] = Field(default_factory=lambda: ["private", "hidden"])
    smart_scopes: list[SmartScopeRule] = Field(default_factory=list)


class SendFilesRequest(BaseModel):
    sender_id: str
    asset_ids: list[str]
    recipient_name: str
    recipient_user_id: str | None = None
    recipient_address: str = ""
    channel: SendChannel = "fyde_direct"
    title: str = ""
    message: str = ""
    sender_platform: PlatformType = "ios"


class PeerPullRequest(BaseModel):
    requester_id: str
    owner_id: str
    query: str


class ResolveAccessRequestPayload(BaseModel):
    owner_id: str
    decision: Literal["approve", "deny"]


class AcceptBundleRequest(BaseModel):
    user_id: str
    destination_type: Literal["photos", "files"] = "photos"
    album_or_folder: str = ""


class ChatTurnRequest(BaseModel):
    user_id: str
    text: str
    platform: PlatformType = "ios"
    auto_send: bool = True
