import type {
  AccessRequest,
  ChatMessage,
  ContactPermission,
  SearchHit,
  TransferBundle,
  UserProfile,
  WaitlistEntry,
} from "./types";

function posterDataUrl(title: string, subtitle: string, bg: string, accent: string, fg: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="540" viewBox="0 0 800 540">
    <rect width="800" height="540" fill="${bg}"/>
    <circle cx="670" cy="120" r="78" fill="${accent}"/>
    <circle cx="130" cy="110" r="32" fill="${fg}" opacity="0.14"/>
    <rect x="42" y="368" width="716" height="128" rx="22" fill="#0A0A0A"/>
    <text x="72" y="424" fill="#FFFFFF" font-family="system-ui, sans-serif" font-size="28" font-weight="800">${title}</text>
    <text x="72" y="462" fill="#FFB38A" font-family="system-ui, sans-serif" font-size="18" font-weight="600">${subtitle}</text>
    <circle cx="716" cy="432" r="13" fill="#FF5500"/>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const FALLBACK_USERS: UserProfile[] = [
  {
    id: "mehmet",
    handle: "mehmet",
    display_name: "Mehmet",
    email: "mehmet@izbirakin.com",
    phone: "+14155550101",
    avatar_color: "#FF5500",
    auth_provider: "email",
    plan_tier: "family",
    auto_save_trusted_to_photos: true,
  },
  {
    id: "maya",
    handle: "maya",
    display_name: "Maya",
    email: "maya@izbirakin.com",
    phone: "+14155550102",
    avatar_color: "#0A0A0A",
    auth_provider: "email",
    plan_tier: "family",
    auto_save_trusted_to_photos: true,
  },
  {
    id: "alex",
    handle: "alex",
    display_name: "Alex",
    email: "alex@fyde.local",
    phone: "+14155550103",
    avatar_color: "#FF7733",
    auth_provider: "email",
    plan_tier: "pro",
    auto_save_trusted_to_photos: false,
  },
];

export const FALLBACK_SEARCH_HITS: SearchHit[] = [
  {
    score: 0.96,
    matched_moment_sec: 14.0,
    matched_moment_label: "Big wave wipeout & laugh",
    match_reason: "Matched video moment @ 0:14s",
    asset: {
      id: "ast_pacifica",
      owner_id: "mehmet",
      owner_name: "Mehmet",
      filename: "pacifica_surf_4k.mp4",
      title: "Pacifica Sunset Surf Session",
      media_type: "video",
      mime_type: "video/mp4",
      size_bytes: 48200000,
      created_at: new Date().toISOString(),
      location: "Pacifica, CA",
      people: ["Mehmet", "Maya"],
      tags: ["surf", "beach", "wipeout"],
      summary: "Sunset surf session with funny wipeout at 14s",
      video_moments: [{ timestamp_sec: 14.0, label: "Big wave wipeout & laugh" }],
      download_url: "#",
      thumbnail_url: posterDataUrl("Pacifica Sunset Surf", "4K Video • Jump to 0:14s", "#FF5500", "#FFFFFF", "#0A0A0A"),
    },
  },
  {
    score: 0.93,
    match_reason: "Matched location & people (Shanghai • Alex)",
    asset: {
      id: "ast_shanghai",
      owner_id: "mehmet",
      owner_name: "Mehmet",
      filename: "shanghai_bund_night.jpg",
      title: "Shanghai Bund Rooftop Night",
      media_type: "photo",
      mime_type: "image/jpeg",
      size_bytes: 4600000,
      created_at: new Date().toISOString(),
      location: "Shanghai, China",
      people: ["Mehmet", "Maya", "Alex"],
      tags: ["china", "trip", "night"],
      summary: "Group selfie overlooking the Bund skyline in Shanghai",
      video_moments: [],
      download_url: "#",
      thumbnail_url: posterDataUrl("Shanghai Bund Night", "China Trip • Mehmet, Maya, Alex", "#0A0A0A", "#FF5500", "#FFFFFF"),
    },
  },
  {
    score: 0.89,
    match_reason: "Matched document memory (Passports)",
    asset: {
      id: "ast_passports",
      owner_id: "mehmet",
      owner_name: "Mehmet",
      filename: "Family_Passport_Scans.pdf",
      title: "Family Passport Scans",
      media_type: "document",
      mime_type: "application/pdf",
      size_bytes: 1850000,
      created_at: new Date().toISOString(),
      location: "San Francisco, CA",
      people: ["Mehmet", "Maya"],
      tags: ["travel", "passport"],
      summary: "High-res color scans of family passports",
      video_moments: [],
      download_url: "#",
      thumbnail_url: "",
    },
  },
];

export const FALLBACK_PERMISSIONS: ContactPermission[] = [
  {
    id: "perm_1",
    owner_id: "mehmet",
    contact_user_id: "maya",
    contact_name: "Maya",
    contact_handle: "maya",
    email: "maya@izbirakin.com",
    phone: "+14155550102",
    relationship: "Partner",
    tier: "trusted",
    smart_scopes: [],
  },
  {
    id: "perm_2",
    owner_id: "mehmet",
    contact_user_id: "alex",
    contact_name: "Alex",
    contact_handle: "alex",
    email: "alex@fyde.local",
    phone: "+14155550103",
    relationship: "Best Friend",
    tier: "smart_scope",
    smart_scopes: [
      {
        id: "sc_china",
        label: "All China trip photos & videos with Alex",
        locations: ["China", "Shanghai"],
        people: ["Alex"],
        media_types: ["photo", "video"],
        semantic_query: "China trip",
      },
    ],
  },
];

export const FALLBACK_CHAT: ChatMessage[] = [
  {
    id: "msg_1",
    user_id: "mehmet",
    role: "user",
    text: "Allow Alex to grab all our China trip photos with him — no folder needed!",
    created_at: new Date().toISOString(),
  },
  {
    id: "msg_2",
    user_id: "mehmet",
    role: "assistant",
    text: "Done! Alex now has a Smart Circle pass for photos & videos from China with him.",
    action_card: {
      action_type: "smart_scope_active",
      summary: "Smart Scope active for Alex",
      previews: [
        {
          asset_id: "ast_shanghai",
          filename: "shanghai_bund_night.jpg",
          title: "Shanghai Bund Rooftop Night",
          media_type: "photo",
          mime_type: "image/jpeg",
          size_bytes: 4600000,
          download_url: "#",
          thumbnail_url: "",
          location: "Shanghai, China",
          people: ["Mehmet", "Maya", "Alex"],
        },
      ],
    },
    created_at: new Date().toISOString(),
  },
];

export const FALLBACK_BUNDLES: TransferBundle[] = [
  {
    id: "bnd_1",
    sender_id: "maya",
    sender_name: "Maya",
    recipient_id: "mehmet",
    recipient_name: "Mehmet",
    channel: "fyde_direct",
    title: "Sunday Farmers Market Snaps (4 Photos)",
    message: "Dropped straight from Maya's iPhone!",
    origin: "direct_drop",
    status: "delivered",
    delivery_detail: "Ready for 1-tap save to Apple Photos",
    share_link: "https://fyde.izbirakin.com",
    created_at: new Date().toISOString(),
    items: [
      {
        asset_id: "ast_mkt_1",
        filename: "peaches_stand.jpg",
        title: "Heirloom Peaches Stand",
        media_type: "photo",
        mime_type: "image/jpeg",
        size_bytes: 3100000,
        download_url: "#",
        thumbnail_url: "",
        location: "Ferry Building",
        people: ["Maya"],
      },
      {
        asset_id: "ast_mkt_2",
        filename: "iced_espresso.jpg",
        title: "Orange Peel Espresso Tonic",
        media_type: "photo",
        mime_type: "image/jpeg",
        size_bytes: 2800000,
        download_url: "#",
        thumbnail_url: "",
        location: "Ferry Building",
        people: ["Mehmet", "Maya"],
      },
    ],
  },
];

export const FALLBACK_REQUESTS: AccessRequest[] = [];

const LOCAL_WL_KEY = "fyde_local_waitlist_v1";

export function getLocalWaitlistEntries(): WaitlistEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_WL_KEY);
    return raw ? (JSON.parse(raw) as WaitlistEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveLocalWaitlistEntry(
  email: string,
  name: string,
  platformInterest: string
): { already_joined: boolean; entry: WaitlistEntry; message: string } {
  const cleanEmail = email.trim().toLowerCase();
  const list = getLocalWaitlistEntries();
  const found = list.find((item) => item.email === cleanEmail);
  if (found) {
    return {
      already_joined: true,
      entry: found,
      message: `You're already on the list at spot #${found.position}!`,
    };
  }
  const code = Math.random().toString(36).slice(2, 6).toUpperCase() + Math.floor(10 + Math.random() * 89);
  const entry: WaitlistEntry = {
    id: `wl_${Date.now()}`,
    email: cleanEmail,
    name: name.trim(),
    platform_interest: platformInterest,
    referral_code: code,
    position: 341 + list.length,
    invite_code: `FYDE-${code}`,
    created_at: new Date().toISOString(),
  };
  list.push(entry);
  try {
    localStorage.setItem(LOCAL_WL_KEY, JSON.stringify(list));
  } catch {
    // ignore storage quota errors
  }
  return {
    already_joined: false,
    entry,
    message: `Boom — you're in! Spot #${entry.position} locked on fyde.izbirakin.com.`,
  };
}
