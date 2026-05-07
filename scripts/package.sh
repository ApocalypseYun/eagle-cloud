#!/bin/bash
# Build and package the plugin as a .eagleplugin directory for end users.
# Usage: ./scripts/package.sh
# Output: dist/eagle-cloud-sync.eagleplugin/

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/dist"
PLUGIN_NAME="eagle-cloud-sync"
PLUGIN_DIR="$OUTPUT_DIR/$PLUGIN_NAME.eagleplugin"

echo "==> Cleaning previous build..."
rm -rf "$OUTPUT_DIR"
rm -rf "$PROJECT_DIR/background" "$PROJECT_DIR/window"

echo "==> Building TypeScript..."
cd "$PROJECT_DIR"
npm run build

echo "==> Assembling plugin package..."
mkdir -p "$PLUGIN_DIR"

# Copy manifest
cp "$PROJECT_DIR/manifest.json" "$PLUGIN_DIR/"

# Copy built files (now output directly to background/ and window/ in project root)
cp -r "$PROJECT_DIR/background" "$PLUGIN_DIR/"
cp -r "$PROJECT_DIR/window" "$PLUGIN_DIR/"

# Copy logo placeholder
mkdir -p "$PLUGIN_DIR/images"
if [ -f "$PROJECT_DIR/images/logo.png" ]; then
  cp "$PROJECT_DIR/images/logo.png" "$PLUGIN_DIR/images/"
else
  echo "⚠️  No logo.png found. Plugin will use default icon."
fi

# Create zip for distribution
cd "$OUTPUT_DIR"
zip -r "$PLUGIN_NAME.eagleplugin.zip" "$PLUGIN_NAME.eagleplugin/"

echo ""
echo "✅ Done! Plugin packaged at:"
echo "   $PLUGIN_DIR"
echo "   $OUTPUT_DIR/$PLUGIN_NAME.eagleplugin.zip"
echo ""
echo "📦 Installation:"
echo "   Unzip → double-click the .eagleplugin folder → Eagle auto-installs."
