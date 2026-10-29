// POST /api/chat
// Тело запроса: { characterId: string, messages: [{ role: "user" | "model", text: string }] }
// Ответ: { reply: string } или { error: string }
//
// Переменные окружения (Vercel: Settings, Environment Variables):
//   GEMINI_API_KEY - ключ из https://aistudio.google.com/apikey (обязательно)
//   GEMINI_MODEL   - модель (необязательно, по умолчанию gemini-3.8-flash)

import { getCharacter } from "@/lib/characters";
import { buildSystemPrompt, cleanReply } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash"];
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

// Если модель недоступна для ключа (Google иногда закрывает старые модели),
// пробуем следующую из списка.
function modelsToTry() {
  const list = [process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter((m): m is string => !!m?.trim());
  return [...new Set(list.map((m) => m.trim()))];
}

function requestBody(model: string, systemPrompt: string, contents: Content[]) {
  return JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 8192,
      // Модели 3.x по умолчанию долго «думают»; для живого чата хватает low.
      ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_LOW_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  });
}

type ApiError = { status: number; message: string; reason: string };

function readApiError(status: number, data: unknown): ApiError {
  const e = (data as { error?: { message?: string; status?: string; details?: { reason?: string }[] } })?.error;
  return {
    status,
    message: e?.message || "",
    reason: e?.details?.find((d) => d.reason)?.reason || e?.status || "",
  };
}

function isModelUnavailable(e: ApiError) {
  return e.status === 404 || (e.status === 400 && /model|not (found|supported)|thinking/i.test(e.message));
}

// Понятное объяснение ошибки для учителя.
function explain(e: ApiError) {
  if (e.status === 429) return error("Слишком много вопросов сразу. Подождите минуту и спросите ещё раз.", 429);
  if (/API_KEY_INVALID|API key not valid/i.test(e.reason + e.message))
    return error("Ключ GEMINI_API_KEY неверный. Проверьте его в настройках Vercel и сделайте Redeploy.", 502);
  if (e.status === 403 || /PERMISSION_DENIED|SERVICE_DISABLED/i.test(e.reason))
    return error("Ключу GEMINI_API_KEY запрещён доступ. Создайте новый ключ в Google AI Studio.", 502);
  if (/location is not supported|FAILED_PRECONDITION/i.test(e.reason + e.message))
    return error("Google не обслуживает регион сервера. В Vercel выберите регион функций в США или Европе.", 502);
  if (isModelUnavailable(e))
    return error("Модель недоступна для этого ключа. Укажите в GEMINI_MODEL актуальную модель, например gemini-3.8-flash.", 502);
  return error("Собеседник сейчас не может ответить. Попробуйте чуть позже.", 502);
}

export async function POST(req: Request) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return error("На сервере не задан GEMINI_API_KEY. Добавьте его в настройках Vercel и сделайте Redeploy.", 500);

  const body = await req.json().catch(() => null);
  const character = getCharacter(body?.characterId);
  if (!character) return error("Персонаж не найден", 400);

  const contents = sanitizeMessages(body?.messages);
  if (!contents) return error("Пустое сообщение", 400);

  const systemPrompt = buildSystemPrompt(character);
  let lastError: ApiError | null = null;

  for (const model of modelsToTry()) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: requestBody(model, systemPrompt, contents),
      });
    } catch (err) {
      console.error("Model API request failed", model, err);
      return error("Нет связи с сервером модели. Попробуйте снова.", 502);
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      lastError = readApiError(response.status, data);
      console.error("Model API error", model, response.status, JSON.stringify(data));
      if (isModelUnavailable(lastError)) continue;
      return explain(lastError);
    }

    const reply: string | undefined = data?.candidates?.[0]?.content?.parts
      ?.filter((p: { thought?: boolean }) => !p.thought)
      .map((p: { text?: string }) => p.text || "")
      .join("")
      .trim();

    return Response.json({
      reply: reply
        ? cleanReply(reply)
        : "Хм... Об этом мне трудно говорить. Спроси меня лучше о чём-нибудь другом из книги.",
    });
  }

  return explain(lastError ?? { status: 404, message: "model", reason: "" });
}
