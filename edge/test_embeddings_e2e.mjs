import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

// Exercise the real upload, D1/R2, search, and reindex routes in workerd.
// Only the external AI call is mocked; no production resources or credentials are used.
const run = promisify(execFile);
const base = "http://127.0.0.1:8793";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=";
const state = await mkdtemp(join(tmpdir(), "fyde-embedding-e2e-"));
const config = join(state, "wrangler.json");
const entry = join(state, "worker.ts");
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
const wrangler = resolve("node_modules/.bin/wrangler");
let proc;
let logs = "";

try {
  await mkdir(join(state, "assets"));
  await writeFile(config, JSON.stringify({
    name: "fyde-embedding-test", main: entry, compatibility_date: "2026-03-01",
    assets: { directory: join(state, "assets"), binding: "ASSETS" },
    d1_databases: [{ binding: "DB", database_name: "fyde-db", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: resolve("migrations") }],
    r2_buckets: [{ binding: "BLOBS", bucket_name: "fyde-test-blobs" }],
    durable_objects: { bindings: [{ name: "USER_HUB", class_name: "UserRelayHub" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["UserRelayHub"] }],
    vars: { REQUIRE_INVITE_CODE: "false", ALLOW_DEMO_AUTH: "true" },
  }));
  await writeFile(entry, `
    import worker from ${JSON.stringify(resolve("src/index.ts"))};
    export { UserRelayHub } from ${JSON.stringify(resolve("src/index.ts"))};
    const vector = (axis = 0) => Array.from({length:768}, (_, i) => i === axis ? 1 : 0);
    export default {
      async fetch(request, env) {
        const mode = request.headers.get("X-Test-AI") || "ok";
        const ai = mode === "missing" ? undefined : { async run(model, input) {
          if (model !== "@cf/google/embeddinggemma-2" || input.dimensions !== 768) throw Error("wrong model");
          if (mode === "fail") throw Error("provider unavailable");
          if (mode === "bad-dims") return {data:[{embedding:[1, 0]}]};
          if (mode === "zero") return {data:[{embedding:Array(768).fill(0)}]};
          if (mode === "nonfinite") return {data:[{embedding:Array(768).fill(NaN)}]};
          if (input.input) {
            if (!input.input[0].startsWith("task: search result | query: ") && !input.input[0].startsWith("title: ")) throw Error("missing task prefix");
            return {data:[{embedding:vector(/unrelated|kayak/.test(input.input[0]) ? 1 : 0)}]};
          }
          const messages = Array.isArray(input.messages[0]) ? input.messages : [input.messages];
          return {data: messages.map((conversation, index) => {
            const part = conversation[0].content[0];
            if (part.type !== "image_url" || part.image_url.url !== "data:image/png;base64,${png}") throw Error("pixels were not supplied");
            return { index, embedding: vector() };
          })};
        }};
        return worker.fetch(request, {...env, AI: ai});
      }
    };
  `);
  await run(wrangler, ["d1", "migrations", "apply", "fyde-db", "--local", "--persist-to", state, "--config", config], { env });
  proc = spawn(wrangler, ["dev", "--local", "--config", config, "--persist-to", state,
    "--port", "8793", "--inspector-port", "0", "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
  { stdio: ["ignore", "pipe", "pipe"], env });
  proc.stdout.on("data", (d) => { logs += d; });
  proc.stderr.on("data", (d) => { logs += d; });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "test Worker must start");

  const upload = async (mode = "ok", heic = false, tags = []) => {
    const form = new FormData();
    form.set("owner_id", "mehmet");
    form.set("ocr_text", "printed words");
    form.set("tags", JSON.stringify(tags));
    form.set("file", new Blob([heic ? Buffer.from("HEIC original") : Buffer.from(png, "base64")],
      { type: heic ? "image/heic" : "image/png" }), heic ? "IMG_123.HEIC" : "IMG_123.png");
    if (heic) form.set("preview", new Blob([Buffer.from(png, "base64")], { type: "image/png" }), "preview.png");
    const response = await fetch(`${base}/api/assets/upload`, { method: "POST", headers: { "X-Test-AI": mode }, body: form });
    assert.equal(response.status, 200);
    return response.json();
  };
  const photo = await upload();
  assert.equal(photo.embedder_name, "embeddinggemma-2-768");
  assert.equal(photo.embedding.length, 768);
  assert.equal(photo.ocr_text, "printed words");
  assert.equal(photo.summary, "", "OCR must remain separate from a caption");
  const stored = await (await fetch(`${base}/api/assets/mehmet`)).json();
  assert.deepEqual(stored.find((a) => a.id === photo.id).embedding, photo.embedding);
  assert.deepEqual(Buffer.from(await (await fetch(`${base}${photo.download_url}`)).arrayBuffer()), Buffer.from(png, "base64"));
  console.log("✓ Photo pixels produce a persisted 768-D index and preserve the original");

  const search = async (query) => {
    const response = await fetch(`${base}/api/search`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "mehmet", query, scope: "mine" }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.ok((await search("people at an event")).some((h) => h.asset.id === photo.id), "visual search must work without matching metadata");
  assert.ok(!(await search("unrelated subject")).some((h) => h.asset.id === photo.id));
  console.log("✓ Search embeds queries in the same space and rejects unrelated images");

  const rafting = await upload("ok", false, ["rafting", "watersport", "oar"]);
  const related = await search("kayak photos");
  assert.ok(related.some((hit) => hit.asset.id === rafting.id), "Related tags remain searchable even when visual vectors disagree");
  assert.ok(!related.some((hit) => hit.asset.id === photo.id), "A related tag must not match an untagged, unrelated image");
  console.log("✓ Kayak search finds rafting tags on an existing visual index");

  const heic = await upload("ok", true);
  assert.equal(heic.embedder_name, "embeddinggemma-2-768");
  assert.equal(await (await fetch(`${base}${heic.download_url}`)).text(), "HEIC original");
  console.log("✓ HEIC uses the supplied preview while retaining the original");

  for (const mode of ["missing", "fail", "bad-dims", "zero", "nonfinite"]) {
    const fallback = await upload(mode);
    assert.equal(fallback.embedder_name, "fyde-edge-mrl256", mode);
    assert.equal(fallback.embedding.length, 256, mode);
    assert.ok((await search("printed words")).some((h) => h.asset.id === fallback.id), "OCR stays searchable during fallback");
  }
  console.log("✓ Missing AI, provider failures, and invalid vectors keep an honest text fallback");

  const demo = async (handle) => {
    const response = await fetch(`${base}/api/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle }) });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  const ownerToken = await demo("mehmet");
  const otherToken = await demo("sarah");
  const reindex = (id, token, mode = "ok") => fetch(`${base}/api/assets/${id}/reindex`, {
    method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-Test-AI": mode },
  });
  assert.equal((await reindex(photo.id)).status, 401);
  assert.equal((await reindex(photo.id, otherToken)).status, 403);
  const legacy = await upload("missing");
  const updated = await reindex(legacy.id, ownerToken);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).dims, 768);
  assert.equal((await reindex(photo.id, ownerToken, "fail")).status, 503);
  const after = await (await fetch(`${base}/api/assets/mehmet`)).json();
  assert.deepEqual(after.find((a) => a.id === photo.id).embedding, photo.embedding, "failed reindex must keep a working visual index");
  assert.equal(after.find((a) => a.id === legacy.id).embedder_name, "embeddinggemma-2-768");
  console.log("✓ Only owners can reindex; existing photos upgrade and failed retries preserve their index");
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  proc?.kill("SIGTERM");
  if (proc && proc.exitCode === null) await new Promise((r) => proc.once("exit", r));
  await rm(state, { recursive: true, force: true });
}
