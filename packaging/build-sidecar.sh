#!/bin/bash
# Build the macOS Apple Silicon backend sidecar. The binary is not committed.
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [[ "$TRIPLE" != "aarch64-apple-darwin" ]]; then
  echo "This script builds the Apple Silicon sidecar. Current host is $TRIPLE." >&2
  exit 1
fi
python3 -m venv build/sidecar-venv
build/sidecar-venv/bin/pip install -r backend/requirements.txt 'pyinstaller==6.16.0'
build/sidecar-venv/bin/python -m PyInstaller --noconfirm --clean --onefile --console \
  --name docxeditor-backend \
  --target-arch arm64 \
  --distpath build/sidecar \
  --workpath build/pyinstaller \
  --specpath packaging \
  --paths . \
  --collect-submodules uvicorn \
  --collect-submodules keyring.backends.macOS \
  --collect-data docx \
  --collect-data certifi \
  --copy-metadata keyring \
  --hidden-import uvicorn.logging \
  --hidden-import uvicorn.loops.asyncio \
  --hidden-import uvicorn.protocols.http.h11_impl \
  --hidden-import uvicorn.lifespan.on \
  --hidden-import keyring \
  --hidden-import keyring.backends.macOS \
  --hidden-import keyring.backends.fail \
  --hidden-import python_multipart \
  --hidden-import python_multipart.multipart \
  --hidden-import dotenv \
  --hidden-import anthropic \
  --hidden-import h11 \
  --hidden-import backend.main \
  --exclude-module backend.test_credentials \
  --exclude-module backend.test_continuation \
  --exclude-module backend.test_desktop_runtime \
  --exclude-module pytest \
  packaging/sidecar_entry.py
mkdir -p src-tauri/binaries
cp build/sidecar/docxeditor-backend "src-tauri/binaries/docxeditor-backend-${TRIPLE}"
chmod +x "src-tauri/binaries/docxeditor-backend-${TRIPLE}"
echo "sidecar: src-tauri/binaries/docxeditor-backend-${TRIPLE}"
