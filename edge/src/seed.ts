import { hashPasswordPBKDF2 } from "./crypto";
import { embedTextLocal } from "./embedder";
import type { ChatMessage, ContactPermission, Env, IndexedAsset } from "./types";

let seedChecked = false;

function makePosterSvg(title: string, subtitle: string, topHex: string, bottomHex: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${topHex}"/>
        <stop offset="100%" stop-color="${bottomHex}"/>
      </linearGradient>
    </defs>
    <rect width="800" height="600" fill="url(#g)"/>
    <circle cx="640" cy="130" r="56" fill="#F8F9F4" opacity="0.88"/>
    <rect x="44" y="438" width="712" height="118" rx="18" fill="#293022" opacity="0.92"/>
    <text x="72" y="486" fill="#F8F9F4" font-family="system-ui, sans-serif" font-size="26" font-weight="700">${title}</text>
    <text x="72" y="522" fill="#E2E5DC" font-family="system-ui, sans-serif" font-size="17">${subtitle}</text>
    <circle cx="718" cy="497" r="11" fill="#BF5134"/>
  </svg>`;
}

export async function ensureSeeded(env: Env): Promise<void> {
  if (seedChecked) return;
  const existing = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first<{ cnt: number }>();
  if (Number(existing?.cnt || 0) > 0) {
    seedChecked = true;
    return;
  }

  const now = new Date().toISOString();
  const demoPw = await hashPasswordPBKDF2("fyde2026");

  const demoUsers = [
    ["mehmet", "mehmet", "Mehmet", "mehmet@izbirakin.com", "+14155550101", "#293022", "family"],
    ["maya", "maya", "Maya", "maya@izbirakin.com", "+14155550102", "#BF5134", "family"],
    ["alex", "alex", "Alex", "alex@fyde.local", "+14155550103", "#4B5940", "pro"],
    ["sarah", "sarah", "Sarah", "sarah@taxfirm.local", "+14155550104", "#6B705C", "starter"],
  ] as const;

  for (const [id, handle, name, email, phone, color, plan] of demoUsers) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users
       (id, handle, display_name, email, phone, avatar_color, password_hash, auth_provider, plan_tier, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'email', ?, ?)`
    )
      .bind(id, handle, name, email, phone, color, demoPw, plan, now)
      .run();
  }

  const perms: ContactPermission[] = [
    {
      id: "perm_mehmet_maya",
      owner_id: "mehmet",
      contact_user_id: "maya",
      contact_name: "Maya",
      contact_handle: "maya",
      email: "maya@izbirakin.com",
      phone: "+14155550102",
      relationship: "Wife",
      tier: "trusted",
      excluded_tags: ["private", "hidden"],
      smart_scopes: [],
      updated_at: now,
    },
    {
      id: "perm_maya_mehmet",
      owner_id: "maya",
      contact_user_id: "mehmet",
      contact_name: "Mehmet",
      contact_handle: "mehmet",
      email: "mehmet@izbirakin.com",
      phone: "+14155550101",
      relationship: "Husband",
      tier: "trusted",
      excluded_tags: ["private", "hidden"],
      smart_scopes: [],
      updated_at: now,
    },
    {
      id: "perm_mehmet_alex",
      owner_id: "mehmet",
      contact_user_id: "alex",
      contact_name: "Alex",
      contact_handle: "alex",
      email: "alex@fyde.local",
      phone: "+14155550103",
      relationship: "Friend",
      tier: "smart_scope",
      excluded_tags: ["private", "hidden"],
      smart_scopes: [
        {
          id: "scope_china_alex",
          label: "All China trip photos & videos with Alex (no folder required)",
          locations: ["China", "Shanghai", "Beijing", "Hangzhou"],
          people: ["Alex"],
          media_types: ["photo", "video"],
          semantic_query: "China trip",
          similarity_threshold: 0.24,
          excluded_tags: ["private", "hidden"],
        },
      ],
      updated_at: now,
    },
    {
      id: "perm_mehmet_sarah",
      owner_id: "mehmet",
      contact_user_id: "sarah",
      contact_name: "Sarah",
      contact_handle: "sarah",
      email: "sarah@taxfirm.local",
      phone: "+14155550104",
      relationship: "Accountant",
      tier: "ask_first",
      excluded_tags: ["private", "hidden"],
      smart_scopes: [],
      updated_at: now,
    },
  ];

  for (const p of perms) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO permissions (id, owner_id, contact_user_id, contact_name_lower, data) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(p.id, p.owner_id, p.contact_user_id || null, p.contact_name.toLowerCase(), JSON.stringify(p))
      .run();
  }

  // Put lightweight zero-egress R2 objects for demo previews
  const r2Seeds: Array<{ key: string; contentType: string; body: string; asset: Omit<IndexedAsset, "embedding"> }> = [
    {
      key: "blob_china_wall.svg",
      contentType: "image/svg+xml",
      body: makePosterSvg("Great Wall Sunset Selfie", "Beijing, China • Maya, Mehmet", "#C85A3A", "#3A2D3E"),
      asset: {
        id: "asset_china_wall_maya",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "IMG_8412_Great_Wall_Sunset.svg",
        title: "Great Wall Sunset Selfie",
        media_type: "photo",
        mime_type: "image/svg+xml",
        size_bytes: 1840,
        created_at: "2026-05-14T10:30:00Z",
        location: "Beijing, China",
        people: ["Maya", "Mehmet"],
        tags: ["china", "trip", "sunset", "great wall", "photos"],
        folder_path: "",
        ocr_text: "",
        summary: "Golden hour photo on the Mutianyu Great Wall during our China trip with Maya.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_china_wall.svg",
        download_url: "/api/blobs/blob_china_wall.svg",
        thumbnail_url: "/api/blobs/blob_china_wall.svg",
      },
    },
    {
      key: "blob_shanghai_bund.svg",
      contentType: "image/svg+xml",
      body: makePosterSvg("Shanghai Bund Skyline Dinner", "Shanghai, China • Maya, Alex, Mehmet", "#B84A58", "#1D2848"),
      asset: {
        id: "asset_shanghai_bund_group",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "IMG_8490_Shanghai_Bund_Night.svg",
        title: "Shanghai Bund Skyline Dinner",
        media_type: "photo",
        mime_type: "image/svg+xml",
        size_bytes: 1920,
        created_at: "2026-05-17T13:15:00Z",
        location: "Shanghai, China",
        people: ["Maya", "Alex", "Mehmet"],
        tags: ["china", "trip", "shanghai", "skyline", "dinner", "photos"],
        folder_path: "",
        ocr_text: "",
        summary: "Group photo overlooking the Bund skyline in Shanghai with Maya and Alex.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_shanghai_bund.svg",
        download_url: "/api/blobs/blob_shanghai_bund.svg",
        thumbnail_url: "/api/blobs/blob_shanghai_bund.svg",
      },
    },
    {
      key: "blob_hangzhou_lake.svg",
      contentType: "image/svg+xml",
      body: makePosterSvg("West Lake Pagoda Walk", "Hangzhou, China • Alex, Mehmet", "#BF6B3F", "#2B4C44"),
      asset: {
        id: "asset_hangzhou_temple_alex",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "IMG_8521_Hangzhou_West_Lake.svg",
        title: "West Lake Pagoda Walk",
        media_type: "photo",
        mime_type: "image/svg+xml",
        size_bytes: 1860,
        created_at: "2026-05-19T08:00:00Z",
        location: "Hangzhou, China",
        people: ["Alex", "Mehmet"],
        tags: ["china", "trip", "hangzhou", "temple", "pagoda", "photos"],
        folder_path: "",
        ocr_text: "",
        summary: "Walking by West Lake pagoda in China with Alex.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_hangzhou_lake.svg",
        download_url: "/api/blobs/blob_hangzhou_lake.svg",
        thumbnail_url: "/api/blobs/blob_hangzhou_lake.svg",
      },
    },
    {
      key: "blob_passports_2026.txt",
      contentType: "text/plain; charset=utf-8",
      body: "PASSENGER PASSPORT RECORD\nHolders: Mehmet Uzgoren & Maya Uzgoren\nVerified Scan — Valid Through October 2034\n",
      asset: {
        id: "asset_passports_2026",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "Family_Passports_Scan_2026.pdf",
        title: "Mehmet & Maya Passport Scans",
        media_type: "document",
        mime_type: "text/plain",
        size_bytes: 118,
        created_at: "2026-02-10T18:00:00Z",
        location: "",
        people: ["Mehmet", "Maya"],
        tags: ["passport", "id", "travel", "official"],
        folder_path: "",
        ocr_text: "PASSENGER PASSPORT RECORD Mehmet Uzgoren Maya Uzgoren Valid Through October 2034",
        summary: "High-resolution scan of Mehmet and Maya passports for international travel.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_passports_2026.txt",
        download_url: "/api/blobs/blob_passports_2026.txt",
        thumbnail_url: "",
      },
    },
    {
      key: "blob_tax_return_2025.txt",
      contentType: "text/plain; charset=utf-8",
      body: "FORM 1040 JOINT TAX RETURN SUMMARY (2025)\nIncludes W-2, 1099-INT, and Deductions Schedule.\n",
      asset: {
        id: "asset_tax_return_2025",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "2025_Joint_Tax_Return_Package.pdf",
        title: "2025 Joint Federal & State Tax Return",
        media_type: "document",
        mime_type: "text/plain",
        size_bytes: 96,
        created_at: "2026-04-12T16:20:00Z",
        location: "",
        people: ["Mehmet", "Maya"],
        tags: ["tax", "finance", "w2", "1099", "filing"],
        folder_path: "",
        ocr_text: "FORM 1040 JOINT TAX RETURN SUMMARY W-2 1099-INT",
        summary: "Joint 2025 tax return summary, W-2 forms, and deductions worksheet.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_tax_return_2025.txt",
        download_url: "/api/blobs/blob_tax_return_2025.txt",
        thumbnail_url: "",
      },
    },
    {
      key: "blob_surfing_clip.svg",
      contentType: "image/svg+xml",
      body: makePosterSvg("Surfing Waves at Pacifica Beach", "Video Clip • 0.8s Paddle • 2.2s Riding Wave", "#0284C7", "#0F172A"),
      asset: {
        id: "asset_surfing_pacifica",
        owner_id: "mehmet",
        owner_name: "Mehmet",
        device_id: "edge_seed",
        filename: "VID_9014_Pacifica_Surfing.mp4",
        title: "Surfing Waves at Pacifica Beach",
        media_type: "video",
        mime_type: "image/svg+xml",
        size_bytes: 2048,
        created_at: "2026-08-22T01:10:00Z",
        location: "Pacifica, California",
        people: ["Mehmet", "Maya"],
        tags: ["beach", "surfing", "ocean", "waves", "summer"],
        folder_path: "",
        ocr_text: "",
        summary: "Action clip catching waves at Pacifica Beach at sunset.",
        duration_sec: 4.0,
        video_moments: [
          {
            timestamp_sec: 0.8,
            label: "Paddling out through ocean surf",
            embedding: embedTextLocal("Paddling out through ocean surf beach"),
          },
          {
            timestamp_sec: 2.2,
            label: "Standing up on surfboard riding a clean wave",
            embedding: embedTextLocal("Standing up on surfboard riding a clean wave surfing"),
          },
        ],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_surfing_clip.svg",
        download_url: "/api/blobs/blob_surfing_clip.svg",
        thumbnail_url: "/api/blobs/blob_surfing_clip.svg",
      },
    },
    {
      key: "blob_maya_vet_invoice.txt",
      contentType: "text/plain; charset=utf-8",
      body: "GOLDEN GATE VETERINARY CLINIC — PAID INVOICE\nPatient: Milo (Golden Retriever)\nWellness Exam & Booster: $245.00\n",
      asset: {
        id: "asset_maya_vet_invoice",
        owner_id: "maya",
        owner_name: "Maya",
        device_id: "edge_seed",
        filename: "Golden_Gate_Vet_Invoice_Milo.pdf",
        title: "Milo Annual Vet Checkup Invoice",
        media_type: "document",
        mime_type: "text/plain",
        size_bytes: 114,
        created_at: "2026-10-03T20:15:00Z",
        location: "San Francisco, California",
        people: ["Maya", "Mehmet"],
        tags: ["invoice", "receipt", "vet", "pet", "dog"],
        folder_path: "",
        ocr_text: "GOLDEN GATE VETERINARY CLINIC PAID INVOICE Milo Golden Retriever",
        summary: "Paid veterinary receipt and vaccination record for Milo.",
        video_moments: [],
        embedder_name: "fyde-edge-mrl256",
        blob_id: "blob_maya_vet_invoice.txt",
        download_url: "/api/blobs/blob_maya_vet_invoice.txt",
        thumbnail_url: "",
      },
    },
  ];

  for (const item of r2Seeds) {
    await env.BLOBS.put(item.key, item.body, {
      httpMetadata: { contentType: item.contentType },
    });
    const composite = `${item.asset.title} ${item.asset.filename} ${item.asset.location} ${item.asset.people.join(" ")} ${item.asset.tags.join(" ")} ${item.asset.summary} ${item.asset.ocr_text}`;
    const fullAsset: IndexedAsset = {
      ...item.asset,
      embedding: embedTextLocal(composite),
    };
    await env.DB.prepare(
      "INSERT OR REPLACE INTO assets (id, owner_id, media_type, created_at, data) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(fullAsset.id, fullAsset.owner_id, fullAsset.media_type, fullAsset.created_at, JSON.stringify(fullAsset))
      .run();
  }

  const welcomeMehmet: ChatMessage = {
    id: "msg_welcome_mehmet",
    user_id: "mehmet",
    role: "assistant",
    text: "Welcome to **fyde.** on Cloudflare Edge! Ask me to send photos, videos, or files via Direct Fyde, iMessage, or Email, pull files from trusted contacts, or set folderless Smart Scopes.",
    created_at: now,
  };
  const welcomeMaya: ChatMessage = {
    id: "msg_welcome_maya",
    user_id: "maya",
    role: "assistant",
    text: "Hi Maya! You have **Trusted Access** to Mehmet's library. Try asking: *\"Get our passport scans from Mehmet's files\"* or *\"Get all China trip photos from Mehmet\"*.",
    created_at: now,
  };

  for (const msg of [welcomeMehmet, welcomeMaya]) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO chat_messages (id, user_id, created_at, data) VALUES (?, ?, ?, ?)"
    )
      .bind(msg.id, msg.user_id, msg.created_at, JSON.stringify(msg))
      .run();
  }

  seedChecked = true;
}
