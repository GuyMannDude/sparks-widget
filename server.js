import express from "express";
import cors from "cors";
import { readFileSync, existsSync, rmSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const PORT = 50095;
// Direct to OpenRouter. The customer-facing chat path must not share a
// router or model toggle with anything else (2026-07-07: the 8100 proxy's
// stored key died and Peter silently 401'd on every chat).
const LLM_URL = "https://openrouter.ai/api/v1/chat/completions";
const MNEMO_URL = "http://127.0.0.1:50002";
const AGENT_ID = "peter-widget";
// grok-4-fast was deprecated by xAI (404 as of 2026-07-07); grok-4.3 is
// its recommended successor ($1.25/$2.50 per 1M — same class).
const MODEL = "x-ai/grok-4.3";
const KNOWLEDGE_DIR = join(process.env.HOME, "peter-customer", "knowledge");
const MNEMO_DATA_DIR = join(process.env.HOME, ".agentb-portal", "agents");

// Read the OpenRouter key per request so a key rotation takes effect
// without a service restart (the file is tiny; widget traffic is low).
const KEYS_PATH = join(process.env.HOME, ".rockys-switch", "keys.json");
function loadApiKey() {
  return JSON.parse(readFileSync(KEYS_PATH, "utf8")).openrouter;
}
loadApiKey(); // fail loud at startup if the keys file is missing/broken

// Load product knowledge from file
let productKnowledge = "";
try {
  productKnowledge = readFileSync(join(KNOWLEDGE_DIR, "products.md"), "utf8");
  console.log(`Loaded product knowledge: ${productKnowledge.length} chars`);
} catch (e) {
  console.error("WARNING: Could not load products.md:", e.message);
  productKnowledge = "No product knowledge loaded. Tell visitors to check projectsparks.ai for details.";
}

const SYSTEM_PROMPT = `You are Peter, a cheerful cartoon lobster who is the mascot and resident expert for Project Sparks. You help visitors learn about Project Sparks products and tools.

Your personality: friendly, enthusiastic, a little quirky. You love helping people. You speak casually but knowledgeably. Keep answers concise — 2-3 sentences max unless the visitor asks for detail.

PRODUCT KNOWLEDGE:
${productKnowledge}

IMPORTANT RULES:
- Products marked "(Retired)" are NOT available. Do not list, recommend, or mention them to visitors.
- If a visitor asks about a retired product, say it's no longer available and suggest current alternatives.
- If the visitor corrects you, accept the correction gracefully. Say something like "Good catch! Let me fix that." Never repeat the same wrong answer.
- If you don't know something, say: "That's a great question — I don't have that answer yet. Email rocky@projectsparks.ai for a quicker answer, or check back and I might have it next time!"
- Never make up product features or capabilities
- Never discuss pricing, payments, or business details you don't know
- Never mention internal server names, hostnames, ports, file paths, or infrastructure details
- Keep it fun and friendly`;

const app = express();
app.use(cors());
app.use(express.json());

// Serve the widget JS
app.get("/rocky-widget.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  // No caching — we want the widget to pick up edits on every page load
  // without users needing to hard-refresh.
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(join(__dirname, "rocky-widget.js"));
});

// Serve Rocky icon
app.get("/rocky-icon.svg", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.sendFile(join(__dirname, "rocky-icon.svg"));
});

// --- Mnemo helpers ---
async function mnemoRecall(visitorId, prompt = "previous conversation visitor name") {
  // The prompt is semantic — Mnemo finds chunks whose content is semantically
  // near it. Pass the user's actual question for context-relevant recall;
  // fall back to a broad name/conversation prompt when no question is known.
  try {
    const res = await fetch(`${MNEMO_URL}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, agent_id: `${AGENT_ID}-${visitorId}`, max_results: 5 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.chunks?.length ? data.chunks.map((c) => c.content).join("\n") : null;
  } catch {
    return null;
  }
}

async function mnemoSave(visitorId, summary, keyFacts, retries = 2) {
  const payload = {
    session_id: `widget-${visitorId}-${Date.now()}`,
    summary,
    key_facts: keyFacts,
    projects_referenced: [],
    decisions_made: [],
    agent_id: `${AGENT_ID}-${visitorId}`,
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${MNEMO_URL}/writeback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      console.error(`[mnemo-save] Attempt ${attempt + 1} failed: HTTP ${res.status}`);
    } catch (err) {
      console.error(`[mnemo-save] Attempt ${attempt + 1} failed: ${err.message}`);
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  console.error(`[mnemo-save] All ${retries + 1} attempts failed for visitor ${visitorId}`);
}

// --- Chat log ---
// Writes a JSONL line per exchange to ~/peter-customer/logs/chat-YYYY-MM-DD.log
// so edit/test cycles have a real trail. Failures here never break the request.
const CHAT_LOG_DIR = join(process.env.HOME, "peter-customer", "logs");
try { mkdirSync(CHAT_LOG_DIR, { recursive: true }); } catch {}

function logChat(entry) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const path = join(CHAT_LOG_DIR, `chat-${today}.log`);
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`[chatlog] failed: ${err.message}`);
  }
}

// --- Chat endpoint ---
app.post("/api/chat", async (req, res) => {
  const { messages, visitor_id } = req.body;
  if (!messages?.length) return res.status(400).json({ error: "messages required" });

  const ts = new Date().toISOString();
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "(no user message)";
  const memoryOn = Boolean(visitor_id);

  // Build context with Mnemo memory if available. Recall is semantic, so we
  // pass the visitor's most recent message as the prompt — that pulls
  // chunks relevant to what they're actually asking right now, instead of
  // the old fixed "visitor profile" string that matched nothing.
  let memoryContext = "";
  let recalledMemoryPreview = null;
  if (visitor_id) {
    const memory = await mnemoRecall(visitor_id, lastUser);
    if (memory) {
      memoryContext = `\n\nYou have some background on this visitor from previous conversations:\n${memory}\n\nUse this context naturally but do NOT re-introduce yourself or greet them again — the greeting already happened.`;
      recalledMemoryPreview = memory.slice(0, 500);
    }
  }

  const systemMsg = { role: "system", content: SYSTEM_PROMPT + memoryContext };

  try {
    const llmRes = await fetch(LLM_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${loadApiKey()}`,
        "Content-Type": "application/json",
        "X-Sparks-Agent": "Peter",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [systemMsg, ...messages],
        max_tokens: 512,
        temperature: 0.7,
      }),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text();
      console.error(`[chat] LLM error ${llmRes.status}: ${errText}`);
      logChat({ ts, kind: "error", visitor_id: visitor_id || null, memory_on: memoryOn, user: lastUser, error: `LLM ${llmRes.status}`, detail: errText.slice(0, 500) });
      return res.json({ reply: "I'm having a little trouble connecting right now. Try again in a moment, or email rocky@projectsparks.ai!" });
    }

    const data = await llmRes.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) {
      console.error("[chat] LLM returned empty content:", JSON.stringify(data).slice(0, 200));
      logChat({ ts, kind: "error", visitor_id: visitor_id || null, memory_on: memoryOn, user: lastUser, error: "empty content" });
      return res.json({ reply: "Hmm, I drew a blank on that one. Could you rephrase?" });
    }

    logChat({
      ts,
      kind: "exchange",
      visitor_id: visitor_id || null,
      memory_on: memoryOn,
      turn_count: messages.length,
      user: lastUser,
      reply,
      recalled_memory_preview: recalledMemoryPreview,
    });

    res.json({ reply });
  } catch (err) {
    console.error(`[chat] Error: ${err.message}`);
    logChat({ ts, kind: "error", visitor_id: visitor_id || null, memory_on: memoryOn, user: lastUser, error: err.message });
    res.json({ reply: "I'm having a little trouble right now. Try again in a moment!" });
  }
});

// --- Save visitor info ---
app.post("/api/save-visitor", async (req, res) => {
  const { visitor_id, first_name, location, conversation_snippet } = req.body;
  if (!visitor_id) return res.status(400).json({ error: "visitor_id required" });

  const facts = [];
  if (first_name) facts.push(`Visitor's first name: ${first_name}`);
  if (location) facts.push(`Visitor is from: ${location}`);
  if (conversation_snippet) facts.push(`Recent conversation:\n${conversation_snippet}`);

  const summary = conversation_snippet
    ? `Conversation snippet saved for visitor ${visitor_id} chatting on projectsparks.ai.`
    : `New visitor${first_name ? ` named ${first_name}` : ""}${location ? ` from ${location}` : ""} started chatting via the widget on projectsparks.ai.`;

  await mnemoSave(visitor_id, summary, facts);
  res.json({ ok: true });
});

// --- Log unanswered question ---
app.post("/api/log-question", async (req, res) => {
  const { visitor_id, question } = req.body;
  if (!question) return res.status(400).json({ error: "question required" });

  await mnemoSave(
    "unanswered",
    `Unanswered question from visitor ${visitor_id || "unknown"}: ${question}`,
    [`Question: ${question}`, `Visitor: ${visitor_id || "unknown"}`, `Time: ${new Date().toISOString()}`]
  );
  res.json({ ok: true });
});

// --- Recall visitor ---
app.get("/api/recall/:visitor_id", async (req, res) => {
  const memory = await mnemoRecall(req.params.visitor_id);
  res.json({ memory });
});

// --- Wipe visitor data ---
app.post("/api/wipe-visitor", async (req, res) => {
  const { visitor_id } = req.body;
  if (!visitor_id) return res.status(400).json({ error: "visitor_id required" });

  const agentDir = join(MNEMO_DATA_DIR, `${AGENT_ID}-${visitor_id}`);

  try {
    if (existsSync(agentDir)) {
      rmSync(agentDir, { recursive: true, force: true });
    }
    console.log(`Wiped visitor ${visitor_id}: directory removed`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Wipe error:", err.message);
    res.status(500).json({ error: "Wipe failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Sparks Widget backend (peter-customer instance) on port ${PORT}`);
});
