"""
app.py — Token server and static file server for Maneuver Talk-to-Founder

Endpoints:
  GET  /           → Serve the app UI
  POST /token      → Issue a signed LiveKit room token for the visitor
  GET  /api/leads  → Return all captured lead records (append-only JSON)
"""

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from livekit.api import AccessToken, VideoGrants

BASE_DIR = Path(__file__).parent
LEADS_PATH = BASE_DIR / "captured_leads.json"

app = FastAPI(title="Maneuver Talk-to-Founder")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/", response_class=HTMLResponse)
async def serve_ui():
    return HTMLResponse((BASE_DIR / "static" / "index.html").read_text("utf-8"))


@app.post("/token")
async def get_token(payload: dict = {}):
    """
    Issue a signed LiveKit JWT so the browser can join the voice room.
    The agent worker connects to the same room and handles STT → LLM → TTS.
    """
    api_key    = os.getenv("LIVEKIT_API_KEY", "")
    api_secret = os.getenv("LIVEKIT_API_SECRET", "")
    lk_url     = os.getenv("LIVEKIT_URL", "")

    if not (api_key and api_secret and lk_url):
        return JSONResponse(
            {"error": "LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL not set in .env"},
            status_code=503,
        )

    room_name = payload.get("room") or f"maneuver-{int(time.time())}"
    identity  = payload.get("identity") or f"visitor-{int(time.time())}"

    token = (
        AccessToken(api_key, api_secret)
        .with_identity(identity)
        .with_name("Visitor")
        .with_grants(VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return JSONResponse({"token": token, "url": lk_url, "room": room_name})


@app.get("/api/leads")
async def get_leads():
    """Return all captured lead records written by the agent."""
    if not LEADS_PATH.exists():
        return JSONResponse([])
    try:
        return JSONResponse(json.loads(LEADS_PATH.read_text("utf-8")))
    except Exception:
        return JSONResponse([])


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
