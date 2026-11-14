from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

from .models import MediaType, PlatformType, SendChannel, SmartScopeRule, UserProfile

KNOWN_LOCATIONS = [
    "china", "beijing", "shanghai", "hangzhou",
    "japan", "kyoto", "tokyo",
    "california", "pacifica", "san francisco",
    "italy", "paris", "london", "mexico",
]


class ParsedIntent:
    def __init__(
        self,
        intent: str,
        *,
        query: str = "",
        target_person: str = "",
        channel: SendChannel = "fyde_direct",
        permission_tier: str = "smart_scope",
        locations: list[str] | None = None,
        people_filter: list[str] | None = None,
        media_types: list[MediaType] | None = None,
        destination_type: str = "photos",
        album_or_folder: str = "",
    ) -> None:
        self.intent = intent
        self.query = query
        self.target_person = target_person
        self.channel = channel
        self.permission_tier = permission_tier
        self.locations = locations or []
        self.people_filter = people_filter or []
        self.media_types = media_types or []
        self.destination_type = destination_type
        self.album_or_folder = album_or_folder


def parse_chat_intent(
    text: str,
    current_user: UserProfile,
    known_contacts: list[dict[str, str]],
) -> ParsedIntent:
    """
    Uses Gemini structured tool routing if `GEMINI_API_KEY` is configured; otherwise runs
    a fast, deterministic local NLU parser covering all 5 Fyde Chat workflows.
    """
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if api_key:
        llm_parsed = _try_gemini_intent(api_key, text, current_user, known_contacts)
        if llm_parsed is not None:
            return llm_parsed
    return _parse_intent_locally(text, known_contacts)


def _try_gemini_intent(
    api_key: str,
    text: str,
    current_user: UserProfile,
    known_contacts: list[dict[str, str]],
) -> ParsedIntent | None:
    prompt = (
        f"Current user: {current_user.display_name} (@{current_user.handle}).\n"
        f"Known contacts: {json.dumps(known_contacts)}.\n"
        "Classify the user message into JSON with keys:\n"
        '{"intent": "send"|"peer_pull"|"set_permission"|"accept_bundle"|"search",\n'
        ' "query": "search query for files/photos/videos",\n'
        ' "target_person": "contact name, handle, email, or relationship",\n'
        ' "channel": "fyde_direct"|"imessage"|"email",\n'
        ' "permission_tier": "trusted"|"smart_scope"|"ask_first"|"send_only",\n'
        ' "locations": ["China", ...],\n'
        ' "people_filter": ["Alex", ...],\n'
        ' "media_types": ["photo"|"video"|"document"],\n'
        ' "destination_type": "photos"|"files",\n'
        ' "album_or_folder": "optional album or folder name"}\n'
        f"User message: {text}"
    )
    try:
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-2.5-flash:generateContent?key={api_key}"
        )
        resp = httpx.post(
            url,
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"},
            },
            timeout=8.0,
        )
        resp.raise_for_status()
        raw_text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        obj: dict[str, Any] = json.loads(raw_text)
        return ParsedIntent(
            obj.get("intent", "search"),
            query=obj.get("query", ""),
            target_person=obj.get("target_person", ""),
            channel=obj.get("channel", "fyde_direct"),
            permission_tier=obj.get("permission_tier", "smart_scope"),
            locations=obj.get("locations") or [],
            people_filter=obj.get("people_filter") or [],
            media_types=obj.get("media_types") or [],
            destination_type=obj.get("destination_type", "photos"),
            album_or_folder=obj.get("album_or_folder", ""),
        )
    except Exception:
        return None


def _resolve_contact_mention(text_lower: str, known_contacts: list[dict[str, str]]) -> str:
    # Check explicit email first
    email_match = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text_lower)
    if email_match:
        return email_match.group(0)

    for c in known_contacts:
        name = c.get("name", "")
        handle = c.get("handle", "")
        rel = c.get("relationship", "")
        if name and re.search(rf"\b{re.escape(name.lower())}(?:'s)?\b", text_lower):
            return name
        if handle and re.search(rf"\b@?{re.escape(handle.lower())}(?:'s)?\b", text_lower):
            return name or handle
        if rel and re.search(rf"\b{re.escape(rel.lower())}(?:'s)?\b", text_lower):
            return name or rel

    # Generic fallback extraction after "to " or "from "
    m = re.search(r"\b(?:to|from|for|allow|let|give|set)\s+([A-Z][a-z]+)", text_lower.title())
    if m:
        candidate = m.group(1)
        if candidate.lower() not in {"My", "All", "Our", "The", "Photos", "Files", "Imessage", "Email"}:
            return candidate
    return ""


def _extract_media_types(text_lower: str) -> list[MediaType]:
    types: list[MediaType] = []
    if any(w in text_lower for w in ("photo", "photos", "picture", "pictures", "image", "images", "selfie")):
        types.append("photo")
    if any(w in text_lower for w in ("video", "videos", "clip", "clips", "footage")):
        types.append("video")
    if any(w in text_lower for w in ("pdf", "pdfs", "doc", "docs", "document", "documents", "invoice", "passport", "tax")):
        types.append("document")
    return types


def _parse_intent_locally(text: str, known_contacts: list[dict[str, str]]) -> ParsedIntent:
    tl = text.strip().lower()
    contact = _resolve_contact_mention(tl, known_contacts)

    # Channel detection
    channel: SendChannel = "fyde_direct"
    if any(k in tl for k in ("imessage", "i-message", "text message", "sms")):
        channel = "imessage"
    elif any(k in tl for k in ("via email", "by email", "over email", "email ")) or re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", tl):
        channel = "email"

    # 1. Accept received bundle into Photos or Files
    if re.search(r"\b(accept|save\s+received|import\s+received|add\s+received)\b", tl):
        dest = "photos" if "photo" in tl or "album" in tl else "files"
        if any(w in tl for w in ("document", "documents", "folder", "files", "taxes")):
            dest = "files"
        if "into photos" in tl or "to photos" in tl or "my photos" in tl:
            dest = "photos"
        quoted = re.search(r"['\"]([^'\"]+)['\"]", text)
        album = quoted.group(1) if quoted else ""
        return ParsedIntent(
            "accept_bundle",
            query=text,
            target_person=contact,
            destination_type=dest,
            album_or_folder=album,
        )

    # 2. Permission updates ("give Maya full access", "set Sarah to ask first", "share all China trip photos with Alex", "allow Alex to access...")
    is_perm = bool(
        re.search(
            r"\b(permission|permissions|trusted|full\s+access|access\s+any|can\s+access|allow\b.*?\baccess|let\b.*?\baccess|ask\s+first|smart\s+scope|grant)\b",
            tl,
        )
    ) or (tl.startswith("share all ") and "with " in tl and "send" not in tl)

    if is_perm and contact:
        if any(k in tl for k in ("trusted", "full access", "access any", "anything", "most trusted", "everything")):
            tier = "trusted"
        elif any(k in tl for k in ("ask first", "ask-first", "approval", "approve first", "request only")):
            tier = "ask_first"
        elif any(k in tl for k in ("revoke", "remove access", "send only", "block")):
            tier = "send_only"
        else:
            tier = "smart_scope"

        locs = [loc.title() for loc in KNOWN_LOCATIONS if loc in tl]
        media_types = _extract_media_types(tl)
        people_filter: list[str] = []
        if re.search(r"\bwith\s+(him|her|them|" + re.escape(contact.lower()) + r")\b", tl):
            people_filter.append(contact)

        # Build clean semantic topic string
        topic = tl
        for noise in (
            "allow", "let", "give", "grant", "set", "can access", "to access",
            "permission", "permissions", "with him", "with her", "with them",
            contact.lower(), "all of my", "all my", "my", "photos", "videos", "files",
        ):
            topic = topic.replace(noise, " ")
        topic = re.sub(r"\s+", " ", topic).strip(" .,")
        return ParsedIntent(
            "set_permission",
            query=topic,
            target_person=contact,
            permission_tier=tier,
            locations=locs,
            people_filter=people_filter,
            media_types=media_types,
        )

    # 3. Cross-peer pull / request ("get passport scans from Mehmet's files", "request ... from Maya", "pull ... from Mehmet")
    from_match = re.search(r"\bfrom\s+([a-zA-Z0-9_@']+)", tl)
    is_pull = bool(re.search(r"\b(get|pull|fetch|request|grab|ask)\b", tl) and from_match and not tl.startswith("send"))
    if is_pull and contact:
        cleaned_q = re.sub(r"\b(get|pull|fetch|request|grab|please|can you|from)\b", " ", tl)
        cleaned_q = re.sub(rf"\b{re.escape(contact.lower())}(?:'s)?\b", " ", cleaned_q)
        cleaned_q = cleaned_q.replace("my husband's", " ").replace("my wife's", " ").replace("files", " ")
        cleaned_q = re.sub(r"\s+", " ", cleaned_q).strip(" .,")
        return ParsedIntent(
            "peer_pull",
            query=cleaned_q or text,
            target_person=contact,
        )

    # 4. Outbound Send ("send ... to Maya", "imessage Sarah the surfing video", "email the tax pdf to ...")
    is_send = bool(re.search(r"\b(send|imessage|email|share|forward)\b", tl)) and bool(contact)
    if is_send:
        cleaned_q = tl
        for kw in ("send", "imessage", "i-message", "email", "share", "forward", "via", "over", "by", "direct", "fyde", "please"):
            cleaned_q = re.sub(rf"\b{kw}\b", " ", cleaned_q)
        cleaned_q = re.sub(rf"\bto\s+{re.escape(contact.lower())}\b", " ", cleaned_q)
        cleaned_q = re.sub(rf"\b{re.escape(contact.lower())}\b", " ", cleaned_q)
        cleaned_q = cleaned_q.replace("my wife", " ").replace("my husband", " ").replace("my accountant", " ")
        cleaned_q = re.sub(r"\s+", " ", cleaned_q).strip(" .,")
        return ParsedIntent(
            "send",
            query=cleaned_q or text,
            target_person=contact,
            channel=channel,
        )

    # 5. Default: Multimodal search inside Chat
    cleaned_search = re.sub(r"^(find|search|show me|look for|where is)\s+", "", tl).strip()
    return ParsedIntent("search", query=cleaned_search or text)
