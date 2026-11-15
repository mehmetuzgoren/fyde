# Fyde

Agent-native photo, video, and file sharing powered by multimodal vector embeddings and a permissioned peer-to-peer network—across **iOS**, **macOS**, **Web**, and **wrist wearables**.

---

## Why Fyde?

### 1. Google Drive and Dropbox Are Visually Blind to AI Agents
Cloud storage providers like **Google Drive** and **Dropbox** do not provide pixel-level vector embeddings for videos and photos—at best, they fall back to filenames, metadata, or OCR/transcript text search inside media.

When you connect an AI agent to Google Drive, you **cannot** just ask:
> *"Find me my demo video at the YC hackathon last week."*

If that recording is saved as `IMG_4829.MOV` and nobody says *"YC hackathon"* on camera, Drive cannot determine what the video is actually about.

**Fyde embeds media directly from pixels.** Using **EmbeddingGemma 2** multimodal vectors across photos, video keyframes (with scene-level timestamps), and documents, you can simply describe an image or video moment to your agent in plain English. Fyde finds the exact asset—and exact timestamp—making referencing and sending media **10x easier**.

### 2. The Network Effect: Never Sift Through 1,000 Group Trip Photos Again
Almost everyone has lived through the post-trip bottleneck: asking a friend to send the group photos after a long trip, only for both of you to dread sifting through 1,000 camera-roll shots to pick out the right ones.

Because Fyde connects people through a **permissioned peer-to-peer network**, your agent can work across libraries. Instead of nagging your friend to manually sort an album, you just tell your agent:
> *"Get all the photos from the group trip from Alex where I'm in the photo."*

Within the permissions your friend grants, Fyde searches their library semantically—matching the trip, visual context, and who is in frame—and delivers only the matching photos straight into your library or Apple Photos.

---

## How It Works

- **Pixel-Level Multimodal Search:** Photos and sampled video keyframes are embedded into a shared 768-D vector space (`@cf/google/embeddinggemma-2` on Cloudflare Workers AI, plus local CoreML / Python fallback) alongside PDFs and documents. Video hits jump straight to the matched moment.
- **Agentic Send & Pull:** Tell Fyde Chat (by text or wrist voice via **Vexo**) what to find or send—delivering directly over **Fyde P2P**, **iMessage** (`Messages.app` / iOS composer), or **Email**.
- **Folderless Smart Permissions:** No manual album curation required. Set per-contact access to:
  - **Trusted:** Automatic retrieval for close contacts (e.g., family or co-founders).
  - **Smart Scope:** Natural-language rules like *"Allow Alex to access group trip photos with him"* enforced automatically via metadata + vector similarity.
  - **Ask First:** Out-of-scope requests trigger a 1-tap approval card without leaking private filenames beforehand.
- **Direct to Apple Photos:** Incoming bundles on iPhone and Mac save directly into Apple Photos via `PhotoKit`.

---

## Image titles

Fyde uses [Gemini 4 Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen) to summarize uploaded photos and name them from their visible content. The title and summary appear in the library and search results; the original filename and file stay intact. If Gemini is unavailable, the upload keeps its supplied title or filename.

Set `GEMINI_API_KEY` in the backend environment. For local Cloudflare development, put it in the ignored `edge/.dev.vars` file. The local relay launcher also reads the ignored `.env` file at the project root. For direct Uvicorn runs from `server/`, pass `--env-file ../.env`. Keep the key on the server. A deployed Worker reads it from a Cloudflare secret.

The apps can send a JPEG preview alongside an original image, including HEIC. Gemini uses that preview when available. Existing Edge photos get a generated title when their owner reindexes them.

## Repository Structure

```text
fyde/
├── edge/          # Cloudflare Worker API, D1, R2, Durable Objects & Workers AI (EmbeddingGemma 2)
├── apple/         # Native SwiftUI app + FydeKit framework for iOS 18+ & macOS 15+
├── web/           # React + TypeScript + Vite web client
├── server/        # Local FastAPI + WebSocket P2P relay, multimodal embedder & iMessage/Email bridges
├── vexo/          # Vexo wristband BLE/USB voice-to-Fyde agent bridge
└── start_dev.sh   # One-command launcher for local relay (:8765) + web client (:5173)
```

---

## Quick Start

### Local Relay + Web App
```bash
./start_dev.sh
```
- **Web App:** `http://localhost:5173`
- **Local Relay API:** `http://127.0.0.1:8765`

### Cloudflare Edge Stack (Workers AI + D1 + R2)
```bash
cd edge
npm run db:migrate:local
npm run dev
```

### iOS & macOS App
```bash
open apple/FydeApp/Fyde.xcodeproj
```
Select an **iPhone Simulator**, physical **iPhone**, or **My Mac** target in Xcode and press **Run (`⌘R`)**.
