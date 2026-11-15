import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Runs inside the existing edge E2E worker, using its isolated D1 and R2 state.
export async function runVoiceSendScenarios(base, executeSql) {
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const chat = async (text, source = "vexo", userId = "mehmet") => {
    const result = await post("/api/chat", { user_id: userId, text, source });
    assert.equal(result.status, 200);
    return result.data;
  };
  const confirm = (messageId, extra = {}) => post("/api/chat/confirm", {
    user_id: "mehmet", via: "band", ...(messageId ? { message_id: messageId } : {}), ...extra,
  });
  const ids = (message) => message.action_card?.asset_ids;
  const type = (message) => message.action_card?.action_type;
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const assets = await (await fetch(`${base}/api/assets/mehmet`)).json();
  const photo = assets.find((asset) => asset.id === "asset_china_wall_maya");
  assert.ok(photo);
  const cat = {
    ...photo, id: "asset_voice_cat", filename: "milo_cat.jpg", title: "Milo the Cat on the Couch",
    location: "", people: [], tags: ["cat", "pet"], summary: "Milo resting on a couch",
    ocr_text: "", embedding: [], video_moments: [], folder_path: "",
  };
  const bank = {
    ...cat, id: "asset_voice_bank", filename: "bank_statement.pdf", title: "Bank Statement",
    media_type: "document", tags: ["private"], summary: "Bank statement",
  };
  await executeSql(`
    INSERT INTO users (id, handle, display_name, email, created_at)
    VALUES ('voice_john', 'johnapple', 'John Appleseed', 'john@voice.test', ${quote(new Date().toISOString())});
    INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
    VALUES ('voice_john_friend', 'mehmet', 'voice_john', 'accepted', ${quote(new Date().toISOString())}, ${quote(new Date().toISOString())});
    ${[cat, bank].map((asset) => `INSERT INTO assets (id, owner_id, media_type, created_at, data)
      VALUES (${quote(asset.id)}, 'mehmet', ${quote(asset.media_type)}, ${quote(asset.created_at)}, ${quote(JSON.stringify(asset))});`).join("\n")}
  `);
  // The received-search test deliberately grants Sarah Trusted access. Set the voice
  // scenario's permission explicitly so an earlier test cannot change its meaning.
  await post("/api/permissions", { owner_id: "mehmet", contact_user_id: "sarah", contact_name: "Sarah", tier: "ask_first" });

  const search = await chat("Show me the Great Wall sunset photo", "typed");
  assert.deepEqual(search.action_card.focus_asset_ids, [photo.id]);
  const contextual = await chat("Vexo, send that to Maya.");
  assert.equal(type(contextual), "send_completed");
  assert.deepEqual(ids(contextual), [photo.id]);

  const held = await chat("Vexo, send my cat picture to John.");
  assert.equal(type(held), "send_confirmation", held.text);
  assert.deepEqual(ids(held), [cat.id]);
  assert.equal(held.action_card.band_confirmable, true);
  const sent = await confirm(held.id);
  assert.equal(sent.status, 200);
  assert.equal(type(sent.data), "send_completed");
  assert.equal((await confirm()).status, 404, "A second tap cannot send again");
  const inbox = await (await fetch(`${base}/api/received/voice_john`)).json();
  assert.ok(inbox.bundles.some((bundle) => bundle.id === sent.data.action_card.bundle.id));
  const followup = await chat("Vexo send it to Maya too");
  assert.equal(type(followup), "send_completed");
  assert.deepEqual(ids(followup), [cat.id]);

  const privateHold = await chat("Vexo, send my bank statement to Maya");
  assert.equal(type(privateHold), "send_confirmation");
  assert.equal(privateHold.action_card.band_confirmable, false);
  assert.equal((await confirm(privateHold.id)).status, 403);
  assert.equal((await confirm(privateHold.id, { via: "app" })).status, 200);

  const askFirst = await chat("Vexo, send the tax return to Sarah");
  assert.equal(type(askFirst), "send_confirmation");
  assert.deepEqual(ids(askFirst), ["asset_tax_return_2025"]);
  const cancelled = await confirm(askFirst.id, { via: "app", decision: "cancel" });
  assert.equal(type(cancelled.data), "send_cancelled");

  const older = await chat("send the tax return to Sarah");
  const newest = await chat("send my cat picture to John");
  assert.equal((await confirm(older.id)).status, 404, "An explicit message ID cannot make a band tap send an older hold");
  assert.equal((await confirm(newest.id)).status, 200);
  assert.equal((await confirm()).status, 404, "A tap cannot walk back to an older hold");
  assert.equal((await confirm(older.id, { via: "app", decision: "cancel" })).status, 200);

  const doubleTap = await chat("send my cat picture to John");
  const taps = await Promise.all([confirm(doubleTap.id), confirm(doubleTap.id)]);
  assert.equal(taps.filter((result) => result.status === 200).length, 1, "Two simultaneous taps send once");
  assert.ok(taps.every((result) => [200, 404, 409].includes(result.status)));

  const stale = await chat("send my cat picture to John");
  const oldTime = new Date(Date.now() - 11 * 60_000).toISOString();
  await executeSql(`UPDATE chat_messages SET created_at = ${quote(oldTime)},
    data = json_set(data, '$.created_at', ${quote(oldTime)}) WHERE user_id = 'mehmet';`);
  assert.equal((await confirm(stale.id)).status, 404, "An explicit ID cannot bypass the band's ten-minute deadline");
  assert.equal((await confirm(stale.id, { via: "app" })).status, 200, "An older card can still be sent from the app");

  const retagged = await chat("send my cat picture to John");
  await executeSql(`UPDATE assets SET data = json_set(data, '$.tags', json('["private"]')) WHERE id = ${quote(cat.id)};`);
  assert.equal((await confirm(retagged.id)).status, 403, "The band must recheck privacy if a file changed after the hold");
  assert.equal((await confirm(retagged.id, { via: "app", decision: "cancel" })).status, 200);
  await executeSql(`UPDATE assets SET data = ${quote(JSON.stringify(cat))} WHERE id = ${quote(cat.id)};`);

  const changedOwner = await chat("send my cat picture to John");
  await executeSql(`UPDATE assets SET owner_id = 'maya' WHERE id = ${quote(cat.id)};`);
  assert.equal((await confirm(changedOwner.id)).status, 403, "Ownership is rechecked when a held send is confirmed");
  await confirm(changedOwner.id, { via: "app", decision: "cancel" });
  await executeSql(`UPDATE assets SET owner_id = 'mehmet' WHERE id = ${quote(cat.id)};`);

  const batch = await chat("send China trip photos to Sarah");
  assert.equal(type(batch), "send_confirmation");
  assert.equal(ids(batch).length, 3);
  const firstId = ids(batch)[0];
  await executeSql(`UPDATE assets SET owner_id = 'maya' WHERE id = ${quote(firstId)};`);
  assert.equal((await confirm(batch.id, { via: "app" })).status, 403, "A changed selection fails as a whole instead of sending a partial bundle");
  await confirm(batch.id, { via: "app", decision: "cancel" });
  await executeSql(`UPDATE assets SET owner_id = 'mehmet' WHERE id = ${quote(firstId)};`);

  const smart = await chat("Vexo, send the Hangzhou photo to Alex");
  assert.equal(type(smart), "send_completed");
  assert.deepEqual(ids(smart), ["asset_hangzhou_temple_alex"]);
  await chat("find my China photos");
  const mixedScope = await chat("Vexo, send those to Alex");
  assert.equal(type(mixedScope), "send_confirmation", "A batch containing an out-of-scope file needs confirmation");
  assert.equal(ids(mixedScope).length, 3);
  await confirm(mixedScope.id, { via: "app", decision: "cancel" });
  for (const [text, explanation] of [
    ["Vexo send my cat picture to Bob", /don't know who/],
    ["Vexo send my dog picture to Maya", /couldn't find/],
    ["Vexo, send that", /Who should I send/],
  ]) {
    const failed = await chat(text);
    assert.equal(failed.action_card, null);
    assert.match(failed.text, explanation);
  }
  const typo = await chat("Vexo, send my cat picture to Jon");
  assert.equal(typo.action_card.recipient_name, "John Appleseed");
  await confirm(typo.id, { via: "app", decision: "cancel" });
  const texted = await chat("Vexo, text Maya the surfing video");
  assert.equal(texted.action_card.channel, "imessage");
  assert.deepEqual(ids(texted), ["asset_surfing_pacifica"]);
  const wife = await chat("send my wife the tax return", "typed");
  assert.equal(type(wife), "send_completed");
  assert.equal(wife.action_card.recipient_name, "Maya");
  const email = await chat("Hey Vexo, can you send the Great Wall photo to Maya by email?");
  assert.equal(email.action_card.channel, "email");
  assert.equal(type(await chat("Vexo, find my China photos")), "search_results");

  // A separate receiver submits while Fyde is closed. Both turns must survive a
  // later history fetch, even after the conversation has passed its 80-row window.
  await executeSql(`
    INSERT INTO users (id, handle, display_name, email, created_at)
    VALUES ('voice_johnny', 'johnny', 'Johnny', 'johnny@voice.test', ${quote(new Date().toISOString())});
    ${Array.from({ length: 85 }, (_, i) => {
      const message = { id: `old_voice_${i}`, user_id: "mehmet", role: "user", text: "Older chat", created_at: "2025-01-01T00:00:00.000Z" };
      return `INSERT INTO chat_messages (id, user_id, created_at, data) VALUES (${quote(message.id)}, 'mehmet', ${quote(message.created_at)}, ${quote(JSON.stringify(message))});`;
    }).join("\n")}
  `);
  await post("/api/permissions", { owner_id: "mehmet", contact_user_id: "voice_johnny", contact_name: "Johnny", tier: "trusted" });
  const spoken = "Vexo send my cat photos to Johnny";
  const vexoPath = fileURLToPath(new URL("../vexo", import.meta.url));
  const script = "import json,sys; sys.path.insert(0,sys.argv[1]); from fyde_bridge import dispatch_voice_to_fyde; print(json.dumps(dispatch_voice_to_fyde(sys.argv[2], 'mehmet', sys.argv[3])))";
  const { stdout } = await promisify(execFile)("python3", ["-c", script, vexoPath, base, spoken], {
    env: { ...process.env, FYDE_SESSION_TOKEN: "" },
  });
  const backgroundReply = JSON.parse(stdout);
  assert.equal(type(backgroundReply), "send_completed", backgroundReply.text);
  assert.equal(backgroundReply.action_card.recipient_name, "Johnny");
  const restored = await (await fetch(`${base}/api/chat/mehmet`)).json();
  assert.equal(restored.length, 80);
  assert.equal(restored.at(-2).text, spoken);
  assert.equal(restored.at(-2).source, "vexo");
  assert.equal(restored.at(-1).id, backgroundReply.id);
  assert.equal(restored.at(-1).source, "vexo");
  const johnnyInbox = await (await fetch(`${base}/api/received/voice_johnny`)).json();
  assert.ok(johnnyInbox.bundles.some((bundle) => bundle.id === backgroundReply.action_card.bundle.id));

  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws/mehmet?device_id=voice_history_test&platform=web&device_name=Test`);
  const events = [];
  socket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));
  await once(socket, "open");
  try {
    const liveReply = await chat("Vexo send my cat photos to Johnny");
    // The POST awaits both notifications, but the client event queue may still be draining.
    for (let i = 0; i < 50 && !events.some((event) => event.payload?.id === liveReply.id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const liveTurns = events.filter((event) => event.event === "chat_message");
    assert.equal(liveTurns.length, 2, "Both the spoken request and receipt are broadcast");
    assert.deepEqual(liveTurns.map((event) => event.payload.role), ["user", "assistant"]);
    assert.ok(liveTurns.every((event) => event.payload.source === "vexo"));
  } finally {
    socket.close();
  }

  // Received photos are part of the recipient's library, even before saving them
  // to Apple Photos. Sending them must not grant access to the sender's other files.
  const receiverId = "voice_received_owner";
  const secondCat = { ...cat, id: "asset_voice_second_cat", filename: "milo_napping.jpg", title: "Milo Napping" };
  await executeSql(`
    INSERT INTO users (id, handle, display_name, email, created_at)
    VALUES (${quote(receiverId)}, 'receivedowner', 'Received Owner', 'received@voice.test', ${quote(new Date().toISOString())});
    INSERT INTO assets (id, owner_id, media_type, created_at, data)
    VALUES (${quote(secondCat.id)}, 'mehmet', 'photo', ${quote(secondCat.created_at)}, ${quote(JSON.stringify(secondCat))});
  `);
  const catIds = [cat.id, secondCat.id].sort();
  const received = await post("/api/send", {
    sender_id: "mehmet", asset_ids: catIds, recipient_name: "Received Owner",
    recipient_user_id: receiverId, channel: "fyde_direct",
  });
  assert.equal(received.status, 200);
  const receivedSearch = await chat("Show me all of my cat photos", "typed", receiverId);
  assert.equal(type(receivedSearch), "search_results", receivedSearch.text);
  assert.deepEqual([...ids(receivedSearch)].sort(), catIds);
  const forwarded = await chat("Send all of my cat photos to Maya", "typed", receiverId);
  assert.equal(type(forwarded), "send_completed", forwarded.text);
  assert.deepEqual([...ids(forwarded)].sort(), catIds);
  assert.equal(forwarded.action_card.bundle.sender_id, receiverId);
  const originalCats = await (await fetch(`${base}/api/assets/mehmet`)).json();
  assert.ok(catIds.every((id) => originalCats.some((asset) => asset.id === id && asset.owner_id === "mehmet")),
    "Forwarding preserves the original ownership");
  const contextualForward = await chat("send those to Maya", "typed", receiverId);
  assert.equal(type(contextualForward), "send_completed", contextualForward.text);
  assert.deepEqual([...ids(contextualForward)].sort(), catIds);

  for (const assetIds of [[bank.id], [cat.id, bank.id]]) {
    const forbidden = await post("/api/send", {
      sender_id: receiverId, asset_ids: assetIds, recipient_name: "Maya", recipient_user_id: "maya", channel: "fyde_direct",
    });
    assert.equal(forbidden.status, 403, "A received photo does not authorize the sender's unshared files");
  }
  const unshared = await chat("Send my bank statement to Maya", "typed", receiverId);
  assert.equal(unshared.action_card, null);
  const voiceForward = await chat("Vexo send both of my cat photos to Maya", "vexo", receiverId);
  assert.equal(type(voiceForward), "send_confirmation", voiceForward.text);
  assert.deepEqual([...ids(voiceForward)].sort(), catIds);
  const confirmedForward = await confirm(voiceForward.id, { user_id: receiverId });
  assert.equal(confirmedForward.status, 200);
  assert.equal(type(confirmedForward.data), "send_completed");

  const removedReceipt = await chat("Vexo send all of my cat photos to Maya", "vexo", receiverId);
  assert.equal(type(removedReceipt), "send_confirmation", removedReceipt.text);
  await executeSql(`DELETE FROM bundles WHERE id = ${quote(received.data.id)};`);
  assert.equal((await confirm(removedReceipt.id, { user_id: receiverId })).status, 403,
    "Confirmation must recheck that the sender still has the received files");
  assert.equal((await confirm(removedReceipt.id, { user_id: receiverId, via: "app" })).status, 403);
  console.log("✓ Received cat photos: search, all/both phrasing, contextual forwarding, confirmation, and unshared-file isolation");

  const rafting = {
    ...cat, id: "asset_voice_rafting", filename: "IMG_4829.jpg", title: "River Adventure",
    tags: ["rafting", "watersport", "oar"], summary: "A group on the river",
  };
  const kayaking = { ...rafting, id: "asset_voice_kayaking", filename: "IMG_4830.jpg", tags: ["kayaking"] };
  await executeSql([rafting, kayaking].map((asset) => `INSERT INTO assets (id, owner_id, media_type, created_at, data)
    VALUES (${quote(asset.id)}, 'mehmet', 'photo', ${quote(asset.created_at)}, ${quote(JSON.stringify(asset))});`).join("\n"));
  const paddlingIds = [rafting.id, kayaking.id].sort();
  for (const query of ["kayak photos", "canoeing pictures", "paddling photos"]) {
    const result = await post("/api/search", { user_id: "mehmet", query, scope: "mine", media_type: "photo" });
    assert.equal(result.status, 200);
    assert.ok(paddlingIds.every((id) => result.data.some((hit) => hit.asset.id === id)), query);
  }
  const relatedSearch = await chat("Show me my kayak photos", "typed");
  assert.deepEqual([...relatedSearch.action_card.focus_asset_ids].sort(), paddlingIds);
  const relatedSend = await chat("Send all my kayak photos to Maya", "typed");
  assert.equal(type(relatedSend), "send_completed", relatedSend.text);
  assert.deepEqual([...ids(relatedSend)].sort(), paddlingIds, "Include both exact and related visual tags, excluding unrelated photos");
  const relatedVoice = await chat("Vexo send my canoeing photos to John");
  assert.equal(type(relatedVoice), "send_confirmation", relatedVoice.text);
  assert.deepEqual([...ids(relatedVoice)].sort(), paddlingIds);
  await confirm(relatedVoice.id, { via: "app", decision: "cancel" });
  console.log("✓ Related visual tags: kayak, kayaking, canoeing, and rafting work in search, focus, and typed/voice sends");
  console.log("✓ Headless Vexo command: Johnny receives cat photos, newest history restores both turns, live clients receive both events");
  console.log("✓ Vexo voice sends: context, contacts, permissions, confirmation, privacy changes, expiry, and delivery");
}
