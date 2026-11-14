import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:8789";

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
  const proc = spawn(
    "./node_modules/.bin/wrangler",
    ["dev", "--port", "8789", "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } }
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

    console.log("\nALL CLOUDFLARE EDGE E2E TESTS PASSED!");
  } catch (err) {
    console.error("E2E Test Failed:", err);
    console.error("Wrangler logs:\n", logs);
    process.exitCode = 1;
  } finally {
    proc.kill("SIGTERM");
  }
}

main();
