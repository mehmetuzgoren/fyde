import Foundation
import Observation
@preconcurrency import CoreBluetooth
#if os(iOS)
import UIKit
#endif

public enum VexoTransportKind: String, CaseIterable, Sendable, Identifiable {
    case bluetooth = "bluetooth"
    case macBridge = "mac_bridge"
    case simulator = "simulator"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .bluetooth: return "Bluetooth (Vexo-HACK-69)"
        case .macBridge: return "Mac Bridge (ws://)"
        case .simulator: return "Pretend Band (Sim #69)"
        }
    }

    public var subtitle: String {
        switch self {
        case .bluetooth:
            return "Direct CoreBluetooth connection on iPhone or Mac. Double-tap Vexo-HACK-69 first."
        case .macBridge:
            return "For Xcode iPhone Simulator: bridges frames through vexo/fyde_bridge.py on your Mac."
        case .simulator:
            return "Built-in Vexo-HACK-69 hardware simulator for testing gestures, LED, and voice flows."
        }
    }
}

public enum VexoConnectionPhase: String, Sendable, Equatable {
    case disconnected
    case scanning
    case connecting
    case verifying
    case connected
    case reconnecting
}

public struct VexoGestureEventRecord: Identifiable, Sendable, Equatable {
    public let id: UUID
    public let timestamp: Date
    public let title: String
    public let detail: String

    public init(id: UUID = UUID(), timestamp: Date = Date(), title: String, detail: String) {
        self.id = id
        self.timestamp = timestamp
        self.title = title
        self.detail = detail
    }
}

@MainActor
@Observable
public final class VexoBandManager {
    // Hardcoded strictly to Band #69 per vexo-open-kit/AGENTS.md Rule 1
    public let bandNumber: Int = VexoBandConstants.assignedBandNumber
    public var bandName: String { VexoBandConstants.assignedBandName }

    public var transportKind: VexoTransportKind = {
        #if targetEnvironment(simulator)
        return .macBridge
        #else
        return .bluetooth
        #endif
    }()

    public var macBridgeURL: String = "ws://127.0.0.1:8790" {
        didSet {
            UserDefaults.standard.set(macBridgeURL, forKey: "fyde.vexo.macBridgeURL")
        }
    }

    public var phase: VexoConnectionPhase = .disconnected
    public var autoReconnect: Bool = true
    public var statusMessage: String = "Double-tap Vexo-HACK-69 (blue blink), then tap Connect."
    public var lastError: String?

    // Live Band Telemetry
    public var bandInfo: VexoBandInfo?
    public var battery: VexoBatteryReading?
    public var chipTempCelsius: Double?
    public var rssiDbm: Int?
    public var latestMotion: VexoMotionSample?
    public var latestAccelMagnitudeG: Double = 1.0
    public var activityStateLabel: String = "Still"
    public var sessionSteps: Int = 0
    public var cadenceSpm: Int = 0
    public var activeStreams: VexoStreamMask = []
    public var currentLED: VexoLEDState = VexoLEDState(r: 255, g: 85, b: 0, brightness: 96, pattern: .solid, periodMs: 1000)
    public var recentEvents: [VexoGestureEventRecord] = []

    // Voice-to-Fyde (Deepgram Nova-3 over raw Opus)
    /// Stored strictly in memory for the current session (never persisted to UserDefaults, logs, or band storage).
    public var deepgramApiKeyInMemory: String = ""
    public var isListeningVoice: Bool = false
    public var liveTranscript: String = ""
    public var voiceAutoSendToChat: Bool = true
    public var voiceListenDurationSec: Int = 7
    public var audioPacketsReceived: Int = 0

    // Gesture-to-Fyde Mappings
    public var doubleTapTogglesVoice: Bool = true
    public var singleTapApprovesOrSaves: Bool = true
    public var tiltCyclesTabs: Bool = true
    public var shakeRefreshesInbox: Bool = true

    // Hooks wired by FydeStore
    public var onVoiceCommandReady: ((String) async -> Void)?
    public var onSingleTapTriggered: (() async -> String?)?
    public var onTiltTriggered: (() -> String?)?
    public var onShakeTriggered: (() async -> String?)?

    public var isConnected: Bool { phase == .connected }
    public var isMicLockedLED: Bool {
        activeStreams.contains(.audio) || activeStreams.contains(.micLevel)
    }
    public var hasDeepgramKey: Bool {
        !effectiveDeepgramKey.isEmpty
    }

    // Internal drivers & command synchronization
    private let bleDriver = VexoCoreBluetoothDriver()
    private let deepgram = VexoDeepgramClient()
    private var bridgeWebSocket: URLSessionWebSocketTask?
    private var bridgeReceiveTask: Task<Void, Never>?
    private var simLoopTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var voiceAutoStopTask: Task<Void, Never>?
    private var ledRestoreTask: Task<Void, Never>?

    private var userInitiatedDisconnect: Bool = false
    private var criticalBatterySeen: Bool = false
    private var baselineStepsTotal: UInt32?
    private var nextSeq: UInt8 = 0
    private var commandInFlight: Bool = false
    private var commandQueueWaiters: [CheckedContinuation<Void, Never>] = []
    private var pendingResponseSeq: UInt8?
    private var pendingResponseOpcode: UInt8?
    private var pendingResponseContinuation: CheckedContinuation<VexoResponseFrame, Error>?

    // Shake detection rolling buffer (0.5 s @ 50 Hz = 25 samples, threshold 1.5 g per AGENTS.md)
    private var recentMagnitudesG: [Double] = []
    private var shakeQuietUntil: Date = .distantPast
    #if os(iOS)
    private var voiceBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    #endif

    public init() {
        if let savedBridge = UserDefaults.standard.string(forKey: "fyde.vexo.macBridgeURL"), !savedBridge.isEmpty {
            self.macBridgeURL = savedBridge
        }
        // In Xcode Debug runs, optionally pick up DEEPGRAM_API_KEY from environment without persisting it anywhere.
        if let envKey = ProcessInfo.processInfo.environment["DEEPGRAM_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envKey.isEmpty {
            self.deepgramApiKeyInMemory = envKey
        }
        wireDrivers()
        #if os(iOS)
        if UserDefaults.standard.bool(forKey: "fyde.vexo.backgroundBluetooth") {
            bleDriver.prepareForRestoration()
        }
        #endif
    }

    private var effectiveDeepgramKey: String {
        deepgramApiKeyInMemory.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func forgetDeepgramKey() {
        deepgramApiKeyInMemory = ""
    }

    // MARK: - Connect / Disconnect

    public func connect() async {
        lastError = nil
        userInitiatedDisconnect = false
        criticalBatterySeen = false
        reconnectTask?.cancel()
        reconnectTask = nil

        switch transportKind {
        case .bluetooth:
            UserDefaults.standard.set(true, forKey: "fyde.vexo.backgroundBluetooth")
            await connectBluetooth()
        case .macBridge:
            await connectMacBridge()
        case .simulator:
            await connectSimulator()
        }
    }

    public func disconnect() {
        UserDefaults.standard.set(false, forKey: "fyde.vexo.backgroundBluetooth")
        endVoiceBackgroundTask()
        userInitiatedDisconnect = true
        reconnectTask?.cancel()
        reconnectTask = nil
        voiceAutoStopTask?.cancel()
        voiceAutoStopTask = nil
        ledRestoreTask?.cancel()
        ledRestoreTask = nil
        deepgram.cancelImmediately()
        isListeningVoice = false

        tearDownTransports()
        resetSessionTelemetry()
        phase = .disconnected
        statusMessage = "Disconnected from \(bandName)."
    }

    private func tearDownTransports() {
        bleDriver.disconnect()
        bridgeReceiveTask?.cancel()
        bridgeReceiveTask = nil
        bridgeWebSocket?.cancel(with: .goingAway, reason: nil)
        bridgeWebSocket = nil
        simLoopTask?.cancel()
        simLoopTask = nil

        if let cont = pendingResponseContinuation {
            pendingResponseContinuation = nil
            pendingResponseSeq = nil
            pendingResponseOpcode = nil
            cont.resume(throwing: VexoSpeechError("Connection closed."))
        }
    }

    private func resetSessionTelemetry() {
        activeStreams = []
        baselineStepsTotal = nil
        sessionSteps = 0
        cadenceSpm = 0
        recentMagnitudesG.removeAll()
    }

    // MARK: - 1. Native CoreBluetooth Connection (iPhone & Mac)

    private func connectBluetooth() async {
        phase = .scanning
        statusMessage = "Scanning for \(bandName)… Double-tap your band so it blinks blue."
        bleDriver.startScanAndConnect()
    }

    // MARK: - 2. Mac WebSocket Bridge Connection (Xcode iPhone Simulator -> Real Band #69)

    private func connectMacBridge() async {
        guard let url = URL(string: macBridgeURL) else {
            lastError = "Invalid Mac Bridge URL (\(macBridgeURL))."
            phase = .disconnected
            return
        }
        phase = .connecting
        statusMessage = "Connecting to Mac Vexo Bridge (\(macBridgeURL)) for \(bandName)…"

        let ws = URLSession.shared.webSocketTask(with: url)
        self.bridgeWebSocket = ws
        ws.resume()

        bridgeReceiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let activeWS = self.bridgeWebSocket else { break }
                do {
                    let msg = try await activeWS.receive()
                    switch msg {
                    case .data(let frame):
                        self.handleIncomingRawFrame(frame)
                    case .string(let text):
                        if let hexData = Self.dataFromHex(text) {
                            self.handleIncomingRawFrame(hexData)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    self.handleTransportDropped(
                        reason: "Could not reach Mac Vexo Bridge at \(self.macBridgeURL). Start `python3 vexo/fyde_bridge.py bridge` on your Mac, or switch to Bluetooth on a physical iPhone / Pretend Band Sim."
                    )
                    break
                }
            }
        }

        try? await Task.sleep(nanoseconds: 250_000_000)
        guard bridgeWebSocket != nil, phase == .connecting else { return }
        await completeHandshakeAndConfigure()
    }

    // MARK: - 3. Pretend Band Simulator (Vexo-HACK-69)

    private func connectSimulator() async {
        phase = .verifying
        statusMessage = "Starting pretend band \(bandName) (firmware 1.1.0)…"
        try? await Task.sleep(nanoseconds: 180_000_000)

        bandInfo = VexoBandInfo(
            protoMajor: 1,
            protoMinor: 1,
            fwMajor: 1,
            fwMinor: 1,
            fwPatch: 0,
            hw: 1,
            bandNo: UInt16(bandNumber),
            caps: 0x07FF,
            maxFrame: 244,
            uptimeMs: 12_400
        )
        battery = VexoBatteryReading(percent: 89, state: 0, millivolts: 4025)
        chipTempCelsius = 31.25
        rssiDbm = -54
        activeStreams = [.motion, .event, .activity, .battery, .temp, .link]
        currentLED = VexoLEDState(r: 255, g: 85, b: 0, brightness: 96, pattern: .solid, periodMs: 1000)
        phase = .connected
        statusMessage = "Connected to pretend band \(bandName) (Sim)."
        logGesture("Connected", detail: "\(bandName) simulator ready (fw 1.1.0)")

        simLoopTask?.cancel()
        simLoopTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                guard let self, self.phase == .connected, self.transportKind == .simulator else { break }
                tick += 1
                let swing = sin(Double(tick) * 0.6) * 110.0
                let sample = VexoMotionSample(
                    ax: Int16(swing),
                    ay: Int16(-swing * 0.5),
                    az: 1000,
                    gx: 15,
                    gy: -10,
                    gz: 5
                )
                self.latestMotion = sample
                self.latestAccelMagnitudeG = sample.magnitudeG ?? 1.0
                if tick % 4 == 0 {
                    self.sessionSteps += 2
                    self.cadenceSpm = 108
                    self.activityStateLabel = "Walking"
                }
            }
        }
    }

    // MARK: - Post-Connect Handshake & Hard Rule 4 Verification

    private func completeHandshakeAndConfigure() async {
        phase = .verifying
        statusMessage = "Verifying \(bandName) identity…"

        do {
            let infoResp = try await sendCommand(
                VexoBandProtocol.encodeSimple(.getInfo, seq: allocateSeq()),
                expect: .getInfo
            )
            guard infoResp.isOK, case .info(let info) = infoResp.payload else {
                throw VexoSpeechError("GET_INFO failed (\(infoResp.status?.name ?? "error")).")
            }

            // HARD RULE 4 (vexo-open-kit/AGENTS.md): Verify band.number == 69!
            if Int(info.bandNo) != bandNumber {
                userInitiatedDisconnect = true
                tearDownTransports()
                phase = .disconnected
                let msg = "Wrong band answered (band #\(info.bandNo), expected \(bandName)). Disconnected immediately without changing anything."
                lastError = msg
                statusMessage = msg
                return
            }

            self.bandInfo = info

            // Sync band clock on firmware 1.1+
            if info.supportsClockAndIntervals {
                let nowMs = UInt64(Date().timeIntervalSince1970 * 1000.0)
                _ = try? await sendCommand(
                    VexoBandProtocol.encodeTimeSet(seq: allocateSeq(), unixMs: nowMs),
                    expect: .timeSet
                )
            }

            // Read initial battery
            if let battResp = try? await sendCommand(
                VexoBandProtocol.encodeSimple(.batteryGet, seq: allocateSeq()),
                expect: .batteryGet
            ), battResp.isOK, case .battery(let b) = battResp.payload {
                self.battery = b
            }

            // Widen accelerometer range to 8g at 50Hz so wrist shakes don't clip at 2g
            _ = try? await sendCommand(
                VexoBandProtocol.encodeImuSet(seq: allocateSeq(), rateHz: 50, accelRangeG: 8, gyroRangeDps: 2000),
                expect: .imuSet
            )

            // Start telemetry & gesture streams (fall back without .link if over USB bridge)
            let desiredWithLink: VexoStreamMask = [.motion, .event, .activity, .battery, .temp, .link]
            let startResp = try await sendCommand(
                VexoBandProtocol.encodeStreamStart(seq: allocateSeq(), mask: desiredWithLink.rawValue),
                expect: .streamStart
            )
            if startResp.isOK, case .activeStreams(let mask) = startResp.payload {
                self.activeStreams = VexoStreamMask(rawValue: mask)
            } else if startResp.status == .notAvailable {
                let usbMask: VexoStreamMask = [.motion, .event, .activity, .battery, .temp]
                let fallbackResp = try await sendCommand(
                    VexoBandProtocol.encodeStreamStart(seq: allocateSeq(), mask: usbMask.rawValue),
                    expect: .streamStart
                )
                if fallbackResp.isOK, case .activeStreams(let mask) = fallbackResp.payload {
                    self.activeStreams = VexoStreamMask(rawValue: mask)
                }
            }

            phase = .connected
            lastError = nil
            statusMessage = "Connected to \(bandName) (fw \(info.firmwareVersion)). Double-tap band to speak to Fyde."
            logGesture("Connected", detail: "\(bandName) verified • fw \(info.firmwareVersion)")

            // Brief welcome blink in Fyde terracotta-orange
            await setBandLED(VexoLEDState(r: 255, g: 85, b: 0, brightness: 110, pattern: .solid, periodMs: 1000))
        } catch {
            tearDownTransports()
            phase = .disconnected
            let msg = error.localizedDescription
            lastError = msg
            statusMessage = msg
        }
    }

    // MARK: - Controls: LED, Identify, Voice Listening & Simulator Triggers

    public func setBandLED(_ state: VexoLEDState) async {
        currentLED = state
        guard phase == .connected else { return }
        if transportKind == .simulator { return }
        // Rule 4: While AUDIO or MIC_LEVEL is active, band locks LED to solid blue and refuses LED_SET.
        guard !isMicLockedLED else { return }

        let seq = allocateSeq()
        let frame = VexoBandProtocol.encodeLedSet(
            seq: seq,
            r: state.r,
            g: state.g,
            b: state.b,
            brightness: state.brightness,
            pattern: state.pattern.rawValue,
            periodMs: state.periodMs
        )
        _ = try? await sendCommand(frame, expect: .ledSet)
    }

    public func identifyBand(seconds: UInt8 = 3) async {
        guard phase == .connected else { return }
        if transportKind == .simulator {
            logGesture("Identify", detail: "Simulated white 4Hz flash (\(seconds)s)")
            return
        }
        guard !isMicLockedLED else {
            lastError = "Cannot blink LED while the band microphone is active (solid blue privacy indicator)."
            return
        }
        let seq = allocateSeq()
        _ = try? await sendCommand(
            VexoBandProtocol.encodeIdentify(seq: seq, seconds: min(max(seconds, 1), 30)),
            expect: .identify
        )
    }

    /// Flashes a status color on Vexo-HACK-69 for Fyde transfer/approval events, then restores Fyde idle glow.
    public func notifyFydeEventLED(kind: FydeWristFeedbackKind) {
        guard phase == .connected else { return }
        ledRestoreTask?.cancel()
        ledRestoreTask = Task { [weak self] in
            guard let self else { return }
            let alertState: VexoLEDState
            let holdNs: UInt64
            switch kind {
            case .incomingBundleOrRequest:
                alertState = VexoLEDState(r: 255, g: 115, b: 0, brightness: 220, pattern: .blink, periodMs: 400)
                holdNs = 4_000_000_000
            case .actionSucceeded:
                alertState = VexoLEDState(r: 0, g: 255, b: 100, brightness: 200, pattern: .flash, periodMs: 500)
                holdNs = 2_400_000_000
            case .attentionError:
                alertState = VexoLEDState(r: 255, g: 35, b: 55, brightness: 200, pattern: .blink, periodMs: 300)
                holdNs = 2_000_000_000
            case .awaitingConfirmation:
                alertState = VexoLEDState(r: 255, g: 190, b: 0, brightness: 210, pattern: .breathe, periodMs: 900)
                holdNs = 8_000_000_000
            }
            await self.setBandLED(alertState)
            try? await Task.sleep(nanoseconds: holdNs)
            guard !Task.isCancelled, self.phase == .connected else { return }
            await self.setBandLED(VexoLEDState(r: 255, g: 85, b: 0, brightness: 96, pattern: .solid, periodMs: 1000))
        }
    }

    public func toggleVoiceListening() async {
        if isListeningVoice {
            await stopVoiceListeningAndDispatch(submit: voiceAutoSendToChat)
        } else {
            await startVoiceListening()
        }
    }

    public func startVoiceListening() async {
        guard phase == .connected else {
            lastError = "Connect \(bandName) first before starting wrist voice capture."
            return
        }
        guard !isListeningVoice else { return }
        beginVoiceBackgroundTask()
        defer {
            if !isListeningVoice { endVoiceBackgroundTask() }
        }
        lastError = nil
        liveTranscript = ""
        audioPacketsReceived = 0

        if transportKind == .simulator {
            isListeningVoice = true
            activeStreams.insert(.audio)
            statusMessage = "\(VexoDeepgramClient.privacyNotice)"
            logGesture("Mic On (Blue LED)", detail: "Listening on pretend band \(bandName)…")
            scheduleVoiceAutoStop()
            return
        }

        do {
            try deepgram.start(apiKey: effectiveDeepgramKey)
        } catch {
            lastError = error.localizedDescription
            statusMessage = error.localizedDescription
            return
        }

        // Start AUDIO stream (bit 3) — hardware lights solid blue LED
        let resp = try? await sendCommand(
            VexoBandProtocol.encodeStreamStart(seq: allocateSeq(), mask: VexoStreamMask.audio.rawValue),
            expect: .streamStart
        )
        guard let resp, resp.isOK, case .activeStreams(let mask) = resp.payload else {
            deepgram.cancelImmediately()
            lastError = "Band refused AUDIO stream (\(resp?.status?.name ?? "timeout"))."
            return
        }

        activeStreams = VexoStreamMask(rawValue: mask)
        isListeningVoice = true
        statusMessage = VexoDeepgramClient.privacyNotice
        logGesture("Mic On (Solid Blue LED)", detail: "Streaming Opus 16kHz -> Deepgram Nova-3")

        scheduleVoiceAutoStop()
    }

    private func scheduleVoiceAutoStop() {
        let maxSecs = UInt64(max(3, min(voiceListenDurationSec, 30)))
        voiceAutoStopTask?.cancel()
        voiceAutoStopTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: maxSecs * 1_000_000_000)
            guard let self, !Task.isCancelled, self.isListeningVoice else { return }
            // stopVoiceListeningAndDispatch cancels any pending timer. This timer
            // has fired, so release it before stopping to keep transcription and chat alive.
            self.voiceAutoStopTask = nil
            await self.stopVoiceListeningAndDispatch(submit: self.voiceAutoSendToChat)
        }
    }

    public func stopVoiceListeningAndDispatch(submit: Bool) async {
        guard isListeningVoice else { return }
        defer { endVoiceBackgroundTask() }
        voiceAutoStopTask?.cancel()
        voiceAutoStopTask = nil
        isListeningVoice = false

        if transportKind != .simulator {
            let stopResp = try? await sendCommand(
                VexoBandProtocol.encodeStreamStop(seq: allocateSeq(), mask: VexoStreamMask.audio.rawValue),
                expect: .streamStop
            )
            if let stopResp, stopResp.isOK, case .activeStreams(let mask) = stopResp.payload {
                activeStreams = VexoStreamMask(rawValue: mask)
            } else {
                activeStreams.remove(.audio)
            }
        } else {
            activeStreams.remove(.audio)
        }

        let finalWords: String
        if transportKind == .simulator {
            finalWords = liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            statusMessage = "Finishing Deepgram transcription…"
            finalWords = await deepgram.stopAndCollectFinalTranscript()
        }

        liveTranscript = finalWords
        logGesture("Mic Off", detail: finalWords.isEmpty ? "No speech heard" : "Heard: \"\(finalWords)\"")

        // Restore Fyde LED now that mic indicator unlocked
        await setBandLED(currentLED)

        if submit, !finalWords.isEmpty {
            statusMessage = "Vexo #\(bandNumber) → Fyde Chat: \"\(finalWords)\""
            // FydeStore flashes the outcome (sent / waiting for a tap / not understood).
            await onVoiceCommandReady?(finalWords)
        } else {
            statusMessage = finalWords.isEmpty
                ? "No speech detected on \(bandName). Speak within arm's length while the LED is solid blue."
                : "Captured from \(bandName): \"\(finalWords)\""
        }
    }

    private func beginVoiceBackgroundTask() {
        #if os(iOS)
        guard voiceBackgroundTask == .invalid else { return }
        voiceBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Vexo voice command") { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.endVoiceBackgroundTask()
                await self.stopVoiceListeningAndDispatch(submit: self.voiceAutoSendToChat)
            }
        }
        #endif
    }

    private func endVoiceBackgroundTask() {
        #if os(iOS)
        guard voiceBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(voiceBackgroundTask)
        voiceBackgroundTask = .invalid
        #endif
    }

    // MARK: - Simulator Gesture & Voice Injection Helpers

    public func simulateGesture(_ kind: VexoGestureKind) async {
        await handleBandGesture(kind: kind, arg: 0)
    }

    public func simulateShake() async {
        await triggerShakeDetected()
    }

    public func simulateSpokenCommand(_ phrase: String) async {
        liveTranscript = phrase
        logGesture("Sim Voice (\(bandName))", detail: "\"\(phrase)\"")
        if transportKind == .simulator, isListeningVoice {
            await stopVoiceListeningAndDispatch(submit: true)
            return
        }
        statusMessage = "Vexo #\(bandNumber) → Fyde Chat: \"\(phrase)\""
        await onVoiceCommandReady?(phrase)
    }

    // MARK: - Incoming Frame & Event Routing

    private func wireDrivers() {
        deepgram.onTranscriptUpdate = { [weak self] text, _ in
            guard let self else { return }
            self.liveTranscript = text
        }
        deepgram.onError = { [weak self] message in
            guard let self else { return }
            self.lastError = message
            self.statusMessage = message
        }

        bleDriver.onStateUpdated = { [weak self] stateDesc, unavailReason in
            guard let self else { return }
            if let unavailReason {
                self.phase = .disconnected
                self.lastError = unavailReason
                self.statusMessage = unavailReason
            } else if let stateDesc {
                self.statusMessage = stateDesc
            }
        }
        bleDriver.onTransportReady = { [weak self] in
            guard let self else { return }
            self.transportKind = .bluetooth
            Task { await self.completeHandshakeAndConfigure() }
        }
        bleDriver.onFrameReceived = { [weak self] data in
            self?.handleIncomingRawFrame(data)
        }
        bleDriver.onScanTimedOut = { [weak self] in
            guard let self else { return }
            if self.phase == .reconnecting {
                return // reconnect loop handles retries
            }
            self.phase = .disconnected
            let msg = "Could not see \(self.bandName). Close any other dashboard/app connected to it, double-tap the band (blue blink), and tap Connect."
            self.lastError = msg
            self.statusMessage = msg
        }
        bleDriver.onDisconnected = { [weak self] errDesc in
            self?.handleTransportDropped(reason: errDesc ?? "Bluetooth link to \(VexoBandConstants.assignedBandName) closed.")
        }
    }

    private func handleIncomingRawFrame(_ raw: Data) {
        guard let decoded = VexoBandProtocol.decodeFrame(raw) else { return }
        switch decoded {
        case .response(let resp):
            if resp.seq == pendingResponseSeq, resp.opcodeByte == pendingResponseOpcode,
               let cont = pendingResponseContinuation {
                pendingResponseContinuation = nil
                pendingResponseSeq = nil
                pendingResponseOpcode = nil
                cont.resume(returning: resp)
            }

        case .notice(let code, let arg):
            if code == 1 {
                logGesture("Low Battery", detail: "\(arg)% — LED brightness capped")
            } else if code == 2 {
                criticalBatterySeen = true
                activeStreams = []
                isListeningVoice = false
                deepgram.cancelImmediately()
                let msg = "Critical battery (\(arg)%) on \(bandName) — plug into USB power."
                lastError = msg
                statusMessage = msg
            }

        case .motion(_, _, let samples):
            for s in samples {
                ingestMotionSample(s)
            }

        case .motion2(_, _, _, _, let samples):
            for s in samples {
                ingestMotionSample(s)
            }

        case .event(_, let eventCode, let arg):
            if let kind = VexoGestureKind(rawValue: eventCode) {
                Task { await self.handleBandGesture(kind: kind, arg: arg) }
            }

        case .activity(let act):
            if baselineStepsTotal == nil {
                baselineStepsTotal = act.stepsTotal
            }
            let base = baselineStepsTotal ?? act.stepsTotal
            sessionSteps = act.stepsTotal >= base ? Int(act.stepsTotal - base) : Int(act.stepsTotal)
            cadenceSpm = Int(act.cadenceSpm)
            activityStateLabel = act.stateLabel

        case .audio(_, let opus):
            audioPacketsReceived += 1
            if isListeningVoice {
                deepgram.feedOpusPacket(opus)
            }

        case .battery(let batt):
            self.battery = batt

        case .temp(_, let tempMc):
            self.chipTempCelsius = Double(tempMc) / 1000.0

        case .link(let lnk):
            self.rssiDbm = lnk.validRssi

        case .micLevel, .unknown:
            break
        }
    }

    private func ingestMotionSample(_ sample: VexoMotionSample) {
        latestMotion = sample
        guard let mag = sample.magnitudeG else { return }
        latestAccelMagnitudeG = mag
        recentMagnitudesG.append(mag)
        if recentMagnitudesG.count > 25 {
            recentMagnitudesG.removeFirst(recentMagnitudesG.count - 25)
        }
        if recentMagnitudesG.count >= 10,
           Date() > shakeQuietUntil,
           let maxG = recentMagnitudesG.max(),
           let minG = recentMagnitudesG.min(),
           (maxG - minG) > 1.5 {
            shakeQuietUntil = Date().addingTimeInterval(1.2)
            recentMagnitudesG.removeAll()
            Task { await self.triggerShakeDetected() }
        }
    }

    private func handleBandGesture(kind: VexoGestureKind, arg: UInt8) async {
        switch kind {
        case .tap:
            if singleTapApprovesOrSaves, let summary = await onSingleTapTriggered?() {
                logGesture("Single Tap", detail: summary)
                statusMessage = "Vexo #\(bandNumber) Tap: \(summary)"
                notifyFydeEventLED(kind: .actionSucceeded)
            } else {
                logGesture("Single Tap", detail: "Ready (no pending approvals/bundles)")
                statusMessage = "\(bandName) tapped — double-tap to speak a Fyde command."
            }

        case .doubleTap:
            logGesture("Double Tap", detail: doubleTapTogglesVoice ? (isListeningVoice ? "Stopping voice" : "Starting voice") : "Observed")
            if doubleTapTogglesVoice {
                await toggleVoiceListening()
            }

        case .tilt:
            if tiltCyclesTabs, let tabSummary = onTiltTriggered?() {
                logGesture("Wrist Tilt", detail: tabSummary)
                statusMessage = "Vexo #\(bandNumber) Tilt: \(tabSummary)"
            } else {
                logGesture("Wrist Tilt", detail: "Observed")
            }

        case .freeFall:
            logGesture("Free-Fall", detail: "Detected drop")

        case .orientation:
            let faces = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]
            let face = Int(arg) < faces.count ? faces[Int(arg)] : "\(arg)"
            logGesture("Orientation", detail: "Face \(face) up")

        case .motionStart, .motionStop:
            break
        }
    }

    private func triggerShakeDetected() async {
        if isListeningVoice {
            await stopVoiceListeningAndDispatch(submit: false)
            logGesture("Wrist Shake", detail: "Cancelled active voice listening")
            statusMessage = "Cancelled wrist voice capture."
            return
        }
        if shakeRefreshesInbox, let msg = await onShakeTriggered?() {
            logGesture("Wrist Shake", detail: msg)
            statusMessage = "Vexo #\(bandNumber) Shake: \(msg)"
            notifyFydeEventLED(kind: .actionSucceeded)
        } else {
            logGesture("Wrist Shake", detail: "Detected (>1.5g delta)")
        }
    }

    private func handleTransportDropped(reason: String) {
        endVoiceBackgroundTask()
        resetSessionTelemetry()
        if isListeningVoice {
            isListeningVoice = false
            deepgram.cancelImmediately()
        }
        if let cont = pendingResponseContinuation {
            pendingResponseContinuation = nil
            pendingResponseSeq = nil
            pendingResponseOpcode = nil
            cont.resume(throwing: VexoSpeechError(reason))
        }

        guard !userInitiatedDisconnect, !criticalBatterySeen, autoReconnect, transportKind == .bluetooth else {
            phase = .disconnected
            lastError = userInitiatedDisconnect ? nil : reason
            statusMessage = reason
            return
        }

        // Rule 3 & contract §1: After a dropped link, band reopens connect window for 120s without double-tap.
        phase = .reconnecting
        statusMessage = "Link to \(bandName) dropped — auto-reconnecting (120s window)…"
        logGesture("Reconnecting", detail: "Attempting 120s automatic BLE recovery")

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            let deadline = Date().addingTimeInterval(120)
            while !Task.isCancelled, Date() < deadline {
                guard let self, self.phase == .reconnecting else { return }
                self.bleDriver.startScanAndConnect()
                try? await Task.sleep(nanoseconds: 12_000_000_000)
                if self.phase == .connected { return }
            }
            guard let self, self.phase == .reconnecting else { return }
            self.bleDriver.disconnect()
            self.phase = .disconnected
            let msg = "Auto-reconnect to \(self.bandName) timed out. Double-tap the band and tap Connect."
            self.lastError = msg
            self.statusMessage = msg
        }
    }

    // MARK: - Serialized Command Sender (1 in-flight command, 2.5s timeout per contract §2.1)

    private func allocateSeq() -> UInt8 {
        let s = nextSeq
        nextSeq &+= 1
        return s
    }

    private func sendCommand(_ frame: Data, expect opcode: VexoOpcode) async throws -> VexoResponseFrame {
        // Acquire single-command lock
        if commandInFlight {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                commandQueueWaiters.append(cont)
            }
        }
        commandInFlight = true
        defer {
            if !commandQueueWaiters.isEmpty {
                let next = commandQueueWaiters.removeFirst()
                next.resume()
            } else {
                commandInFlight = false
            }
        }

        let seq = frame[1]
        let timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled,
                  let self,
                  self.pendingResponseSeq == seq,
                  let cont = self.pendingResponseContinuation else { return }
            self.pendingResponseContinuation = nil
            self.pendingResponseSeq = nil
            self.pendingResponseOpcode = nil
            cont.resume(throwing: VexoSpeechError("Timed out waiting for \(opcode.name) from \(VexoBandConstants.assignedBandName)."))
        }
        defer { timeoutTask.cancel() }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<VexoResponseFrame, Error>) in
            self.pendingResponseSeq = seq
            self.pendingResponseOpcode = opcode.rawValue
            self.pendingResponseContinuation = cont
            self.writeRawCommandToActiveTransport(frame)
        }
    }

    private func writeRawCommandToActiveTransport(_ frame: Data) {
        switch transportKind {
        case .bluetooth:
            bleDriver.writeCommand(frame)
        case .macBridge:
            bridgeWebSocket?.send(.data(frame)) { _ in }
        case .simulator:
            break
        }
    }

    private func logGesture(_ title: String, detail: String) {
        recentEvents.insert(VexoGestureEventRecord(title: title, detail: detail), at: 0)
        if recentEvents.count > 25 {
            recentEvents.removeLast(recentEvents.count - 25)
        }
    }

    private static func dataFromHex(_ raw: String) -> Data? {
        let clean = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.count % 2 == 0, !clean.isEmpty else { return nil }
        var out = Data(capacity: clean.count / 2)
        var idx = clean.startIndex
        while idx < clean.endIndex {
            let next = clean.index(idx, offsetBy: 2)
            guard let byte = UInt8(clean[idx..<next], radix: 16) else { return nil }
            out.append(byte)
            idx = next
        }
        return out
    }
}

public enum FydeWristFeedbackKind: Sendable {
    case incomingBundleOrRequest
    case actionSucceeded
    case attentionError
    /// A voice send is held for a confirmation tap (amber breathe).
    case awaitingConfirmation
}

// MARK: - Main-Queue CoreBluetooth GATT Driver (Strictly Filtered to Vexo-HACK-69)

private final class VexoCoreBluetoothDriver: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, @unchecked Sendable {
    private let serviceUUID = CBUUID(string: VexoBandConstants.serviceUUIDString)
    private let rxUUID = CBUUID(string: VexoBandConstants.rxCharacteristicUUIDString)
    private let txUUID = CBUUID(string: VexoBandConstants.txCharacteristicUUIDString)

    private var central: CBCentralManager?
    private var connectedPeripheral: CBPeripheral?
    private var rxChar: CBCharacteristic?
    private var txChar: CBCharacteristic?
    private var scanTimeoutWorkItem: DispatchWorkItem?
    private var wantsScan: Bool = false

    var onStateUpdated: (@MainActor (_ status: String?, _ unavailableError: String?) -> Void)?
    var onTransportReady: (@MainActor () -> Void)?
    var onFrameReceived: (@MainActor (Data) -> Void)?
    var onScanTimedOut: (@MainActor () -> Void)?
    var onDisconnected: (@MainActor (String?) -> Void)?

    func startScanAndConnect() {
        wantsScan = true
        if central == nil {
            prepareForRestoration()
            return
        }
        if let central {
            evaluateCentralStateAndScan(central)
        }
    }

    func prepareForRestoration() {
        guard central == nil else { return }
        #if os(iOS)
        central = CBCentralManager(delegate: self, queue: .main, options: [
            CBCentralManagerOptionRestoreIdentifierKey: "com.fydefiles.vexo.band69"
        ])
        #else
        central = CBCentralManager(delegate: self, queue: .main)
        #endif
    }

    func writeCommand(_ frame: Data) {
        guard let p = connectedPeripheral, let rx = rxChar else { return }
        p.writeValue(frame, for: rx, type: .withResponse)
    }

    func disconnect() {
        wantsScan = false
        scanTimeoutWorkItem?.cancel()
        scanTimeoutWorkItem = nil
        central?.stopScan()
        if let p = connectedPeripheral {
            if let tx = txChar, tx.isNotifying {
                p.setNotifyValue(false, for: tx)
            }
            central?.cancelPeripheralConnection(p)
        }
        connectedPeripheral = nil
        rxChar = nil
        txChar = nil
    }

    private func evaluateCentralStateAndScan(_ manager: CBCentralManager) {
        switch manager.state {
        case .poweredOn:
            guard wantsScan else { return }
            beginFilteredScan(manager)
        case .poweredOff:
            wantsScan = false
            let msg = "Bluetooth is turned off. Turn Bluetooth ON on your iPhone/Mac (do not pair in Settings), then tap Connect."
            Task { @MainActor in self.onStateUpdated?(nil, msg) }
        case .unauthorized:
            wantsScan = false
            let msg = "Bluetooth permission denied for Fyde. Enable Bluetooth for Fyde in Settings → Privacy & Security → Bluetooth."
            Task { @MainActor in self.onStateUpdated?(nil, msg) }
        case .unsupported:
            wantsScan = false
            #if targetEnvironment(simulator)
            let msg = "Xcode iOS Simulator does not expose hardware Bluetooth. Switch Transport to 'Mac Bridge' (with `python3 vexo/fyde_bridge.py bridge`) or 'Pretend Band (Sim #69)', or run Fyde on your physical iPhone."
            #else
            let msg = "Bluetooth Low Energy is not supported on this device."
            #endif
            Task { @MainActor in self.onStateUpdated?(nil, msg) }
        case .resetting, .unknown:
            Task { @MainActor in self.onStateUpdated?("Waiting for Bluetooth radio…", nil) }
        @unknown default:
            break
        }
    }

    private func beginFilteredScan(_ manager: CBCentralManager) {
        scanTimeoutWorkItem?.cancel()
        manager.stopScan()
        // Active scan filtered by Vexo Open Service UUID; AllowDuplicates ensures we catch the scan response localName too.
        manager.scanForPeripherals(
            withServices: [serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.wantsScan, self.connectedPeripheral == nil else { return }
            self.wantsScan = false
            self.central?.stopScan()
            Task { @MainActor in self.onScanTimedOut?() }
        }
        scanTimeoutWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10.0, execute: work)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        for peripheral in peripherals {
            guard peripheral.name == VexoBandConstants.assignedBandName else {
                central.cancelPeripheralConnection(peripheral)
                continue
            }
            connectedPeripheral = peripheral
            peripheral.delegate = self
            if peripheral.state == .connected {
                // Subscribe, then completeHandshakeAndConfigure verifies GET_INFO before settings.
                peripheral.discoverServices([serviceUUID])
            } else {
                central.connect(peripheral)
            }
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        evaluateCentralStateAndScan(central)
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        guard wantsScan else { return }
        let advLocalName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let mfgData = advertisementData[CBAdvertisementDataManufacturerDataKey] as? Data

        let decision = VexoBandProtocol.evaluateAdvertisement(
            localName: advLocalName,
            manufacturerData: mfgData,
            expectedBand: VexoBandConstants.assignedBandNumber
        )

        guard decision == .matched else {
            return // Ignore every other band or wait for scan response
        }

        wantsScan = false
        scanTimeoutWorkItem?.cancel()
        scanTimeoutWorkItem = nil
        central.stopScan()

        connectedPeripheral = peripheral
        peripheral.delegate = self
        Task { @MainActor in
            self.onStateUpdated?("Found \(VexoBandConstants.assignedBandName) (\(RSSI.intValue) dBm) — connecting…", nil)
        }
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { @MainActor in
            self.onStateUpdated?("Discovering Vexo GATT service…", nil)
        }
        peripheral.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        let desc = error?.localizedDescription ?? "Failed to connect to \(VexoBandConstants.assignedBandName)."
        connectedPeripheral = nil
        rxChar = nil
        txChar = nil
        Task { @MainActor in self.onDisconnected?(desc) }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let desc = error?.localizedDescription
        connectedPeripheral = nil
        rxChar = nil
        txChar = nil
        Task { @MainActor in self.onDisconnected?(desc) }
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil,
              let svc = peripheral.services?.first(where: { $0.uuid == serviceUUID }) else {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        peripheral.discoverCharacteristics([rxUUID, txUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil, let chars = service.characteristics else {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        rxChar = chars.first(where: { $0.uuid == rxUUID })
        txChar = chars.first(where: { $0.uuid == txUUID })

        guard rxChar != nil, let tx = txChar else {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        // Contract §2.1: Subscribe to TX notifications ONCE before sending the first command!
        if tx.isNotifying {
            Task { @MainActor in self.onTransportReady?() }
        } else {
            peripheral.setNotifyValue(true, for: tx)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == txUUID else { return }
        if error != nil || !characteristic.isNotifying {
            central?.cancelPeripheralConnection(peripheral)
            return
        }
        Task { @MainActor in
            self.onTransportReady?()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.uuid == txUUID, let value = characteristic.value else { return }
        let frameCopy = Data(value)
        Task { @MainActor in
            self.onFrameReceived?(frameCopy)
        }
    }
}
