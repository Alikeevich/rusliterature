// POST /api/chat
// Тело запроса: { characterId: string, messages: [{ role: "user" | "model", text: string }] }
// Ответ: { reply: string } или { error: string }
//
// Переменные окружения (Vercel: Settings, Environment Variables):
//   GEMINI_API_KEY - ключ из https://aistudio.google.com/apikey (обязательно)
//   GEMINI_MODEL   - модель (необязательно, по умолчанию gemini-2.5-flash)

import { getCharacter } from "@/lib/characters";
import { buildSystemPrompt, cleanReply } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 20;
const MAX_MESSAGE_LENGTH = 1000;

type Content = { role: "user" | "model"; parts: { text: string }[] };

function sanitizeMessages(raw: unknown): Content[] | null {
  if (!Array.isArray(raw)) return null;
  const messages: Content[] = raw
    .filter(
      (m): m is { role: "user" | "model"; text: string } =>
        !!m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && !!m.text.trim()
    )
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, parts: [{ text: m.text.trim().slice(0, MAX_MESSAGE_LENGTH) }] }));
  // API требует, чтобы диалог начинался с реплики пользователя.
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return messages;
}

function error(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return error("На сервере не задан GEMINI_API_KEY. Добавьте его в настройках Vercel.", 500);

  const body = await req.json().catch(() => null);
  const character = getCharacter(body?.characterId);
  if (!character) return error("Персонаж не найден", 400);

  const contents = sanitizeMessages(body?.messages);
  if (!contents) return error("Пустое сообщение", 400);

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemPrompt(character) }] },
        contents,
        generationConfig: { temperature: 0.8, maxOutputTokens: 4096 },
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
      return response.status === 429
        ? error("Слишком много вопросов сразу. Подождите минуту и спросите ещё раз.", 429)
        : error("Собеседник сейчас не может ответить. Попробуйте чуть позже.", 502);
    }

    const reply: string | undefined = data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || "")
      .join("")
      .trim();

    return Response.json({
      reply: reply
        ? cleanReply(reply)
        : "Хм... Об этом мне трудно говорить. Спроси меня лучше о чём-нибудь другом из книги.",
    });
  } catch (err) {
    console.error("Model API request failed", err);
    return error("Нет связи с сервером. Проверьте интернет и попробуйте снова.", 502);
  }
}
