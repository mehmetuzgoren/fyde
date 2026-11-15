from __future__ import annotations

from pathlib import Path
from fastapi.testclient import TestClient

from app.main import create_app
from app.models import ChatMessage


def test_delete_files_checks_owner_and_preserves_shared_copies(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path / "delete_files")
    with TestClient(app) as client:
        def upload(name: str) -> dict:
            response = client.post(
                "/api/assets/upload",
                data={"owner_id": "mehmet", "title": name},
                files={"file": (f"{name}.txt", b"File deletion integration fixture", "text/plain")},
            )
            assert response.status_code == 200
            return response.json()

        asset = upload("Unshared file")
        endpoint = f"/api/assets/{asset['id']}"
        assert client.delete(endpoint).status_code == 422
        assert client.delete(endpoint, params={"user_id": "maya"}).status_code == 403
        assert client.get(asset["download_url"]).status_code == 200
        with client.websocket_connect("/ws/mehmet?device_id=delete_test&platform=web") as ws:
            assert ws.receive_json()["event"] == "connected"
            deleted = client.delete(endpoint, params={"user_id": "mehmet"})
            assert deleted.status_code == 200
            assert deleted.json() == {"ok": True, "id": asset["id"]}
            assert ws.receive_json() == {"event": "asset_deleted", "payload": {"id": asset["id"]}}
        assert client.delete(endpoint, params={"user_id": "mehmet"}).status_code == 404
        assert client.get(asset["download_url"]).status_code == 404
        assert all(a["id"] != asset["id"] for a in client.get("/api/assets/mehmet").json())
        hits = client.post("/api/search", json={"user_id": "mehmet", "query": "", "scope": "mine", "limit": 100}).json()
        assert all(hit["asset"]["id"] != asset["id"] for hit in hits)

        shared = upload("Shared file")
        sent = client.post("/api/send", json={
            "sender_id": "mehmet", "asset_ids": [shared["id"]],
            "recipient_name": "Sarah", "recipient_user_id": "sarah", "channel": "fyde_direct",
        })
        assert sent.status_code == 200
        bundle = sent.json()
        accepted = client.post(f"/api/bundles/{bundle['id']}/accept", json={
            "user_id": "sarah", "destination_type": "files", "album_or_folder": "Saved files",
        })
        assert accepted.status_code == 200
        assert client.delete(f"/api/assets/{shared['id']}", params={"user_id": "mehmet"}).status_code == 200
        assert client.get(shared["download_url"]).content == b"File deletion integration fixture"
        copies = client.get("/api/assets/sarah").json()
        copy = next(a for a in copies if a["download_url"] == shared["download_url"])
        assert copy["id"] != shared["id"]
        assert client.delete(f"/api/assets/{copy['id']}", params={"user_id": "sarah"}).status_code == 200
        # The received bundle remains usable after both searchable library entries are removed.
        assert client.get(bundle["items"][0]["download_url"]).status_code == 200
        received = client.post("/api/search", json={"user_id": "sarah", "query": "", "scope": "contacts"}).json()
        assert any(hit["asset"]["id"] == shared["id"] for hit in received)


def test_wrist_commands_persist_and_broadcast_both_chat_turns(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path / "wrist_history")
    with TestClient(app) as client:
        for i in range(85):
            app.state.storage.append_chat_message(ChatMessage(
                id=f"old_wrist_{i}", user_id="mehmet", role="user", text="Older chat",
                created_at="2025-01-01T00:00:00.000Z",
            ))

        # The receiver posts without an app or a WebSocket connection.
        payload = {"user_id": "mehmet", "text": "Send the China photos to Maya", "platform": "vexo-band-69", "source": "vexo", "client_message_id": "wrist_1"}
        response = client.post("/api/chat", json=payload)
        assert response.status_code == 200
        reply = response.json()
        assert reply["source"] == "vexo"
        assert reply["action_card"]["action_type"] == "send_completed"
        history = client.get("/api/chat/mehmet").json()
        assert len(history) == 80
        assert history[-2]["text"] == payload["text"]
        assert history[-2]["client_message_id"] == "wrist_1"
        assert history[-1]["id"] == reply["id"]

        # An open app sees the transcript as well as the result of a later command.
        with client.websocket_connect("/ws/mehmet?device_id=chat_history&platform=web") as socket:
            assert socket.receive_json()["event"] == "connected"
            response = client.post("/api/chat", json={**payload, "text": "Find my China photos", "client_message_id": "wrist_2"})
            assert response.status_code == 200
            turns = []
            while len(turns) < 2:
                event = socket.receive_json()
                if event["event"] == "chat_message":
                    turns.append(event["payload"])
            assert [turn["role"] for turn in turns] == ["user", "assistant"]
            assert all(turn["source"] == "vexo" for turn in turns)


def test_received_files_are_searchable_without_library_access(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path / "received_search")
    with TestClient(app) as client:
        def search(scope: str = "all", query: str = "tax return", **filters: object) -> list[dict]:
            response = client.post(
                "/api/search",
                json={"user_id": "sarah", "query": query, "scope": scope, **filters},
            )
            assert response.status_code == 200
            return response.json()

        asset_id = "asset_tax_return_2025"
        assert not any(hit["asset"]["id"] == asset_id for hit in search())

        # Repeated shares appear once, using the most recent bundle's destination.
        for title in ("Tax documents", "Latest tax documents"):
            response = client.post(
                "/api/send",
                json={
                    "sender_id": "mehmet",
                    "asset_ids": [asset_id],
                    "recipient_name": "Sarah",
                    "recipient_user_id": "sarah",
                    "channel": "fyde_direct",
                    "title": title,
                },
            )
            assert response.status_code == 200
        bundle = response.json()

        for scope in ("all", "contacts"):
            hits = search(scope)
            matches = [hit for hit in hits if hit["asset"]["id"] == asset_id]
            assert len(matches) == 1
            assert matches[0]["asset"]["owner_id"] == "mehmet"
            assert matches[0]["asset"]["folder_path"] == "Received/Latest tax documents"
            assert matches[0]["match_reason"].startswith("Received from Mehmet")
            assert any(hit["asset"]["id"] == asset_id for hit in search(scope, ""))
            assert any(hit["asset"]["id"] == asset_id for hit in search(scope, media_type="document"))
            assert not any(hit["asset"]["id"] == asset_id for hit in search(scope, media_type="photo"))
            assert not any(hit["asset"]["id"] == asset_id for hit in search(scope, contact_owner_id="maya"))
        assert not any(hit["asset"]["id"] == asset_id for hit in search("mine"))
        alex_hits = client.post(
            "/api/search", json={"user_id": "alex", "query": "tax return", "scope": "all"}
        ).json()
        assert not any(hit["asset"]["id"] == asset_id for hit in alex_hits)

        # Granting library access must not duplicate an already received file.
        permission = client.post(
            "/api/permissions",
            json={"owner_id": "mehmet", "contact_user_id": "sarah", "contact_name": "Sarah", "tier": "trusted"},
        )
        assert permission.status_code == 200
        for scope in ("all", "contacts"):
            assert len([hit for hit in search(scope) if hit["asset"]["id"] == asset_id]) == 1

        accepted = client.post(
            f"/api/bundles/{bundle['id']}/accept",
            json={"user_id": "sarah", "destination_type": "files", "album_or_folder": "Taxes"},
        )
        assert accepted.status_code == 200
        source_url = bundle["items"][0]["download_url"]
        assert len([hit for hit in search() if hit["asset"]["download_url"] == source_url]) == 1
        assert any(hit["asset"]["download_url"] == source_url for hit in search("mine"))

        # A received file remains searchable from its bundle if the sender's index disappears.
        with app.state.storage._conn() as connection:
            connection.execute("DELETE FROM assets WHERE id = ?", (asset_id,))
        fallback = next(hit for hit in search("contacts") if hit["asset"]["id"] == asset_id)
        assert fallback["asset"]["download_url"] == bundle["items"][0]["download_url"]
        assert "Taxes" in fallback["asset"]["folder_path"]
        assert fallback["match_reason"].startswith("Received from Mehmet")


def test_full_fyde_p2p_multimodal_and_permissions_flow(tmp_path: Path) -> None:
    app = create_app(data_dir=tmp_path / "fyde_test_data")
    with TestClient(app) as client:
        # 1. Health & seeded users
        health = client.get("/api/health").json()
        assert health["status"] == "ok"

        users = client.get("/api/users").json()
        handles = {u["handle"] for u in users}
        assert {"mehmet", "maya", "alex", "sarah"}.issubset(handles)

        # 2. Multimodal video timestamp search ("riding a clean wave" -> hits surfing MP4 @ 2.2s)
        vid_hits = client.post(
            "/api/search",
            json={"user_id": "mehmet", "query": "riding a clean wave on surfboard", "scope": "mine"},
        ).json()
        assert len(vid_hits) >= 1
        top_vid = vid_hits[0]
        assert top_vid["asset"]["id"] == "asset_surfing_pacifica"
        assert top_vid["matched_moment_sec"] == 2.2

        # 3. Wife (Maya = Trusted) chats to HER OWN Fyde Chat to pull passport scans from Mehmet!
        maya_turn = client.post(
            "/api/chat",
            json={
                "user_id": "maya",
                "text": "Get our passport scans from Mehmet's files",
                "platform": "ios",
            },
        ).json()
        assert maya_turn["action_card"]["action_type"] == "peer_pull_completed"
        pulled_bundle = maya_turn["action_card"]["bundle"]
        pulled_ids = [it["asset_id"] for it in pulled_bundle["items"]]
        assert "asset_passports_2026" in pulled_ids
        # Private work vault doc MUST never be exposed even to Trusted contacts!
        assert "asset_private_work_deck" not in pulled_ids

        # Verify bundle landed in Maya's Received tab AND she can accept it via Chat
        maya_inbox = client.get("/api/received/maya").json()
        assert any(b["id"] == pulled_bundle["id"] for b in maya_inbox["bundles"])

        accept_turn = client.post(
            "/api/chat",
            json={
                "user_id": "maya",
                "text": "Accept Mehmet's passport bundle into Documents/Travel",
                "platform": "ios",
            },
        ).json()
        assert accept_turn["action_card"]["action_type"] == "bundle_accepted"
        assert accept_turn["action_card"]["bundle"]["status"] == "accepted_files"

        # 4. Folderless Smart Scope: Alex has permission ONLY for "All China trip photos & videos with Alex"
        alex_pull = client.post(
            "/api/peer/pull",
            json={"requester_id": "alex", "owner_id": "mehmet", "query": "China trip photos"},
        ).json()
        assert alex_pull["bundle"] is not None
        alex_item_ids = {it["asset_id"] for it in alex_pull["bundle"]["items"]}
        assert "asset_shanghai_bund_group" in alex_item_ids
        assert "asset_hangzhou_temple_alex" in alex_item_ids
        # Great Wall photo only has Maya & Mehmet (not Alex), so folderless people rule excludes it!
        assert "asset_china_wall_maya" not in alex_item_ids

        # 5. Out-of-scope request: Alex requests Mehmet's 2025 tax return -> creates Ask-First request, zero metadata leak
        alex_tax_req = client.post(
            "/api/peer/pull",
            json={"requester_id": "alex", "owner_id": "mehmet", "query": "2025 tax return"},
        ).json()
        assert alex_tax_req["bundle"] is None
        assert alex_tax_req["access_request"] is not None
        # Requester must NOT see private matched_previews before approval
        assert alex_tax_req["access_request"]["matched_previews"] == []
        req_id = alex_tax_req["access_request"]["id"]

        # Mehmet sees the pending request WITH matched previews in his Received tab and approves it
        mehmet_inbox = client.get("/api/received/mehmet").json()
        pending_reqs = [r for r in mehmet_inbox["incoming_requests"] if r["id"] == req_id]
        assert len(pending_reqs) == 1
        assert len(pending_reqs[0]["matched_previews"]) >= 1

        resolved = client.post(
            f"/api/requests/{req_id}/resolve",
            json={"owner_id": "mehmet", "decision": "approve"},
        ).json()
        assert resolved["access_request"]["status"] == "approved"
        assert resolved["bundle"]["recipient_id"] == "alex"

        # 6. Chat permission management + automatic background sending over Email, iMessage (with Mac WebSocket bridge), and Direct Fyde
        perm_turn = client.post(
            "/api/chat",
            json={
                "user_id": "mehmet",
                "text": "Allow Sarah to access all my China trip photos with Maya",
                "platform": "ios",
            },
        ).json()
        assert perm_turn["action_card"]["action_type"] == "permission_updated"
        assert perm_turn["action_card"]["permission"]["tier"] == "smart_scope"

        email_turn = client.post(
            "/api/chat",
            json={
                "user_id": "mehmet",
                "text": "Send the 2025 tax return to Sarah via email",
                "platform": "ios",
            },
        ).json()
        assert email_turn["action_card"]["action_type"] == "send_completed"
        assert email_turn["action_card"]["bundle"]["channel"] == "email"
        assert email_turn["action_card"]["bundle"]["status"] == "sent_background"

        # Connect Mehmet's macOS bridge over WebSocket and send an iMessage from iPhone!
        with client.websocket_connect("/ws/mehmet?device_id=mac_studio&platform=macos&device_name=Mehmet+Mac") as ws:
            init_evt = ws.receive_json()
            assert init_evt["event"] == "connected"

            imsg_turn = client.post(
                "/api/chat",
                json={
                    "user_id": "mehmet",
                    "text": "iMessage Maya the Pacifica surfing video",
                    "platform": "ios",
                },
            ).json()
            assert imsg_turn["action_card"]["action_type"] == "send_completed"
            assert imsg_turn["action_card"]["bundle"]["channel"] == "imessage"

            # Verify Mac WebSocket received the live iMessage bridge job!
            events = []
            for _ in range(2):
                events.append(ws.receive_json())
            assert any(e["event"] == "imessage_bridge_job" for e in events)
