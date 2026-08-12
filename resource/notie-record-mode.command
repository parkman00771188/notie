#!/bin/zsh
# 노티 녹음 모드 전환 (macOS) — 더블클릭할 때마다 기본 사운드 출력을
#   🔈 일반 모드: 스피커 (볼륨 키 사용 가능)
#   🎙️ 녹음 모드: 스피커+BlackHole 다중 출력 (컴퓨터 소리 녹음 가능, 볼륨 키 비활성)
# 사이에서 토글합니다. BlackHole 2ch가 설치되어 있어야 합니다.
set -e

SCRIPT=$(mktemp /tmp/notie-record-mode-XXXXXX.swift)
trap 'rm -f "$SCRIPT"' EXIT
cat > "$SCRIPT" <<'SWIFT_EOF'
import CoreAudio
import Foundation

let AGG_UID = "com.notie.multi-output"
let AGG_NAME = "스피커+BlackHole (Notie)"

func deviceIDs() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
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
func name(_ id: AudioDeviceID) -> String { strProp(id, kAudioDevicePropertyDeviceNameCFString) ?? "?" }
func uid(_ id: AudioDeviceID) -> String { strProp(id, kAudioDevicePropertyDeviceUID) ?? "?" }
func transport(_ id: AudioDeviceID) -> UInt32 {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v: UInt32 = 0; var size = UInt32(4)
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &v)
    return v
}
func outCh(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 8); defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}
func defaultOutput() -> AudioDeviceID {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id = AudioDeviceID(0); var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}
func setDefaultOutput(_ id: AudioDeviceID) -> Bool {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v = id
    return AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &v) == noErr
}

let devs = deviceIDs()
let speaker = devs.first { transport($0) == kAudioDeviceTransportTypeBuiltIn && outCh($0) > 0 }
var agg = devs.first { uid($0) == AGG_UID }

if uid(defaultOutput()) == AGG_UID {
    // 녹음 모드 → 일반 모드
    guard let sp = speaker, setDefaultOutput(sp) else { print("❌ 스피커 전환 실패"); exit(1) }
    print("🔈 일반 모드: 출력을 '\(name(sp))'로 전환했습니다. 볼륨 키를 쓸 수 있어요.")
} else {
    // 일반 모드 → 녹음 모드 (다중 출력 장치가 없으면 생성)
    if agg == nil {
        guard let sp = speaker, let spUID = strProp(sp, kAudioDevicePropertyDeviceUID),
              let bh = devs.first(where: { name($0).contains("BlackHole") && outCh($0) > 0 }),
              let bhUID = strProp(bh, kAudioDevicePropertyDeviceUID) else {
            print("❌ BlackHole 장치를 찾지 못했습니다. https://existential.audio/blackhole/ 에서 설치해주세요.")
            exit(1)
        }
        let desc: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: AGG_NAME,
            kAudioAggregateDeviceUIDKey as String: AGG_UID,
            kAudioAggregateDeviceIsStackedKey as String: 1,
            kAudioAggregateDeviceMainSubDeviceKey as String: spUID,
            kAudioAggregateDeviceSubDeviceListKey as String: [
                [kAudioSubDeviceUIDKey as String: spUID],
                [kAudioSubDeviceUIDKey as String: bhUID, kAudioSubDeviceDriftCompensationKey as String: 1],
            ],
        ]
        var newID = AudioDeviceID(0)
        guard AudioHardwareCreateAggregateDevice(desc as CFDictionary, &newID) == noErr, newID != 0 else {
            print("❌ 다중 출력 장치 생성 실패"); exit(1)
        }
        usleep(300_000)
        agg = newID
    }
    guard let device = agg, setDefaultOutput(device) else { print("❌ 녹음 모드 전환 실패"); exit(1) }
    // macOS는 메인 서브 장치(스피커)의 음소거·볼륨0을 다중 출력 전체에 적용해
    // BlackHole 피드까지 무음이 된다(실측). 녹음이 죽지 않도록 최소 볼륨을 보장한다.
    if let sp = speaker {
        var muteAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        if AudioObjectHasProperty(sp, &muteAddr) {
            var off: UInt32 = 0
            AudioObjectSetPropertyData(sp, &muteAddr, 0, nil, 4, &off)
        }
        for element in [UInt32(0), 1, 2] {
            var volAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
            if AudioObjectHasProperty(sp, &volAddr) {
                var v: Float32 = 0; var size = UInt32(4)
                AudioObjectGetPropertyData(sp, &volAddr, 0, nil, &size, &v)
                if v < 0.1 {
                    var minV: Float32 = 0.1
                    AudioObjectSetPropertyData(sp, &volAddr, 0, nil, 4, &minV)
                }
            }
        }
        print("   스피커 음소거를 해제하고 볼륨을 최소 10%로 맞췄어요 — 음소거/볼륨0이면 녹음도 무음이 되기 때문이에요.")
    }
    print("🎙️ 녹음 모드: 컴퓨터 소리가 BlackHole로도 전달됩니다. (볼륨 키는 이 모드에서 비활성)")
    print("   완전 무음으로 녹음하려면 Chrome에서 [탭 공유 + 오디오 공유]를 사용하세요.")
}
SWIFT_EOF

swift "$SCRIPT"
echo ""
echo "3초 후 창이 닫힙니다..."
sleep 3
