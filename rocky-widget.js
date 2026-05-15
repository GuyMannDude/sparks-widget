(function () {
  "use strict";

  // --- Config ---
  const API_BASE = window.ROCKY_WIDGET_API || "";
  const ICON_URL = API_BASE + "/rocky-icon.svg";

  // --- Visitor ID (persistent across sessions) ---
  function getVisitorId() {
    let id = localStorage.getItem("rocky_visitor_id");
    if (!id) {
      id = "v_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem("rocky_visitor_id", id);
    }
    return id;
  }

  // --- Memory toggle (persisted to localStorage across sessions) ---
  // Default: OFF. Visitor opts INTO memory, not out of it.
  const MEMORY_KEY = "rocky_widget_memory_on";
  function loadMemoryOn() {
    try { return localStorage.getItem(MEMORY_KEY) === "1"; } catch { return false; }
  }
  function saveMemoryOn(on) {
    try { localStorage.setItem(MEMORY_KEY, on ? "1" : "0"); } catch {}
  }

  // --- State (persisted to sessionStorage for page navigation) ---
  // Bump STATE_VERSION whenever the state shape changes so old sessions
  // get a clean slate instead of crashing on stale fields.
  const STATE_KEY = "rocky_widget_state";
  const STATE_VERSION = 2;
  function loadState() {
    const fresh = { v: STATE_VERSION, messages: [], phase: "idle", open: false };
    try {
      const s = sessionStorage.getItem(STATE_KEY);
      if (!s) return fresh;
      const parsed = JSON.parse(s);
      // Migrate old state: any v<2 used phases like "ask_name"/"ask_location"
      // and stored stale name/location fields. Throw it away.
      if (parsed.v !== STATE_VERSION) return fresh;
      if (parsed.phase === "ask_name" || parsed.phase === "ask_location") return fresh;
      return parsed;
    } catch { return fresh; }
  }
  function saveState(state) {
    try {
      state.v = STATE_VERSION;
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {}
  }

  let state = loadState();
  let memoryOn = loadMemoryOn();
  const visitorId = getVisitorId();

  // --- Styles ---
  const style = document.createElement("style");
  style.textContent = `
    #rocky-widget-bubble {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 64px; height: 64px; border-radius: 50%;
      background: linear-gradient(135deg, #e85040, #c0302a);
      box-shadow: 0 4px 20px rgba(212,168,42,0.4), 0 0 0 3px rgba(212,168,42,0.3);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #rocky-widget-bubble:hover {
      transform: scale(1.1);
      box-shadow: 0 4px 28px rgba(212,168,42,0.6), 0 0 0 4px rgba(212,168,42,0.4);
    }
    #rocky-widget-bubble img { width: 48px; height: 48px; pointer-events: none; }

    #rocky-widget-window {
      position: fixed; bottom: 100px; right: 24px; z-index: 99998;
      width: 380px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 140px);
      background: #0c0c18; border: 1px solid rgba(212,168,42,0.3);
      border-radius: 16px; display: none; flex-direction: column;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(212,168,42,0.15);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      overflow: hidden;
    }
    #rocky-widget-window.open { display: flex; }

    .rw-header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; background: #101020;
      border-bottom: 1px solid rgba(212,168,42,0.2);
    }
    .rw-header img { width: 32px; height: 32px; }
    .rw-header-text { flex: 1; }
    .rw-header-name { color: #d4a82a; font-size: 14px; font-weight: 600; }
    .rw-header-status { color: #9090a0; font-size: 11px; }
    .rw-close {
      background: none; border: none; color: #9090a0; font-size: 20px;
      cursor: pointer; padding: 0 4px; line-height: 1;
    }
    .rw-close:hover { color: #e8e8f0; }

    .rw-messages {
      flex: 1; overflow-y: auto; padding: 16px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .rw-messages::-webkit-scrollbar { width: 4px; }
    .rw-messages::-webkit-scrollbar-track { background: transparent; }
    .rw-messages::-webkit-scrollbar-thumb { background: rgba(212,168,42,0.3); border-radius: 2px; }

    .rw-msg {
      max-width: 85%; padding: 10px 14px; border-radius: 14px;
      font-size: 13px; line-height: 1.5; color: #e8e8f0; word-wrap: break-word;
    }
    .rw-msg.rocky {
      align-self: flex-start; background: #1a1a2e;
      border-bottom-left-radius: 4px;
    }
    .rw-msg.visitor {
      align-self: flex-end; background: #d4a82a; color: #0c0c18;
      border-bottom-right-radius: 4px;
    }
    .rw-msg.typing {
      align-self: flex-start; background: #1a1a2e;
      border-bottom-left-radius: 4px; color: #9090a0; font-style: italic;
    }

    .rw-input-row {
      display: flex; gap: 8px; padding: 12px 16px;
      border-top: 1px solid rgba(212,168,42,0.2); background: #101020;
    }
    .rw-input {
      flex: 1; background: #1a1a2e; border: 1px solid rgba(212,168,42,0.2);
      border-radius: 10px; padding: 10px 14px; color: #e8e8f0; font-size: 13px;
      outline: none; font-family: inherit;
    }
    .rw-input::placeholder { color: #606070; }
    .rw-input:focus { border-color: rgba(212,168,42,0.5); }
    .rw-send {
      background: #d4a82a; border: none; border-radius: 10px;
      padding: 0 16px; color: #0c0c18; font-weight: 600; font-size: 13px;
      cursor: pointer; transition: background 0.2s; white-space: nowrap;
    }
    .rw-send:hover { background: #f0c848; }
    .rw-send:disabled { opacity: 0.5; cursor: not-allowed; }

    .rw-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 16px 10px;
      background: #101020;
    }
    .rw-wipe {
      background: none; border: none; color: #606070; font-size: 11px;
      cursor: pointer; font-family: inherit; padding: 2px 8px;
      transition: color 0.2s;
    }
    .rw-wipe:hover { color: #e85040; }

    /* Memory toggle — segmented control, live Mnemo demo */
    .rw-memory-toggle {
      display: inline-flex; gap: 0; padding: 2px;
      background: #1a1a2e; border: 1px solid rgba(212,168,42,0.2);
      border-radius: 10px; font-size: 10px; font-family: inherit;
    }
    .rw-memory-toggle button {
      background: transparent; border: none; color: #9090a0;
      padding: 4px 10px; border-radius: 8px; cursor: pointer;
      font-size: 10px; font-family: inherit;
      transition: background 0.2s, color 0.2s;
    }
    .rw-memory-toggle button:hover { color: #e8e8f0; }
    .rw-memory-toggle button.active {
      background: #d4a82a; color: #0c0c18; font-weight: 600;
    }

    @media (max-width: 480px) {
      #rocky-widget-window {
        bottom: 0; right: 0; left: 0; width: 100%; max-width: 100%;
        height: calc(100vh - 80px); max-height: calc(100vh - 80px);
        border-radius: 16px 16px 0 0;
      }
      #rocky-widget-bubble { bottom: 16px; right: 16px; width: 56px; height: 56px; }
      #rocky-widget-bubble img { width: 40px; height: 40px; }
    }
  `;
  document.head.appendChild(style);

  // --- DOM ---
  const bubble = document.createElement("div");
  bubble.id = "rocky-widget-bubble";
  bubble.innerHTML = `<img src="${ICON_URL}" alt="Peter">`;

  const win = document.createElement("div");
  win.id = "rocky-widget-window";
  win.innerHTML = `
    <div class="rw-header">
      <img src="${ICON_URL}" alt="Peter">
      <div class="rw-header-text">
        <div class="rw-header-name">Peter</div>
        <div class="rw-header-status">Project Sparks assistant</div>
      </div>
      <button class="rw-close" aria-label="Close">&times;</button>
    </div>
    <div class="rw-messages"></div>
    <div class="rw-input-row">
      <input class="rw-input" type="text" placeholder="Type a message..." autocomplete="off">
      <button class="rw-send">Send</button>
    </div>
    <div class="rw-footer">
      <div class="rw-memory-toggle" role="group" aria-label="Memory mode">
        <button class="rw-mem-off" data-mode="off" title="Stateless — Peter forgets after you close the chat">Quick answers</button>
        <button class="rw-mem-on"  data-mode="on"  title="Conversation is saved to Mnemo Cortex so Peter remembers next visit">Mnemo Cortex</button>
      </div>
      <button class="rw-wipe" title="Clear my saved data">Clear data</button>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  const msgBox = win.querySelector(".rw-messages");
  const input = win.querySelector(".rw-input");
  const sendBtn = win.querySelector(".rw-send");
  const closeBtn = win.querySelector(".rw-close");

  // --- Render ---
  function renderMessages() {
    msgBox.innerHTML = "";
    for (const m of state.messages) {
      const div = document.createElement("div");
      div.className = "rw-msg " + (m.role === "assistant" ? "rocky" : "visitor");
      div.textContent = m.content;
      msgBox.appendChild(div);
    }
    msgBox.scrollTop = msgBox.scrollHeight;
  }

  function addMessage(role, content) {
    state.messages.push({ role, content });
    saveState(state);
    renderMessages();
  }

  function showTyping() {
    const div = document.createElement("div");
    div.className = "rw-msg typing";
    div.id = "rw-typing";
    div.textContent = "Peter is thinking...";
    msgBox.appendChild(div);
    msgBox.scrollTop = msgBox.scrollHeight;
  }
  function hideTyping() {
    const el = document.getElementById("rw-typing");
    if (el) el.remove();
  }

  // --- API calls ---
  async function sendChat() {
    const apiMessages = state.messages.map((m) => ({
      role: m.role === "visitor" ? "user" : "assistant",
      content: m.content,
    }));

    // Only pass visitor_id when memory toggle is ON — that's what enables
    // server-side Mnemo recall and per-visitor save.
    const payload = { messages: apiMessages };
    if (memoryOn) payload.visitor_id = visitorId;

    try {
      const res = await fetch(API_BASE + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      return data.reply;
    } catch {
      return "Oops — my connection hiccupped. Try again in a sec!";
    }
  }

  async function saveConversation() {
    if (!memoryOn) return;
    const recentMsgs = state.messages.slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
    try {
      await fetch(API_BASE + "/api/save-visitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_id: visitorId, conversation_snippet: recentMsgs }),
      });
    } catch {}
  }

  async function checkReturning() {
    try {
      const res = await fetch(API_BASE + "/api/recall/" + visitorId);
      const data = await res.json();
      return data.memory;
    } catch { return null; }
  }


  // --- Open flow ---
  // No identity gate. Visitor asks anything, Peter answers anything.
  // If memory toggle is ON and Mnemo has prior context, warm welcome-back.
  let startingConversation = false;
  async function startConversation() {
    if (state.messages.length > 0 || startingConversation) return;
    startingConversation = true;
    state.phase = "chat";
    saveState(state);

    if (memoryOn) {
      const memory = await checkReturning();
      if (memory) {
        showTyping();
        try {
          const res = await fetch(API_BASE + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [{ role: "user", content: "(Returning visitor opened the chat. Greet them warmly using what you remember. One short sentence.)" }],
              visitor_id: visitorId,
            }),
          });
          hideTyping();
          if (res.ok) {
            const data = await res.json();
            addMessage("assistant", data.reply);
            startingConversation = false;
            return;
          }
        } catch {
          hideTyping();
        }
      }
    }

    addMessage("assistant", "Hey! Ask me anything about Project Sparks.");
    startingConversation = false;
  }

  // --- Send handler ---
  // No phases, no identity parsing. Visitor sends, Peter answers.
  let sending = false;
  let visitorMsgCount = 0;
  async function handleSend() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    input.value = "";

    addMessage("visitor", text);
    visitorMsgCount += 1;

    showTyping();
    const reply = await sendChat();
    hideTyping();
    addMessage("assistant", reply);

    // Periodic save — every 3 visitor messages — only if memory toggle is ON.
    if (visitorMsgCount % 3 === 0) {
      saveConversation();
    }

    sending = false;
    sendBtn.disabled = false;
    input.focus();
  }

  // --- Events ---
  bubble.addEventListener("click", () => {
    state.open = !state.open;
    saveState(state);
    win.classList.toggle("open", state.open);
    if (state.open) {
      startConversation();
      input.focus();
    }
  });

  closeBtn.addEventListener("click", () => {
    state.open = false;
    saveState(state);
    win.classList.remove("open");
  });

  sendBtn.addEventListener("click", handleSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  // --- Wipe handler ---
  const wipeBtn = win.querySelector(".rw-wipe");
  wipeBtn.addEventListener("click", async () => {
    if (!confirm("This will delete any data Peter has saved about you on the server and clear this chat. Continue?")) return;
    try {
      await fetch(API_BASE + "/api/wipe-visitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitor_id: visitorId }),
      });
    } catch {}
    state.messages = [];
    state.phase = "idle";
    state.open = true;
    startingConversation = false;
    saveState(state);
    renderMessages();
    addMessage("assistant", "Your data has been cleared. Fresh start — ask me anything.");
  });

  // --- Memory toggle handler ---
  const memOffBtn = win.querySelector(".rw-mem-off");
  const memOnBtn = win.querySelector(".rw-mem-on");
  function renderMemoryToggle() {
    memOffBtn.classList.toggle("active", !memoryOn);
    memOnBtn.classList.toggle("active", memoryOn);
  }
  function setMemory(on) {
    if (on === memoryOn) return;
    memoryOn = on;
    saveMemoryOn(on);
    renderMemoryToggle();
    addMessage("assistant", on
      ? "Memory is on — I'll save this chat to Mnemo Cortex so I remember you next visit."
      : "Memory is off — this chat is stateless. Nothing's saved.");
  }
  memOffBtn.addEventListener("click", () => setMemory(false));
  memOnBtn.addEventListener("click", () => setMemory(true));

  // --- Init ---
  renderMemoryToggle();
  if (state.open) {
    win.classList.add("open");
  }
  renderMessages();
})();
