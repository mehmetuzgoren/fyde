import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runVoiceSendScenarios } from "./test_voice_send_e2e.mjs";

const BASE = "http://127.0.0.1:8789";
const run = promisify(execFile);

async function waitForReady(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("Timed out waiting for wrangler dev");
}

async function main() {
  // Each run starts with the seeded permissions, independent of other dev/test sessions.
  const state = await mkdtemp(join(tmpdir(), "fyde-edge-e2e-"));
  const env = { ...process.env, CI: "1" };
  const wrangler = "./node_modules/.bin/wrangler";
  await run(wrangler, ["d1", "migrations", "apply", "fyde-db", "--local", "--persist-to", state], { env });
  const executeSql = async (sql) => {
    const file = join(state, "fixture.sql");
    await writeFile(file, sql);
    await run(wrangler, ["d1", "execute", "fyde-db", "--local", "--persist-to", state, "--file", file], { env });
  };
  const proc = spawn(
    wrangler,
    ["dev", "--local", "--persist-to", state, "--port", "8789", "--inspector-port", "0", "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
    { stdio: ["ignore", "pipe", "pipe"], env }
  );

  let logs = "";
  proc.stdout.on("data", (d) => (logs += d.toString()));
  proc.stderr.on("data", (d) => (logs += d.toString()));

  try {
    const health = await waitForReady(BASE);
    assert.equal(health.status, "ok");
    assert.equal(health.domain, "fyde.izbirakin.com");
    console.log("✓ 1. Cloudflare Worker health check passed:", health.architecture);

    // 2. Static Assets (`fyde.izbirakin.com` Landing HTML + Logo + `f.` Favicon)
    const htmlRes = await fetch(`${BASE}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes("fyde."), "Index HTML should include fyde. brand title");
    assert.ok(html.includes("/favicon.svg"), "Index HTML should link /favicon.svg");

    const logoRes = await fetch(`${BASE}/logo.png`);
    assert.equal(logoRes.status, 200);
    const favRes = await fetch(`${BASE}/favicon.svg`);
    assert.equal(favRes.status, 200);
    console.log("✓ 2. Static Assets served `/` landing HTML, `/logo.png`, and `/favicon.svg` (`f.`)");

    // 3. Waitlist API (D1)
    const testWlEmail = `founder_${Date.now()}@izbirakin.com`;
    const wlRes = await fetch(`${BASE}/api/waitlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: testWlEmail, name: "Mehmet", platform_interest: "ios_macos" }),
    });
    assert.equal(wlRes.status, 200);
    const wlData = await wlRes.json();
    assert.equal(wlData.already_joined, false);
    assert.ok(wlData.entry.position >= 341);
    assert.ok(wlData.entry.invite_code.startsWith("FYDE-"));
    console.log(`✓ 3. Waitlist D1 persistence passed (Spot #${wlData.entry.position}, Code ${wlData.entry.invite_code})`);

    // 4. Passwordless 6-Digit Email OTP + Session JWT
    const otpEmail = `otp_${Date.now()}@izbirakin.com`;
    const sendOtpRes = await fetch(`${BASE}/api/auth/email/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: otpEmail }),
    });
    assert.equal(sendOtpRes.status, 200);
    const sendOtpData = await sendOtpRes.json();
    assert.equal(sendOtpData.sent, true);
    assert.equal(sendOtpData.dev_code_hint.length, 6);

    const verifyRes = await fetch(`${BASE}/api/auth/email/verify-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: otpEmail, code: sendOtpData.dev_code_hint, display_name: "OTP Tester" }),
    });
    assert.equal(verifyRes.status, 200);
    const verifyData = await verifyRes.json();
    assert.ok(verifyData.token);
    assert.equal(verifyData.user.email, otpEmail);

    const meRes = await fetch(`${BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${verifyData.token}` },
    });
    const meData = await meRes.json();
    assert.equal(meData.authenticated, true);
    assert.equal(meData.user.id, verifyData.user.id);
    console.log("✓ 4. Passwordless 6-digit Email OTP + Bearer JWT session verified");

    // 5. Email + Password (Web Crypto PBKDF2-SHA256)
    const pwEmail = `pw_${Date.now()}@izbirakin.com`;
    const regRes = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pwEmail, password: "superSecretPassword99!", display_name: "PW Member" }),
    });
    assert.equal(regRes.status, 200);
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pwEmail, password: "superSecretPassword99!" }),
    });
    assert.equal(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.ok(loginData.token);
    console.log("✓ 5. Email + Password PBKDF2-SHA256 registration & login verified");

    // 6. Billing Plans + Subscription Checkout
    const plansRes = await fetch(`${BASE}/api/billing/plans`);
    const plansData = await plansRes.json();
    assert.equal(plansData.plans.length, 3);

    const checkoutRes = await fetch(`${BASE}/api/billing/checkout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ tier: "family", interval: "yearly" }),
    });
    assert.equal(checkoutRes.status, 200);
    const checkoutData = await checkoutRes.json();
    assert.equal(checkoutData.plan_tier, "family");

    const meAfterUpgrade = await (
      await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${loginData.token}` } })
    ).json();
    assert.equal(meAfterUpgrade.user.plan_tier, "family");
    console.log("✓ 6. Billing Plans & Subscription upgrade to fyde. Household verified");

    // 7. Durable Object WebSocket Hibernation + Multimodal Search + Smart Scope Pull + R2 Range Streaming
    const wsEvents = [];
    const ws = new WebSocket(`ws://127.0.0.1:8789/ws/maya?device_id=test_ios&platform=ios`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    ws.addEventListener("message", (evt) => {
      wsEvents.push(JSON.parse(String(evt.data)));
    });

    // Mehmet sends China trip photos to Maya via Chat
    const chatSend = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "mehmet", text: "Send China trip photos to Maya" }),
      })
    ).json();
    assert.equal(chatSend.action_card.action_type, "send_completed");

    await new Promise((r) => setTimeout(r, 250));
    assert.ok(wsEvents.some((e) => e.event === "bundle_received"), "Maya DO WebSocket should receive bundle_received");
    ws.close();

    // Maya pulls passport scans via Trusted Spouse permission
    const mayaPull = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "maya", text: "Get our passport scans from Mehmet's files" }),
      })
    ).json();
    assert.equal(mayaPull.action_card.action_type, "peer_pull_completed");

    // Mehmet grants Alex folderless Smart Scope & Alex pulls China trip photos vs restricted tax return
    await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "mehmet", text: "Allow Alex to access all my China trip photos with him" }),
    });
    const alexAllowed = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "alex", text: "Get China trip photos from Mehmet" }),
      })
    ).json();
    assert.equal(alexAllowed.action_card.action_type, "peer_pull_completed");

    const alexBlocked = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "alex", text: "Get 2025 tax return from Mehmet" }),
      })
    ).json();
    assert.equal(alexBlocked.action_card.action_type, "peer_request_pending");

    // R2 Byte-Range Request (`206 Partial Content`)
    const blobUrl = alexAllowed.action_card.previews[0].download_url;
    const rangeRes = await fetch(`${BASE}${blobUrl}`, { headers: { Range: "bytes=0-31" } });
    assert.equal(rangeRes.status, 206);
    assert.ok((rangeRes.headers.get("Content-Range") || "").startsWith("bytes 0-31/"));
    console.log("✓ 7. Durable Object WebSocket + Trusted/Smart-Scope P2P + R2 206 Byte-Range streaming verified!");

    // 7b. Received files show up in the recipient's search. Sarah is Ask-First (no library
    // access to Mehmet), so the only way she can find his tax return is that he sent it to her.
    const sentToSarah = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_id: "mehmet",
        asset_ids: ["asset_tax_return_2025"],
        recipient_name: "Sarah",
        recipient_user_id: "sarah",
        channel: "fyde_direct",
      }),
    });
    assert.equal(sentToSarah.status, 200);
    const sarahSearch = async (scope, query = "tax return", filters = {}) =>
      (
        await fetch(`${BASE}/api/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id: "sarah", query, scope, ...filters }),
        })
      ).json();
    for (const scope of ["all", "contacts"]) {
      const hits = await sarahSearch(scope);
      const hit = hits.find((h) => h.asset.id === "asset_tax_return_2025");
      assert.ok(hit, `Sarah's "${scope}" search should find the tax return Mehmet sent her`);
      assert.ok(hit.match_reason.startsWith("Received from Mehmet"), `unexpected reason: ${hit.match_reason}`);
      assert.equal(hits.filter((h) => h.asset.id === "asset_tax_return_2025").length, 1, "listed once");
      assert.equal(hit.asset.owner_id, "mehmet", "Received file keeps its original ownership");
      const documents = await sarahSearch(scope, "tax return", { media_type: "document" });
      assert.ok(documents.some((h) => h.asset.id === "asset_tax_return_2025"), "Document filter includes received PDF");
      const photos = await sarahSearch(scope, "tax return", { media_type: "photo" });
      assert.ok(!photos.some((h) => h.asset.id === "asset_tax_return_2025"), "Photo filter excludes received PDF");
    }
    const recent = await sarahSearch("all", "");
    assert.ok(recent.some((h) => h.asset.id === "asset_tax_return_2025"), "Received file listed with no query");
    const mine = await sarahSearch("mine");
    assert.ok(!mine.some((h) => h.asset.id === "asset_tax_return_2025"), "Received file is not in Sarah's own library");

    const resend = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sender_id: "mehmet", asset_ids: ["asset_tax_return_2025"],
        recipient_name: "Sarah", recipient_user_id: "sarah", channel: "fyde_direct",
      }),
    });
    assert.equal(resend.status, 200);
    const resentBundle = await resend.json();
    const accepted = await fetch(`${BASE}/api/bundles/${resentBundle.id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "sarah", destination_type: "files", album_or_folder: "Taxes" }),
    });
    assert.equal(accepted.status, 200);
    const sharedAfterAccept = await sarahSearch("contacts");
    const acceptedHits = sharedAfterAccept.filter((h) => h.asset.id === "asset_tax_return_2025");
    assert.equal(acceptedHits.length, 1, "Repeated and accepted shares are listed once");
    assert.ok(acceptedHits[0].asset.folder_path.includes("Taxes"), "Search reflects the accepted destination");

    const trusted = await fetch(`${BASE}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner_id: "mehmet", contact_user_id: "sarah", contact_name: "Sarah", tier: "trusted" }),
    });
    assert.equal(trusted.status, 200);
    const trustedHits = await sarahSearch("all");
    assert.equal(trustedHits.filter((h) => h.asset.id === "asset_tax_return_2025").length, 1, "Received and permitted-library hits are deduplicated");
    console.log("✓ 7b. Received files are searchable by the recipient (Everything + Shared with me)");

    // 8. Social Graph: @handle claim, @handle search, friend request + accept, activity feed & Chat @mention
    const customHandle = `tester_${String(Date.now()).slice(-5)}`;
    const handleRes = await fetch(`${BASE}/api/auth/handle`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ handle: `@${customHandle}`, display_name: "Handle Tester", bio: "Testing @handles on fyde." }),
    });
    assert.equal(handleRes.status, 200);
    const handleData = await handleRes.json();
    assert.equal(handleData.user.handle, customHandle);
    assert.equal(handleData.user.bio, "Testing @handles on fyde.");

    const searchUserRes = await fetch(`${BASE}/api/users/search?q=@${customHandle}`, {
      headers: { Authorization: `Bearer ${verifyData.token}` },
    });
    assert.equal(searchUserRes.status, 200);
    const searchUsers = await searchUserRes.json();
    assert.ok(searchUsers.some((u) => u.handle === customHandle), "User search by @handle should find customHandle");

    // OTP user adds customHandle via @mention in Chat
    const addViaChat = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${verifyData.token}`,
        },
        body: JSON.stringify({ text: `Add @${customHandle} as a friend` }),
      })
    ).json();
    assert.equal(addViaChat.action_card.action_type, "friend_request_sent");

    // customHandle views incoming request & accepts it
    const overviewBefore = await (
      await fetch(`${BASE}/api/social/overview`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      })
    ).json();
    assert.equal(overviewBefore.incoming_requests.length, 1);

    const acceptFriendRes = await fetch(`${BASE}/api/social/request/${overviewBefore.incoming_requests[0].id}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loginData.token}`,
      },
      body: JSON.stringify({ decision: "accept" }),
    });
    assert.equal(acceptFriendRes.status, 200);

    const overviewAfter = await (
      await fetch(`${BASE}/api/social/overview`, {
        headers: { Authorization: `Bearer ${loginData.token}` },
      })
    ).json();
    assert.ok(overviewAfter.friends.some((f) => f.id === verifyData.user.id), "Accepted friend should appear in friends list");
    assert.ok(overviewAfter.feed.length >= 1, "Social activity feed should include connection event");

    // Verify @mention in Chat works for Mehmet -> @maya
    const atSend = await (
      await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "mehmet", text: "Send China trip photos to @maya" }),
      })
    ).json();
    assert.equal(atSend.action_card.action_type, "send_completed");
    console.log("✓ 8. Social @handle claim, directory search, friend requests, activity feed & Chat @mentions verified!");

    // Send authorization: every asset must belong to the resolved sender.
    const mayaLoginRes = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "maya@izbirakin.com", password: "fyde2026" }),
    });
    assert.equal(mayaLoginRes.status, 200);
    const mayaSession = await mayaLoginRes.json();
    const sendAsMaya = (assetIds, overrides = {}) => fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mayaSession.token}`,
        Origin: BASE,
      },
      body: JSON.stringify({
        sender_id: "maya",
        asset_ids: assetIds,
        recipient_name: "Sarah",
        recipient_user_id: "sarah",
        channel: "fyde_direct",
        ...overrides,
      }),
    });
    const inbox = async (id) => {
      const res = await fetch(`${BASE}/api/received/${id}`);
      assert.equal(res.status, 200);
      return res.json();
    };
    const beforeMaya = await inbox("maya");
    const beforeSarah = await inbox("sarah");
    const ownedId = "asset_maya_vet_invoice";
    const foreignId = "asset_tax_return_2025";
    const missingId = "asset_does_not_exist";
    let forbiddenBody;
    for (const channel of ["fyde_direct", "email", "imessage"]) {
      for (const ids of [[foreignId], [ownedId, foreignId], [foreignId, ownedId], [ownedId, missingId], [missingId]]) {
        const res = await sendAsMaya(ids, { channel });
        assert.equal(res.status, 403, `${channel}: reject the entire batch ${JSON.stringify(ids)}`);
        assert.equal(res.headers.get("Access-Control-Allow-Origin"), BASE);
        const body = await res.json();
        assert.equal(typeof body.error, "string");
        forbiddenBody ??= body;
        assert.deepEqual(body, forbiddenBody, "Missing and foreign assets must return the same error");
      }
    }
    const spoofedSender = await sendAsMaya([foreignId], { sender_id: "mehmet" });
    assert.equal(spoofedSender.status, 403, "A body sender_id cannot override the authenticated sender");
    assert.deepEqual(await spoofedSender.json(), forbiddenBody);
    const legacySender = await fetch(`${BASE}/api/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender_id: "maya", asset_ids: [foreignId], recipient_name: "Sarah" }),
    });
    assert.equal(legacySender.status, 403, "Ownership also applies when demo mode resolves the sender_id");
    for (const ids of [undefined, null, [], ownedId, [null], [1], [""], [" "]]) {
      const res = await sendAsMaya(ids);
      assert.equal(res.status, 400, `Reject malformed asset_ids: ${JSON.stringify(ids)}`);
      assert.equal(typeof (await res.json()).error, "string");
    }
    assert.deepEqual(await inbox("maya"), beforeMaya, "Rejected sends must not create sent bundles");
    assert.deepEqual(await inbox("sarah"), beforeSarah, "Rejected sends must not deliver partial bundles");
    const ownedSend = await sendAsMaya([ownedId]);
    assert.equal(ownedSend.status, 200, "The owner can still send their asset");
    const ownedBundle = await ownedSend.json();
    assert.equal(ownedBundle.sender_id, "maya");
    assert.deepEqual(ownedBundle.items.map((item) => item.asset_id), [ownedId]);
    assert.ok((await inbox("sarah")).bundles.some((bundle) => bundle.id === ownedBundle.id));
    console.log("✓ Send authorization rejects foreign/missing assets, mixed batches, spoofed senders, and malformed IDs; owned sends work");

    await runVoiceSendScenarios(BASE, executeSql);

    console.log("\nALL CLOUDFLARE EDGE E2E TESTS PASSED!");
  } catch (err) {
    console.error("E2E Test Failed:", err);
    console.error("Wrangler logs:\n", logs);
    process.exitCode = 1;
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const stopped = once(proc, "exit");
      proc.kill("SIGTERM");
      await stopped;
    }
    await rm(state, { recursive: true, force: true });
  }
}

main();
