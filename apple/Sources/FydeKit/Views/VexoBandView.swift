import SwiftUI

// MARK: - Compact Pill Shown in the Chat Header

public struct VexoRibbonPillView: View {
    @Bindable var vexo: VexoBandManager
    var onTap: () -> Void

    public init(vexo: VexoBandManager, onTap: @escaping () -> Void) {
        self.vexo = vexo
        self.onTap = onTap
    }

    public var body: some View {
        Button(action: onTap) {
            FydeStatusPill(title: pillTitle, detail: batteryDetail, tone: tone) {
                ZStack {
                    if isBusy {
                        Circle()
                            .stroke(dotColor.opacity(0.35), lineWidth: 3)
                            .frame(width: 13, height: 13)
                    }
                    Circle()
                        .fill(dotColor)
                        .frame(width: 7, height: 7)
                }
                .frame(width: 13, height: 13)
                Image(systemName: vexo.isListeningVoice ? "waveform" : "applewatch.radiowaves.left.and.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tone == .neutral ? FydeTheme.inkSecondary : tone.foreground)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Vexo band \(vexo.bandNumber): \(pillTitle)")
    }

    private var isBusy: Bool {
        switch vexo.phase {
        case .scanning, .connecting, .verifying, .reconnecting: return true
        default: return false
        }
    }

    private var tone: FydeTone {
        if vexo.isListeningVoice { return .live }
        return vexo.isConnected ? .success : .neutral
    }

    private var batteryDetail: String? {
        guard vexo.isConnected, !vexo.isListeningVoice, let pct = vexo.battery?.percent else { return nil }
        return "\(pct)%"
    }

    private var dotColor: Color {
        if vexo.isListeningVoice { return FydeTheme.live }
        switch vexo.phase {
        case .connected: return FydeTheme.success
        case .scanning, .connecting, .verifying, .reconnecting: return FydeTheme.warning
        case .disconnected: return FydeTheme.muted
        }
    }

    private var pillTitle: String {
        if vexo.isListeningVoice {
            return "Listening on Vexo #\(vexo.bandNumber)"
        }
        switch vexo.phase {
        case .connected:
            return "Vexo #\(vexo.bandNumber)"
        case .scanning:
            return "Looking for Vexo #\(vexo.bandNumber)…"
        case .connecting, .verifying:
            return "Connecting Vexo #\(vexo.bandNumber)…"
        case .reconnecting:
            return "Reconnecting Vexo #\(vexo.bandNumber)…"
        case .disconnected:
            return "Connect Vexo #\(vexo.bandNumber)"
        }
    }
}

// MARK: - Live Wrist Microphone Banner Above the Chat Composer

public struct VexoLiveMicBannerView: View {
    @Bindable var vexo: VexoBandManager

    public init(vexo: VexoBandManager) {
        self.vexo = vexo
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                TimelineView(.animation(minimumInterval: 0.06)) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    HStack(alignment: .center, spacing: 3) {
                        ForEach(0..<5, id: \.self) { i in
                            let level = 0.35 + 0.65 * abs(sin(t * 6 + Double(i) * 0.9))
                            Capsule()
                                .fill(FydeTheme.live)
                                .frame(width: 3, height: 18 * level)
                        }
                    }
                    .frame(width: 28, height: 20)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("Listening on \(vexo.bandName)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(FydeTheme.live)
                    Text("Band light is solid blue while the mic is on")
                        .font(.caption2)
                        .foregroundStyle(FydeTheme.inkSecondary)
                }

                Spacer(minLength: 4)

                Button {
                    Task { await vexo.stopVoiceListeningAndDispatch(submit: false) }
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(FydeTheme.inkSecondary)
                        .frame(width: 32, height: 32)
                        .background(FydeTheme.surface, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel voice command")

                Button {
                    Task { await vexo.stopVoiceListeningAndDispatch(submit: true) }
                } label: {
                    Label("Send", systemImage: "arrow.up")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                        .background(FydeTheme.live, in: Capsule())
                }
                .buttonStyle(.plain)
            }

            Group {
                if !vexo.liveTranscript.isEmpty {
                    Text("“\(vexo.liveTranscript)”")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(FydeTheme.ink)
                } else {
                    Text("Speak near your wrist — e.g. “Send China trip photos to Maya”")
                        .font(.footnote)
                        .foregroundStyle(FydeTheme.inkSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(VexoDeepgramClient.privacyNotice)
                .font(.caption2)
                .foregroundStyle(FydeTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .background(FydeTheme.liveSoft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(FydeTheme.live.opacity(0.25), lineWidth: 1)
        )
    }
}

// MARK: - Full Vexo-HACK-69 Control & Diagnostics Sheet

public struct VexoBandSheetView: View {
    @Bindable var store: FydeStore
    @Environment(\.dismiss) private var dismiss

    @State private var selectedPattern: VexoLEDPattern = .solid
    @State private var customSimulatedPhrase: String = "Send China trip photos to Maya"

    private var vexo: VexoBandManager { store.vexo }

    public init(store: FydeStore) {
        self.store = store
    }

    public var body: some View {
        @Bindable var band = store.vexo
        NavigationStack {
            Form {
                // 1. Connection & iOS Bluetooth Instructions
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Label(band.bandName, systemImage: "applewatch.radiowaves.left.and.right")
                                .font(.headline.weight(.bold))
                            Spacer()
                            Text(phaseBadgeTitle)
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(phaseBadgeColor.opacity(0.16), in: Capsule())
                                .foregroundStyle(phaseBadgeColor)
                        }

                        Text(band.statusMessage)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if let err = band.lastError {
                            Text(err)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(.vertical, 2)

                    Picker("Connection Mode", selection: $band.transportKind) {
                        ForEach(VexoTransportKind.allCases) { mode in
                            Text(mode.title).tag(mode)
                        }
                    }
                    .disabled(band.phase != .disconnected)

                    Text(band.transportKind.subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    if band.transportKind == .bluetooth {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("How to connect on iPhone / Mac", systemImage: "info.circle.fill")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(FydeBrand.terracotta)
                            Text("1. Keep Bluetooth ON on your iPhone — **do not** pair \(band.bandName) in iOS Settings → Bluetooth (Vexo rejects OS pairing).\n2. **Double-tap \(band.bandName)** so its LED blinks blue (60s window).\n3. Tap **Connect \(band.bandName)** below.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    } else if band.transportKind == .macBridge {
                        TextField("Mac Bridge WebSocket URL", text: $band.macBridgeURL)
                            .autocorrectionDisabled()
                        Text("Run `python3 vexo/fyde_bridge.py bridge` on your Mac to bridge \(band.bandName) (Bluetooth or `--usb`) into the Xcode iPhone Simulator.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }

                    Toggle("Auto-Reconnect (120s window on drop)", isOn: $band.autoReconnect)

                    HStack(spacing: 12) {
                        if band.phase == .disconnected {
                            Button {
                                Task { await band.connect() }
                            } label: {
                                Label("Connect \(band.bandName)", systemImage: "bolt.horizontal.circle.fill")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(FydeBrand.terracotta)
                        } else {
                            Button(role: .destructive) {
                                band.disconnect()
                            } label: {
                                Label("Disconnect", systemImage: "xmark.circle.fill")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .buttonStyle(.bordered)

                            if band.isConnected {
                                Button {
                                    Task { await band.identifyBand(seconds: 3) }
                                } label: {
                                    Label("Identify (Blink White)", systemImage: "light.beacon.max.fill")
                                        .font(.caption.weight(.semibold))
                                }
                                .buttonStyle(.bordered)
                                .disabled(band.isMicLockedLED)
                            }
                        }
                    }
                } header: {
                    Text("Band #69 Bluetooth Link")
                }

                // 2. Live Wrist Telemetry
                if band.isConnected {
                    Section("Live \(band.bandName) Telemetry") {
                        if let info = band.bandInfo {
                            LabeledContent("Verified Hardware", value: "#\(info.bandNo) • fw \(info.firmwareVersion)")
                        }
                        if let batt = band.battery {
                            LabeledContent("Battery", value: "\(batt.percent)% (\(batt.stateLabel), \(batt.millivolts) mV)")
                        }
                        if let rssi = band.rssiDbm {
                            LabeledContent("BLE Signal (RSSI)", value: "\(rssi) dBm")
                        }
                        if let temp = band.chipTempCelsius {
                            LabeledContent("Chip Temp", value: String(format: "%.1f °C", temp))
                        }
                        LabeledContent("Activity & Steps", value: "\(band.activityStateLabel) • \(band.sessionSteps) steps (\(band.cadenceSpm) spm)")
                        LabeledContent("Motion |a|", value: String(format: "%.2f g", band.latestAccelMagnitudeG))
                    }
                }

                // 3. Voice-to-Fyde Chat (Deepgram Nova-3 Raw Opus)
                Section {
                    SecureField("Deepgram API Key (in-memory only)", text: $band.deepgramApiKeyInMemory)
                        .autocorrectionDisabled()

                    HStack {
                        Circle()
                            .fill(band.hasDeepgramKey ? Color.green : Color.orange)
                            .frame(width: 7, height: 7)
                        Text(band.hasDeepgramKey ? "Deepgram key loaded in memory" : "Paste your team's Deepgram key for live wrist STT")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if band.hasDeepgramKey {
                            Button("Forget Key") {
                                band.forgetDeepgramKey()
                            }
                            .font(.caption2.bold())
                        }
                    }

                    Toggle("Auto-submit spoken commands to Fyde Chat", isOn: $band.voiceAutoSendToChat)

                    Stepper("Max listen window: \(band.voiceListenDurationSec)s", value: $band.voiceListenDurationSec, in: 3...20)

                    if band.isConnected {
                        Button {
                            Task { await band.toggleVoiceListening() }
                        } label: {
                            Label(
                                band.isListeningVoice ? "Stop Listening & Send to Fyde" : "Speak into \(band.bandName) Now",
                                systemImage: band.isListeningVoice ? "stop.circle.fill" : "mic.circle.fill"
                            )
                            .font(.subheadline.weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(band.isListeningVoice ? FydeTheme.live : FydeTheme.accent)
                    }

                    if !band.liveTranscript.isEmpty {
                        LabeledContent("Last Transcript", value: band.liveTranscript)
                            .font(.caption)
                    }

                    Text(VexoDeepgramClient.privacyNotice)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Wrist Voice → Fyde Chat")
                }

                // 4. Physical Wrist Gestures -> Fyde Actions
                Section("Wrist Gestures → Fyde Actions") {
                    Toggle("Double-Tap: Start / Stop Voice Command", isOn: $band.doubleTapTogglesVoice)
                    Toggle("Single-Tap: Approve Request / Save Bundle to Photos", isOn: $band.singleTapApprovesOrSaves)
                    Toggle("Wrist Tilt: Cycle Search / Chat / Received Tabs", isOn: $band.tiltCyclesTabs)
                    Toggle("Wrist Shake (>1.5g): Refresh Inbox (or Cancel Mic)", isOn: $band.shakeRefreshesInbox)
                }

                // 5. RGB LED Control
                if band.isConnected {
                    Section {
                        Picker("LED Pattern", selection: $selectedPattern) {
                            ForEach(VexoLEDPattern.allCases) { p in
                                Text(p.label).tag(p)
                            }
                        }

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ledPresetButton("Fyde Orange", r: 255, g: 85, b: 0, tint: FydeBrand.terracotta)
                                ledPresetButton("Emerald", r: 0, g: 255, b: 100, tint: .green)
                                ledPresetButton("Indigo", r: 88, g: 86, b: 214, tint: FydeTheme.live)
                                ledPresetButton("Warm White", r: 255, g: 240, b: 220, tint: .orange)
                                ledPresetButton("LED Off", r: 0, g: 0, b: 0, brightness: 0, patternOverride: .off, tint: .secondary)
                            }
                            .padding(.vertical, 2)
                        }
                        .disabled(band.isMicLockedLED)

                        if band.isMicLockedLED {
                            Text("LED is hardware-locked to solid blue while the microphone stream is active.")
                                .font(.caption2)
                                .foregroundStyle(.blue)
                        }
                    } header: {
                        Text("\(band.bandName) RGB Light")
                    }
                }

                // 6. Test / Pretend Band Quick Triggers
                if band.isConnected {
                    Section("Test Wrist Triggers in Fyde") {
                        HStack(spacing: 8) {
                            Button("Sim Tap") {
                                Task { await band.simulateGesture(.tap) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)

                            Button("Sim Tilt") {
                                Task { await band.simulateGesture(.tilt) }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)

                            Button("Sim Shake") {
                                Task { await band.simulateShake() }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }

                        HStack(spacing: 8) {
                            TextField("Simulated wrist voice command", text: $customSimulatedPhrase)
                                .font(.caption)
                            Button("Send as Wrist Voice") {
                                let text = customSimulatedPhrase.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !text.isEmpty else { return }
                                Task {
                                    await band.simulateSpokenCommand(text)
                                    dismiss()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(FydeTheme.accent)
                            .controlSize(.small)
                        }
                    }
                }

                // 7. Recent Event Log
                if !band.recentEvents.isEmpty {
                    Section("Recent \(band.bandName) Events") {
                        ForEach(band.recentEvents.prefix(10)) { ev in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(ev.title)
                                        .font(.caption.weight(.semibold))
                                    Spacer()
                                    Text(ev.timestamp, style: .time)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Text(ev.detail)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(FydeTheme.paper)
            .tint(FydeTheme.accent)
            .navigationTitle("Vexo #\(vexo.bandNumber)")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 580)
        #endif
    }

    private func ledPresetButton(
        _ label: String,
        r: UInt8,
        g: UInt8,
        b: UInt8,
        brightness: UInt8 = 140,
        patternOverride: VexoLEDPattern? = nil,
        tint: Color
    ) -> some View {
        Button {
            let pat = patternOverride ?? selectedPattern
            Task {
                await vexo.setBandLED(VexoLEDState(
                    r: r,
                    g: g,
                    b: b,
                    brightness: brightness,
                    pattern: pat,
                    periodMs: 800
                ))
            }
        } label: {
            Text(label)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(tint.opacity(0.15), in: Capsule())
                .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }

    private var phaseBadgeTitle: String {
        switch vexo.phase {
        case .connected: return "Connected"
        case .scanning: return "Scanning BLE"
        case .connecting: return "Connecting"
        case .verifying: return "Verifying #69"
        case .reconnecting: return "Auto-Reconnecting"
        case .disconnected: return "Disconnected"
        }
    }

    private var phaseBadgeColor: Color {
        switch vexo.phase {
        case .connected: return .green
        case .scanning, .connecting, .verifying, .reconnecting: return .orange
        case .disconnected: return .secondary
        }
    }
}
