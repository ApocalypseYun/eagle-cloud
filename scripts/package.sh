#!/bin/bash
# Build and package the plugin as a .eagleplugin file for end users.
# Usage: ./scripts/package.sh
# Output: dist/eagle-cloud-sync.eagleplugin

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/dist"
PLUGIN_NAME="eagle-cloud-sync"
PLUGIN_DIR="$OUTPUT_DIR/$PLUGIN_NAME"

echo "==> Cleaning previous build..."
rm -rf "$OUTPUT_DIR"

echo "==> Building TypeScript..."
cd "$PROJECT_DIR"
npm run build

echo "==> Assembling plugin package..."
mkdir -p "$PLUGIN_DIR"

# Copy manifest and built files
cp "$PROJECT_DIR/manifest.json" "$PLUGIN_DIR/"
cp -r "$OUTPUT_DIR/background" "$PLUGIN_DIR/"
cp -r "$OUTPUT_DIR/window" "$PLUGIN_DIR/"

# Copy logo placeholder (create if not exists)
mkdir -p "$PLUGIN_DIR/images"
if [ ! -f "$PROJECT_DIR/images/logo.png" ]; then
  echo "⚠️  No logo.png found. Plugin will use default icon."
else
  cp "$PROJECT_DIR/images/logo.png" "$PLUGIN_DIR/images/"
fi

echo "==> Creating .eagleplugin archive..."
cd "$OUTPUT_DIR"
mv "$PLUGIN_NAME" "$PLUGIN_NAME.eagleplugin"

echo ""
echo "✅ Done! Plugin packaged at:"
echo "   $OUTPUT_DIR/$PLUGIN_NAME.eagleplugin"
echo ""
echo "📦 Installation:"
echo "   Double-click the .eagleplugin file, Eagle will auto-install it."
echo "   Or: Eagle → Plugins menu → Install from local file"
