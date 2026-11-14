# fyde. (`fydefiles` — `fyde.izbirakin.com`)

Multimodal, permissioned peer-to-peer file, photo, and video sharing across **iPhone (iOS)**, **macOS**, and **Web (`fyde.izbirakin.com`)**, powered by **Cloudflare Workers + Hibernating Durable Objects + D1 + Zero-Egress R2**.

---

## Brand & Experience

- **Wordmark Logo:** `fyde.` (`#293022` forest ink + `#BF5134` terracotta dot on `#F8F9F4` warm cream)
- **Favicon & AppIcon:** `f.` (`web/public/favicon.svg`, `apple-touch-icon.png`, and `apple/FydeApp/App/Assets.xcassets/AppIcon.appiconset`)
- **Default Entry at `fyde.izbirakin.com` (`/`):**
  - Starts unauthenticated visitors on the **`fyde.` Waitlist + Product Landing Page** (with live D1 queue position & referral/invite token) alongside a top-right **`Log in`** modal and **Pricing / Stripe Checkout** section.
- **Login Options (`/api/auth/*`):**
  1. **Sign in with Apple** (Web OIDC `/api/auth/apple/start` + Native iOS/macOS `SignInWithAppleButton` `/api/auth/apple/native` verified against Apple's RSA JWKS)
  2. **Continue with Google** (OAuth 2.0 `/api/auth/google/start` & `/api/auth/google/callback`)
  3. **Passwordless 6-Digit Email Code (OTP)** (`/api/auth/email/send-code` & `/api/auth/email/verify-code`)
  4. **Email + Password** (Web Crypto `PBKDF2-SHA256` `/api/auth/register` & `/api/auth/login`)
- **Payment & Subscription Options (`/api/billing/*`):**
  - **Starter (\$0)** · **fyde. Pro (\$12/mo or \$99/yr)** · **fyde. Household (\$19/mo or \$159/yr)**
  - **Stripe Checkout** supporting **Apple Pay**, **Google Pay**, **Stripe Link**, and **Cards**, plus **Customer Billing Portal** (`/api/billing/portal`) and HMAC-SHA256 verified **Stripe Webhooks** (`/api/billing/webhook`).
- **Authenticated 3-Tab Layout:**
  1. **Left Tab — Search:** 256-D MRL multimodal search across photos, video keyframe timestamps (streamed via R2 `206 Partial Content` byte ranges), and PDFs across My Library & Permitted Contacts.
  2. **Middle Tab (Default App Landing) — `fyde. Chat`:** Conversational background sending over **Direct Fyde**, **iMessage** (via macOS `Messages.app` bridge), and **Email**, inline **Flexible Contact Permissions** (Trusted Spouse Full Access, Folderless Smart Scopes e.g. *"all my China trip photos with Alex"*, Ask-First 1-tap approvals), and accepting received bundles via chat.
  3. **Right Tab — Received:** AirDrop-like **Direct-to-Photos** saving via PhotoKit (`PHPhotoLibrary`) + pending Ask-First approval cards.

---

## Repository Structure

```text
fydefiles/
├── edge/                   # Cloudflare Workers + Hibernating Durable Objects + D1 + R2 + Auth + Stripe Billing
│   ├── wrangler.jsonc      # Custom domain `fyde.izbirakin.com`, Static Assets, D1, R2, Durable Objects
│   ├── migrations/         # 0001_init.sql (waitlist, users, OTPs, OAuth states, permissions, assets, bundles)
│   ├── src/                # index.ts, durableHub.ts, auth.ts, billing.ts, crypto.ts, embedder.ts, seed.ts
│   └── test_edge_e2e.mjs   # Full Wrangler local D1 + R2 + DO WebSocket + Auth + Billing E2E suite
├── web/                    # `fyde.izbirakin.com` Landing + Waitlist + Login + Pricing + 3-Tab Web App
│   ├── public/             # logo.png, f-dot-mark.png, favicon.svg, favicon-32x32.png, apple-touch-icon.png
│   └── src/                # LandingView.tsx, AuthAndBillingModals.tsx, App.tsx, styles.css
├── apple/                  # Native Multiplatform SwiftUI App (iPhone iOS 18+ & macOS 15+)
│   ├── Sources/FydeKit/    # AuthAndBillingViews.swift, FydeRootView.swift, FydeStore.swift, PhotoKit/Messages
│   └── FydeApp/            # Fyde.xcodeproj + Assets.xcassets (`f.` AppIcon + `FydeLogo`)
├── server/                 # Optional standalone Python FastAPI / local ffmpeg worker reference
└── start_dev.sh            # Migrates local D1 & launches Cloudflare Edge (:8787) + Web (:5173)
```

---

## Local Quick Start

### 1. Run Cloudflare Edge + Web App
```bash
chmod +x ./start_dev.sh
./start_dev.sh
```
- **Cloudflare Edge Worker (D1 + R2 + Durable Objects):** `http://127.0.0.1:8787`
- **Web App (Waitlist + Landing + Login + 3-Tab App):** `http://localhost:5173`

### 2. Run Automated Edge E2E Tests
```bash
cd edge && npm test
```

### 3. Run the iPhone & macOS Apps
```bash
open apple/FydeApp/Fyde.xcodeproj
```
Select an **iPhone Simulator** or **My Mac** and press **Run (`⌘R`)**. Sign in via **Sign in with Apple**, **6-Digit Email Code**, **Password**, or tap an instant P2P preview account (`@mehmet`, `@maya`, `@alex`).

---

## Deploying Live to `fyde.izbirakin.com` on Cloudflare

1. **Create your production D1 database & R2 bucket once:**
   ```bash
   cd edge
   npx wrangler login
   npx wrangler d1 create fyde-db
   npx wrangler r2 bucket create fyde-blobs
   ```
   Copy the returned `database_id` into `edge/wrangler.jsonc` under `d1_databases[0].database_id`, then apply the schema:
   ```bash
   npm run db:migrate:remote
   ```

2. **Configure Production Secrets (Auth, Email & Stripe Billing):**
   ```bash
   npx wrangler secret put JWT_SECRET
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put APPLE_CLIENT_ID
   npx wrangler secret put RESEND_API_KEY
   ```
   - **Google OAuth Redirect URI:** `https://fyde.izbirakin.com/api/auth/google/callback`
   - **Apple Services ID Return URL:** `https://fyde.izbirakin.com/api/auth/apple/callback`
   - **Stripe Webhook Endpoint:** `https://fyde.izbirakin.com/api/billing/webhook` (events: `checkout.session.completed`, `customer.subscription.deleted`)

3. **Build Web Assets & Deploy Globally to `fyde.izbirakin.com`:**
   ```bash
   cd edge
   npm run deploy
   ```
   Because `wrangler.jsonc` includes `"routes": [{ "pattern": "fyde.izbirakin.com", "custom_domain": true }]` under your `izbirakin.com` Cloudflare zone, Cloudflare automatically provisions SSL/DNS and serves the Waitlist + Landing Page, API, R2 streams, and Durable Object WebSockets on **`https://fyde.izbirakin.com`**.
