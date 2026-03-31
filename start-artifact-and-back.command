#!/bin/bash
# Artifact & Back — launcher
# Double-click this file to start the app in your browser.

PORT=8899

# Resolve the directory this script lives in (handles spaces, symlinks)
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║       Artifact & Back                ║"
echo "  ║       http://localhost:$PORT          ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Serving from: $SCRIPT_DIR"
echo "  Press Ctrl+C to stop the server."
echo ""

# Verify the HTML file exists
if [ ! -f "$SCRIPT_DIR/artifact-and-back.html" ]; then
  echo "  ERROR: artifact-and-back.html not found in $SCRIPT_DIR"
  echo "  Make sure both files are in the same folder."
  read -p "  Press Enter to close..."
  exit 1
fi

cd "$SCRIPT_DIR"

# Open browser after a short delay to let the server start
(sleep 1 && open "http://localhost:$PORT/artifact-and-back.html" 2>/dev/null || xdg-open "http://localhost:$PORT/artifact-and-back.html" 2>/dev/null) &

# Start server
python3 -m http.server $PORT
