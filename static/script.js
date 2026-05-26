/**
 * script.js — Maneuver Talk-to-Founder Frontend (LiveKit Agents)
 *
 * Connects the browser to a LiveKit room where the Maneuver voice agent lives.
 * The agent handles STT (Deepgram nova-2), LLM (Claude Haiku), and
 * TTS (Cartesia) entirely server-side over WebRTC — no browser audio APIs needed.
 *
 * This script manages:
 *   - Room connection + local mic publish
 *   - Remote audio track subscription (agent TTS arrives as a WebRTC audio track)
 *   - Transcription display (LiveKit TranscriptionReceived events)
 *   - Data message handling — lead field updates + visual cards from the agent
 *   - Avatar state ring driven by ActiveSpeakersChanged events
 */

import {
  Room,
  RoomEvent,
  Track,
} from 'https://cdn.jsdelivr.net/npm/livekit-client@2.9.3/+esm';

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const statusBadge = document.getElementById('statusBadge');
const startBtn    = document.getElementById('startBtn');
const stopBtn     = document.getElementById('stopBtn');
const messagesEl  = document.getElementById('messages');
const modeTag     = document.getElementById('modeTag');
const visualArea  = document.getElementById('visualArea');
const agentAvatar = document.getElementById('agentAvatar');
const leadFields  = {
  name:     document.getElementById('field-name'),
  company:  document.getElementById('field-company'),
  problem:  document.getElementById('field-problem'),
  timeline: document.getElementById('field-timeline'),
  budget:   document.getElementById('field-budget'),
};

let room = null;

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(status) {
  const labels = {
    idle:        'Ready',
    connecting:  'Connecting',
    listening:   'Listening',
    speaking:    'Speaking',
    thinking:    'Thinking',
  };
  statusBadge.textContent = labels[status] || status;
  statusBadge.className   = `status ${status}`;

  if (agentAvatar) {
    agentAvatar.className = 'agent-avatar';
    if (status === 'listening') agentAvatar.classList.add('listening');
    if (status === 'speaking')  agentAvatar.classList.add('speaking');
    if (status === 'thinking')  agentAvatar.classList.add('thinking');
  }
}

// ─── Transcript display ───────────────────────────────────────────────────────
// Accumulate consecutive segments from the same speaker into one bubble.
// A new bubble is only created when the speaker changes.

const _lastMsg = { role: null, bodyEl: null };

function addMessage(role, text) {
  if (!text.trim()) return;

  if (_lastMsg.role === role && _lastMsg.bodyEl) {
    // Same speaker — append to existing bubble with a space
    _lastMsg.bodyEl.textContent += ' ' + text.trim();
  } else {
    // Speaker changed (or first message) — create a new bubble
    const el = document.createElement('div');
    el.className = `message ${role}`;

    const label = document.createElement('span');
    label.className   = 'msg-label';
    label.textContent = role === 'user' ? 'You' : 'Alex (Maneuver)';

    const body = document.createElement('p');
    body.textContent = text.trim();

    el.appendChild(label);
    el.appendChild(body);
    messagesEl.appendChild(el);

    _lastMsg.role   = role;
    _lastMsg.bodyEl = body;
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function newTurn() {
  // Call this to force the next message into a fresh bubble (e.g. after agent speaks)
  _lastMsg.role   = null;
  _lastMsg.bodyEl = null;
}

// ─── Lead panel ───────────────────────────────────────────────────────────────

function updateLeadField(field, value) {
  const el = leadFields[field];
  if (!el || !value) return;
  el.textContent = value;
  el.parentElement?.classList.add('filled');
}

// ─── Visual cards ─────────────────────────────────────────────────────────────

function renderCard(cardType) {
  const cards = {
    services: `
      <div class="visual-card animate-in">
        <div class="vc-header">🚀 Services</div>
        <ul>
          <li>Product vision &amp; positioning</li>
          <li>UX and service design</li>
          <li>Low-latency MVP development</li>
          <li>Growth experiments &amp; launch support</li>
        </ul>
      </div>`,

    process: `
      <div class="visual-card animate-in">
        <div class="vc-header">⚙️ How we work</div>
        <ol>
          <li><strong>Discovery &amp; alignment</strong> — align on customer problem</li>
          <li><strong>Prototype &amp; feedback</strong> — working build in 2 weeks</li>
          <li><strong>Iterate &amp; launch</strong> — ship fast, measure outcomes</li>
          <li><strong>Growth &amp; measurement</strong> — retention, acquisition loops</li>
        </ol>
      </div>`,

    pricing: `
      <div class="visual-card animate-in">
        <div class="vc-header">💰 Engagement Models</div>
        <div class="pricing-row"><span>Discovery Sprint</span><span>2 – 4 weeks</span></div>
        <div class="pricing-row"><span>Core Product Build</span><span>8 – 12 weeks</span></div>
        <div class="pricing-row"><span>Growth Retainer</span><span>Monthly</span></div>
        <p class="vc-note">Fixed scope or lightweight retainer — whatever fits your stage.</p>
      </div>`,

    team: `
      <div class="visual-card animate-in">
        <div class="vc-header">👥 Team</div>
        <p>Founder-led product strategy, design, and engineering. I personally lead
           discovery and roadmap — a small, experienced delivery crew handles the build.</p>
      </div>`,

    case_studies: `
      <div class="visual-card animate-in">
        <div class="vc-header">📁 Past Work</div>
        <ul>
          <li>EV charging network customer experience</li>
          <li>Freight visibility dashboard for a logistics startup</li>
          <li>Carbon credits subscription product</li>
        </ul>
      </div>`,

    summary: `
      <div class="visual-card animate-in summary-card">
        <div class="vc-header">✅ Discovery Complete</div>
        <p>All key info captured. The team will review and follow up with a tailored approach.</p>
      </div>`,
  };

  visualArea.innerHTML = cards[cardType] || `
    <div class="visual-card animate-in">
      <div class="vc-header">🌱 About Maneuver</div>
      <p>Boutique product &amp; growth studio for climate and mobility startups.
         We move fast, stay founder-close, and focus on outcomes over deliverables.</p>
    </div>`;

  // Update the mode tag when Q&A cards appear
  if (['services','process','pricing','team','case_studies'].includes(cardType)) {
    modeTag.textContent = 'q&a';
  } else if (cardType === 'summary') {
    modeTag.textContent = 'complete';
  }
}

// ─── Data message handler ─────────────────────────────────────────────────────

function handleDataMessage(payload) {
  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return;
  }

  if (msg.type === 'lead_update') {
    updateLeadField(msg.field, msg.value);
    modeTag.textContent = 'discovery';
  } else if (msg.type === 'show_card') {
    renderCard(msg.card);
  }
}

// ─── Connect / disconnect ─────────────────────────────────────────────────────

async function startConversation() {
  startBtn.disabled = true;
  setStatus('connecting');

  try {
    // 1. Get a room token from the FastAPI token server
    const res = await fetch('/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
    const { token, url } = await res.json();

    // 2. Create the LiveKit room
    room = new Room({ adaptiveStream: true, dynacast: true });

    // Avatar ring: track which participants are actively speaking
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const agentSpeaking = speakers.some(p => !room.localParticipant || p.sid !== room.localParticipant.sid);
      setStatus(agentSpeaking ? 'speaking' : 'listening');
    });

    // Agent TTS arrives as a remote audio track — attach it to the DOM so it plays
    room.on(RoomEvent.TrackSubscribed, (track, _pub, _participant) => {
      if (track.kind === Track.Kind.Audio) {
        const audioEl = track.attach();
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
      }
    });

    // Transcription events — show conversation in the left panel.
    // We accumulate consecutive segments from the same speaker into one bubble.
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      segments.forEach(segment => {
        if (!segment.final) return;
        if (!segment.text?.trim()) return;
        const isAgent = participant && participant.sid !== room.localParticipant?.sid;
        const role = isAgent ? 'agent' : 'user';
        // Force a new bubble whenever the speaker flips
        if (_lastMsg.role && _lastMsg.role !== role) newTurn();
        addMessage(role, segment.text);
      });
    });

    // Data messages from the agent → UI updates
    room.on(RoomEvent.DataReceived, (payload) => handleDataMessage(payload));

    // Clean up when the room disconnects
    room.on(RoomEvent.Disconnected, () => {
      setStatus('idle');
      startBtn.disabled = false;
      stopBtn.disabled  = true;
    });

    // 3. Connect to LiveKit Cloud
    await room.connect(url, token);

    // 4. Enable microphone — LiveKit publishes it and Deepgram STT picks it up server-side
    await room.localParticipant.setMicrophoneEnabled(true);

    stopBtn.disabled = false;
    setStatus('listening');

  } catch (err) {
    console.error('[LiveKit error]', err);
    const msg = err?.message || String(err);
    addMessage('agent', `Could not connect: ${msg}. Check browser console for details.`);
    setStatus('idle');
    startBtn.disabled = false;
  }
}

function stopConversation() {
  if (room) {
    room.disconnect();
    room = null;
  }
  setStatus('idle');
  startBtn.disabled = false;
  stopBtn.disabled  = true;
}

// ─── Event listeners ──────────────────────────────────────────────────────────

startBtn.addEventListener('click', startConversation);
stopBtn.addEventListener('click',  stopConversation);

// ─── Init ─────────────────────────────────────────────────────────────────────

setStatus('idle');
