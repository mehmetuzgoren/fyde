---
name: vexo-fyde
description: Connect, test, and control Vexo wristband #69 (Vexo-HACK-69) with the Fyde iPhone and macOS file-transfer application over Bluetooth, USB, Mac WebSocket Bridge, or Simulator.
---

# Vexo-HACK-69 <-> Fyde Integration Skill

Use this skill whenever the user asks to connect, debug, control, or extend the **Vexo Open wristband (`Vexo-HACK-69`, Band `#69`)** integration with **Fyde**.

## Non-Negotiable Safety Rules

1. **Band `#69` Only (`Vexo-HACK-69`):**
   - Python constant: `BAND = 69` in `vexo/config.py`.
   - Swift constant: `VexoBandConstants.assignedBandNumber = 69` in `apple/Sources/FydeKit/Vexo/VexoBandProtocol.swift`.
   - Always verify `GET_INFO` `band_no == 69` immediately upon connection; disconnect without touching settings if another band answers.
   - Never send `SET_BAND_NUMBER`.
2. **Leave `vexo-open-kit/` Untouched:**
   - Read docs and contract specs from `vexo-open-kit/contract/contract.md`, `vexo-open-kit/docs/bluetooth-contract.md`, and `vexo-open-kit/docs/deepgram.md`, but never modify files inside `vexo-open-kit/`.
3. **API Keys & Audio Privacy:**
   - Never ask the user to paste `DEEPGRAM_API_KEY` into chat, never log/print it, and never persist it to `UserDefaults` or band storage. Read from environment/`.env` on Mac or transient in-memory `SecureField` on iOS.
   - Keep `mip_opt_out=true` and display the Deepgram microphone notice whenever `AUDIO` streaming is active.

## Architecture Map

- **Native iOS & macOS App (`apple/Sources/FydeKit/`):**
  - `Vexo/VexoBandProtocol.swift`: Byte-exact Vexo Open v1.1 protocol codec, BLE UUIDs (`254f0001/2/3-df82-4a9c-a2b5-563a0f6b2021`), and strict `Vexo-HACK-69` / `0xFFFF` (`[0x4F, proto, 0x45, 0x00]`) advertisement filter.
  - `Vexo/VexoDeepgramClient.swift`: Native `URLSessionWebSocketTask` streaming raw 16kHz 20ms Vexo Opus packets directly to Deepgram Nova-3 (`encoding=opus&sample_rate=16000&channels=1&mip_opt_out=true`).
  - `Vexo/VexoBandManager.swift`: `@MainActor @Observable` controller supporting `.bluetooth` (`CoreBluetooth`), `.macBridge` (`ws://127.0.0.1:8790`), and `.simulator` (`Sim #69`), with 120s auto-reconnect, mic-LED lock guard, and 1.5g wrist shake detector.
  - `Views/VexoBandView.swift`: Header `Vexo #69` pill, live blue-LED mic banner, and full `VexoBandSheetView` control sheet.
  - `FydeStore.swift`: Wires wrist gestures to Fyde file transfer actions:
    - **Double-tap** -> Toggle wrist voice capture -> Deepgram -> `sendChatPrompt(..., source: "vexo")` (e.g., *"Vexo, send that to John"*, *"Vexo send my cat picture to John"*).
      - Parsing lives in `edge/src/voiceCommands.ts` (wake word, "send X to Y" / "text Y the X", "that/it/those" -> last files in the chat, contact first-name + one-letter-off matching). Handler: `handleChatSendCommand` in `edge/src/index.ts`.
      - With `source=vexo` the relay sends immediately only when the recipient's permissions (`evaluateAssetPermission`) cover every file; otherwise it returns a `send_confirmation` card (band breathes amber). Private-tagged files are never band-confirmable.
    - **Single-tap** -> Send the most recent held voice send (held < 10 min, `POST /api/chat/confirm` with `via=band`); otherwise approve pending Ask-First `AccessRequest` or save latest delivered `TransferBundle` directly to Apple Photos / Files.
    - **Wrist tilt** -> Cycle `Search` / `Chat` / `Received` tabs.
    - **Wrist shake** -> Refresh Fyde relay inbox & search index (`refreshAll()`), or cancel active voice listening.
- **Mac CLI & Simulator Bridge (`vexo/`):**
  - `vexo/config.py`: Defines `BAND = 69`.
  - `vexo/fyde_bridge.py`: Provides `status`, `identify`, `led`, `listen`, `watch`, and `bridge` (`ws://127.0.0.1:8790`).

## Common Commands

### 1. Direct Wristband Check or Control from Mac
```bash
# Real BLE (double-tap Vexo-HACK-69 first so it blinks blue)
python3 vexo/fyde_bridge.py status
python3 vexo/fyde_bridge.py identify 5
python3 vexo/fyde_bridge.py led "#ff5500" --pattern breathe

# Over USB-C cable (no double-tap needed)
python3 vexo/fyde_bridge.py status --usb

# Pretend Band #69 simulator
python3 vexo/fyde_bridge.py status --sim
```

### 2. Bridge Real `Vexo-HACK-69` to Xcode iPhone Simulator
```bash
python3 vexo/fyde_bridge.py bridge        # via Mac Bluetooth
python3 vexo/fyde_bridge.py bridge --usb  # via Mac USB-C cable
python3 vexo/fyde_bridge.py bridge --sim  # via SimTransport(69)
```

### 3. Build & Test Apple App (`FydeKit` + `Fyde.xcodeproj`)
```bash
cd apple && swift test
cd apple/FydeApp && xcodebuild -project Fyde.xcodeproj -scheme Fyde -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```
