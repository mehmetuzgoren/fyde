#!/usr/bin/env node
// Re-embeds a user's library with EmbeddingGemma 2 (POST /api/assets/:id/reindex).
//
// For each photo it sends a ~1536 px JPEG preview (HEIC-safe, small payload); for each video it
// sends keyframes every few seconds (one searchable moment each, so search can jump to the
// moment); documents are re-embedded server-side from their text. Needs macOS `sips` for
// previews and `ffmpeg`/`ffprobe` for video keyframes.
//
//   node scripts/reindex-media.mjs --base https://fyde.izbirakin.com --user mehmet
//   node scripts/reindex-media.mjs --base http://127.0.0.1:8792 --user mehmet --only asset_abc123
//
// Auth: pass a session token with --token (or FYDE_TOKEN); without one the relay must accept
// `user_id` (REQUIRE_AUTH not "true").

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, [])
);
const BASE = (args.base || "http://127.0.0.1:8787").replace(/\/$/, "");
const USER = args.user || "mehmet";
const TOKEN = args.token || process.env.FYDE_TOKEN || "";
const ONLY = args.only ? new Set(args.only.split(",")) : null;
const FRAME_EVERY_SEC = Number(args["frame-every"] || 3);
const MAX_FRAMES = 24;

const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const work = fs.mkdtempSync(path.join(os.tmpdir(), "fyde-reindex-"));

function run(cmd, argv) {
  return execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

async function download(asset) {
  const url = asset.download_url.startsWith("http") ? asset.download_url : `${BASE}${asset.download_url}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const file = path.join(work, `${asset.id}_${asset.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

function photoPreview(file) {
  const out = `${file}.preview.jpg`;
  try {
    run("sips", ["-Z", "1536", "-s", "format", "jpeg", "-s", "formatOptions", "85", file, "--out", out]);
  } catch {
    run("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "scale='min(1536,iw)':-2", "-q:v", "3", out]);
  }
  return out;
}

function videoKeyframes(file) {
  let duration = 0;
  try {
    duration = Number.parseFloat(
      run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]).trim()
    );
  } catch {
    duration = 0;
  }
  const total = duration > 0 ? duration : 1;
  let times = [];
  for (let t = Math.min(0.5, total / 2); t < total; t += FRAME_EVERY_SEC) times.push(Number(t.toFixed(2)));
  if (times.length === 0) times = [Number((total / 2).toFixed(2))];
  if (times.length > MAX_FRAMES) times = Array.from({ length: MAX_FRAMES }, (_, i) => Number((((i + 0.5) * total) / MAX_FRAMES).toFixed(2)));
  const frames = [];
  for (const t of times) {
    const out = `${file}.f${String(t).replace(".", "_")}.jpg`;
    try {
      run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "4", out]);
      if (fs.existsSync(out) && fs.statSync(out).size > 0) frames.push({ t, file: out });
    } catch {
      // unreadable frame: skip
    }
  }
  return { duration: duration > 0 ? duration : null, frames };
}

async function reindex(asset) {
  const form = new FormData();
  form.append("user_id", USER);
  let detail = "server-side text";
  if (asset.media_type === "photo" && asset.download_url) {
    const file = await download(asset);
    const preview = photoPreview(file);
    form.append("preview", new Blob([fs.readFileSync(preview)], { type: "image/jpeg" }), "preview.jpg");
    detail = `preview ${(fs.statSync(preview).size / 1024).toFixed(0)} KB`;
  } else if (asset.media_type === "video" && asset.download_url) {
    const file = await download(asset);
    const { duration, frames } = videoKeyframes(file);
    for (const f of frames) form.append("frame", new Blob([fs.readFileSync(f.file)], { type: "image/jpeg" }), path.basename(f.file));
    form.append("frame_times", frames.map((f) => f.t).join(","));
    if (duration) form.append("duration_sec", String(duration));
    detail = `${frames.length} keyframe(s)${duration ? `, ${duration.toFixed(1)}s` : ""}`;
  }
  const res = await fetch(`${BASE}/api/assets/${encodeURIComponent(asset.id)}/reindex`, { method: "POST", headers, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${body.error || ""}`.trim());
  return { detail, body };
}

const listRes = await fetch(`${BASE}/api/assets/${encodeURIComponent(USER)}`, { headers });
if (!listRes.ok) throw new Error(`Listing assets failed: ${listRes.status}`);
const assets = (await listRes.json()).filter((a) => !ONLY || ONLY.has(a.id));
console.log(`Re-indexing ${assets.length} asset(s) for ${USER} on ${BASE}`);
let failed = 0;
for (const a of assets) {
  try {
    const { detail, body } = await reindex(a);
    const moments = body.video_moments?.length ? `, ${body.video_moments.length} moment(s)` : "";
    console.log(`  ✓ ${a.id}  ${a.media_type.padEnd(8)} ${a.filename}  → ${body.embedder_name} ${body.dims}-D (${detail}${moments})`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${a.id}  ${a.media_type.padEnd(8)} ${a.filename}  → ${err.message}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
