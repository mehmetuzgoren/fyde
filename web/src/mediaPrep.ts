// Inputs for the relay's EmbeddingGemma 2 index, made in the browser before upload:
// a ~1536 px JPEG preview of photos (1536 px matched full-size quality in our measurements)
// and keyframes of videos every few seconds (each becomes a searchable, seekable moment).
// Anything the browser can't decode is skipped and the relay embeds the original instead.

const PREVIEW_MAX_SIDE = 1536;
const FRAME_MAX_SIDE = 768;
const FRAME_EVERY_SEC = 3;
const MAX_FRAMES = 24;
const SEEK_TIMEOUT_MS = 4000;

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
}

function sizedCanvas(width: number, height: number, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

export async function makeImagePreview(file: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const canvas = sizedCanvas(bitmap.width, bitmap.height, PREVIEW_MAX_SIDE);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await canvasToJpeg(canvas, 0.85);
  } catch {
    return null; // e.g. HEIC outside Safari
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
    function finish(ok: boolean) {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve(ok);
    }
    function onSeeked() {
      finish(true);
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

export async function extractVideoKeyframes(
  file: Blob
): Promise<{ duration: number | null; frames: Array<{ t: number; blob: Blob }> }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    const loaded = await new Promise<boolean>((resolve) => {
      video.onloadeddata = () => resolve(true);
      video.onerror = () => resolve(false);
      window.setTimeout(() => resolve(false), 10000);
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!loaded || duration <= 0 || !video.videoWidth) return { duration: null, frames: [] };

    let times: number[] = [];
    for (let t = Math.min(0.5, duration / 2); t < duration; t += FRAME_EVERY_SEC) times.push(t);
    if (times.length === 0) times = [duration / 2];
    if (times.length > MAX_FRAMES) times = Array.from({ length: MAX_FRAMES }, (_, i) => ((i + 0.5) * duration) / MAX_FRAMES);

    const canvas = sizedCanvas(video.videoWidth, video.videoHeight, FRAME_MAX_SIDE);
    const ctx = canvas.getContext("2d");
    const frames: Array<{ t: number; blob: Blob }> = [];
    for (const t of times) {
      if (!ctx || !(await seek(video, t))) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToJpeg(canvas, 0.8);
      if (blob) frames.push({ t: Math.round(t * 100) / 100, blob });
    }
    return { duration, frames };
  } catch {
    return { duration: null, frames: [] };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Adds `preview` (photos) or `frame` + `frame_times` + `duration_sec` (videos) to an upload form. */
export async function appendEmbeddingInputs(form: FormData, file: File): Promise<void> {
  if (file.type.startsWith("image/")) {
    const preview = await makeImagePreview(file);
    if (preview) form.append("preview", preview, "preview.jpg");
  } else if (file.type.startsWith("video/")) {
    const { duration, frames } = await extractVideoKeyframes(file);
    frames.forEach((f, i) => form.append("frame", f.blob, `frame_${i}.jpg`));
    if (frames.length > 0) form.append("frame_times", frames.map((f) => f.t).join(","));
    if (duration) form.append("duration_sec", duration.toFixed(2));
  }
}
