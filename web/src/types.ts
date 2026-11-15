export type PermissionTier = "trusted" | "smart_scope" | "ask_first" | "send_only";
export type MediaType = "photo" | "video" | "document" | "audio" | "folder";
export type SendChannel = "fyde_direct" | "imessage" | "email";
export type ActiveTab = "search" | "chat" | "received";
export type PlanTier = "starter" | "pro" | "family";

export interface UserProfile {
  id: string;
  handle: string;
  display_name: string;
  email: string;
  phone: string;
  avatar_color: string;
  bio?: string;
  auth_provider?: string;
  plan_tier?: PlanTier;
  billing_interval?: string;
  subscription_status?: string;
  auto_save_trusted_to_photos: boolean;
}

export interface DirectoryUser {
  id: string;
  handle: string;
  display_name: string;
  avatar_color: string;
  bio: string;
  friendship_status: "none" | "pending_outgoing" | "pending_incoming" | "accepted";
  friendship_id?: string | null;
}

export interface FriendRequestRecord {
  id: string;
  requester_id: string;
  requester_handle: string;
  requester_name: string;
  requester_avatar_color: string;
  addressee_id: string;
  addressee_handle: string;
  addressee_name: string;
  addressee_avatar_color: string;
  status: "pending" | "accepted" | "declined";
  created_at: string;
  updated_at: string;
}

export interface SocialFeedItem {
  id: string;
  actor_id: string;
  actor_handle: string;
  actor_name: string;
  actor_avatar_color: string;
  target_user_id?: string | null;
  target_handle?: string | null;
  target_name?: string | null;
  kind: string;
  summary: string;
  bundle_id?: string | null;
  created_at: string;
}

export interface SocialOverview {
  friends: DirectoryUser[];
  incoming_requests: FriendRequestRecord[];
  outgoing_requests: FriendRequestRecord[];
  suggestions: DirectoryUser[];
  feed: SocialFeedItem[];
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  tagline: string;
  monthly_usd: number;
  yearly_usd: number;
  features: string[];
  highlighted?: boolean;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  platform_interest: string;
  referral_code: string;
  position: number;
  invite_code: string;
  created_at: string;
}

export interface SmartScopeRule {
  id: string;
  label: string;
  locations: string[];
  people: string[];
  media_types: MediaType[];
  semantic_query?: string | null;
}

export interface ContactPermission {
  id: string;
  owner_id: string;
  contact_user_id?: string | null;
  contact_name: string;
  contact_handle?: string | null;
  email: string;
  phone: string;
  relationship: string;
  tier: PermissionTier;
  smart_scopes: SmartScopeRule[];
}

export interface VideoMoment {
  timestamp_sec: number;
  label: string;
}

export interface IndexedAsset {
  id: string;
  owner_id: string;
  owner_name: string;
  filename: string;
  title: string;
  media_type: MediaType;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  location: string;
  people: string[];
  tags: string[];
  summary: string;
  video_moments: VideoMoment[];
  download_url: string;
  thumbnail_url: string;
}

export interface SearchHit {
  asset: IndexedAsset;
  score: number;
  matched_moment_sec?: number | null;
  matched_moment_label?: string | null;
  match_reason: string;
}

export interface BundleItem {
  asset_id: string;
  filename: string;
  title: string;
  media_type: MediaType;
  mime_type: string;
  size_bytes: number;
  download_url: string;
  thumbnail_url: string;
  location: string;
  people: string[];
  matched_timestamp_sec?: number | null;
}

export interface TransferBundle {
  id: string;
  sender_id: string;
  sender_name: string;
  recipient_id?: string | null;
  recipient_name: string;
  channel: SendChannel;
  title: string;
  message: string;
  items: BundleItem[];
  origin: string;
  status: string;
  delivery_detail: string;
  accepted_destination?: string | null;
  share_link: string;
  created_at: string;
}

export interface AccessRequest {
  id: string;
  requester_id: string;
  requester_name: string;
  owner_id: string;
  owner_name: string;
  query: string;
  matched_previews: BundleItem[];
  status: "pending" | "approved" | "denied";
  created_at: string;
}

export interface ChatActionCard {
  action_type: string;
  summary: string;
  channel?: SendChannel | null;
  recipient_name?: string | null;
  previews: BundleItem[];
  permission?: ContactPermission | null;
  bundle?: TransferBundle | null;
  access_request?: AccessRequest | null;
  requires_confirmation?: boolean;
  /** Why a voice send is waiting for confirmation (send_confirmation cards). */
  hold_reason?: string | null;
  band_confirmable?: boolean;
  source?: string | null;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  text: string;
  action_card?: ChatActionCard | null;
  created_at: string;
}
