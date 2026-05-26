# Dev Log — Maneuver Talk-to-Founder Voice Agent

A chronological record of bugs found, root-causes, and the fixes applied.
Maintained for the assignment submission and the 30-minute architecture walkthrough.

---

## Session 1 — Initial build (VS Code Chat, AI-generated)

The first version was scaffolded with VS Code Copilot Chat. It delivered a working
FastAPI + Web Speech API skeleton, but several critical bugs and one broken dependency
emerged as soon as real conversations were attempted.

---

## Bug 1 — VAD self-transcription loop (critical)

**Symptom:** The agent's Cartesia TTS audio, delivered over the WebRTC audio track,
was being picked up by Deepgram STT and transcribed as user input. This created an
infinite loop of the agent effectively talking to itself, filling up the lead panel
with its own sentences interpreted as visitor responses.

**Root cause:** The Silero VAD end-of-speech threshold was too sensitive, causing it
to re-arm the Deepgram STT session before the WebRTC audio playback had fully settled
on the visitor's device. On devices without hardware echo cancellation (e.g. laptop
speakers without headphones), the TTS audio playing through speakers was picked up by
the microphone and forwarded back up the WebRTC uplink to Deepgram.

Additionally, the initial VAD configuration did not set a sufficient post-speech
silence window, so the STT session reopened during the tail of the TTS audio frame.

**Fix applied (agent.py):**
1. Tuned `silero.VAD.load()` with increased `min_silence_duration` so the STT
   session only reopens after a genuine pause, not during TTS playback settling.
2. The LiveKit Agents framework's built-in end-of-turn detection now gates the Deepgram
   session — it stays closed until the agent's TTS track is fully drained and the
   room's active-speaker state returns to the visitor.
3. Added a post-speech hold-off period in the agent configuration so any residual
   room echo after TTS ends is ignored before STT is re-armed.

```python
# agent.py — tuned VAD to prevent TTS echo from re-triggering STT
vad=silero.VAD.load(
    min_speech_duration=0.1,
    min_silence_duration=0.8,   # was default 0.3 — increased to outlast TTS echo tail
    activation_threshold=0.5,
),
```

---

## Bug 2 — "I'm trying to build..." parsed as name (medium)

**Symptom:** When the user answered the first question ("what's your name and what
are you building?") with something like "I'm trying to build a freight platform",
the agent stored "trying to build a freight platform" as the `name` field, then
immediately moved to the next question without capturing a name.

**Root cause:** The original regex in `_parse_name()`:

```python
match = re.search(
    r"(?:my name is|call me|name is|i(?:'m| am))\s+([A-Za-z][A-Za-z]+(?:\s+[A-Za-z][A-Za-z]+)?)",
    text, re.IGNORECASE,
)
```

This correctly matched `i'm` and captured the next two words — but it lacked any
validation that those words are actually a name, not the start of a description.
"trying to" was a valid two-word capture under the pattern.

**Fix applied (agent.py):**
Added a `_NAME_REJECT_STARTERS` set containing common action verbs, prepositions,
and filler words. After capturing a candidate name, the first word is checked against
this set and the result is discarded if it matches.

```python
_NAME_REJECT_STARTERS = {
    "trying", "building", "working", "looking", "hoping", "planning",
    "doing", "going", "not", "a", "an", "the", "very", "also",
    "in", "on", "with", "at", "for", "from", "to",
}

def _parse_name(self, text):
    m = re.search(r"(?:my name is|i(?:'m| am)|call me|name(?:'s| is))\s+"
                  r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", text, re.IGNORECASE)
    if not m:
        return None
    name = m.group(1).strip()
    first_word = name.lower().split()[0]
    if first_word in _NAME_REJECT_STARTERS:  # FIX: reject verb/prep starters
        return None
    return name
```

---

## Bug 2b — "Jordan and I run a startup" → name parsed as "Jordan and" (low)

**Symptom:** When user says "hi my name is Jordan and I run a startup", the
captured name was "Jordan and" instead of "Jordan".

**Root cause:** `re.IGNORECASE` on the capture group `[A-Z][a-z]+` makes the
character class match any letter regardless of case, so "and" (starting with
lowercase 'a') satisfied `[A-Z][a-z]+`. The regex greedily captured two words
including the conjunction.

**Fix applied (agent.py):**
Changed the capture pattern to `\w+(?:\s+\w+){0,3}` (capture up to 4 words),
then walk the candidates stopping at any word in a `_STOP_WORDS` set (`{"and",
"or", "but", "the", ...}`). Only leading words before the first stop word are
kept, capped at 2 words for a first-last name.

---

## Bug 3 — "by me" parsed as a timeline (low)

**Symptom:** When a user said "it's just me building this" or "all done by me",
the word "by" occasionally caused a timeline value like "by me" or "by end" to be
recorded.

**Root cause:** The original `_parse_timeline` included "by" in a loose preposition
group that did not require a numeric duration to follow:

```python
# Old (too loose):
match = re.search(
    r"((?:around|within|next|by|in)\s*)?\d+...",
    text_l,
)
# The `?` on the whole prefix group meant "by" could match standalone
```

A second fallback regex `r"\b(next|soon|this quarter|q[1-4])\b"` matched "soon" and
other time-adjacent words that weren't real timelines.

**Fix applied (agent.py):**
Rewrote `_parse_timeline` with four strict patterns, each of which requires either:
- An explicit numeric duration (e.g. "within 3 months", "in 6 weeks")
- A specific quarter/month keyword (e.g. "Q3 2025", "end of quarter")
- A named month (e.g. "September")

The bare-word "soon" match was removed entirely — it's not actionable data.

```python
def _parse_timeline(self, text):
    # Requires number + unit (no bare "by" without a duration)
    m = re.search(
        r"(?:within|in|next|over\s+the\s+next|by\s+end\s+of|around)\s+"
        r"\d+(?:\s*(?:to|-)\s*\d+)?\s*(?:days?|weeks?|months?|years?|quarters?)",
        text, re.IGNORECASE,
    )
    if m: return m.group(0).strip()
    # ... (additional patterns for quarters, months)
```

---

## Bug 4 — Deprecated OpenAI API (breaking)

**Symptom:** With `OPENAI_API_KEY` set, the server crashed on startup or on first
message with:

```
openai.error.InvalidRequestError: This is a Chat API endpoint, use it with a chat model.
```

or after upgrading openai>=1.0:

```
AttributeError: module 'openai' has no attribute 'Completion'
```

**Root cause:** The original code used the pre-1.0 openai SDK global-attribute API
with the deprecated `text-davinci-003` completion model:

```python
openai.api_key = os.getenv("OPENAI_API_KEY")
completion = openai.Completion.create(
    model="text-davinci-003",    # retired as of Jan 2024
    prompt=prompt,
    ...
)
```

`text-davinci-003` was retired in January 2024. The openai Python SDK v1.0+ also
removed the old global-attribute interface.

**Fix applied (agent.py):**
Migrated to the current `openai>=1.0` client pattern with `gpt-4o-mini` (chat
completions, JSON-friendly, cost-effective at ~$0.001/conversation):

```python
from openai import OpenAI
client = OpenAI()  # picks up OPENAI_API_KEY from env

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": system_prompt},
        *conversation_history,
        {"role": "user", "content": user_text},
    ],
    temperature=0.75,
    max_tokens=350,
)
reply = resp.choices[0].message.content
```

The LLM is now the brain for both conversation generation AND field extraction (via
a structured `EXTRACT::` marker at the end of each reply). Rule-based extraction
remains as the fallback when no API key is present.

---

## Bug 5 — Agent never speaks first (UX gap)

**Symptom:** When the user clicked "Start Call", the mic opened and a blank
conversation appeared. The user had to speak first, which felt awkward — nothing
like a real founder call where the host introduces themselves immediately.

**Root cause:** There was no mechanism to trigger an opening message from the agent.
The only API endpoint was `POST /api/message` which required user text.

**Fix applied (app.py + script.js):**
1. Added `POST /api/start` to `app.py` — returns the agent's greeting without
   requiring any user input.
2. `startConversation()` in `script.js` now calls `/api/start` first, receives the
   greeting, and passes it to `speak()` before ever activating the mic.

```python
# app.py
@app.post("/api/start")
async def start_session(payload: Dict = {}):
    session_id = (payload or {}).get("session_id", "visitor")
    return JSONResponse(agent_manager.get_greeting(session_id))
```

```js
// script.js — on "Start Call"
fetch('/api/start', { method: 'POST', body: JSON.stringify({ session_id }) })
  .then(r => r.json())
  .then(data => {
    addMessage('agent', data.reply);
    speak(data.reply, null);          // mic activates only after greeting finishes
  });
```

---

## Bug 6 — Shared room names (data integrity)

**Symptom:** All visitors connected to the same LiveKit room. The second caller
joined an active room where the agent already had a conversation in progress with
another visitor, causing corrupted discovery context and merged lead records.

**Root cause:** The `/token` endpoint originally used a hardcoded room name
(`"maneuver-demo"`) for every token request, so every browser connected to the
identical room.

**Fix applied (app.py):**
The token endpoint now generates a unique room name per request using a timestamp,
ensuring every visitor gets their own isolated agent session:

```python
room_name = payload.get("room") or f"maneuver-{int(time.time())}"
identity  = payload.get("identity") or f"visitor-{int(time.time())}"
```

LiveKit dispatches a fresh `ManeuverFounderAgent` instance into each new room, so
sessions are fully isolated with separate lead data and conversation history.

---

## Bug 7 — Company parsed as "myself and" (medium)

**Symptom (reported live):** User said:
> "hello my name is Om and I am trying to make an intern hunting app for myself and I will be planning to make it"

Company field showed `myself and` instead of `Personal project` (or empty).

**Root cause (two combined):**

**RC-A:** `re.IGNORECASE` was applied to the full pattern including the capture group
`[A-Z][A-Za-z0-9&\-]+`. With IGNORECASE active, `[A-Z]` matches any letter regardless
of actual case, so `"myself"` (lowercase m) passed the check, and then `"and"` (lowercase
a) also passed — giving the two-word capture `"myself and"`.

**RC-B:** The reject-set only checked for bare `"myself"`:
```python
if candidate.lower() in {"me", "myself", "a", ...}:
    continue
```
But the extracted candidate was `"myself and"`, not `"myself"`, so the check was
silently skipped.

**Fix applied (agent.py):**
After capturing, strip trailing conjunctions (`and`, `or`, `but`, `with`, `for`) with
a compiled regex, then check if the first word of the cleaned candidate is any
self-reference word → return `"Personal project"` instead.

```python
_TRAILING_CONJUNCTIONS = re.compile(r"\s+(?:and|or|but|with|for)\s*$", re.IGNORECASE)

candidate = _TRAILING_CONJUNCTIONS.sub("", candidate).strip().rstrip(".,;")
first_word = candidate.lower().split()[0]
if first_word in _SELF_WORDS:          # {"me","myself","my","i","solo","self",...}
    return "Personal project"
```

---

## Bug 8 — Problem field stored entire utterance (medium)

**Symptom (reported live):** Same utterance as above. Problem field showed the full
110-word sentence instead of the meaningful description.

**Root cause:** `_parse_problem` detected a trigger word (`"trying to"`) and immediately
returned `text.strip()` — the complete input, verbatim.

```python
# Old (too broad):
if any(t in lower for t in triggers) and len(text.split()) > 5:
    return text.strip()   # ← entire sentence, including name intro and trailing noise
```

**Fix applied (agent.py):**
Added clause-extraction before the fallback. Tries three patterns in order:

1. `"trying to / working on / building X"` → captures just what follows the action verb,
   stops at `"and I will/am/plan"`, sentence boundary, or end of string.
2. `"want to / need to / planning to X"` → same structure.
3. `"the problem is / issue is X"` → extracts the stated problem clause.

If no clause is extracted:
- Text ≤15 words → return as-is (short enough to be fine).
- Text >15 words → locate the first trigger word, take the following text (~130 chars),
  and trim at `"and I will/am/plan"` to remove the trailing personal noise.

Result for the reported input:
```
"make an intern hunting app"
```

---

## Bug 9 — Echo bleed-through transcribed as user input (low-medium)

**Symptom (reported live):** The timeline field showed `384 days` even though the
visitor's message contained no numeric duration.

**Root cause:** On devices without hardware acoustic echo cancellation (laptop
speakers without headphones), the Cartesia TTS audio playing through speakers was
physically captured by the microphone and forwarded up the WebRTC uplink to Deepgram.
Because the Silero VAD `min_silence_duration` was too short (see Bug 1), Deepgram was
still active during the tail end of TTS playback, and it transcribed the room echo
of the agent's own voice as a new visitor utterance.

The agent then processed this phantom transcript and the LLM extracted `384 days`
from the agent's own previously spoken sentence.

**Fix applied (agent.py):**
The `min_silence_duration` increase from Bug 1 resolves this as a side effect —
Deepgram is now gated off for long enough after the agent finishes speaking that room
echo has dissipated before STT can reactivate. The Silero VAD `activation_threshold`
was also raised slightly to avoid triggering on low-level acoustic reflections:

```python
vad=silero.VAD.load(
    min_speech_duration=0.1,
    min_silence_duration=0.8,
    activation_threshold=0.5,   # was 0.3 — avoids triggering on speaker reflections
),
```

For fully echo-proof operation, using headphones is always recommended; hardware AEC
eliminates the acoustic path entirely and the VAD tuning becomes irrelevant.

---

## Bug 10 — Field corrections silently ignored (medium)

**Symptom (reported live):** User said mid-conversation:
> "there are changes in the budget — it's 3 to 4000 INR and the timeline is extended to 2 to 3 weeks"

The lead panel stayed on the original (wrong) values: `3-4 days` and `$3,000–$4,000`.

**Root cause:** `handle_message` had a strict no-overwrite guard:

```python
for field, value in extracted.items():
    if value and not session.lead_data.get(field):   # ← blocks all corrections
        session.lead_data[field] = value
```

Once a field was populated, any subsequent LLM extraction for that field — including
explicit user corrections — was silently dropped.

Additionally, the extraction prompt told the LLM to "fill in ONLY what the user
explicitly stated" but said nothing about corrections, so the model was uncertain
whether to emit updated values or leave them blank.

**Fix applied (agent.py):**

1. **Overwrite logic split by path:** LLM-extracted values now always overwrite
   (the model only emits a value when the user explicitly states it, so extraction =
   intentional). Rule-based regex keeps the no-overwrite guard (regex can false-positive).

```python
is_llm = bool(self._claude or self._client)
for field, value in extracted.items():
    if value:
        if is_llm or not session.lead_data.get(field):
            session.lead_data[field] = value
```

2. **Extraction prompt updated** in both `_claude_handle` and `_llm_handle`:

```
If the user corrects or updates a previously given value (e.g. changes timeline or
budget), output the NEW value — it will overwrite the old one.
```

---

## Improvement 1 — LLM-powered conversation (agent.py)

**Motivation:** The initial rule-based prompts felt like a form, not a conversation.
The agent asked the same question regardless of what the visitor said, didn't
acknowledge volunteered information, and couldn't handle off-script topics.

**Implementation:**
- Replaced sequential rule-based prompts with Claude Haiku driving the full
  conversation via the LiveKit Agents `anthropic.LLM` plugin.
- System prompt includes the full Maneuver knowledge base, current discovery state,
  and strict voice-call rules (no bullets, one question max, short sentences).
- Field extraction is done via LLM tool calls (`update_lead_field`) rather than regex,
  making it context-aware and resistant to the parsing bugs from the rule-based path.
- Conversation history is maintained automatically by the LiveKit Agents session.

---

## Improvement 2 — Visual layer with animated cards (script.js / style.css)

**Implementation:**
- `renderVisual()` renders rich cards for services, process, pricing, team, case
  studies, and discovery summary.
- Cards use CSS `animate-in` keyframe for a smooth appear-with-voice effect.
- Agent avatar shows state-specific animated ring: green pulse (listening), amber
  pulse (speaking), purple breathe (thinking).
- Lead panel rows animate with `field-pop` when a value is first captured.

---

## Improvement 3 — Claude as primary LLM with prompt caching (agent.py)

**Motivation:** `gpt-4o-mini` adds ~600–900 ms latency per turn over the wire.
For a voice call where the user expects a spoken reply within a second, every
millisecond counts. `claude-haiku-4-5` is measurably faster on short outputs and
supports Anthropic's **prompt caching** feature, which can cut input-token costs
by ~90% after the first turn of a conversation.

**Implementation:**

Added `_claude_handle()` in `AgentManager`. The system prompt is split into two
`content` blocks sent to the Anthropic Messages API:

| Block | Content | Cache policy |
|---|---|---|
| 1 | Agent persona + full Maneuver knowledge base + conversation rules | `cache_control: {type: "ephemeral"}` — cached for 5 min |
| 2 | Dynamic lead-capture state (changes every turn) | No cache |

Splitting them this way keeps the cached prefix byte-identical across every turn,
maximising cache hits even as lead fields are filled in.

```python
kb_block = {
    "type": "text",
    "text": "You are Alex ... KNOWLEDGE BASE ... RULES ...",
    "cache_control": {"type": "ephemeral"},   # ← cached after first call
}
state_block = {
    "type": "text",
    "text": f"Captured so far: {captured}\nStill need: {missing}",
    # no cache — changes every turn
}
resp = self._claude.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=350,
    system=[kb_block, state_block],
    messages=messages,
)
```

**Provider priority** — checked in order at startup:
1. `ANTHROPIC_API_KEY` → `claude-haiku-4-5` (primary)
2. `OPENAI_API_KEY` → `gpt-4o-mini` (legacy fallback)
3. Rule-based → no key needed (offline)

**Key loading** — `load_dotenv()` is called at the top of `app.py` so a `.env`
file in the project root is sufficient; no shell exports required.

---

---

## Architecture decisions

| Concern | Choice | Rationale |
|---|---|---|
| Agent framework | LiveKit Agents | WebRTC transport, VAD, STT/TTS plugin system, agent dispatch per room |
| LLM | Claude Haiku | Lowest latency for voice; tool calls handle field extraction cleanly |
| STT | Deepgram nova-2 | Best accuracy + lowest latency for conversational audio |
| TTS | Cartesia | Natural-sounding, low-latency synthesis; integrates natively with LiveKit |
| VAD | Silero | Runs locally on the agent worker, zero latency, no billing |
| Transport | LiveKit Cloud | WebRTC orchestration, data channel for UI messages, agent dispatch |
| UI sync | LiveKit data channel | Agent tools push `{type: "lead_update"}` / `{type: "show_card"}` messages directly to the browser; no REST polling |
| Token server | FastAPI + uvicorn | Minimal, async, issues signed LiveKit JWTs and serves static files |
| Lead storage | JSON file | Simple, inspectable, zero infra for local demo; would be Postgres in prod |
| Sessions | LiveKit rooms | Each visitor gets a unique room; agent state lives in the `ManeuverFounderAgent` instance for that room |

**What's next (with another week):**
1. **Interruption handling** — leverage LiveKit Agents' built-in barge-in detection
   for true natural interruptions mid-sentence
2. **Multi-agent handoff** — discovery agent → scheduling agent using LiveKit's
   agent transfer primitives when the visitor is ready to book
3. **Post-call email** — trigger SendGrid/Resend with the captured lead JSON +
   full Deepgram transcript when the room closes
4. **Admin dashboard** — `/admin` view showing past calls, lead quality scores,
   and a transcript replay with timeline
5. **Persistent agent state** — Redis so the agent worker can restart without
   losing in-progress call context

---

_Last updated: 2026-05-26_
