# Talk to Founder — Voice AI Agent for Maneuver

A real-time voice AI web app built on **LiveKit Agents** that lets any visitor have
a live voice conversation with an AI agent representing Maneuver's founder.

The agent runs a natural discovery call (captures name, company, problem, timeline,
budget) and answers questions about Maneuver from a knowledge base — with a
synchronized visual layer that reacts to the conversation in real time.

---

## Architecture

```
Browser ──── WebRTC (LiveKit JS SDK v2) ────► LiveKit Cloud
                                                    │
                                           livekit-agents (Python)
                                                    │
                                       ┌────────────┴────────────┐
                                      STT                       TTS
                                 (Deepgram nova-2)         (Cartesia)
                                       └────────────┬────────────┘
                                                   LLM
                                            (Claude Haiku)
                                                    │
                                          Agent logic + tools
                                   (discovery + Q&A + lead capture)
```

- **STT** — Deepgram nova-2 transcribes visitor audio server-side
- **LLM** — Claude Haiku generates replies and calls tools to extract lead fields
- **TTS** — Cartesia synthesises speech; audio is delivered back over WebRTC
- **VAD** — Silero handles voice activity detection locally on the agent
- **UI sync** — the agent pushes JSON over the LiveKit data channel to update
  the lead panel and visual cards in real time

---

## How to run locally

### Prerequisites

- Python 3.10+
- A modern browser (Chrome or Edge recommended)
- Free accounts at:
  - [LiveKit Cloud](https://livekit.io) — WebRTC + agent orchestration
  - [Deepgram](https://console.deepgram.com) — STT
  - [Cartesia](https://play.cartesia.ai) — TTS
  - [Anthropic](https://console.anthropic.com) — LLM

### Setup

```bash
# 1. Create and activate virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Fill in credentials
cp .env.example .env
# Edit .env with your LiveKit, Deepgram, Cartesia, and Anthropic keys

# 4. Start the token server (serves UI + issues LiveKit room tokens)
python app.py

# 5. In a second terminal, start the LiveKit agent worker
python agent.py dev
```

Open **http://localhost:8000** in Chrome or Edge, allow mic access, and click
**Start Call**.

### .env file

```
# LiveKit (sign up free at https://livekit.io)
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxx
LIVEKIT_API_SECRET=your-secret-here

# Anthropic — Claude Haiku LLM
ANTHROPIC_API_KEY=sk-ant-...

# Deepgram — STT
DEEPGRAM_API_KEY=...

# Cartesia — TTS
CARTESIA_API_KEY=...
```

---

## What is included

| File | Purpose |
|---|---|
| `agent.py` | LiveKit Agents worker — Silero VAD + Deepgram STT + Claude Haiku + Cartesia TTS |
| `app.py` | FastAPI server — serves UI, issues LiveKit room tokens, stores leads |
| `static/index.html` | App shell — avatar, conversation pane, visual panel, lead panel |
| `static/script.js` | LiveKit JS client — room connection, audio, transcription, data messages |
| `static/style.css` | Dark design system, animated avatar rings, visual cards |
| `knowledge_base.md` | Maneuver knowledge — services, process, pricing, team, case studies |
| `captured_leads.json` | Auto-created when a discovery call completes; append-only |
| `DEVLOG.md` | Chronological bug log with root causes and fixes |

---

## How the conversation works

1. Visitor clicks **Start Call** — browser gets a LiveKit room token from `/token`
2. LiveKit Agents dispatches the `ManeuverFounderAgent` into the room
3. Agent greets first via Cartesia TTS delivered over WebRTC
4. Visitor speaks → Deepgram STT transcribes → Claude Haiku generates a reply
5. When the agent captures a field, it calls `update_lead_field()` — a tool that
   pushes `{type: "lead_update"}` over the LiveKit data channel; the browser updates
   the right-hand panel instantly
6. When the visitor asks about Maneuver, the agent calls `show_visual_card()` — a
   context card slides into the visual panel
7. When all five fields are captured, the agent calls `save_lead()` — lead is written
   to `captured_leads.json` and a summary card appears

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Serve the app |
| `POST /token` | Issue a LiveKit JWT so the browser can join the voice room |
| `GET /api/leads` | Return all captured lead records |

---

## Models and providers

| Layer | Provider | Model / Service | Why |
|---|---|---|---|
| LLM | Anthropic | `claude-haiku-4-5` | Lowest latency for voice; tool calls handle field extraction cleanly |
| STT | Deepgram | nova-2-general | Best accuracy + lowest latency for conversational audio |
| TTS | Cartesia | default voice | Natural-sounding, low-latency synthesis |
| VAD | Silero | bundled with livekit-plugins-silero | Runs locally, zero latency, no billing |
| Transport | LiveKit | LiveKit Cloud | WebRTC orchestration, data channel, agent dispatch |

---

## Visual layer (synchronized)

While the agent speaks, the right panel reacts:

| Trigger | Visual |
|---|---|
| Agent asks about services | Services card with offering list |
| Agent asks about process | Step-by-step process card |
| Agent answers pricing questions | Engagement model card with timelines |
| Agent talks about the team | Team card |
| Agent references past work | Case studies card |
| Discovery field captured | Lead panel row animates green |
| All fields captured | Summary card + lead saved to disk |

The agent avatar shows a real-time state ring:
- 🟢 **Green pulse** — listening
- 🟡 **Amber pulse** — speaking
- 🟣 **Purple breathe** — thinking

---

## Captured discovery output (example)

```json
[
  {
    "name": "Sarah",
    "company": "GreenFleet",
    "problem": "help fleet managers track EV charging costs and carbon offsets in one place",
    "timeline": "3 months",
    "budget": "$50k",
    "captured_at": "2026-05-26T10:22:14Z"
  }
]
```

---

## Bugs fixed (summary)

See `DEVLOG.md` for root causes and full diffs.

| # | Bug | Impact |
|---|---|---|
| 1 | **VAD self-transcription** — Cartesia TTS audio picked up by Deepgram STT | Critical: agent transcribed its own speech as user input |
| 2 | **Name parser false positive** — "I'm trying to build..." stored as name | Medium: wrong lead data |
| 2b | **Name includes conjunction** — "Jordan and I run..." stored as "Jordan and" | Medium: wrong lead data |
| 3 | **Timeline parser false positive** — "by me" matched as timeline | Low: wrong lead data |
| 4 | **Deprecated OpenAI API** — `text-davinci-003` retired, old SDK interface | Breaking: agent crash |
| 5 | **No agent greeting** — visitor had to speak first | UX: awkward opening |
| 6 | **Shared room names** — all visitors landed in the same room | Data: lead data corruption between callers |
| 7 | **Company "myself and"** — "for myself and I will..." → wrong company | Medium: wrong lead data |
| 8 | **Problem = entire utterance** — long sentence stored verbatim | Medium: messy lead data |
| 9 | **Echo bleed-through** — Cartesia TTS echo transcribed after end-of-speech | Low-medium: phantom field values |
| 10 | **Field corrections ignored** — user saying "actually the budget is X" didn't update | Medium: stale lead data |

---

## What I'd build next (with another week)

1. **Interruption handling** — true barge-in using LiveKit's built-in interruption
   detection so the visitor can cut the agent off mid-sentence naturally
2. **Multi-agent handoff** — discovery agent → scheduling agent when the visitor is
   ready to book a follow-up call, using LiveKit's agent transfer primitives
3. **Post-call email** — trigger a SendGrid/Resend email to the team with the
   captured lead JSON + full transcript when the room closes
4. **Founder dashboard** — `/admin` view showing all past calls, lead quality scores,
   and a transcript replay with timeline
5. **Persistent sessions** — Redis for agent state so the worker can restart without
   losing active call context
