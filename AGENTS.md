# Fyde + Vexo Open (`Vexo-HACK-69`) Agent Guide

## Assigned Hardware Identity (Strict Rules)

1. **Assigned Band:** **`69`** (`Vexo-HACK-69`).
   - Python single source of truth: `BAND = 69` in `vexo/config.py`.
   - Swift single source of truth: `VexoBandConstants.assignedBandNumber = 69` in `apple/Sources/FydeKit/Vexo/VexoBandProtocol.swift`.
2. **Never connect to another band:** Only scan for, connect to, or accept `Vexo-HACK-69`. After every connection (Bluetooth, USB serial, or WebSocket bridge), verify `GET_INFO` returns `band_no == 69`; if another band answers, disconnect immediately without changing anything.
3. **Never renumber a band:** Never send `SET_BAND_NUMBER` (`0x03`) or call `set_band_number`.
4. **Never edit `vexo-open-kit/`:** `vexo-open-kit/` is the unmodified upstream reference clone (`https://github.com/VexoAI-Org/vexo-open-kit`). Import from `vexo-open-kit/python` or mirror its contract (`vexo-open-kit/contract/contract.md`) in project code (`apple/` and `vexo/`).
5. **Secrets & Microphone Privacy:**
   - Never ask for, hardcode, commit, print, or persist `DEEPGRAM_API_KEY` or `OPENAI_API_KEY` in code, `UserDefaults`, logs, or band storage. Read from environment variables or an untracked `.env` file only (or in-memory session field on iOS).
   - Keep `mip_opt_out=true` on Deepgram connections and always surface the Deepgram microphone privacy notice whenever wrist audio streaming is active.
   - Remember that while `AUDIO` or `MIC_LEVEL` streams, the band's RGB LED is hardware-locked to solid blue (`LED_SET` and `IDENTIFY` return `DENIED` until audio stops).

## Connecting `Vexo-HACK-69` to the Fyde iPhone App

- **Physical iPhone (Native `CoreBluetooth`):**
  1. Keep Bluetooth **ON** on the iPhone, **do NOT pair** `Vexo-HACK-69` in iOS **Settings -> Bluetooth** (Vexo firmware has no bonding/encryption and rejects OS pairing requests).
  2. Close any browser dashboard or laptop script currently connected to `Vexo-HACK-69` (the band accepts one BLE connection at a time).
  3. **Double-tap** `Vexo-HACK-69` so its light blinks blue (60-second advertising window).
  4. Open **Fyde** on the iPhone, tap the **`Vexo #69`** pill in the top header, ensure mode is **Bluetooth**, and tap **Connect Vexo #69**.
- **Xcode iPhone Simulator (`Mac Bridge` or `Sim #69`):**
  - Because the Xcode iOS Simulator has no Bluetooth hardware access, either select **`Sim #69`** inside Fyde for the built-in pretend band, or run `python3 vexo/fyde_bridge.py bridge` on the Mac (connecting to real `Vexo-HACK-69` over Mac BLE or `--usb`) and select **`Mac Bridge`** (`ws://127.0.0.1:8790`) inside Fyde.

## Direct CLI / Agent Commands (`vexo/fyde_bridge.py`)

```bash
# Query Vexo-HACK-69 status (omit --sim for real BLE, or pass --usb for USB-C)
python3 vexo/fyde_bridge.py status
python3 vexo/fyde_bridge.py status --sim

# Blink Vexo-HACK-69 white or set RGB LED
python3 vexo/fyde_bridge.py identify 5
python3 vexo/fyde_bridge.py led "#ff5500" --pattern breathe

# Stream wrist speech -> Deepgram Nova-3 -> Fyde Chat (/api/chat)
python3 vexo/fyde_bridge.py listen 6 --send-to-fyde

# Run continuous wrist-to-Fyde daemon on Mac
python3 vexo/fyde_bridge.py watch

# Bridge real Vexo-HACK-69 (BLE or USB) to Fyde running in Xcode iPhone Simulator
python3 vexo/fyde_bridge.py bridge
```
