// Notie 오디오 도우미 — 127.0.0.1:45123 에서 대기하며 웹앱의 신호로
// 기본 사운드 출력을 전환한다.
//   POST /record-on  → 스피커+BlackHole 다중 출력(없으면 생성) + 음소거 해제·볼륨 10% 보장
//   POST /record-off → 내장 스피커 복귀
//   GET  /status     → {"helper":"notie","mode":"record|normal","blackhole":true|false}
// 브라우저에서 직접 호출하므로 CORS/Private Network Access 헤더를 포함한다.
import CoreAudio
import Foundation
import Network

let PORT: UInt16 = 45123
let AGG_UID = "com.notie.multi-output"
let AGG_NAME = "스피커+BlackHole (Notie)"

// ---- CoreAudio 유틸 ----

func deviceIDs() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func strProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectHasProperty(id, &addr) else { return nil }
    var cf: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let st = withUnsafeMutablePointer(to: &cf) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
    guard st == noErr, let v = cf else { return nil }
    return v as String
}

func devName(_ id: AudioDeviceID) -> String { strProp(id, kAudioDevicePropertyDeviceNameCFString) ?? "?" }
func devUID(_ id: AudioDeviceID) -> String { strProp(id, kAudioDevicePropertyDeviceUID) ?? "?" }

func transport(_ id: AudioDeviceID) -> UInt32 {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v: UInt32 = 0
    var size = UInt32(4)
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v)
    return v
}

func outCh(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}

func defaultOutput() -> AudioDeviceID {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}

func setDefaultOutput(_ id: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v = id
    return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v) == noErr
}

func builtinSpeaker() -> AudioDeviceID? {
    deviceIDs().first { transport($0) == kAudioDeviceTransportTypeBuiltIn && outCh($0) > 0 }
}

func blackholeDevice() -> AudioDeviceID? {
    deviceIDs().first { devName($0).contains("BlackHole") && outCh($0) > 0 }
}

func aggregateDevice() -> AudioDeviceID? {
    deviceIDs().first { devUID($0) == AGG_UID }
}

/// 메인 출력 장치 음소거 해제 + 볼륨 10% 미만이면 10%로 — 메인 서브 장치가 음소거/볼륨0이면
/// macOS가 다중 출력 전체(BlackHole 피드 포함)를 무음 처리하기 때문(실측).
func ensureAudible(_ dev: AudioDeviceID) {
    var muteAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    if AudioObjectHasProperty(dev, &muteAddr) {
        var off: UInt32 = 0
        AudioObjectSetPropertyData(dev, &muteAddr, 0, nil, 4, &off)
    }
    for element in [UInt32(0), 1, 2] {
        var volAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
        if AudioObjectHasProperty(dev, &volAddr) {
            var v: Float32 = 0
            var size = UInt32(4)
            AudioObjectGetPropertyData(dev, &volAddr, 0, nil, &size, &v)
            if v < 0.1 {
                var minV: Float32 = 0.1
                AudioObjectSetPropertyData(dev, &volAddr, 0, nil, 4, &minV)
            }
        }
    }
}

/// 집계 장치의 메인 서브 장치 UID
func aggregateMainUID(_ agg: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyMainSubDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectHasProperty(agg, &addr) else { return nil }
    var cf: CFString? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    let st = withUnsafeMutablePointer(to: &cf) { AudioObjectGetPropertyData(agg, &addr, 0, nil, &size, $0) }
    guard st == noErr, let v = cf else { return nil }
    return v as String
}

/// '지금 듣고 있는 출력 장치(main) + BlackHole' 조합의 다중 출력 장치 확보.
/// 스피커든 에어팟이든 현재 장치를 그대로 유지한 채 BlackHole로만 복사본을 보낸다.
func ensureAggregate(main: AudioDeviceID) -> AudioDeviceID? {
    guard let mainUID = strProp(main, kAudioDevicePropertyDeviceUID),
          let bh = blackholeDevice(), let bhUID = strProp(bh, kAudioDevicePropertyDeviceUID) else { return nil }
    if let existing = aggregateDevice() {
        if aggregateMainUID(existing) == mainUID { return existing }
        // 출력 장치가 바뀌었으면(스피커→에어팟 등) 새 조합으로 재생성
        AudioHardwareDestroyAggregateDevice(existing)
        usleep(300_000)
    }
    let desc: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: AGG_NAME,
        kAudioAggregateDeviceUIDKey as String: AGG_UID,
        kAudioAggregateDeviceIsStackedKey as String: 1,
        kAudioAggregateDeviceMainSubDeviceKey as String: mainUID,
        kAudioAggregateDeviceSubDeviceListKey as String: [
            [kAudioSubDeviceUIDKey as String: mainUID],
            [kAudioSubDeviceUIDKey as String: bhUID, kAudioSubDeviceDriftCompensationKey as String: 1],
        ],
    ]
    var newID = AudioDeviceID(0)
    guard AudioHardwareCreateAggregateDevice(desc as CFDictionary, &newID) == noErr, newID != 0 else { return nil }
    usleep(400_000) // 서브 장치 연결 대기
    return newID
}

// ---- 모드 전환 ----

/// record-off 때 되돌아갈 원래 출력 장치 UID (도우미 프로세스 수명 동안 유지)
var savedOutputUID: String? = nil

func statusJSON() -> String {
    let current = defaultOutput()
    let mode = devUID(current) == AGG_UID ? "record" : "normal"
    let hasBH = blackholeDevice() != nil
    let outName = devName(current).replacingOccurrences(of: "\"", with: "")
    return "{\"helper\":\"notie\",\"version\":1,\"mode\":\"\(mode)\",\"blackhole\":\(hasBH),\"output\":\"\(outName)\"}"
}

func recordOn() -> (String, String) {
    guard blackholeDevice() != nil else {
        return ("409 Conflict", "{\"ok\":false,\"error\":\"blackhole-missing\"}")
    }
    let current = defaultOutput()
    if devUID(current) == AGG_UID {
        // 이미 녹음 모드 — 메인 장치 볼륨만 재보장
        if let mainUID = aggregateMainUID(current),
           let main = deviceIDs().first(where: { devUID($0) == mainUID }) {
            ensureAudible(main)
        }
        return ("200 OK", "{\"ok\":true,\"mode\":\"record\"}")
    }
    guard let agg = ensureAggregate(main: current) else {
        return ("500 Internal Server Error", "{\"ok\":false,\"error\":\"aggregate-failed\"}")
    }
    savedOutputUID = devUID(current)
    ensureAudible(current)
    guard setDefaultOutput(agg) else {
        return ("500 Internal Server Error", "{\"ok\":false,\"error\":\"switch-failed\"}")
    }
    usleep(350_000) // 라우팅 안정화 후 응답 — 곧바로 캡처가 시작되기 때문
    NSLog("record-on: '\(devName(current))'+BlackHole 다중 출력으로 전환")
    return ("200 OK", "{\"ok\":true,\"mode\":\"record\"}")
}

func recordOff() -> (String, String) {
    if devUID(defaultOutput()) == AGG_UID {
        // 원래 쓰던 장치(에어팟 등)로 복귀 — 없어졌으면 내장 스피커로
        let restore = deviceIDs().first { devUID($0) == savedOutputUID } ?? builtinSpeaker()
        guard let target = restore, setDefaultOutput(target) else {
            return ("500 Internal Server Error", "{\"ok\":false,\"error\":\"switch-failed\"}")
        }
        NSLog("record-off: '\(devName(target))'로 복귀")
    }
    return ("200 OK", "{\"ok\":true,\"mode\":\"normal\"}")
}

// ---- 미니 HTTP 서버 ----

func respond(_ conn: NWConnection, status: String, body: String) {
    let head = [
        "HTTP/1.1 \(status)",
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Allow-Headers: *",
        "Access-Control-Allow-Private-Network: true",
        "Content-Type: application/json; charset=utf-8",
        "Content-Length: \(body.utf8.count)",
        "Connection: close",
        "",
        "",
    ].joined(separator: "\r\n")
    conn.send(content: (head + body).data(using: .utf8), completion: .contentProcessed { _ in
        conn.cancel()
    })
}

func handle(_ conn: NWConnection) {
    conn.start(queue: .main)
    conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { data, _, _, _ in
        guard let data, let text = String(data: data, encoding: .utf8),
              let requestLine = text.split(separator: "\r\n").first else {
            conn.cancel()
            return
        }
        let parts = requestLine.split(separator: " ")
        let method = parts.count > 0 ? String(parts[0]) : ""
        let path = parts.count > 1 ? String(parts[1]) : "/"
        switch (method, path) {
        case ("OPTIONS", _):
            respond(conn, status: "204 No Content", body: "")
        case ("GET", "/status"):
            respond(conn, status: "200 OK", body: statusJSON())
        case ("POST", "/record-on"):
            let (st, body) = recordOn()
            respond(conn, status: st, body: body)
        case ("POST", "/record-off"):
            let (st, body) = recordOff()
            respond(conn, status: st, body: body)
        default:
            respond(conn, status: "404 Not Found", body: "{\"ok\":false}")
        }
    }
}

let params = NWParameters.tcp
params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: PORT)!)
params.allowLocalEndpointReuse = true
guard let listener = try? NWListener(using: params) else {
    NSLog("포트 \(PORT) 바인딩 실패 — 이미 실행 중인지 확인")
    exit(1)
}
listener.newConnectionHandler = { handle($0) }
listener.stateUpdateHandler = { state in
    if case .ready = state { NSLog("Notie 오디오 도우미 대기 중: http://127.0.0.1:\(PORT)") }
    if case .failed(let err) = state {
        NSLog("리스너 오류: \(err)")
        exit(1)
    }
}
listener.start(queue: .main)
RunLoop.main.run()
