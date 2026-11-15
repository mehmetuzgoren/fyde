"""Single source of truth for Fyde's assigned Vexo Open wristband.

Rules (vexo-open-kit/AGENTS.md):
- BAND = 69 (Vexo-HACK-69) is the ONLY band this project may ever scan for or talk to.
- Never renumber a band (SET_BAND_NUMBER must never be called).
- Keep API keys (DEEPGRAM_API_KEY, OPENAI_API_KEY) in environment variables or .env only.
"""
import os
from pathlib import Path


def read_environment() -> dict[str, str]:
    """Load only our configuration from the untracked project .env, without a shell."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.is_file():
        return {}
    allowed = {"DEEPGRAM_API_KEY", "FYDE_RELAY_URL", "FYDE_USER_ID", "FYDE_SESSION_TOKEN", "VEXO_BRIDGE_PORT"}
    values = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.removeprefix("export ").partition("=")
        if separator and key.strip() in allowed:
            values[key.strip()] = value.strip().strip("\"'")
    return values


for key, value in read_environment().items():
    os.environ.setdefault(key, value)

BAND = 69
BAND_NAME = "Vexo-HACK-69"

DEFAULT_FYDE_RELAY_URL = os.environ.get("FYDE_RELAY_URL", "https://fyde.izbirakin.com").rstrip("/")
DEFAULT_FYDE_USER_ID = os.environ.get("FYDE_USER_ID", "")
DEFAULT_BRIDGE_HOST = "127.0.0.1"
DEFAULT_BRIDGE_PORT = int(os.environ.get("VEXO_BRIDGE_PORT", "8790"))
