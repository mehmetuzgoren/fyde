export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  USER_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI?: Ai;

  PUBLIC_APP_URL?: string;
  EMAIL_FROM?: string;
  REQUIRE_INVITE_CODE?: string;

  // Optional Secrets (`wrangler secret put ...`)
  JWT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_PRO_YEARLY?: string;
  STRIPE_PRICE_FAMILY_MONTHLY?: string;
  STRIPE_PRICE_FAMILY_YEARLY?: string;
  GEMINI_API_KEY?: string;
  EMBEDDING_GEMMA_URL?: string;
}

export type PermissionTier = "trusted" | "smart_scope" | "ask_first" | "send_only";
export type MediaType = "photo" | "video" | "document" | "audio" | "folder";
export type SendChannel = "fyde_direct" | "imessage" | "email";
export type PlanTier = "starter" | "pro" | "family";

export interface UserProfile {
  id: string;
  handle: string;
  display_name: string;
  email: string;
  phone: string;
  avatar_color: string;
  auth_provider?: string;
  plan_tier: PlanTier;
  billing_interval?: string;
  subscription_status?: string;
  auto_save_trusted_to_photos: boolean;
}

export interface WaitlistEntry {
  id: string;
  email: string;
  name: string;
  platform_interest: string;
  referral_code: string;
  position: number;
  invite_status: string;
  created_at: string;
}

export interface SmartScopeRule {
  id: string;
  label: string;
  locations: string[];
  people: string[];
  media_types: MediaType[];
  date_from?: string | null;
  date_to?: string | null;
  semantic_query?: string | null;
  similarity_threshold: number;
  excluded_tags: string[];
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
  excluded_tags: string[];
  smart_scopes: SmartScopeRule[];
  updated_at: string;
}

export interface VideoMoment {
  timestamp_sec: number;
  label: string;
  embedding: number[];
}

export interface IndexedAsset {
  id: string;
  owner_id: string;
  owner_name: string;
  device_id: string;
  filename: string;
  title: string;
  media_type: MediaType;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  location: string;
  people: string[];
  tags: string[];
  folder_path: string;
  ocr_text: string;
  summary: string;
  duration_sec?: number | null;
  video_moments: VideoMoment[];
  embedding: number[];
  embedder_name: string;
  blob_id?: string | null;
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
  recipient_address: string;
  channel: SendChannel;
  title: string;
  message: string;
  items: BundleItem[];
  origin: "pushed" | "pulled_by_trusted" | "pulled_by_smart_scope" | "approved_request";
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
  matched_asset_ids: string[];
  matched_previews: BundleItem[];
  status: "pending" | "approved" | "denied";
  bundle_id?: string | null;
  created_at: string;
}

export interface ChatActionCard {
  action_type: string;
  summary: string;
  channel?: SendChannel | null;
  recipient_name?: string | null;
  recipient_id?: string | null;
  recipient_address?: string | null;
  asset_ids: string[];
  previews: BundleItem[];
  permission?: ContactPermission | null;
  bundle?: TransferBundle | null;
  access_request?: AccessRequest | null;
  requires_confirmation: boolean;
}

export interface ChatMessage {
  id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  text: string;
  action_card?: ChatActionCard | null;
  created_at: string;
}
