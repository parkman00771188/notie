#!/bin/zsh
# Notie 오디오 도우미 제거
LABEL="co.mindsai.notie.audiohelper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID" "$PLIST" 2>/dev/null || true
rm -f "$PLIST" "$HOME/Library/Application Support/Notie/notie-audio-helper"
echo "✅ 제거 완료 — 기본 출력은 시스템 설정에서 직접 관리하시면 됩니다."
sleep 3
