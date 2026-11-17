#!/bin/zsh
# slack-claude-bot を macOS の launchd（LaunchAgent）で常駐させる。
#   ./scripts/launchd.sh install    plistを生成して登録・起動（ログイン時に自動起動、落ちたら自動再起動）
#   ./scripts/launchd.sh restart    再起動（config.json を変えたあと等）
#   ./scripts/launchd.sh status     状態の確認
#   ./scripts/launchd.sh logs       ログを追う
#   ./scripts/launchd.sh uninstall  停止して登録解除
#
# launchd から起動するので、Claude Code のセッションの環境変数を引き継がない。
# 実行中は caffeinate でアイドルスリープを防ぐ（画面はスリープしてよい）。
# ノートMacで蓋を閉じた場合のスリープは防げない。
set -euo pipefail

LABEL="local.slack-claude-bot"
REPO_DIR="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/slack-claude-bot.log"
DOMAIN="gui/$(id -u)"

write_plist() {
  mkdir -p "${PLIST:h}" "${LOG:h}"
  cat >| "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>/usr/bin/caffeinate -i -w \$\$ &amp; exec ./node_modules/.bin/tsx src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
}

case "${1:-}" in
  install)
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed: $PLIST"
    echo "log: $LOG"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code|runs) ='
    ;;
  logs)
    tail -f "$LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "uninstalled"
    ;;
  *)
    echo "usage: $0 {install|restart|status|logs|uninstall}" >&2
    exit 2
    ;;
esac
