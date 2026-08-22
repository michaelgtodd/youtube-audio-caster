#!/bin/sh
# Fetch the standalone yt-dlp binary for this platform into ./bin.
# It is NOT vendored: it is ~36MB and goes stale fast (YouTube changes break
# older builds), so it is fetched fresh and should be updated periodically.
set -e
cd "$(dirname "$0")/.." || exit 1
mkdir -p bin
BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
case "$(uname -s)" in
  Darwin) NAME="yt-dlp_macos"; OUT="bin/yt-dlp" ;;
  Linux)  NAME="yt-dlp_linux"; OUT="bin/yt-dlp" ;;
  MINGW*|MSYS*|CYGWIN*) NAME="yt-dlp.exe"; OUT="bin/yt-dlp.exe" ;;
  *) echo "unsupported platform: $(uname -s)"; exit 1 ;;
esac
echo "downloading $NAME -> $OUT"
curl -fL --progress-bar -o "$OUT" "$BASE/$NAME"
chmod +x "$OUT"
"$OUT" --version && echo "yt-dlp ready"
