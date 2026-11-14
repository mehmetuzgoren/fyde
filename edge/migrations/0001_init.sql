-- Fyde Edge D1 Schema (Waitlist, Auth, Stripe Billing, Permissions, Multimodal Index & Bundles)

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  platform_interest TEXT NOT NULL DEFAULT 'ios_macos',
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL,
  invite_status TEXT NOT NULL DEFAULT 'pending',
  invite_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  avatar_color TEXT NOT NULL DEFAULT '#293022',
  password_hash TEXT NOT NULL DEFAULT '',
  auth_provider TEXT NOT NULL DEFAULT 'email',
  apple_sub TEXT,
  google_sub TEXT,
  plan_tier TEXT NOT NULL DEFAULT 'starter',
  billing_interval TEXT NOT NULL DEFAULT 'monthly',
  subscription_status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  auto_save_trusted_to_photos INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_otps (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  redirect_after TEXT NOT NULL DEFAULT '/app',
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  contact_user_id TEXT,
  contact_name_lower TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permissions_owner ON permissions(owner_id);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bundles_recipient ON bundles(recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bundles_sender ON bundles(sender_id, created_at DESC);

CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_owner ON access_requests(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id, created_at ASC);
