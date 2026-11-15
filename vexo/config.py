"""Single source of truth for Fyde's assigned Vexo Open wristband.

Rules (vexo-open-kit/AGENTS.md):
- BAND = 69 (Vexo-HACK-69) is the ONLY band this project may ever scan for or talk to.
- Never renumber a band (SET_BAND_NUMBER must never be called).
- Keep API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY) in environment variables or .env only.
"""
import os

BAND = 69
BAND_NAME = "Vexo-HACK-69"

DEFAULT_FYDE_RELAY_URL = os.environ.get("FYDE_RELAY_URL", "http://127.0.0.1:8787").rstrip("/")
DEFAULT_FYDE_USER_ID = os.environ.get("FYDE_USER_ID", "mehmet")
DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = int(os.environ.get("VEXO_BRIDGE_PORT", "8790"))
