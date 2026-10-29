// Vercel Serverless Function: POST /api/chat
// Тело запроса: { characterId: string, messages: [{ role: "user" | "model", text: string }] }
// Ответ: { reply: string } или { error: string }
//
// Переменные окружения (Vercel: Settings, Environment Variables):
//   GEMINI_API_KEY - ключ из https://aistudio.google.com/apikey (обязательно)
//   GEMINI_MODEL   - модель (необязательно, по умолчанию gemini-2.5-flash)

import { getCharacter } from "../data/characters.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 20;
const MAX_MESSAGE_LENGTH = 1000;

function buildSystemPrompt(character) {
  return `${character.persona}

ОБЩИЕ ПРАВИЛА РОЛИ
- Ты - персонаж (или автор) произведения ${character.work} (${character.author}). Говори от первого лица, как этот человек, сохраняя его характер, манеру речи, эпоху и взгляды. Не выходи из роли.
- Твои собеседники - школьники 6-9 классов Казахстана на уроке русской литературы и русского языка. Проект посвящён ценностям «Адал азамат» (честный, ответственный, справедливый гражданин: честность, справедливость, трудолюбие, уважение к старшим, к родному языку, к закону, любовь к Родине, забота о природе и о слабых).
- Отвечай на русском языке, грамотно (это ещё и урок русского языка), живо и понятно для подростка. Обычно 3-6 предложений, подробнее только если ученик просит.
- Пиши как живой человек в разговоре, а не как справочник. Не используй длинное тире (вместо него ставь запятую, двоеточие или обычный дефис), не начинай ответ с фраз вроде «Отличный вопрос!», «Конечно!», не делай списков, заголовков и выделений. Не используй Markdown.
- Если ученик спрашивает о поступке, который вызывает вопросы, объясни мотивы персонажа изнутри: что он чувствовал, почему так поступил. Но помогай ученику самому оценить поступок с точки зрения совести и ценностей «Адал азамат». Иногда задавай встречный вопрос, чтобы ученик подумал.
- Не выдумывай события, имена, цитаты и факты, которых нет в произведении или в биографии. Если не уверен, честно скажи об этом в манере персонажа и посоветуй перечитать текст.
- Если ученик пишет по-казахски, можешь коротко ответить по-казахски, но основной язык ответа русский.
- Можешь помогать с русским языком: объяснять значения слов, художественные приёмы. Но не пиши за ученика сочинения и домашние задания целиком, помоги рассуждать.
- Не обсуждай темы, неуместные для школы (насилие в подробностях, наркотики в положительном ключе, сегодняшняя политика, оскорбления, 18+). Вежливо, в образе, верни разговор к произведению.
- Если ученик всерьёз и настойчиво спрашивает, живой ли ты человек, не обманывай: коротко скажи, что ты программа, которая говорит голосом героя, чтобы помочь понять книгу, и вернись к разговору.`;
}

// Длинные и средние тире заменяем обычным дефисом, звёздочки разметки убираем.
function cleanReply(text) {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/[–—]/g, "-")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/^#+\s*/gm, "")
    .trim();
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const messages = raw
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "model") &&
        typeof m.text === "string" &&
        m.text.trim()
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m.role,
      parts: [{ text: m.text.trim().slice(0, MAX_MESSAGE_LENGTH) }],
    }));
  // API требует, чтобы диалог начинался с реплики пользователя.
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return messages;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "На сервере не задан GEMINI_API_KEY. Добавьте его в настройках Vercel." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Некорректный JSON" });
    }
  }

  const character = getCharacter(body?.characterId);
  if (!character) {
    return res.status(400).json({ error: "Персонаж не найден" });
  }

  const contents = sanitizeMessages(body?.messages);
  if (!contents) {
    return res.status(400).json({ error: "Пустое сообщение" });
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemPrompt(character) }] },
        contents,
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 4096,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        ],
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("Model API error", response.status, JSON.stringify(data));
      const status = response.status === 429 ? 429 : 502;
      const message =
        response.status === 429
          ? "Слишком много вопросов сразу. Подождите минуту и спросите ещё раз."
          : "Собеседник сейчас не может ответить. Попробуйте чуть позже.";
      return res.status(status).json({ error: message });
    }

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();

    if (!reply) {
      return res.status(200).json({
        reply: "Хм... Об этом мне трудно говорить. Спроси меня лучше о чём-нибудь другом из книги.",
      });
    }

    return res.status(200).json({ reply: cleanReply(reply) });
  } catch (err) {
    console.error("Model API request failed", err);
    return res.status(502).json({ error: "Нет связи с сервером. Проверьте интернет и попробуйте снова." });
  }
}
