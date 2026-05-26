"""
agent.py — Maneuver "Talk to Founder" LiveKit Voice Agent

LiveKit Agents worker using:
  - Silero VAD          (voice activity detection, runs locally)
  - Deepgram nova-2     (STT — speech-to-text)
  - Claude Haiku        (LLM — conversation + field extraction via tools)
  - Cartesia            (TTS — text-to-speech)

The agent runs a discovery call (name → company → problem → timeline → budget)
and answers questions about Maneuver from the knowledge base.

UI updates (lead panel fields, visual cards) are pushed to the browser over
the LiveKit data channel — no REST polling required.
"""

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Annotated

from dotenv import load_dotenv

load_dotenv()

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.agents.llm import function_tool
from livekit.plugins import anthropic, cartesia, deepgram, silero
import livekit.agents.worker as _lk_worker

# Default assignment timeout is 7.5 s — too short on high-latency networks.
# Increase to 30 s so the handshake survives India ↔ US round-trips.
_lk_worker.ASSIGNMENT_TIMEOUT = 30.0

BASE_DIR = Path(__file__).parent
KNOWLEDGE_PATH = BASE_DIR / "knowledge_base.md"
LEADS_PATH = BASE_DIR / "captured_leads.json"

DISCOVERY_FIELDS = ["name", "company", "problem", "timeline", "budget"]


def _load_knowledge() -> str:
    if not KNOWLEDGE_PATH.exists():
        return ""
    return KNOWLEDGE_PATH.read_text("utf-8")


KNOWLEDGE = _load_knowledge()

SYSTEM_PROMPT = f"""You are Alex, founder of Maneuver — a product and growth partner for climate and mobility startups. You are on a live voice discovery call with a potential client.

MANEUVER KNOWLEDGE BASE:
{KNOWLEDGE}

DISCOVERY GOAL:
Capture these five fields naturally through conversation:
  1. name     — visitor's first name
  2. company  — their company or project name
  3. problem  — the core problem they are solving and for whom
  4. timeline — their target timeline or deadline
  5. budget   — their rough budget range

CONVERSATION RULES (critical — this is a live voice call):
- Sound like a warm, curious founder — not a bot or a form
- Keep every reply SHORT: 1–3 sentences max
- Plain sentences only — no bullet points, no markdown, no numbered lists
- Never ask more than ONE question at a time
- Acknowledge everything the visitor volunteers before asking the next question
- If the visitor asks about Maneuver, answer from the knowledge base, then steer gently back to discovery
- If the visitor corrects a previously given value, use the new one
- When you capture any field value (including corrections), call update_lead_field() immediately
- When the visitor asks about a Maneuver topic, call show_visual_card() with the matching card
- When all five fields are captured, call save_lead() with the complete data, then give a warm summary
"""


class ManeuverFounderAgent(Agent):
    """LiveKit voice agent representing Alex, Maneuver's founder."""

    def __init__(self) -> None:
        super().__init__(
            instructions=SYSTEM_PROMPT,
            stt=deepgram.STT(
                model="nova-2-general",
                language="en-US",
                # 800 ms of silence before Deepgram closes an utterance.
                # Default is 25 ms — way too aggressive; causes every breath-pause
                # to create a new segment and confuses the turn detector.
                endpointing_ms=800,
                interim_results=False,   # only emit final transcripts
                smart_format=True,
            ),
            llm=anthropic.LLM(model="claude-haiku-4-5-20251001"),
            tts=cartesia.TTS(),
            vad=silero.VAD.load(),
            # Wait at least 0.5 s of silence before generating a reply,
            # and at most 2 s (sensible defaults for a voice call).
            min_endpointing_delay=0.5,
            max_endpointing_delay=2.0,
        )
        self._lead: dict[str, str] = {f: "" for f in DISCOVERY_FIELDS}
        self._room = None

    async def on_enter(self) -> None:
        """Speak the opening greeting as soon as the agent joins the room."""
        await self.session.say(
            "Hey! I'm Alex, founder of Maneuver. Really glad you stopped by. "
            "Tell me a bit about yourself and what you're working on — "
            "what brings you here today?",
            allow_interruptions=True,
        )

    async def _publish_ui(self, payload: dict) -> None:
        """Push a JSON message to the browser over the LiveKit data channel."""
        if self._room:
            await self._room.local_participant.publish_data(
                json.dumps(payload).encode(),
                reliable=True,
            )

    @function_tool
    async def update_lead_field(
        self,
        field: Annotated[str, "One of: name, company, problem, timeline, budget"],
        value: Annotated[
            str,
            "The value captured from the visitor's words. "
            "Use the corrected value if the visitor updates a prior answer.",
        ],
    ) -> str:
        """
        Call this immediately whenever you capture or update any discovery field value.
        Also call this when the visitor corrects a field they gave earlier.
        """
        if field in self._lead:
            self._lead[field] = value
            await self._publish_ui({"type": "lead_update", "field": field, "value": value})
        return f"Captured {field}: {value}"

    @function_tool
    async def show_visual_card(
        self,
        card_type: Annotated[
            str,
            "One of: services, process, pricing, team, case_studies, summary",
        ],
    ) -> str:
        """
        Call this when the visitor asks about a Maneuver topic (services, process,
        pricing, team, case studies) to display the relevant context card on screen.
        """
        await self._publish_ui({"type": "show_card", "card": card_type})
        return f"Showing {card_type} card"

    @function_tool
    async def save_lead(
        self,
        name: Annotated[str, "Visitor's first name"],
        company: Annotated[str, "Their company or project name"],
        problem: Annotated[str, "The core problem they are solving"],
        timeline: Annotated[str, "Their target timeline"],
        budget: Annotated[str, "Their budget range"],
    ) -> str:
        """
        Call this when all five discovery fields are captured.
        Saves the lead record to disk and triggers the summary card on screen.
        """
        lead = {
            "name": name,
            "company": company,
            "problem": problem,
            "timeline": timeline,
            "budget": budget,
            "captured_at": datetime.utcnow().isoformat() + "Z",
        }

        leads: list = []
        if LEADS_PATH.exists():
            try:
                leads = json.loads(LEADS_PATH.read_text("utf-8"))
            except Exception:
                leads = []
        leads.append(lead)
        LEADS_PATH.write_text(json.dumps(leads, indent=2), "utf-8")

        await self._publish_ui({"type": "show_card", "card": "summary"})
        return "Lead saved"


async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    agent = ManeuverFounderAgent()
    agent._room = ctx.room
    session = AgentSession()
    await session.start(room=ctx.room, agent=agent)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
