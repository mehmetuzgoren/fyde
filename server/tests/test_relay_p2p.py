from __future__ import annotations

from pathlib import Path
from fastapi.testclient import TestClient

from app.main import create_app


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
