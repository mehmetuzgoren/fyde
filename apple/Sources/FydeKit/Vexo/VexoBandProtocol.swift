import Foundation

// MARK: - Vexo Open Band Contract v1.1 (Assigned strictly to Band #69)

public enum VexoBandConstants {
    /// Single source of truth for this team's Vexo Open band number (Vexo-HACK-69).
    /// Per vexo-open-kit/AGENTS.md: never scan for or connect to any other band number.
    public static let assignedBandNumber: Int = 69

    public static var assignedBandName: String {
        VexoBandProtocol.bandName(for: assignedBandNumber)
    }

    public static let serviceUUIDString = "254f0001-df82-4a9c-a2b5-563a0f6b2021"
    public static let rxCharacteristicUUIDString = "254f0002-df82-4a9c-a2b5-563a0f6b2021"
    public static let txCharacteristicUUIDString = "254f0003-df82-4a9c-a2b5-563a0f6b2021"
}

public enum VexoOpcode: UInt8, Sendable, CaseIterable {
    case getInfo = 0x01
    case getName = 0x02
    case setBandNumber = 0x03 // Never invoked over client; decoded for test-vector completeness
    case identify = 0x04
    case restart = 0x05
    case sleep = 0x06
    case timeSet = 0x07
    case timeGet = 0x08
    case streamStart = 0x10
    case streamStop = 0x11
    case streamGet = 0x12
    case streamSetInterval = 0x13
    case streamGetInterval = 0x14
    case imuSet = 0x20
    case imuGet = 0x21
    case eventSet = 0x22
    case eventGet = 0x23
    case motion2Set = 0x24
    case motion2Get = 0x25
    case micSetGain = 0x30
    case micGet = 0x31
    case radioSetTxPower = 0x40
    case radioGet = 0x41
    case ledSet = 0x50
    case ledGet = 0x51
    case tempSetInterval = 0x60
    case batteryGet = 0x61
    case storeInfo = 0x70
    case storePut = 0x71
    case storeGet = 0x72
    case storeDel = 0x73
    case storeWipe = 0x74

    public var name: String {
        switch self {
        case .getInfo: return "GET_INFO"
        case .getName: return "GET_NAME"
        case .setBandNumber: return "SET_BAND_NUMBER"
        case .identify: return "IDENTIFY"
        case .restart: return "RESTART"
        case .sleep: return "SLEEP"
        case .timeSet: return "TIME_SET"
        case .timeGet: return "TIME_GET"
        case .streamStart: return "STREAM_START"
        case .streamStop: return "STREAM_STOP"
        case .streamGet: return "STREAM_GET"
        case .streamSetInterval: return "STREAM_SET_INTERVAL"
        case .streamGetInterval: return "STREAM_GET_INTERVAL"
        case .imuSet: return "IMU_SET"
        case .imuGet: return "IMU_GET"
        case .eventSet: return "EVENT_SET"
        case .eventGet: return "EVENT_GET"
        case .motion2Set: return "MOTION2_SET"
        case .motion2Get: return "MOTION2_GET"
        case .micSetGain: return "MIC_SET_GAIN"
        case .micGet: return "MIC_GET"
        case .radioSetTxPower: return "RADIO_SET_TX_POWER"
        case .radioGet: return "RADIO_GET"
        case .ledSet: return "LED_SET"
        case .ledGet: return "LED_GET"
        case .tempSetInterval: return "TEMP_SET_INTERVAL"
        case .batteryGet: return "BATTERY_GET"
        case .storeInfo: return "STORE_INFO"
        case .storePut: return "STORE_PUT"
        case .storeGet: return "STORE_GET"
        case .storeDel: return "STORE_DEL"
        case .storeWipe: return "STORE_WIPE"
        }
    }
}

public enum VexoStatus: UInt8, Sendable {
    case ok = 0
    case unknownOpcode = 1
    case badLength = 2
    case badArg = 3
    case busy = 4
    case notAvailable = 5
    case denied = 6
    case notFound = 7
    case noSpace = 8
    case ioError = 9

    public var name: String {
        switch self {
        case .ok: return "OK"
        case .unknownOpcode: return "UNKNOWN_OPCODE"
        case .badLength: return "BAD_LENGTH"
        case .badArg: return "BAD_ARG"
        case .busy: return "BUSY"
        case .notAvailable: return "NOT_AVAILABLE"
        case .denied: return "DENIED"
        case .notFound: return "NOT_FOUND"
        case .noSpace: return "NO_SPACE"
        case .ioError: return "IO_ERROR"
        }
    }
}

public struct VexoStreamMask: OptionSet, Sendable, Equatable {
    public let rawValue: UInt16
    public init(rawValue: UInt16) { self.rawValue = rawValue }

    public static let motion = VexoStreamMask(rawValue: 1 << 0)     // 0x0001
    public static let event = VexoStreamMask(rawValue: 1 << 1)      // 0x0002
    public static let activity = VexoStreamMask(rawValue: 1 << 2)   // 0x0004
    public static let audio = VexoStreamMask(rawValue: 1 << 3)      // 0x0008
    public static let battery = VexoStreamMask(rawValue: 1 << 4)    // 0x0010
    public static let temp = VexoStreamMask(rawValue: 1 << 5)       // 0x0020
    public static let link = VexoStreamMask(rawValue: 1 << 6)       // 0x0040
    public static let micLevel = VexoStreamMask(rawValue: 1 << 7)   // 0x0080
    public static let motion2 = VexoStreamMask(rawValue: 1 << 8)    // 0x0100
}

public enum VexoLEDPattern: UInt8, Sendable, CaseIterable, Identifiable {
    case off = 0
    case solid = 1
    case blink = 2
    case breathe = 3
    case flash = 4
    case rainbow = 5

    public var id: UInt8 { rawValue }

    public var label: String {
        switch self {
        case .off: return "Off"
        case .solid: return "Solid"
        case .blink: return "Blink"
        case .breathe: return "Breathe"
        case .flash: return "Flash"
        case .rainbow: return "Rainbow"
        }
    }
}

public enum VexoGestureKind: UInt8, Sendable {
    case tap = 1
    case doubleTap = 2
    case freeFall = 3
    case tilt = 4
    case orientation = 5
    case motionStart = 6
    case motionStop = 7

    public var label: String {
        switch self {
        case .tap: return "Single Tap"
        case .doubleTap: return "Double Tap"
        case .freeFall: return "Free-Fall"
        case .tilt: return "Tilt"
        case .orientation: return "Orientation"
        case .motionStart: return "Motion Start"
        case .motionStop: return "Motion Stop"
        }
    }
}

public struct VexoBandInfo: Sendable, Equatable {
    public let protoMajor: UInt8
    public let protoMinor: UInt8
    public let fwMajor: UInt8
    public let fwMinor: UInt8
    public let fwPatch: UInt8
    public let hw: UInt8
    public let bandNo: UInt16
    public let caps: UInt16
    public let maxFrame: UInt16
    public let uptimeMs: UInt32

    public var firmwareVersion: String {
        "\(fwMajor).\(fwMinor).\(fwPatch)"
    }

    public var supportsClockAndIntervals: Bool {
        protoMajor > 1 || (protoMajor == 1 && protoMinor >= 1)
    }
}

public struct VexoBatteryReading: Sendable, Equatable {
    public let percent: UInt8
    public let state: UInt8 // 0 on battery, 1 charging, 2 charged
    public let millivolts: UInt16

    public var stateLabel: String {
        switch state {
        case 1: return "Charging"
        case 2: return "Charged"
        default: return "On Battery"
        }
    }
}

public struct VexoMotionSample: Sendable, Equatable {
    public let ax: Int16? // milli-g
    public let ay: Int16?
    public let az: Int16?
    public let gx: Int16? // tenths of deg/s
    public let gy: Int16?
    public let gz: Int16?

    public var axG: Double? { ax.map { Double($0) / 1000.0 } }
    public var ayG: Double? { ay.map { Double($0) / 1000.0 } }
    public var azG: Double? { az.map { Double($0) / 1000.0 } }
    public var gxDps: Double? { gx.map { Double($0) / 10.0 } }
    public var gyDps: Double? { gy.map { Double($0) / 10.0 } }
    public var gzDps: Double? { gz.map { Double($0) / 10.0 } }

    public var magnitudeG: Double? {
        guard let x = axG, let y = ayG, let z = azG else { return nil }
        return (x * x + y * y + z * z).squareRoot()
    }
}

public struct VexoActivityReading: Sendable, Equatable {
    public let tMs: UInt32
    public let stepsTotal: UInt32
    public let cadenceSpm: UInt8
    public let state: UInt8 // 0 still, 1 walk, 2 run
    public let motionMg: UInt16

    public var stateLabel: String {
        switch state {
        case 1: return "Walking"
        case 2: return "Running"
        default: return "Still"
        }
    }
}

public struct VexoLinkReading: Sendable, Equatable {
    public let tMs: UInt32
    public let rssiDbm: Int8 // 127 = no reading
    public let txDbm: Int8
    public let phy: UInt8

    public var validRssi: Int? {
        rssiDbm == 127 ? nil : Int(rssiDbm)
    }
}

public struct VexoLEDState: Sendable, Equatable {
    public var r: UInt8
    public var g: UInt8
    public var b: UInt8
    public var brightness: UInt8
    public var pattern: VexoLEDPattern
    public var periodMs: UInt16

    public init(
        r: UInt8,
        g: UInt8,
        b: UInt8,
        brightness: UInt8 = 128,
        pattern: VexoLEDPattern = .solid,
        periodMs: UInt16 = 1000
    ) {
        self.r = r
        self.g = g
        self.b = b
        self.brightness = brightness
        self.pattern = pattern
        self.periodMs = periodMs
    }
}

public enum VexoResponsePayload: Sendable, Equatable {
    case empty
    case info(VexoBandInfo)
    case name(String)
    case bandNumber(UInt16)
    case time(set: UInt8, unixMs: UInt64, tMs: UInt32)
    case activeStreams(UInt16)
    case streamInterval(stream: UInt8, intervalMs: UInt32, minMs: UInt32, maxMs: UInt32)
    case imu(rateHz: UInt8, accelRangeG: UInt8, gyroRangeDps: UInt16)
    case eventConfig(eventMask: UInt8, tapThresholdMg: UInt16)
    case motion2Config(rateHz: UInt16, sensors: UInt8, maxAccelHz: UInt16, maxGyroHz: UInt16, maxBothHz: UInt16)
    case micGain(UInt8)
    case micInfo(gainHalfDb: UInt8, sampleRate: UInt16, frameMs: UInt8, channels: UInt8, bitrate: UInt16)
    case radioTxPower(Int8)
    case radioInfo(txDbm: Int8, rssiDbm: Int8, phy: UInt8, interval: UInt16, mtu: UInt16)
    case led(r: UInt8, g: UInt8, b: UInt8, brightness: UInt8, pattern: UInt8, periodMs: UInt16)
    case tempInterval(UInt8)
    case battery(VexoBatteryReading)
    case storeInfo(keysMax: UInt16, valueMax: UInt16, freeBytes: UInt32, usedKeys: UInt16)
    case storeValue(Data)
    case raw(Data)
}

public struct VexoResponseFrame: Sendable, Equatable {
    public let seq: UInt8
    public let opcodeByte: UInt8
    public let statusByte: UInt8
    public let payload: VexoResponsePayload

    public var opcode: VexoOpcode? { VexoOpcode(rawValue: opcodeByte) }
    public var status: VexoStatus? { VexoStatus(rawValue: statusByte) }
    public var isOK: Bool { statusByte == 0 }
}

public enum VexoDecodedFrame: Sendable, Equatable {
    case response(VexoResponseFrame)
    case notice(code: UInt8, arg: UInt8)
    case motion(tMs: UInt32, periodMs: UInt8, samples: [VexoMotionSample])
    case event(tMs: UInt32, event: UInt8, arg: UInt8)
    case activity(VexoActivityReading)
    case audio(seq: UInt16, opus: Data)
    case battery(VexoBatteryReading)
    case temp(tMs: UInt32, tempMc: Int32)
    case link(VexoLinkReading)
    case micLevel(tMs: UInt32, peakDb: UInt8, rmsDb: UInt8)
    case motion2(tMs: UInt32, sampleNo: UInt32, periodUs: UInt32, sensors: UInt8, samples: [VexoMotionSample])
    case unknown(type: UInt8, raw: Data)
}

public enum VexoAdvertisementMatch: Sendable, Equatable {
    case matched
    case pendingScanResponse
    case rejectedOtherBand
}

public enum VexoBandProtocol {
    public static func bandName(for number: Int) -> String {
        if number < 100 {
            return String(format: "Vexo-HACK-%02d", number)
        }
        return "Vexo-HACK-\(number)"
    }

    /// Strict filter ensuring we ONLY ever connect to our assigned band (#69 = Vexo-HACK-69).
    public static func evaluateAdvertisement(
        localName: String?,
        manufacturerData: Data?,
        expectedBand: Int = VexoBandConstants.assignedBandNumber
    ) -> VexoAdvertisementMatch {
        let expectedName = bandName(for: expectedBand)
        var mfgMatched = false

        if let mfg = manufacturerData {
            let bytes = [UInt8](mfg)
            // CoreBluetooth prepends 2-byte LE company ID (0xFFFF) before payload [0x4F, proto_major, band_lo, band_hi]
            if bytes.count >= 6, bytes[0] == 0xFF, bytes[1] == 0xFF, bytes[2] == 0x4F {
                let advertisedBand = Int(UInt16(bytes[4]) | (UInt16(bytes[5]) << 8))
                if advertisedBand != expectedBand {
                    return .rejectedOtherBand
                }
                mfgMatched = true
            } else if bytes.count >= 4, bytes[0] == 0x4F {
                let advertisedBand = Int(UInt16(bytes[2]) | (UInt16(bytes[3]) << 8))
                if advertisedBand != expectedBand {
                    return .rejectedOtherBand
                }
                mfgMatched = true
            }
        }

        if let name = localName, !name.isEmpty {
            if name == expectedName {
                return .matched
            }
            return .rejectedOtherBand
        }

        return mfgMatched ? .matched : .pendingScanResponse
    }

    // MARK: - Little-Endian Helpers

    @inline(__always)
    private static func appendU16(_ out: inout Data, _ v: UInt16) {
        out.append(UInt8(truncatingIfNeeded: v))
        out.append(UInt8(truncatingIfNeeded: v >> 8))
    }

    @inline(__always)
    private static func appendU32(_ out: inout Data, _ v: UInt32) {
        out.append(UInt8(truncatingIfNeeded: v))
        out.append(UInt8(truncatingIfNeeded: v >> 8))
        out.append(UInt8(truncatingIfNeeded: v >> 16))
        out.append(UInt8(truncatingIfNeeded: v >> 24))
    }

    @inline(__always)
    private static func appendU64(_ out: inout Data, _ v: UInt64) {
        for shift in stride(from: 0, to: 64, by: 8) {
            out.append(UInt8(truncatingIfNeeded: v >> shift))
        }
    }

    @inline(__always)
    private static func readU16(_ b: [UInt8], _ o: Int) -> UInt16 {
        UInt16(b[o]) | (UInt16(b[o + 1]) << 8)
    }

    @inline(__always)
    private static func readI16(_ b: [UInt8], _ o: Int) -> Int16 {
        Int16(bitPattern: readU16(b, o))
    }

    @inline(__always)
    private static func readU32(_ b: [UInt8], _ o: Int) -> UInt32 {
        UInt32(b[o])
            | (UInt32(b[o + 1]) << 8)
            | (UInt32(b[o + 2]) << 16)
            | (UInt32(b[o + 3]) << 24)
    }

    @inline(__always)
    private static func readI32(_ b: [UInt8], _ o: Int) -> Int32 {
        Int32(bitPattern: readU32(b, o))
    }

    @inline(__always)
    private static func readU64(_ b: [UInt8], _ o: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in 0..<8 {
            v |= UInt64(b[o + i]) << (i * 8)
        }
        return v
    }

    // MARK: - Command Builders

    public static func encodeSimple(_ opcode: VexoOpcode, seq: UInt8) -> Data {
        Data([0x01, seq, opcode.rawValue])
    }

    public static func encodeIdentify(seq: UInt8, seconds: UInt8) -> Data {
        Data([0x01, seq, VexoOpcode.identify.rawValue, seconds])
    }

    public static func encodeTimeSet(seq: UInt8, unixMs: UInt64) -> Data {
        var d = Data([0x01, seq, VexoOpcode.timeSet.rawValue])
        appendU64(&d, unixMs)
        return d
    }

    public static func encodeStreamStart(seq: UInt8, mask: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.streamStart.rawValue])
        appendU16(&d, mask)
        return d
    }

    public static func encodeStreamStop(seq: UInt8, mask: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.streamStop.rawValue])
        appendU16(&d, mask)
        return d
    }

    public static func encodeStreamSetInterval(seq: UInt8, stream: UInt8, intervalMs: UInt32) -> Data {
        var d = Data([0x01, seq, VexoOpcode.streamSetInterval.rawValue, stream])
        appendU32(&d, intervalMs)
        return d
    }

    public static func encodeStreamGetInterval(seq: UInt8, stream: UInt8) -> Data {
        Data([0x01, seq, VexoOpcode.streamGetInterval.rawValue, stream])
    }

    public static func encodeImuSet(seq: UInt8, rateHz: UInt8, accelRangeG: UInt8, gyroRangeDps: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.imuSet.rawValue, rateHz, accelRangeG])
        appendU16(&d, gyroRangeDps)
        return d
    }

    public static func encodeEventSet(seq: UInt8, eventMask: UInt8, tapThresholdMg: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.eventSet.rawValue, eventMask])
        appendU16(&d, tapThresholdMg)
        return d
    }

    public static func encodeMotion2Set(seq: UInt8, rateHz: UInt16, sensors: UInt8) -> Data {
        var d = Data([0x01, seq, VexoOpcode.motion2Set.rawValue])
        appendU16(&d, rateHz)
        d.append(sensors)
        return d
    }

    public static func encodeMicSetGain(seq: UInt8, gainHalfDb: UInt8) -> Data {
        Data([0x01, seq, VexoOpcode.micSetGain.rawValue, gainHalfDb])
    }

    public static func encodeRadioSetTxPower(seq: UInt8, dbm: Int8) -> Data {
        Data([0x01, seq, VexoOpcode.radioSetTxPower.rawValue, UInt8(bitPattern: dbm)])
    }

    public static func encodeLedSet(
        seq: UInt8,
        r: UInt8,
        g: UInt8,
        b: UInt8,
        brightness: UInt8,
        pattern: UInt8,
        periodMs: UInt16
    ) -> Data {
        var d = Data([0x01, seq, VexoOpcode.ledSet.rawValue, r, g, b, brightness, pattern])
        appendU16(&d, periodMs)
        return d
    }

    public static func encodeTempSetInterval(seq: UInt8, seconds: UInt8) -> Data {
        Data([0x01, seq, VexoOpcode.tempSetInterval.rawValue, seconds])
    }

    public static func encodeStorePut(seq: UInt8, key: UInt16, value: Data) -> Data {
        var d = Data([0x01, seq, VexoOpcode.storePut.rawValue])
        appendU16(&d, key)
        d.append(value)
        return d
    }

    public static func encodeStoreGet(seq: UInt8, key: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.storeGet.rawValue])
        appendU16(&d, key)
        return d
    }

    public static func encodeStoreDel(seq: UInt8, key: UInt16) -> Data {
        var d = Data([0x01, seq, VexoOpcode.storeDel.rawValue])
        appendU16(&d, key)
        return d
    }

    public static func encodeStoreWipe(seq: UInt8) -> Data {
        var d = Data([0x01, seq, VexoOpcode.storeWipe.rawValue])
        appendU16(&d, 0x5856)
        return d
    }

    // MARK: - Frame Decoder (Band -> Client)

    public static func decodeFrame(_ data: Data) -> VexoDecodedFrame? {
        let b = [UInt8](data)
        guard !b.isEmpty else { return nil }

        switch b[0] {
        case 0x01:
            // Commands are client -> band only; never valid from band.
            return nil

        case 0x02:
            return decodeResponse(b)

        case 0x03:
            guard b.count == 3 else { return nil }
            return .notice(code: b[1], arg: b[2])

        case 0x10: // MOTION
            guard b.count >= 7 else { return nil }
            let tMs = readU32(b, 1)
            let periodMs = b[5]
            let count = Int(b[6])
            guard b.count == 7 + 12 * count else { return nil }
            var samples: [VexoMotionSample] = []
            samples.reserveCapacity(count)
            for i in 0..<count {
                let off = 7 + 12 * i
                samples.append(VexoMotionSample(
                    ax: readI16(b, off),
                    ay: readI16(b, off + 2),
                    az: readI16(b, off + 4),
                    gx: readI16(b, off + 6),
                    gy: readI16(b, off + 8),
                    gz: readI16(b, off + 10)
                ))
            }
            return .motion(tMs: tMs, periodMs: periodMs, samples: samples)

        case 0x11: // EVENT
            guard b.count == 7 else { return nil }
            return .event(tMs: readU32(b, 1), event: b[5], arg: b[6])

        case 0x12: // ACTIVITY
            guard b.count == 13 else { return nil }
            return .activity(VexoActivityReading(
                tMs: readU32(b, 1),
                stepsTotal: readU32(b, 5),
                cadenceSpm: b[9],
                state: b[10],
                motionMg: readU16(b, 11)
            ))

        case 0x13: // AUDIO
            guard b.count >= 4 else { return nil }
            let seq = readU16(b, 1)
            let len = Int(b[3])
            guard b.count == 4 + len else { return nil }
            let opus = len > 0 ? Data(b[4..<(4 + len)]) : Data()
            return .audio(seq: seq, opus: opus)

        case 0x14: // BATTERY
            guard b.count == 5 else { return nil }
            return .battery(VexoBatteryReading(
                percent: b[1],
                state: b[2],
                millivolts: readU16(b, 3)
            ))

        case 0x15: // TEMP
            guard b.count == 9 else { return nil }
            return .temp(tMs: readU32(b, 1), tempMc: readI32(b, 5))

        case 0x16: // LINK
            guard b.count == 8 else { return nil }
            return .link(VexoLinkReading(
                tMs: readU32(b, 1),
                rssiDbm: Int8(bitPattern: b[5]),
                txDbm: Int8(bitPattern: b[6]),
                phy: b[7]
            ))

        case 0x17: // MIC_LEVEL
            guard b.count == 7 else { return nil }
            return .micLevel(tMs: readU32(b, 1), peakDb: b[5], rmsDb: b[6])

        case 0x18: // MOTION2
            guard b.count >= 15 else { return nil }
            let tMs = readU32(b, 1)
            let sampleNo = readU32(b, 5)
            let periodUs = readU32(b, 9)
            let sensors = b[13]
            let count = Int(b[14])
            let sampleSize: Int
            switch sensors {
            case 1, 2: sampleSize = 6
            case 3: sampleSize = 12
            default: return nil
            }
            guard b.count == 15 + sampleSize * count else { return nil }
            var samples: [VexoMotionSample] = []
            samples.reserveCapacity(count)
            for i in 0..<count {
                let off = 15 + sampleSize * i
                switch sensors {
                case 1:
                    samples.append(VexoMotionSample(
                        ax: readI16(b, off),
                        ay: readI16(b, off + 2),
                        az: readI16(b, off + 4),
                        gx: nil, gy: nil, gz: nil
                    ))
                case 2:
                    samples.append(VexoMotionSample(
                        ax: nil, ay: nil, az: nil,
                        gx: readI16(b, off),
                        gy: readI16(b, off + 2),
                        gz: readI16(b, off + 4)
                    ))
                default:
                    samples.append(VexoMotionSample(
                        ax: readI16(b, off),
                        ay: readI16(b, off + 2),
                        az: readI16(b, off + 4),
                        gx: readI16(b, off + 6),
                        gy: readI16(b, off + 8),
                        gz: readI16(b, off + 10)
                    ))
                }
            }
            return .motion2(tMs: tMs, sampleNo: sampleNo, periodUs: periodUs, sensors: sensors, samples: samples)

        default:
            return .unknown(type: b[0], raw: data)
        }
    }

    private static func decodeResponse(_ b: [UInt8]) -> VexoDecodedFrame? {
        guard b.count >= 4 else { return nil }
        let seq = b[1]
        let opByte = b[2]
        let stByte = b[3]
        let payloadLen = b.count - 4

        if stByte != 0 {
            guard payloadLen == 0 else { return nil }
            return .response(VexoResponseFrame(seq: seq, opcodeByte: opByte, statusByte: stByte, payload: .empty))
        }

        guard let op = VexoOpcode(rawValue: opByte) else {
            let raw = payloadLen > 0 ? Data(b[4...]) : Data()
            return .response(VexoResponseFrame(seq: seq, opcodeByte: opByte, statusByte: stByte, payload: raw.isEmpty ? .empty : .raw(raw)))
        }

        let payload: VexoResponsePayload
        switch op {
        case .getInfo:
            guard payloadLen == 16 else { return nil }
            payload = .info(VexoBandInfo(
                protoMajor: b[4],
                protoMinor: b[5],
                fwMajor: b[6],
                fwMinor: b[7],
                fwPatch: b[8],
                hw: b[9],
                bandNo: readU16(b, 10),
                caps: readU16(b, 12),
                maxFrame: readU16(b, 14),
                uptimeMs: readU32(b, 16)
            ))
        case .getName:
            guard payloadLen == 12 || payloadLen == 13,
                  let str = String(bytes: b[4...], encoding: .ascii) else { return nil }
            payload = .name(str)
        case .setBandNumber:
            guard payloadLen == 2 else { return nil }
            payload = .bandNumber(readU16(b, 4))
        case .identify, .restart, .sleep, .ledSet, .storePut, .storeDel, .storeWipe:
            guard payloadLen == 0 else { return nil }
            payload = .empty
        case .timeSet, .timeGet:
            guard payloadLen == 13 else { return nil }
            payload = .time(set: b[4], unixMs: readU64(b, 5), tMs: readU32(b, 13))
        case .streamStart, .streamStop, .streamGet:
            guard payloadLen == 2 else { return nil }
            payload = .activeStreams(readU16(b, 4))
        case .streamSetInterval, .streamGetInterval:
            guard payloadLen == 13 else { return nil }
            payload = .streamInterval(
                stream: b[4],
                intervalMs: readU32(b, 5),
                minMs: readU32(b, 9),
                maxMs: readU32(b, 13)
            )
        case .imuSet, .imuGet:
            guard payloadLen == 4 else { return nil }
            payload = .imu(rateHz: b[4], accelRangeG: b[5], gyroRangeDps: readU16(b, 6))
        case .eventSet, .eventGet:
            guard payloadLen == 3 else { return nil }
            payload = .eventConfig(eventMask: b[4], tapThresholdMg: readU16(b, 5))
        case .motion2Set, .motion2Get:
            guard payloadLen == 9 else { return nil }
            payload = .motion2Config(
                rateHz: readU16(b, 4),
                sensors: b[6],
                maxAccelHz: readU16(b, 7),
                maxGyroHz: readU16(b, 9),
                maxBothHz: readU16(b, 11)
            )
        case .micSetGain:
            guard payloadLen == 1 else { return nil }
            payload = .micGain(b[4])
        case .micGet:
            guard payloadLen == 7 else { return nil }
            payload = .micInfo(
                gainHalfDb: b[4],
                sampleRate: readU16(b, 5),
                frameMs: b[7],
                channels: b[8],
                bitrate: readU16(b, 9)
            )
        case .radioSetTxPower:
            guard payloadLen == 1 else { return nil }
            payload = .radioTxPower(Int8(bitPattern: b[4]))
        case .radioGet:
            guard payloadLen == 7 else { return nil }
            payload = .radioInfo(
                txDbm: Int8(bitPattern: b[4]),
                rssiDbm: Int8(bitPattern: b[5]),
                phy: b[6],
                interval: readU16(b, 7),
                mtu: readU16(b, 9)
            )
        case .ledGet:
            guard payloadLen == 7 else { return nil }
            payload = .led(
                r: b[4],
                g: b[5],
                b: b[6],
                brightness: b[7],
                pattern: b[8],
                periodMs: readU16(b, 9)
            )
        case .tempSetInterval:
            guard payloadLen == 1 else { return nil }
            payload = .tempInterval(b[4])
        case .batteryGet:
            guard payloadLen == 4 else { return nil }
            payload = .battery(VexoBatteryReading(percent: b[4], state: b[5], millivolts: readU16(b, 6)))
        case .storeInfo:
            guard payloadLen == 10 else { return nil }
            payload = .storeInfo(
                keysMax: readU16(b, 4),
                valueMax: readU16(b, 6),
                freeBytes: readU32(b, 8),
                usedKeys: readU16(b, 12)
            )
        case .storeGet:
            guard (1...232).contains(payloadLen) else { return nil }
            payload = .storeValue(Data(b[4...]))
        }

        return .response(VexoResponseFrame(seq: seq, opcodeByte: opByte, statusByte: stByte, payload: payload))
    }
}
