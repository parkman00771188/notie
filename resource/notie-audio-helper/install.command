#!/bin/zsh
# Notie 오디오 도우미 설치 — 더블클릭 한 번이면 끝.
# 로그인 시 자동 실행되며, 웹앱이 녹음을 시작하면 현재 출력(스피커/에어팟 등)+BlackHole
# 다중 출력으로 전환하고, 녹음이 끝나면 원래 장치로 되돌립니다.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APPDIR="$HOME/Library/Application Support/Notie"
BIN="$APPDIR/notie-audio-helper"
LABEL="co.mindsai.notie.audiohelper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "❌ Xcode Command Line Tools가 필요해요. 터미널에서 'xcode-select --install' 실행 후 다시 시도해주세요."
  sleep 5; exit 1
fi

echo "도우미 컴파일 중..."
mkdir -p "$APPDIR"
xcrun swiftc -O "$DIR/notie-audio-helper.swift" -o "$BIN"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/$LABEL.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
sleep 1.2

if curl -s --max-time 2 http://127.0.0.1:45123/status | grep -q '"helper":"notie"'; then
  echo ""
  echo "✅ 설치 완료! 이제 노티에서 컴퓨터 소리 녹음을 시작하면 출력이 자동 전환되고,"
  echo "   녹음을 끝내면 원래 장치(스피커/에어팟)로 자동 복귀합니다."
else
  echo "⚠️ 도우미 응답이 없어요. /tmp/$LABEL.log 내용을 확인해주세요."
fi
echo ""
echo "5초 후 창이 닫힙니다..."
sleep 5
