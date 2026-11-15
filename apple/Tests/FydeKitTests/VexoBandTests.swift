import XCTest
@testable import FydeKit

final class VexoBandTests: XCTestCase {
    func testAssignedBandIsStrictly69() {
        XCTAssertEqual(VexoBandConstants.assignedBandNumber, 69)
        XCTAssertEqual(VexoBandConstants.assignedBandName, "Vexo-HACK-69")
        XCTAssertEqual(VexoBandProtocol.bandName(for: 7), "Vexo-HACK-07")
        XCTAssertEqual(VexoBandProtocol.bandName(for: 69), "Vexo-HACK-69")
        XCTAssertEqual(VexoBandProtocol.bandName(for: 123), "Vexo-HACK-123")
    }

    func testAdvertisementFilterStrictlyAcceptsOnlyBand69() {
        // 69 = 0x0045 little-endian -> [0x45, 0x00]
        let mfg69 = Data([0xFF, 0xFF, 0x4F, 0x01, 0x45, 0x00])
        let mfg42 = Data([0xFF, 0xFF, 0x4F, 0x01, 0x2A, 0x00])

        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: "Vexo-HACK-69", manufacturerData: nil),
            .matched
        )
        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: nil, manufacturerData: mfg69),
            .matched
        )
        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: "Vexo-HACK-42", manufacturerData: nil),
            .rejectedOtherBand
        )
        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: nil, manufacturerData: mfg42),
            .rejectedOtherBand
        )
        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: "Vexo-HACK-690", manufacturerData: mfg69),
            .rejectedOtherBand
        )
        XCTAssertEqual(
            VexoBandProtocol.evaluateAdvertisement(localName: nil, manufacturerData: nil),
            .pendingScanResponse
        )
    }

    func testContractVectorsEncodeAndDecode() throws {
        // Verify key contract v1.1 command encodings match test-vectors.json byte-for-byte
        XCTAssertEqual(hex(VexoBandProtocol.encodeSimple(.getInfo, seq: 0)), "010001")
        XCTAssertEqual(hex(VexoBandProtocol.encodeStreamStart(seq: 8, mask: 147)), "0108109300")
        XCTAssertEqual(hex(VexoBandProtocol.encodeStreamStop(seq: 10, mask: 1)), "010a110100")
        XCTAssertEqual(hex(VexoBandProtocol.encodeImuSet(seq: 12, rateHz: 100, accelRangeG: 8, gyroRangeDps: 500)), "010c206408f401")
        XCTAssertEqual(hex(VexoBandProtocol.encodeLedSet(seq: 7, r: 0, g: 255, b: 0, brightness: 128, pattern: 1, periodMs: 1000)), "01075000ff008001e803")
        XCTAssertEqual(hex(VexoBandProtocol.encodeTimeSet(seq: 50, unixMs: 1_794_484_800_123)), "0132077b0aa1cfa1010000")
        XCTAssertEqual(hex(VexoBandProtocol.encodeMotion2Set(seq: 55, rateHz: 416, sensors: 1)), "013724a00101")

        // Verify GET_INFO v1.1 response decode
        let infoFrame = try unhex("023101000101010100014500ff07f40040e20100")
        guard case .response(let r) = VexoBandProtocol.decodeFrame(infoFrame),
              case .info(let info) = r.payload else {
            return XCTFail("Expected GET_INFO response")
        }
        XCTAssertEqual(info.protoMajor, 1)
        XCTAssertEqual(info.protoMinor, 1)
        XCTAssertEqual(info.firmwareVersion, "1.1.0")
        XCTAssertEqual(info.bandNo, 69)
        XCTAssertEqual(info.maxFrame, 244)
        XCTAssertEqual(info.uptimeMs, 123_456)

        // Verify EVENT double-tap decode
        let doubleTap = try unhex("118a1300000200")
        XCTAssertEqual(VexoBandProtocol.decodeFrame(doubleTap), .event(tMs: 5002, event: 2, arg: 0))

        // Verify AUDIO Opus packet decode
        let audioFrame = try unhex("13ffff04deafbeef")
        XCTAssertEqual(
            VexoBandProtocol.decodeFrame(audioFrame),
            .audio(seq: 65535, opus: Data([0xDE, 0xAF, 0xBE, 0xEF]))
        )

        // Verify BATTERY decode
        let battFrame = try unhex("145700930f")
        XCTAssertEqual(
            VexoBandProtocol.decodeFrame(battFrame),
            .battery(VexoBatteryReading(percent: 87, state: 0, millivolts: 3987))
        )

        // Verify invalid frames from test-vectors.json are rejected cleanly (nil, no crash)
        let invalids = [
            "",
            "02",
            "020750",
            "0200010001",
            "0301",
            "10010000002802000000000000000000000000",
            "1101000000",
            "13000005aabb",
            "1457",
            "180100000000000000409c00000001000000000000",
            "0105"
        ]
        for badHex in invalids {
            let d = try unhex(badHex)
            XCTAssertNil(VexoBandProtocol.decodeFrame(d), "Expected invalid frame \(badHex) to return nil")
        }
    }

    @MainActor
    func testSimulatorConnectAndTiltCyclesFydeTabs() async {
        let store = FydeStore(relayBaseURL: "http://127.0.0.1:9")
        store.vexo.transportKind = .simulator
        await store.vexo.connect()
        XCTAssertTrue(store.vexo.isConnected)
        XCTAssertEqual(store.vexo.bandInfo?.bandNo, 69)
        XCTAssertEqual(store.selectedTab, .chat)

        await store.vexo.simulateGesture(.tilt)
        XCTAssertEqual(store.selectedTab, .received)

        await store.vexo.simulateGesture(.tilt)
        XCTAssertEqual(store.selectedTab, .search)

        store.vexo.disconnect()
        XCTAssertFalse(store.vexo.isConnected)
    }

    private func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    private func unhex(_ str: String) throws -> Data {
        var out = Data()
        var idx = str.startIndex
        while idx < str.endIndex {
            let next = str.index(idx, offsetBy: 2)
            let b = try XCTUnwrap(UInt8(str[idx..<next], radix: 16))
            out.append(b)
            idx = next
        }
        return out
    }
}
