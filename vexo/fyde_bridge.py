#!/usr/bin/env python3
"""Fyde <-> Vexo-HACK-69 Bridge & CLI Controller.

Strictly connects ONLY to Band #69 (Vexo-HACK-69) using the unmodified vexo-open-kit
reference library in ../vexo-open-kit.

Modes:
  python3 vexo/fyde_bridge.py status   [--sim | --usb [--serial-port PORT]]
  python3 vexo/fyde_bridge.py identify [SECONDS] [--sim | --usb]
  python3 vexo/fyde_bridge.py led      <HEX_OR_OFF> [--pattern solid|blink|breathe|flash|rainbow] [--sim | --usb]
  python3 vexo/fyde_bridge.py listen   [SECONDS] [--send-to-fyde] [--sim | --usb]
  python3 vexo/fyde_bridge.py watch    [--relay URL] [--user USER_ID] [--sim | --usb]
  python3 vexo/fyde_bridge.py bridge   [--host 127.0.0.1] [--port 8790] [--sim | --usb]

Note on iPhone Bluetooth:
- On a physical iPhone, Fyde connects directly to Vexo-HACK-69 over CoreBluetooth
  (do NOT pair in iOS Settings -> Bluetooth; double-tap the band so it blinks blue,
  then tap "Connect Vexo #69" inside the Fyde iPhone app).
- On the Xcode iPhone Simulator (which has no Bluetooth hardware), run
  `python3 vexo/fyde_bridge.py bridge` on your Mac and choose "Mac Bridge" inside Fyde.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import plistlib
from pathlib import Path
import struct
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
KIT_PYTHON = os.path.join(REPO_ROOT, "vexo-open-kit", "python")
KIT_EXAMPLES = os.path.join(REPO_ROOT, "vexo-open-kit", "examples", "python")

for p in (HERE, KIT_PYTHON, KIT_EXAMPLES):
    if p not in sys.path:
        sys.path.insert(0, p)

from config import (  # noqa: E402
    BAND,
    BAND_NAME,
    DEFAULT_BRIDGE_HOST,
    DEFAULT_BRIDGE_PORT,
    DEFAULT_FYDE_RELAY_URL,
    DEFAULT_FYDE_USER_ID,
    read_environment,
)

from vexo_open import codec  # noqa: E402
from vexo_open.sync import Band, VexoError  # noqa: E402


# ---- Strict Band #69 Connection Helper ------------------------------------------------

def open_band69(args: argparse.Namespace, auto_reconnect: bool = False) -> Band:
    """Connect ONLY to BAND (69 = Vexo-HACK-69) and verify band.number == 69."""
    if getattr(args, "sim", False):
        transport = "sim"
        opts: dict[str, Any] = {}
    elif getattr(args, "usb", False) or getattr(args, "serial_port", None):
        transport = "serial"
        opts = {"port": args.serial_port} if getattr(args, "serial_port", None) else {}
    else:
        transport = "ble"
        opts = {}

    band = Band.connect(BAND, transport=transport, auto_reconnect=auto_reconnect, **opts)
    # Hard Rule 4 (vexo-open-kit/AGENTS.md): double-check band.number == 69 after connect
    if band.number != BAND:
        found = band.number
        band.disconnect()
        raise VexoError(
            "wrong-band",
            f"Connected device reported band #{found}, expected {BAND_NAME} (#{BAND}). Disconnected immediately.",
        )
    return band


# ---- Fyde HTTP Relay Helpers ----------------------------------------------------------

def fyde_http_json(method: str, url: str, payload: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    token = os.environ.get("FYDE_SESSION_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else {}


def dispatch_voice_to_fyde(relay_url: str, user_id: str, spoken_text: str) -> dict[str, Any]:
    """Sends a wrist transcript to Fyde Chat. `source=vexo` makes the relay apply the
    recipient's permissions: covered files send right away, anything else is held for a tap."""
    body = {
        "user_id": user_id,
        "text": spoken_text,
        "platform": "vexo-band-69",
        "source": "vexo",
        "auto_send": True,
    }
    return fyde_http_json("POST", f"{relay_url}/api/chat", body)


def verify_fyde_session(relay_url: str, user_id: str) -> str:
    """Fail before opening the mic if the standalone listener has no valid account."""
    reply = fyde_http_json("GET", f"{relay_url}/api/auth/me")
    user = reply.get("user") or {}
    if not reply.get("authenticated") or (user_id and user_id not in (user.get("id"), user.get("handle"))):
        raise VexoError("auth", "Set FYDE_SESSION_TOKEN and FYDE_USER_ID for your Fyde account in the untracked .env file.")
    return str(user["id"])


def show_microphone_notice() -> None:
    notice = "Wrist audio is sent to Deepgram for transcription with model training disabled. Tell people near the band."
    print(f"[Microphone active] {notice}", flush=True)
    if sys.platform == "darwin":
        # The login service has no terminal; keep the active-microphone notice visible.
        script = 'on run argv\ndisplay notification (item 1 of argv) with title "Vexo #69 microphone active"\nend run'
        subprocess.run(["osascript", "-e", script, notice], capture_output=True, check=False)


def voice_reply_led(reply: dict[str, Any]) -> tuple[str, str, int]:
    """(hex, pattern, period_ms) for the band after a voice command."""
    card = reply.get("action_card") or {}
    if card.get("action_type") == "send_confirmation" and card.get("requires_confirmation"):
        return "#ffbe00", "breathe", 900  # amber: held, single-tap to send
    if not card:
        return "#ff2337", "blink", 300  # red: nothing happened (unknown contact, no match, ...)
    return "#14dc6e", "breathe", 900  # green: done


def confirm_pending_voice_send(relay_url: str, user_id: str) -> Optional[str]:
    """Confirms the newest voice send held in the last 10 minutes. None if nothing is pending."""
    try:
        reply = fyde_http_json(
            "POST",
            f"{relay_url}/api/chat/confirm",
            {"user_id": user_id, "decision": "send", "via": "band"},
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error")
        except (ValueError, OSError):
            detail = None
        return f"Could not confirm: {detail or f'HTTP {exc.code}'}"
    return str(reply.get("text") or "Sent.").replace("**", "")


def approve_first_pending_fyde_request(relay_url: str, user_id: str) -> str:
    inbox = fyde_http_json("GET", f"{relay_url}/api/received/{user_id}")
    pending = [
        r for r in (inbox.get("incoming_requests") or inbox.get("incomingRequests") or [])
        if r.get("status") == "pending"
    ]
    if pending:
        req = pending[0]
        req_id = req["id"]
        requester = req.get("requester_name") or req.get("requesterName") or "contact"
        fyde_http_json(
            "POST",
            f"{relay_url}/api/requests/{req_id}/resolve",
            {"owner_id": user_id, "decision": "approve"},
        )
        return f"Approved pending Fyde request from {requester}."
    bundles = inbox.get("bundles") or []
    return f"No pending approvals ({len(bundles)} received bundle(s) in Fyde inbox)."


# ---- CLI Subcommands ------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> int:
    with open_band69(args) as band:
        batt = band.get_battery()
        led = band.get_led()
        radio = band.get_radio()
        clock = band.time()
        summary = {
            "band": band.name,
            "number": band.number,
            "transport": band.transport_kind,
            "firmware": band.info.firmware,
            "protocol": band.info.protocol,
            "capabilities": band.info.capabilities,
            "battery": dict(batt),
            "radio": dict(radio),
            "led": dict(led),
            "clock_source": clock.source,
        }
        print(json.dumps(summary, indent=2))
    return 0


def cmd_identify(args: argparse.Namespace) -> int:
    with open_band69(args) as band:
        band.identify(args.seconds)
        print(f"Blinking {band.name} white for {args.seconds}s.")
    return 0


def cmd_led(args: argparse.Namespace) -> int:
    with open_band69(args) as band:
        if args.color.lower() == "off":
            band.led_off()
            print(f"Turned {band.name} LED off.")
        else:
            band.set_led(
                args.color,
                brightness=args.brightness,
                pattern=args.pattern,
                period=args.period,
            )
            print(f"Set {band.name} LED -> {args.color} ({args.pattern}, brightness={args.brightness}).")
    return 0


def cmd_listen(args: argparse.Namespace) -> int:
    import speech  # from vexo-open-kit/examples/python/speech.py

    if args.send_to_fyde:
        args.user = verify_fyde_session(args.relay, args.user)
    with open_band69(args) as band:
        if args.sim:
            print(f"[Sim {band.name}] Simulated transcript: 'Send my Kyoto ramen photos to Maya'")
            transcript = "Send my Kyoto ramen photos to Maya"
        else:
            transcript = speech.listen(band, args.seconds).strip()

        print(f"Transcript ({band.name}): {transcript!r}")
        if args.send_to_fyde and transcript:
            reply = dispatch_voice_to_fyde(args.relay, args.user, transcript)
            print(f"Fyde Chat reply: {str(reply.get('text') or '').replace('**', '')}")
            color, pattern, period = voice_reply_led(reply)
            band.set_led(color, brightness=0.5, pattern=pattern, period=period)
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    import speech  # from vexo-open-kit/examples/python/speech.py

    args.user = verify_fyde_session(args.relay, args.user)
    print(f"Connecting to {BAND_NAME} -> Fyde Relay ({args.relay}, user={args.user})...", flush=True)
    with open_band69(args, auto_reconnect=not args.sim) as band:
        band.set_led("#ff5500", brightness=0.35, pattern="solid")
        band.configure(events=True, battery=True)

        listening_lock = threading.Lock()
        active_ears: dict[str, Any] = {"ears": None, "audio_handler": None, "timer": None, "timeout": None, "starting": False, "dispatching": False}

        def stop_and_send() -> None:
            with listening_lock:
                ears = active_ears["ears"]
                handler = active_ears["audio_handler"]
                if ears is None:
                    return
                active_ears["ears"] = None
                active_ears["audio_handler"] = None
                active_ears["dispatching"] = True
                if active_ears["timer"] is not None:
                    active_ears["timer"].cancel()
                if active_ears["timeout"] is not None:
                    active_ears["timeout"].cancel()

            if handler is not None:
                band.off("audio", handler)
            try:
                band.configure(audio=False)
            except VexoError:
                pass
            try:
                words = ears.stop().strip()
                print(f"\n[{BAND_NAME}] Heard: {words!r}")
                try:
                    band.set_led("#ff5500", brightness=0.35, pattern="solid")
                except VexoError:
                    pass  # LED feedback must not prevent a captured command from reaching chat.
                if words:
                    reply = dispatch_voice_to_fyde(args.relay, args.user, words)
                    print(f"[Fyde] {str(reply.get('text') or '').replace('**', '')}")
                    color, pattern, period = voice_reply_led(reply)
                    band.set_led(color, brightness=0.6, pattern=pattern, period=period)
                    if pattern == "breathe" and color == "#ffbe00":
                        print(f"[{BAND_NAME}] Single-tap to send it, or ignore to leave it unsent.")
            except (urllib.error.URLError, OSError, VexoError) as exc:
                print(f"[Fyde] Command failed; check chat before retrying: {type(exc).__name__}", file=sys.stderr)
                try:
                    band.set_led("#ff2337", brightness=0.6, pattern="blink", period=300)
                except VexoError:
                    pass
            finally:
                with listening_lock:
                    active_ears["dispatching"] = False

        def on_transcript(text: str, final: bool) -> None:
            # Finish after a complete sentence and a short pause; the app is not needed.
            with listening_lock:
                if active_ears["ears"] is None or not text.strip():
                    return
                if active_ears["timer"] is not None:
                    active_ears["timer"].cancel()
                active_ears["timer"] = None
                if final:
                    timer = threading.Timer(1.5, stop_and_send)
                    timer.daemon = True
                    active_ears["timer"] = timer
                    timer.start()

        @band.on("double-tap")
        def _on_double_tap(_ev) -> None:
            with listening_lock:
                if active_ears["starting"] or active_ears["dispatching"]:
                    return
                listening = active_ears["ears"] is not None
                if not listening:
                    active_ears["starting"] = True
            if listening:
                stop_and_send()
                return
            print(f"\n[{BAND_NAME}] Double-tap -> starting wrist voice capture (double-tap again to send)...")
            try:
                show_microphone_notice()
                ears = speech.create(endpointing=500)
                ears.start(on_transcript)
                audio_fn = lambda a: ears.feed(a.opus, a.seq)
                with listening_lock:
                    active_ears["ears"] = ears
                    active_ears["audio_handler"] = audio_fn
                    timer = threading.Timer(25.0, stop_and_send)
                    timer.daemon = True
                    active_ears["timeout"] = timer
                band.on("audio", audio_fn)
                band.configure(audio=True)  # hardware locks solid blue mic LED
                timer.start()
            except VexoError as exc:
                print(f"[{BAND_NAME}] Voice capture unavailable: {exc}", file=sys.stderr)
                with listening_lock:
                    failed_ears = active_ears["ears"]
                    handler = active_ears["audio_handler"]
                    active_ears["ears"] = None
                    active_ears["audio_handler"] = None
                    if active_ears["timeout"] is not None:
                        active_ears["timeout"].cancel()
                if handler is not None:
                    band.off("audio", handler)
                if failed_ears is not None:
                    try:
                        failed_ears.stop()
                    except VexoError:
                        pass
            finally:
                with listening_lock:
                    active_ears["starting"] = False

        @band.on("tap")
        def _on_single_tap(_ev) -> None:
            with listening_lock:
                if active_ears["ears"] is not None or active_ears["starting"] or active_ears["dispatching"]:
                    return
            try:
                # A held voice send (amber LED) takes priority over inbox approvals.
                msg = confirm_pending_voice_send(args.relay, args.user) or approve_first_pending_fyde_request(
                    args.relay, args.user
                )
                print(f"[{BAND_NAME} Single-Tap] {msg}")
                if active_ears["ears"] is None:
                    band.set_led("#14dc6e", brightness=0.55, pattern="flash", period=500)
            except (urllib.error.URLError, OSError) as exc:
                print(f"[{BAND_NAME} Single-Tap] Relay unreachable ({args.relay}): {exc}", file=sys.stderr)

        @band.on("tilt")
        def _on_tilt(_ev) -> None:
            print(f"[{BAND_NAME}] Wrist tilt detected.")

        @band.on("reconnecting")
        def _on_reconnecting(ev) -> None:
            print(f"[{BAND_NAME}] Link dropped ({ev.reason}); auto-reconnecting for {ev.seconds}s...")

        @band.on("reconnected")
        def _on_reconnected(ev) -> None:
            print(f"[{BAND_NAME}] Reconnected in {ev.seconds:.1f}s!")

        print(
            f"Connected to {band.name} ({band.transport_kind}, fw {band.info.firmware}).\n"
            f"  - Double-tap wrist : Toggle Deepgram voice -> Fyde Chat (\"send that to Maya\")\n"
            f"  - Single-tap wrist : Send a held voice send (amber), else approve a pending request\n"
            f"  - Press Ctrl+C     : Disconnect cleanly"
        )
        try:
            band.wait()
        finally:
            # Stop the microphone on shutdown without executing an unfinished command.
            with listening_lock:
                ears = active_ears["ears"]
                active_ears["ears"] = None
                timer = active_ears["timer"]
                if timer is not None:
                    timer.cancel()
                if active_ears["timeout"] is not None:
                    active_ears["timeout"].cancel()
            if ears is not None:
                band.configure(audio=False)
                ears.stop()
    return 0


def cmd_service(args: argparse.Namespace) -> int:
    """Manage a per-user macOS listener independently of the Fyde app process."""
    if sys.platform != "darwin":
        raise VexoError("platform", "The login service requires macOS. Use the watch command on other systems.")
    label = "com.fydefiles.vexo69"
    domain = f"gui/{os.getuid()}"
    path = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
    if args.action == "stop":
        subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True, check=False)
        if path.exists():
            path.unlink()
        print("Stopped the Vexo #69 login listener.")
        return 0
    if args.action == "status":
        result = subprocess.run(["launchctl", "print", f"{domain}/{label}"], capture_output=True, text=True)
        # Never print launchctl's environment, which may include credentials.
        print("Vexo #69 login listener is loaded." if result.returncode == 0 else "Vexo #69 login listener is stopped.")
        return 0 if result.returncode == 0 else 1
    saved = read_environment()
    if not saved.get("DEEPGRAM_API_KEY") or not saved.get("FYDE_SESSION_TOKEN"):
        raise VexoError("config", "The login listener needs DEEPGRAM_API_KEY and FYDE_SESSION_TOKEN in the untracked project .env so they remain available after login.")
    args.user = verify_fyde_session(args.relay, args.user)
    import speech
    speech.find_key()  # Validate availability without logging or persisting the key.
    logs = Path.home() / "Library" / "Logs" / "Fyde"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, "-u", os.path.abspath(__file__), "watch", "--relay", args.relay, "--user", args.user]
    if args.usb:
        command.append("--usb")
    if args.serial_port:
        command += ["--serial-port", args.serial_port]
    config = {
        "Label": label,
        "ProgramArguments": command,
        "WorkingDirectory": REPO_ROOT,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "StandardOutPath": str(logs / "vexo69.log"),
        "StandardErrorPath": str(logs / "vexo69.log"),
    }
    # launchd restarts from the untracked .env; secrets never enter the plist.
    path.write_bytes(plistlib.dumps(config))
    path.chmod(0o600)
    subprocess.run(["launchctl", "bootout", f"{domain}/{label}"], capture_output=True, check=False)
    subprocess.run(["launchctl", "bootstrap", domain, str(path)], check=True)
    print("Started Vexo #69 at login. Fyde can be closed; double-tap, speak, and pause to send. Results are saved in chat.")
    return 0


# ---- RFC 6455 WebSocket Raw Frame Bridge (Mac <-> Xcode iOS Simulator) ----------------

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


async def _ws_handshake(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> bool:
    raw_headers = await reader.readuntil(b"\r\n\r\n")
    text = raw_headers.decode("latin-1")
    key: Optional[str] = None
    for line in text.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip().lower() == "sec-websocket-key":
                key = v.strip()
                break
    if not key:
        writer.close()
        return False
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    writer.write(resp.encode("ascii"))
    await writer.drain()
    return True


async def _ws_read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    head = await reader.readexactly(2)
    b0, b1 = head[0], head[1]
    opcode = b0 & 0x0F
    masked = (b1 & 0x80) != 0
    length = b1 & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask_key = await reader.readexactly(4) if masked else b""
    payload = bytearray(await reader.readexactly(length))
    if masked:
        for i in range(length):
            payload[i] ^= mask_key[i & 3]
    return opcode, bytes(payload)


def _ws_encode_frame(payload: bytes, opcode: int = 0x02) -> bytes:
    n = len(payload)
    header = bytearray([0x80 | (opcode & 0x0F)])
    if n < 126:
        header.append(n)
    elif n < 65536:
        header.append(126)
        header.extend(struct.pack("!H", n))
    else:
        header.append(127)
        header.extend(struct.pack("!Q", n))
    return bytes(header) + payload


def _make_raw_transport(args: argparse.Namespace):
    if getattr(args, "sim", False):
        from vexo_open.transports.sim import SimTransport
        return SimTransport(BAND)
    if getattr(args, "usb", False) or getattr(args, "serial_port", None):
        from vexo_open.transports.serial import SerialTransport
        return SerialTransport(port=getattr(args, "serial_port", None))
    from vexo_open.transports.ble import BleTransport
    return BleTransport(BAND)


async def _verify_transport_is_band69(transport) -> dict[str, Any]:
    """Send GET_INFO before exposing the transport and enforce band_no == 69."""
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[dict[str, Any]] = loop.create_future()

    def _on_frame(frame: bytes) -> None:
        decoded = codec.decode_frame(frame)
        if not decoded:
            return
        if decoded.get("frame") == "response" and decoded.get("opcode") == "GET_INFO" and not fut.done():
            fut.set_result(decoded)

    transport.on_frame = _on_frame
    await transport.send(codec.encode_command(0, "GET_INFO"))
    resp = await asyncio.wait_for(fut, timeout=3.0)
    if resp.get("status") != "OK":
        await transport.close()
        raise VexoError("protocol", f"GET_INFO failed with status {resp.get('status')}.")
    data = resp["data"]
    found_no = data["band_no"]
    if found_no != BAND:
        await transport.close()
        raise VexoError(
            "wrong-band",
            f"Refusing to bridge band #{found_no}: this workspace is strictly locked to {BAND_NAME} (#{BAND}).",
        )
    return data


async def _run_bridge_server(args: argparse.Namespace) -> None:
    print(f"Opening {BAND_NAME} transport ({'sim' if args.sim else 'serial' if (args.usb or args.serial_port) else 'ble'})...")
    transport = _make_raw_transport(args)
    await transport.open()
    try:
        info = await _verify_transport_is_band69(transport)
    except BaseException:
        await transport.close()
        raise

    clients: set[asyncio.StreamWriter] = set()

    def _forward_from_band(frame: bytes) -> None:
        packet = _ws_encode_frame(frame, opcode=0x02)
        stale: list[asyncio.StreamWriter] = []
        for w in list(clients):
            try:
                w.write(packet)
            except Exception:
                stale.append(w)
        for w in stale:
            clients.discard(w)

    def _on_band_closed(reason: str) -> None:
        print(f"[{BAND_NAME}] Transport closed: {reason}", file=sys.stderr)
        for w in list(clients):
            try:
                w.write(_ws_encode_frame(b"", opcode=0x08))
                w.close()
            except Exception:
                pass
        clients.clear()

    transport.on_frame = _forward_from_band
    transport.on_close = _on_band_closed

    async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        try:
            if not await _ws_handshake(reader, writer):
                return
            clients.add(writer)
            print(f"[Bridge] Fyde app connected from {peer}")
            while True:
                opcode, payload = await _ws_read_frame(reader)
                if opcode == 0x08:  # Close
                    break
                if opcode == 0x09:  # Ping -> Pong
                    writer.write(_ws_encode_frame(payload, opcode=0x0A))
                    await writer.drain()
                    continue
                if opcode == 0x02 and payload:  # Binary Vexo command frame
                    # Block SET_BAND_NUMBER at bridge boundary too (Rule 1)
                    if len(payload) >= 3 and payload[0] == codec.TYPE_COMMAND and payload[2] == codec.OPCODES["SET_BAND_NUMBER"]:
                        print("[Bridge] Blocked forbidden SET_BAND_NUMBER command.", file=sys.stderr)
                        continue
                    await transport.send(payload)
                elif opcode == 0x01 and payload:  # Hex text fallback
                    try:
                        raw = bytes.fromhex(payload.decode("ascii").strip())
                        if raw and not (len(raw) >= 3 and raw[0] == codec.TYPE_COMMAND and raw[2] == codec.OPCODES["SET_BAND_NUMBER"]):
                            await transport.send(raw)
                    except ValueError:
                        pass
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            clients.discard(writer)
            try:
                writer.close()
            except Exception:
                pass
            print(f"[Bridge] Fyde app disconnected ({peer})")

    server = await asyncio.start_server(_handle_client, args.host, args.port)
    fw = f"{info['fw_major']}.{info['fw_minor']}.{info['fw_patch']}"
    print(
        f"Verified {BAND_NAME} (fw {fw})!\n"
        f"Mac WebSocket Bridge listening on ws://{args.host}:{args.port}\n"
        f"In Fyde on iOS Simulator -> Vexo #69 -> choose 'Mac Bridge' -> tap 'Connect Vexo #69'."
    )
    try:
        async with server:
            await server.serve_forever()
    finally:
        await transport.close()


def cmd_bridge(args: argparse.Namespace) -> int:
    try:
        asyncio.run(_run_bridge_server(args))
    except KeyboardInterrupt:
        print("\nStopped Mac Vexo Bridge.")
    return 0


# ---- CLI Parser -----------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=f"Interface {BAND_NAME} (Band #{BAND}) with Fyde on iPhone & macOS."
    )
    common = argparse.ArgumentParser(add_help=False)
    mode = common.add_mutually_exclusive_group()
    mode.add_argument("--sim", action="store_true", help=f"Use pretend band {BAND_NAME} (no hardware required)")
    mode.add_argument("--usb", action="store_true", help=f"Connect to {BAND_NAME} over USB-C cable")
    common.add_argument("--serial-port", dest="serial_port", default=None, help="Explicit USB serial port (e.g. /dev/cu.usbmodem101)")

    sub = p.add_subparsers(dest="subcommand", required=True)

    s_status = sub.add_parser("status", parents=[common], help=f"Read {BAND_NAME} firmware, battery, radio & LED status")
    s_status.set_defaults(func=cmd_status)

    s_id = sub.add_parser("identify", parents=[common], help=f"Blink {BAND_NAME} white to confirm physical wristband")
    s_id.add_argument("seconds", nargs="?", type=int, default=5, help="Seconds to blink white (1..30)")
    s_id.set_defaults(func=cmd_identify)

    s_led = sub.add_parser("led", parents=[common], help=f"Set {BAND_NAME} RGB LED or turn 'off'")
    s_led.add_argument("color", help="Hex color like '#ff5500' or 'off'")
    s_led.add_argument("--pattern", default="solid", choices=["solid", "blink", "breathe", "flash", "rainbow"])
    s_led.add_argument("--brightness", type=float, default=0.5, help="Brightness 0.0 .. 1.0")
    s_led.add_argument("--period", type=int, default=1000, help="Cycle period in ms (100..10000)")
    s_led.set_defaults(func=cmd_led)

    s_listen = sub.add_parser("listen", parents=[common], help=f"Stream {BAND_NAME} mic -> Deepgram Nova-3")
    s_listen.add_argument("seconds", nargs="?", type=float, default=6.0, help="Seconds to listen")
    s_listen.add_argument("--send-to-fyde", action="store_true", help="Send final transcript to Fyde /api/chat")
    s_listen.add_argument("--relay", default=DEFAULT_FYDE_RELAY_URL, help="Fyde relay URL")
    s_listen.add_argument("--user", default=DEFAULT_FYDE_USER_ID, help="Fyde user handle")
    s_listen.set_defaults(func=cmd_listen)

    s_watch = sub.add_parser("watch", parents=[common], help=f"Run live {BAND_NAME} -> Fyde gesture & voice daemon")
    s_watch.add_argument("--relay", default=DEFAULT_FYDE_RELAY_URL, help="Fyde relay URL")
    s_watch.add_argument("--user", default=DEFAULT_FYDE_USER_ID, help="Fyde user handle")
    s_watch.set_defaults(func=cmd_watch)

    s_service = sub.add_parser("service", parents=[common], help="Manage the standalone macOS login listener")
    s_service.add_argument("action", choices=["start", "stop", "status"])
    s_service.add_argument("--relay", default=DEFAULT_FYDE_RELAY_URL)
    s_service.add_argument("--user", default=DEFAULT_FYDE_USER_ID)
    s_service.set_defaults(func=cmd_service)

    s_bridge = sub.add_parser("bridge", parents=[common], help="Expose ws://127.0.0.1:8790 for Xcode iPhone Simulator")
    s_bridge.add_argument("--host", default=DEFAULT_BRIDGE_HOST)
    s_bridge.add_argument("--port", type=int, default=DEFAULT_BRIDGE_PORT)
    s_bridge.set_defaults(func=cmd_bridge)

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
