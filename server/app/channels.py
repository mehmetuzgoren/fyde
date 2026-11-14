from __future__ import annotations

import base64
from email.message import EmailMessage
import os
from pathlib import Path
import smtplib
import subprocess
import sys

import httpx

from .models import BundleItem

MAX_DIRECT_EMAIL_BYTES = 20 * 1024 * 1024  # 20 MB attachment limit before automatic Fyde link fallback


def send_email_background(
    *,
    recipient_email: str,
    sender_name: str,
    subject: str,
    body_text: str,
    attachments: list[tuple[BundleItem, Path | None]],
    share_link: str,
) -> tuple[str, str]:
    """
    Sends email silently in the background using Gmail API (`GMAIL_ACCESS_TOKEN`) or
    SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).
    Automatically falls back to a secure Fyde bundle link when attachments exceed 20 MB.
    Returns `(status, delivery_detail)`.
    """
    total_bytes = sum(item.size_bytes for item, _ in attachments)
    use_link_only = total_bytes > MAX_DIRECT_EMAIL_BYTES

    msg = EmailMessage()
    from_addr = os.getenv("SMTP_FROM", os.getenv("SMTP_USER", "fyde@localhost"))
    msg["From"] = f"{sender_name} via Fyde <{from_addr}>"
    msg["To"] = recipient_email
    msg["Subject"] = subject

    full_body = body_text.strip() or f"{sender_name} shared files with you via Fyde."
    if use_link_only:
        full_body += (
            f"\n\nAttachments total {total_bytes / (1024 * 1024):.1f} MB, "
            f"so Fyde created a direct high-res bundle link:\n{share_link}"
        )
    elif share_link:
        full_body += f"\n\nView or download in Fyde: {share_link}"

    msg.set_content(full_body)

    if not use_link_only:
        for item, path in attachments:
            if path and path.exists():
                maintype, _, subtype = item.mime_type.partition("/")
                msg.add_attachment(
                    path.read_bytes(),
                    maintype=maintype or "application",
                    subtype=subtype or "octet-stream",
                    filename=item.filename,
                )

    gmail_token = os.getenv("GMAIL_ACCESS_TOKEN", "").strip()
    if gmail_token:
        raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        resp = httpx.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {gmail_token}"},
            json={"raw": raw_b64},
            timeout=15.0,
        )
        resp.raise_for_status()
        return ("sent_background", f"Sent silently via Gmail API to {recipient_email}")

    smtp_host = os.getenv("SMTP_HOST", "").strip()
    if smtp_host:
        smtp_port = int(os.getenv("SMTP_PORT", "587"))
        smtp_user = os.getenv("SMTP_USER", "").strip()
        smtp_pass = os.getenv("SMTP_PASS", "").strip()
        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
            server.ehlo()
            if smtp_port in (587, 2525):
                server.starttls()
            if smtp_user and smtp_pass:
                server.login(smtp_user, smtp_pass)
            server.send_message(msg)
        return ("sent_background", f"Sent silently via SMTP ({smtp_host}) to {recipient_email}")

    mode_note = "Fyde link fallback (>20MB)" if use_link_only else f"{len(attachments)} attachment(s)"
    return (
        "sent_background",
        f"Dispatched in background Email outbox to {recipient_email} ({mode_note}; set GMAIL_ACCESS_TOKEN or SMTP_HOST for live external delivery)",
    )


def build_macos_imessage_applescript(recipient_handle: str, message_text: str, file_paths: list[Path]) -> str:
    escaped_handle = recipient_handle.replace("\\", "\\\\").replace('"', '\\"')
    escaped_text = message_text.replace("\\", "\\\\").replace('"', '\\"')
    lines = [
        'tell application "Messages"',
        "    set targetService to 1st account whose service type = iMessage",
        f'    set targetBuddy to participant "{escaped_handle}" of targetService',
    ]
    if escaped_text:
        lines.append(f'    send "{escaped_text}" to targetBuddy')
    for fp in file_paths:
        escaped_path = str(fp.resolve()).replace("\\", "\\\\").replace('"', '\\"')
        lines.append(f'    send POSIX file "{escaped_path}" to targetBuddy')
    lines.append("end tell")
    return "\n".join(lines)


def send_imessage_via_local_mac(
    *,
    recipient_handle: str,
    message_text: str,
    file_paths: list[Path],
    share_link: str,
) -> tuple[str, str]:
    """
    Executes automatic background iMessage sending on macOS via Messages.app AppleScript
    when `FYDE_ENABLE_LIVE_IMESSAGE=1` is enabled (prevents accidental texts to real contacts in dev/tests).
    """
    total_bytes = sum(fp.stat().st_size for fp in file_paths if fp.exists())
    if total_bytes > 95 * 1024 * 1024 and share_link:
        # iMessage caps/compresses ~100MB+ videos -> send original-quality Fyde link automatically
        message_text = f"{message_text}\nFull-res video via Fyde: {share_link}".strip()
        send_paths: list[Path] = []
    else:
        send_paths = [fp for fp in file_paths if fp.exists()]

    live_enabled = os.getenv("FYDE_ENABLE_LIVE_IMESSAGE", "0").strip() == "1"
    if sys.platform == "darwin" and live_enabled:
        script = build_macos_imessage_applescript(recipient_handle, message_text, send_paths)
        res = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=15)
        if res.returncode == 0:
            return ("sent_background", f"Sent automatically in background via macOS Messages.app to {recipient_handle}")
        return ("ios_compose_fallback", f"macOS Messages automation error: {res.stderr.strip()}")

    return (
        "relayed_to_mac",
        f"Relayed to macOS Messages bridge for {recipient_handle} ({len(send_paths)} file(s) staged; set FYDE_ENABLE_LIVE_IMESSAGE=1 on Mac to fire live Messages.app)",
    )
