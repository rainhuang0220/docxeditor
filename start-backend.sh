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

python3 -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
