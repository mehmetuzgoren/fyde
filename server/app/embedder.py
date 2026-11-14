from __future__ import annotations

import hashlib
import io
import math
import os
import re
import subprocess
import tempfile
from pathlib import Path

import httpx
import numpy as np
from PIL import Image
from pypdf import PdfReader

from .models import VideoMoment

EMBEDDING_DIM = 256  # Matryoshka Representation Learning (MRL) 256-D slice of 768-D

# Semantic concept clusters bridge cross-modal vocabulary in zero-download offline mode
CONCEPT_SYNONYMS: dict[str, list[str]] = {
    "china": ["china", "beijing", "shanghai", "great wall", "bund", "asia", "chinese", "lantern", "temple", "trip", "travel"],
    "japan": ["japan", "tokyo", "kyoto", "shibuya", "fuji", "shrine", "asia", "trip", "travel"],
    "travel": ["trip", "vacation", "holiday", "flight", "hotel", "tour", "sightseeing", "landmark", "journey", "abroad"],
    "beach": ["beach", "ocean", "sea", "surf", "surfing", "waves", "coast", "sand", "summer", "swim", "water"],
    "passport": ["passport", "id", "identification", "visa", "citizenship", "border", "travel document", "scan"],
    "tax": ["tax", "taxes", "irs", "w2", "1099", "return", "accountant", "deduction", "finance", "filing", "fiscal"],
    "invoice": ["invoice", "receipt", "bill", "payment", "expense", "statement", "vet", "clinic", "medical"],
    "family": ["wife", "husband", "spouse", "partner", "family", "wedding", "anniversary", "home", "dinner", "together"],
    "whiteboard": ["whiteboard", "diagram", "architecture", "sketch", "design", "api", "flowchart", "notes", "meeting"],
    "outdoor": ["mountain", "hike", "hiking", "sunset", "sunrise", "nature", "park", "trail", "forest", "sky"],
    "pet": ["dog", "puppy", "cat", "kitten", "pet", "vet", "golden retriever", "walk"],
}


def _l2_normalize(vec: np.ndarray) -> list[float]:
    norm = float(np.linalg.norm(vec))
    if norm < 1e-9:
        return [0.0] * len(vec)
    return [round(float(x / norm), 6) for x in vec]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    va = np.asarray(a[:n], dtype=np.float32)
    vb = np.asarray(b[:n], dtype=np.float32)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    if denom < 1e-9:
        return 0.0
    return float(np.dot(va, vb) / denom)


def _hash_feature(token: str, dim: int = EMBEDDING_DIM) -> tuple[int, float]:
    digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
    val = int.from_bytes(digest, "little")
    idx = val % dim
    sign = 1.0 if ((val >> 32) & 1) == 0 else -1.0
    return idx, sign


def _embed_text_local(text: str, dim: int = EMBEDDING_DIM) -> np.ndarray:
    vec = np.zeros(dim, dtype=np.float32)
    cleaned = text.lower().strip()
    if not cleaned:
        return vec

    words = re.findall(r"[a-z0-9]+", cleaned)
    # 1. Word unigrams & bigrams
    for i, w in enumerate(words):
        idx, sign = _hash_feature(f"w:{w}", dim)
        vec[idx] += 2.2 * sign
        # Stem-like prefix for morphology (e.g. surfing -> surf, photos -> photo)
        if len(w) >= 5:
            p_idx, p_sign = _hash_feature(f"stem:{w[:4]}", dim)
            vec[p_idx] += 1.1 * p_sign
        if i + 1 < len(words):
            b_idx, b_sign = _hash_feature(f"bi:{w}_{words[i+1]}", dim)
            vec[b_idx] += 1.4 * b_sign

    # 2. Character trigrams for typo/OCR resilience
    compact = " ".join(words)
    for i in range(max(0, len(compact) - 2)):
        tri = compact[i : i + 3]
        idx, sign = _hash_feature(f"c3:{tri}", dim)
        vec[idx] += 0.25 * sign

    # 3. Cross-modal semantic concept activation
    word_set = set(words)
    for concept, terms in CONCEPT_SYNONYMS.items():
        matched = any(
            (t in cleaned if " " in t else t in word_set)
            for t in terms
        )
        if matched:
            c_idx, c_sign = _hash_feature(f"concept:{concept}", dim)
            vec[c_idx] += 3.5 * c_sign
            for syn in terms[:5]:
                s_idx, s_sign = _hash_feature(f"w:{syn}", dim)
                vec[s_idx] += 0.9 * s_sign

    return vec


def _extract_image_visual_tags_and_vector(image_bytes: bytes, dim: int = EMBEDDING_DIM) -> tuple[list[str], np.ndarray]:
    """Extracts visual color/scene features + heuristic visual descriptors into the shared 256-D space."""
    visual_vec = np.zeros(dim, dtype=np.float32)
    inferred_tags: list[str] = []
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            rgb = img.convert("RGB").resize((32, 32))
            arr = np.asarray(rgb, dtype=np.float32) / 255.0  # (32, 32, 3)

            mean_r = float(arr[:, :, 0].mean())
            mean_g = float(arr[:, :, 1].mean())
            mean_b = float(arr[:, :, 2].mean())
            brightness = (mean_r + mean_g + mean_b) / 3.0
            std_lum = float(arr.std())

            # Detect visual scene characteristics
            if brightness > 0.82 and std_lum < 0.22:
                inferred_tags.extend(["document", "scan", "paper", "whiteboard"])
            elif mean_b > mean_r + 0.12 and mean_b > 0.45:
                inferred_tags.extend(["ocean", "sky", "beach", "water", "outdoor"])
            elif mean_r > mean_b + 0.18 and mean_r > 0.55:
                inferred_tags.extend(["sunset", "warm", "lantern", "china", "indoor"])
            elif mean_g > mean_r + 0.08 and mean_g > mean_b + 0.08:
                inferred_tags.extend(["nature", "park", "mountain", "outdoor"])

            # 4x4 spatial color grid signature mapped into gentle dimensions
            grid = rgb.resize((4, 4))
            g_arr = np.asarray(grid, dtype=np.float32).flatten() / 255.0
            for i, val in enumerate(g_arr):
                visual_vec[(200 + i) % dim] += (float(val) - 0.5) * 0.6
    except Exception:
        pass

    if inferred_tags:
        visual_vec += 0.6 * _embed_text_local(" ".join(inferred_tags), dim)
    return inferred_tags, visual_vec


def extract_pdf_text(pdf_bytes: bytes, max_pages: int = 8) -> str:
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        chunks: list[str] = []
        for page in reader.pages[:max_pages]:
            txt = page.extract_text() or ""
            if txt.strip():
                chunks.append(txt.strip())
        return "\n".join(chunks)[:6000]
    except Exception:
        return ""


def extract_video_keyframes_ffmpeg(video_path: Path, max_frames: int = 4) -> tuple[float | None, list[tuple[float, bytes]]]:
    """Uses ffmpeg/ffprobe if available to sample evenly spaced keyframes and timestamps."""
    duration: float | None = None
    frames: list[tuple[float, bytes]] = []
    try:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            duration = float(probe.stdout.strip())
    except Exception:
        duration = None

    total = duration if (duration and duration > 0.5) else 4.0
    timestamps = [round(total * (i + 0.5) / max_frames, 1) for i in range(max_frames)]
    for ts in timestamps:
        try:
            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=True) as tmp:
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-ss",
                    str(ts),
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-q:v",
                    "4",
                    tmp.name,
                ]
                res = subprocess.run(cmd, capture_output=True, timeout=5)
                if res.returncode == 0 and Path(tmp.name).stat().st_size > 0:
                    frames.append((ts, Path(tmp.name).read_bytes()))
        except Exception:
            continue
    return duration, frames


class MultimodalEmbedder:
    """
    Pluggable multimodal embedder supporting:
    1. EmbeddingGemma 2 remote/local server (`EMBEDDING_GEMMA_URL`, e.g. llama.cpp / MLX / LiteRT server)
       with native Matryoshka truncation to 256-D.
    2. Google Gemini Multimodal Embeddings (`GEMINI_API_KEY` + `FYDE_EMBEDDER=gemini`).
    3. Fast zero-download local multimodal fallback (`fyde-multimodal-256`) combining visual scene
       descriptors, PDF extraction, video keyframe sampling, and semantic concept projection.
    """

    def __init__(self) -> None:
        self.gemma_url = os.getenv("EMBEDDING_GEMMA_URL", "").strip()
        self.gemini_api_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.preferred = os.getenv("FYDE_EMBEDDER", "auto").lower()

    @property
    def active_provider_name(self) -> str:
        if self.gemma_url:
            return "embeddinggemma-2-mrl256"
        if self.gemini_api_key and self.preferred == "gemini":
            return "gemini-embedding-mrl256"
        return "embeddinggemma-2-compatible-local-256"

    def embed_query(self, query: str) -> list[float]:
        # Try EmbeddingGemma 2 HTTP endpoint if configured
        if self.gemma_url:
            remote = self._call_embedding_gemma(text=f"task: search result | query: {query}")
            if remote:
                return remote

        if self.gemini_api_key and self.preferred == "gemini":
            remote = self._call_gemini_embedding(query)
            if remote:
                return remote

        vec = _embed_text_local(query, EMBEDDING_DIM)
        return _l2_normalize(vec)

    def embed_asset(
        self,
        *,
        filename: str,
        title: str,
        media_type: str,
        location: str = "",
        people: list[str] | None = None,
        tags: list[str] | None = None,
        ocr_text: str = "",
        summary: str = "",
        raw_bytes: bytes | None = None,
        file_path: Path | None = None,
        preset_moments: list[tuple[float, str]] | None = None,
    ) -> tuple[list[float], list[VideoMoment], str, float | None]:
        """Returns (asset_embedding_256d, video_moments, extracted_text, duration_sec)."""
        people = people or []
        tags = list(tags or [])
        extracted_text = ocr_text
        duration_sec: float | None = None
        moments: list[VideoMoment] = []
        visual_vec = np.zeros(EMBEDDING_DIM, dtype=np.float32)

        if media_type == "document" and raw_bytes and filename.lower().endswith(".pdf") and not extracted_text:
            extracted_text = extract_pdf_text(raw_bytes)
        elif media_type == "document" and raw_bytes and not extracted_text:
            try:
                extracted_text = raw_bytes.decode("utf-8", errors="ignore")[:4000]
            except Exception:
                pass

        if media_type == "photo" and raw_bytes:
            v_tags, v_vec = _extract_image_visual_tags_and_vector(raw_bytes)
            visual_vec += v_vec
            for t in v_tags:
                if t not in tags:
                    tags.append(t)

        if media_type == "video":
            if preset_moments:
                for ts, label in preset_moments:
                    m_vec = _l2_normalize(_embed_text_local(f"{title} {location} {' '.join(people)} {label}"))
                    moments.append(VideoMoment(timestamp_sec=ts, label=label, embedding=m_vec))
            if file_path and file_path.exists():
                dur, sampled = extract_video_keyframes_ffmpeg(file_path)
                if dur:
                    duration_sec = dur
                if sampled and not moments:
                    for ts, frame_bytes in sampled:
                        v_tags, v_vec = _extract_image_visual_tags_and_vector(frame_bytes)
                        label = f"Visual frame @ {ts:.1f}s ({', '.join(v_tags[:2]) or 'scene'})"
                        combined = _embed_text_local(f"{title} {summary} {' '.join(v_tags)}") + v_vec
                        moments.append(
                            VideoMoment(
                                timestamp_sec=ts,
                                label=label,
                                embedding=_l2_normalize(combined),
                            )
                        )
                        visual_vec += 0.35 * v_vec

        composite_doc = " | ".join(
            part
            for part in [
                title,
                filename.replace("_", " ").replace("-", " "),
                f"type:{media_type}",
                f"location:{location}" if location else "",
                f"people:{' '.join(people)}" if people else "",
                " ".join(tags),
                summary,
                extracted_text[:2000],
                " ".join(m.label for m in moments),
            ]
            if part
        )

        if self.gemma_url:
            remote = self._call_embedding_gemma(text=f"title: {title} | text: {composite_doc}")
            if remote:
                return remote, moments, extracted_text, duration_sec

        text_vec = _embed_text_local(composite_doc, EMBEDDING_DIM)
        final_vec = _l2_normalize(text_vec + visual_vec)
        return final_vec, moments, extracted_text, duration_sec

    def _call_embedding_gemma(self, text: str) -> list[float] | None:
        """Calls an OpenAI/llama.cpp/MLX-compatible `/v1/embeddings` EmbeddingGemma 2 server and slices MRL 256-D."""
        try:
            resp = httpx.post(
                f"{self.gemma_url.rstrip('/')}/v1/embeddings",
                json={"model": "embeddinggemma-2", "input": text},
                timeout=6.0,
            )
            resp.raise_for_status()
            data = resp.json()
            raw = data["data"][0]["embedding"][:EMBEDDING_DIM]
            return _l2_normalize(np.asarray(raw, dtype=np.float32))
        except Exception:
            return None

    def _call_gemini_embedding(self, text: str) -> list[float] | None:
        try:
            url = (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"gemini-embedding-001:embedContent?key={self.gemini_api_key}"
            )
            resp = httpx.post(
                url,
                json={
                    "content": {"parts": [{"text": text}]},
                    "outputDimensionality": EMBEDDING_DIM,
                },
                timeout=6.0,
            )
            resp.raise_for_status()
            vals = resp.json()["embedding"]["values"][:EMBEDDING_DIM]
            return _l2_normalize(np.asarray(vals, dtype=np.float32))
        except Exception:
            return None
