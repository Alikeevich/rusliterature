import { GRADES, CHARACTERS, AUTHOR_PERSON, getCharacter } from "/data/characters.js";
import { PHOTOS } from "/data/photos.js";

const $ = (id) => document.getElementById(id);

const tabsEl = $("tabs");
const wallEl = $("wall");

const chatEl = $("chat");
const chatAvatar = $("chatAvatar");
const chatName = $("chatName");
const chatWork = $("chatWork");
const chatPortrait = $("chatPortrait");
const chatIntroName = $("chatIntroName");
const chatIntroWork = $("chatIntroWork");
const chatScroll = $("chatScroll");
const chatLog = $("chatLog");
const chatSuggestions = $("chatSuggestions");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const chatSend = $("chatSend");

const photoSet = new Set(PHOTOS);

let currentGrade = GRADES[0].id;
let current = null; // открытый персонаж
let messages = []; // [{ role: "user" | "model", text }]
let busy = false;
let lastFocus = null;

// ───────── История чатов (в браузере ученика) ─────────
const storage = {
  load(id) {
    try {
      const parsed = JSON.parse(localStorage.getItem(`chat:${id}`));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  },
  save(id, list) {
    try {
      localStorage.setItem(`chat:${id}`, JSON.stringify(list.slice(-40)));
    } catch {
      /* хранилище недоступно, просто не сохраняем */
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

// ───────── Фото или инициалы ─────────
function initials(name) {
  const words = name.replace(/\(.*?\)/g, "").split(/[\s-]+/).filter((w) => /^[А-ЯЁA-Z]/.test(w));
  return words.slice(0, 2).map((w) => w[0]).join("");
}

function fillPhoto(el, person, name, color, { square = false } = {}) {
  el.style.setProperty("--accent", color);
  el.replaceChildren();
  if (person && photoSet.has(person)) {
    const img = document.createElement("img");
    img.src = `/img/people/${person}${square ? "-sq" : ""}.webp`;
    img.alt = name;
    img.loading = "lazy";
    img.decoding = "async";
    el.append(img);
  } else {
    const span = document.createElement("span");
    span.className = "initials";
    span.textContent = initials(name);
    el.append(span);
  }
}

function makePhoto(className, person, name, color, opts) {
  const el = document.createElement("div");
  el.className = `photo ${className}`;
  fillPhoto(el, person, name, color, opts);
  return el;
}

// ───────── Классы и стена ─────────
function heroesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "герой";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "героя";
  return "героев";
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const grade of GRADES) {
    const count = CHARACTERS.filter((c) => c.grade === grade.id).length;
    const btn = document.createElement("button");
    btn.className = "grade-tab";
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(grade.id === currentGrade));
    const title = document.createElement("b");
    title.textContent = grade.title;
    const sub = document.createElement("span");
    sub.textContent = `${count} ${heroesWord(count)}`;
    btn.append(title, sub);
    btn.addEventListener("click", () => selectGrade(grade.id));
    tabsEl.append(btn);
  }
}

function selectGrade(id) {
  if (id === currentGrade) return;
  currentGrade = id;
  window.history.replaceState(null, "", `#${id}`);
  renderTabs();
  renderWall();
}

function renderWall() {
  const grid = document.createElement("div");
  grid.className = "wall-grid";
  wallEl.replaceChildren(grid);

  // Группируем по произведениям, сохраняя порядок из списка.
  const groups = new Map();
  for (const c of CHARACTERS.filter((c) => c.grade === currentGrade)) {
    const key = `${c.author}|${c.work}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  for (const [key, chars] of groups) {
    const [author, work] = key.split("|");
    const section = document.createElement("section");
    section.className = "work";

    const head = document.createElement("div");
    head.className = "work-head";
    const authorPerson = AUTHOR_PERSON[author];
    head.append(makePhoto("photo-xs", authorPerson, author, chars[0].color, { square: true }));
    const text = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = work;
    const p = document.createElement("p");
    p.textContent = author;
    text.append(h, p);
    head.append(text);

    const cards = document.createElement("div");
    cards.className = "cards";
    for (const c of chars) cards.append(renderCard(c));

    section.append(head, cards);
    grid.append(section);
  }
}

function renderCard(c) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "card";
  card.style.setProperty("--accent", c.color);
  card.setAttribute("aria-label", `Поговорить: ${c.name}`);

  const body = document.createElement("div");
  body.className = "card-body";
  const name = document.createElement("p");
  name.className = "card-name";
  name.textContent = c.name;
  const role = document.createElement("p");
  role.className = "card-role";
  role.textContent = c.role;
  const ask = document.createElement("span");
  const started = storage.load(c.id)?.some((m) => m.role === "user");
  ask.className = started ? "card-ask is-continue" : "card-ask";
  ask.textContent = started ? "Продолжить разговор" : "Задать вопрос";
  body.append(name, role, ask);

  card.append(makePhoto("", c.person, c.name, c.color), body);
  card.addEventListener("click", () => openChat(c.id));
  return card;
}

// ───────── Чат ─────────
function openChat(id, { fromHistory = false } = {}) {
  const c = getCharacter(id);
  if (!c) return;
  current = c;
  if (!fromHistory) {
    lastFocus = document.activeElement;
    // Кнопка «Назад» на телефоне закрывает чат, а не уходит с сайта.
    window.history.pushState({ chat: id }, "", `#${c.grade}`);
  }

  chatEl.style.setProperty("--accent", c.color);
  fillPhoto(chatAvatar, c.person, c.name, c.color, { square: true });
  fillPhoto(chatPortrait, c.person, c.name, c.color, { square: true });
  chatName.textContent = c.name;
  chatWork.textContent = `${c.work}, ${c.author}`;
  chatIntroName.textContent = c.name;
  chatIntroWork.textContent = `${c.role} · ${c.work}`;

  messages = storage.load(c.id) || [{ role: "model", text: c.greeting }];
  renderLog();
  renderSuggestions();

  chatEl.hidden = false;
  document.body.classList.add("chat-open");
  chatInput.value = "";
  autoResize();
  if (window.matchMedia("(hover: hover)").matches) chatInput.focus();
}

function hideChat() {
  if (chatEl.hidden) return;
  chatEl.hidden = true;
  document.body.classList.remove("chat-open");
  current = null;
  renderWall(); // обновить «Продолжить разговор»
  lastFocus?.focus?.({ preventScroll: true });
}

function closeChat() {
  if (window.history.state?.chat) window.history.back();
  else hideChat();
}

window.addEventListener("popstate", (e) => {
  if (e.state?.chat) openChat(e.state.chat, { fromHistory: true });
  else hideChat();
});

function renderLog() {
  chatLog.replaceChildren();
  for (const m of messages) addBubble(m.role, m.text);
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
  chatSuggestions.replaceChildren();
  if (!current || messages.some((m) => m.role === "user")) return;
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
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function setBusy(value) {
  busy = value;
  chatSend.disabled = value;
}

async function send(text) {
  const question = text.trim();
  if (!question || busy || !current) return;
  const character = current;

  messages.push({ role: "user", text: question });
  storage.save(character.id, messages);
  addBubble("user", question);
  chatSuggestions.replaceChildren();
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
      body: JSON.stringify({ characterId: character.id, messages }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.reply) throw new Error(data.error || "Не получилось получить ответ.");

    messages.push({ role: "model", text: data.reply });
    storage.save(character.id, messages);
    if (current === character) typing.textContent = data.reply;
  } catch (err) {
    // Убираем вопрос без ответа, чтобы его можно было задать снова.
    messages.pop();
    storage.save(character.id, messages);
    if (current === character) {
      typing.remove();
      addBubble("error", err.message || "Нет связи с сервером.");
      chatInput.value = question;
      autoResize();
    }
  } finally {
    setBusy(false);
    if (current === character) scrollDown();
  }
}

function autoResize() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
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

$("chatClose").addEventListener("click", closeChat);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chatEl.hidden) closeChat();
});

$("chatClear").addEventListener("click", () => {
  if (!current || busy) return;
  if (!confirm("Начать разговор заново? Переписка с этим героем удалится.")) return;
  storage.clear(current.id);
  messages = [{ role: "model", text: current.greeting }];
  renderLog();
  renderSuggestions();
});

// ───────── Старт ─────────
const fromHash = Number(location.hash.slice(1));
if (GRADES.some((g) => g.id === fromHash)) currentGrade = fromHash;
window.history.replaceState(null, "", location.hash || `#${currentGrade}`);
renderTabs();
renderWall();
