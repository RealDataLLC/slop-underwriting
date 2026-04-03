import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

# Find .env.local relative to project root (where uvicorn runs from)
_project_root = Path(__file__).resolve().parent.parent.parent
_env_path = _project_root / ".env.local"

if _env_path.exists():
    load_dotenv(_env_path, override=True)
else:
    # Fallback: try cwd
    load_dotenv(".env.local", override=True)

SUPABASE_URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
SUPABASE_KEY = os.environ["NEXT_PUBLIC_SUPABASE_ANON_KEY"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
