import { GRADES, CHARACTERS, getCharacter } from "/data/characters.js";

const tabsEl = document.getElementById("tabs");
const wallEl = document.getElementById("wall");

const chatEl = document.getElementById("chat");
const backdropEl = document.getElementById("chatBackdrop");
const chatAvatar = document.getElementById("chatAvatar");
const chatName = document.getElementById("chatName");
const chatWork = document.getElementById("chatWork");
const chatLog = document.getElementById("chatLog");
const chatSuggestions = document.getElementById("chatSuggestions");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatSend = document.getElementById("chatSend");
const chatClose = document.getElementById("chatClose");
const chatClear = document.getElementById("chatClear");

let currentGrade = GRADES[0].id;
let current = null; // текущий персонаж
let history = []; // [{ role: "user" | "model", text }]
let busy = false;
let lastFocus = null;

// ───────── Хранилище (история чатов у каждого ученика в браузере) ─────────
const storage = {
  load(id) {
    try {
      const raw = localStorage.getItem(`chat:${id}`);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  save(id, messages) {
    try {
      localStorage.setItem(`chat:${id}`, JSON.stringify(messages.slice(-40)));
    } catch {
      /* хранилище недоступно — просто не сохраняем */
    }
  },
  clear(id) {
    try {
      localStorage.removeItem(`chat:${id}`);
    } catch {
      /* ignore */
    }
  },
};

// ───────── Вкладки и стена ─────────
function renderTabs() {
  tabsEl.innerHTML = "";
  for (const grade of GRADES) {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.type = "button";
    btn.role = "tab";
    btn.textContent = grade.title;
    btn.setAttribute("aria-selected", String(grade.id === currentGrade));
    btn.addEventListener("click", () => selectGrade(grade.id));
    tabsEl.append(btn);
  }
}

function selectGrade(id) {
  currentGrade = id;
  window.history.replaceState(null, "", `#${id}`);
  renderTabs();
  renderWall();
}

function renderWall() {
  wallEl.innerHTML = "";
  const list = CHARACTERS.filter((c) => c.grade === currentGrade);

  // Группируем персонажей по произведениям, сохраняя порядок.
  const groups = new Map();
  for (const c of list) {
    const key = `${c.author}|${c.work}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const [key, chars] of groups) {
    const [author, work] = key.split("|");
    const group = document.createElement("div");
    group.className = "work-group";

    const title = document.createElement("h3");
    title.className = "work-title";
    title.textContent = work;
    const small = document.createElement("small");
    small.textContent = author;
    title.append(small);

    const cards = document.createElement("div");
    cards.className = "cards";
    for (const c of chars) cards.append(renderCard(c));

    group.append(title, cards);
    wallEl.append(group);
  }
}

function renderCard(c) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.style.setProperty("--accent", c.color);
  card.setAttribute("aria-label", `Поговорить: ${c.name}`);

  const top = document.createElement("div");
  top.className = "card-top";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = c.emoji;
  const info = document.createElement("div");
  const name = document.createElement("p");
  name.className = "card-name";
  name.textContent = c.name;
  const role = document.createElement("p");
  role.className = "card-role";
  role.textContent = c.role;
  info.append(name, role);
  top.append(avatar, info);

  const greet = document.createElement("p");
  greet.className = "card-greeting";
  greet.textContent = c.greeting;

  const cta = document.createElement("span");
  cta.className = "card-cta";
  cta.textContent = storage.load(c.id)?.length > 1 ? "Продолжить разговор →" : "Задать вопрос →";

  card.append(top, greet, cta);
  card.addEventListener("click", () => openChat(c.id));
  return card;
}

// ───────── Чат ─────────
function openChat(id) {
  const c = getCharacter(id);
  if (!c) return;
  current = c;
  lastFocus = document.activeElement;

  chatEl.style.setProperty("--accent", c.color);
  chatAvatar.style.setProperty("--accent", c.color);
  chatAvatar.textContent = c.emoji;
  chatName.textContent = c.name;
  chatWork.textContent = `${c.work} · ${c.author}`;

  history = storage.load(c.id) || [{ role: "model", text: c.greeting }];
  renderLog();
  renderSuggestions();

  chatEl.hidden = false;
  backdropEl.hidden = false;
  document.body.style.overflow = "hidden";
  chatInput.value = "";
  autoResize();
  setTimeout(() => chatInput.focus(), 50);
}

function closeChat() {
  chatEl.hidden = true;
  backdropEl.hidden = true;
  document.body.style.overflow = "";
  current = null;
  renderWall(); // обновить подписи «Продолжить разговор»
  lastFocus?.focus?.();
}

function renderLog() {
  chatLog.innerHTML = "";
  for (const m of history) addBubble(m.role, m.text);
  scrollDown();
}

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatLog.append(div);
  return div;
}

function renderSuggestions() {
  chatSuggestions.innerHTML = "";
  // Подсказки показываем, пока ученик не задал ни одного вопроса.
  if (!current || history.some((m) => m.role === "user")) return;
  for (const q of current.suggestions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = q;
    chip.addEventListener("click", () => send(q));
    chatSuggestions.append(chip);
  }
}

function scrollDown() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setBusy(value) {
  busy = value;
  chatSend.disabled = value;
  chatInput.disabled = value;
}

async function send(text) {
  const question = text.trim();
  if (!question || busy || !current) return;
  const character = current;

  history.push({ role: "user", text: question });
  storage.save(character.id, history);
  addBubble("user", question);
  chatSuggestions.innerHTML = "";
  chatInput.value = "";
  autoResize();

  const typing = addBubble("model", "");
  typing.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  scrollDown();
  setBusy(true);

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ characterId: character.id, messages: history }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.reply) throw new Error(data.error || "Не удалось получить ответ.");

    // Если ученик успел закрыть чат или открыть другой — не трогаем экран.
    history.push({ role: "model", text: data.reply });
    storage.save(character.id, history);
    if (current === character) {
      typing.textContent = data.reply;
    }
  } catch (err) {
    // Убираем вопрос без ответа, чтобы его можно было задать снова.
    history.pop();
    storage.save(character.id, history);
    if (current === character) {
      typing.remove();
      const errBubble = addBubble("error", err.message || "Ошибка соединения.");
      errBubble.className = "msg error";
      chatInput.value = question;
      autoResize();
    }
  } finally {
    setBusy(false);
    if (current === character) {
      scrollDown();
      chatInput.focus();
    }
  }
}

function autoResize() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 140)}px`;
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  send(chatInput.value);
});

chatInput.addEventListener("input", autoResize);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(chatInput.value);
  }
});

chatClose.addEventListener("click", closeChat);
backdropEl.addEventListener("click", closeChat);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chatEl.hidden) closeChat();
});

chatClear.addEventListener("click", () => {
  if (!current || busy) return;
  if (!confirm("Начать разговор заново? История этого чата будет удалена.")) return;
  storage.clear(current.id);
  history = [{ role: "model", text: current.greeting }];
  renderLog();
  renderSuggestions();
  chatInput.focus();
});

// ───────── Старт ─────────
const fromHash = Number(location.hash.slice(1));
if (GRADES.some((g) => g.id === fromHash)) currentGrade = fromHash;
renderTabs();
renderWall();
