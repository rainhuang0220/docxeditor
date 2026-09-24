#!/bin/bash
# Start the backend server
cd "$(dirname "$0")"

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Activate venv if it exists
if [ -f backend/.venv/bin/activate ]; then
  source backend/.venv/bin/activate
fi

# Browser development only. The packaged app ignores this flag.
python3 -m backend.desktop_runtime --dev-insecure
