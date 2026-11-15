from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app


DESCRIPTION = {"title": "Red bicycle beside a wall", "summary": "A red bicycle leans against a brick wall."}


def image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (24, 24), "red").save(output, format="PNG")
    return output.getvalue()


def gemini_response(description: object = DESCRIPTION, finish_reason: str = "STOP") -> dict:
    return {"candidates": [{"finishReason": finish_reason, "content": {"parts": [
        {"text": "private reasoning", "thought": True},
        {"text": json.dumps(description)},
    ]}}]}


def test_image_title_is_generated_persisted_and_searchable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-secret")
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.url.path == "/v1beta/models/gemini-4-hydrogen:generateContent"
        assert not request.url.query
        assert request.headers["x-goog-api-key"] == "test-secret"
        body = json.loads(request.content)
        image = body["contents"][0]["parts"][0]["inlineData"]
        assert image["mimeType"] == "image/jpeg"
        assert base64.b64decode(image["data"]).startswith(b"\xff\xd8\xff")
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        return httpx.Response(200, json=gemini_response())

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(respond), **kw))
    app = create_app(data_dir=tmp_path)
    with TestClient(app) as client:
        # Native HEIC uploads provide a JPEG/PNG preview; the original must remain downloadable.
        original = b"original HEIC bytes"
        response = client.post("/api/assets/upload", data={"owner_id": "mehmet"}, files={
            "file": ("IMG_4829.HEIC", original, "image/heic"),
            "preview": ("preview.png", image_bytes(), "image/png"),
        })
        assert response.status_code == 200
        asset = response.json()
        assert asset["title"] == DESCRIPTION["title"]
        assert asset["summary"] == DESCRIPTION["summary"]
        assert asset["filename"] == "IMG_4829.HEIC"
        assert client.get(asset["download_url"]).content == original
        listed = client.get("/api/assets/mehmet").json()
        assert next(a for a in listed if a["id"] == asset["id"])["title"] == DESCRIPTION["title"]
        matches = client.post("/api/search", json={"user_id": "mehmet", "query": "red bicycle", "scope": "mine"}).json()
        assert any(hit["asset"]["id"] == asset["id"] for hit in matches)
        assert len(requests) == 1

        document = client.post("/api/assets/upload", data={"owner_id": "mehmet"}, files={"file": ("notes.txt", b"Notes", "text/plain")})
        assert document.status_code == 200
        assert document.json()["title"] == "notes"
        assert len(requests) == 1


@pytest.mark.parametrize("failure", ["unconfigured", "http", "timeout", "invalid_json", "invalid_shape", "blank", "long", "truncated", "blocked"])
def test_image_summary_failure_preserves_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-secret")
    if failure == "unconfigured":
        monkeypatch.delenv("GEMINI_API_KEY")

    def respond(request: httpx.Request) -> httpx.Response:
        if failure == "unconfigured":
            pytest.fail("An unconfigured service must not make a request")
        if failure == "http":
            return httpx.Response(429, json={"error": "rate limited"})
        if failure == "timeout":
            raise httpx.ReadTimeout("timeout", request=request)
        if failure == "invalid_json":
            return httpx.Response(200, text="invalid")
        if failure == "invalid_shape":
            return httpx.Response(200, json=gemini_response([]))
        if failure == "blank":
            return httpx.Response(200, json=gemini_response({"title": "  ", "summary": "A scene."}))
        if failure == "long":
            return httpx.Response(200, json=gemini_response({"title": "a" * 81, "summary": "A scene."}))
        if failure == "truncated":
            return httpx.Response(200, json=gemini_response(finish_reason="MAX_TOKENS"))
        return httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original_client(transport=httpx.MockTransport(respond), **kw))
    app = create_app(data_dir=tmp_path)
    with TestClient(app) as client:
        response = client.post(
            "/api/assets/upload", data={"owner_id": "mehmet", "summary": "Original notes"},
            files={"file": ("IMG_4829.png", image_bytes(), "image/png")},
        )
        assert response.status_code == 200
        asset = response.json()
        assert asset["title"] == "IMG 4829"
        assert asset["summary"] == "Original notes"
        assert client.get(asset["download_url"]).status_code == 200
