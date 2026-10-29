// POST /api/chat
// Тело запроса: { characterId: string, messages: [{ role: "user" | "model", text: string }] }
// Ответ: текст героя потоком (text/plain) или { error: string } с кодом ошибки
//
// Переменные окружения (Vercel: Settings, Environment Variables):
//   GEMINI_API_KEY - ключ из https://aistudio.google.com/apikey (обязательно)
//   GEMINI_MODEL   - модель (необязательно, по умолчанию gemini-3.8-flash)

import { getCharacter } from "@/lib/characters";
import { buildSystemPrompt, cleanChunk } from "@/lib/prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-2.5-flash"];
const MAX_HISTORY = 20;
// Vercel обрывает функцию через maxDuration, поэтому держим запас.
const FIRST_CHUNK_TIMEOUT_MS = 15_000;
const WAIT_BUDGET_MS = 42_000;
const TOTAL_BUDGET_MS = 56_000;
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
      maxOutputTokens: 2048,
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

type Events = AsyncGenerator<GeminiEvent, void, unknown>;
type GeminiEvent = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  error?: unknown;
};

// Разбор потока Server-Sent Events от Gemini.
async function* sseEvents(body: ReadableStream<Uint8Array>): Events {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        try {
          yield JSON.parse(line.slice(5));
        } catch {
          /* неполная строка, пропускаем */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function eventText(event: GeminiEvent) {
  return (event.candidates?.[0]?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");
}

type Attempt =
  | { ok: true; first: string; events: Events; abort: AbortController }
  | { ok: false; error: ApiError | "timeout" | "network" };

// Один запрос к модели: ждём первый кусочек текста не дольше timeoutMs.
async function attempt(model: string, apiKey: string, body: string, timeoutMs: number): Promise<Attempt> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: abort.signal,
    });

    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => null);
      console.error("Model API error", model, response.status, JSON.stringify(data));
      return { ok: false, error: readApiError(response.status, data) };
    }

    const events = sseEvents(response.body);
    while (true) {
      const next = await events.next();
      if (next.done) return { ok: true, first: "", events, abort };
      if (next.value.error) {
        console.error("Model stream error", model, JSON.stringify(next.value.error));
        return { ok: false, error: "network" };
      }
      const text = eventText(next.value);
      if (text) return { ok: true, first: text, events, abort };
    }
  } catch (err) {
    const timedOut = abort.signal.aborted;
    console.error(timedOut ? "Model timeout" : "Model request failed", model, timedOut ? `${timeoutMs}ms` : err);
    return { ok: false, error: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

function streamReply(first: string, events: Events, abort: AbortController, deadline: number) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const kill = setTimeout(() => abort.abort(), Math.max(1000, deadline - Date.now()));
      controller.enqueue(
        encoder.encode(
          first ? cleanChunk(first) : "Хм... Об этом мне трудно говорить. Спроси меня лучше о чём-нибудь другом из книги."
        )
      );
      try {
        while (true) {
          const next = await events.next();
          if (next.done) break;
          const text = eventText(next.value);
          if (text) controller.enqueue(encoder.encode(cleanChunk(text)));
        }
      } catch {
        /* оборвалось по времени: отдаём то, что успели */
      } finally {
        clearTimeout(kill);
        controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return error("На сервере не задан GEMINI_API_KEY. Добавьте его в настройках Vercel и сделайте Redeploy.", 500);

  const body = await req.json().catch(() => null);
  const character = getCharacter(body?.characterId);
  if (!character) return error("Персонаж не найден", 400);

  const contents = sanitizeMessages(body?.messages);
  if (!contents) return error("Пустое сообщение", 400);

  const systemPrompt = buildSystemPrompt(character);
  let lastError: ApiError | "timeout" | "network" | null = null;

  for (const model of modelsToTry()) {
    const left = startedAt + WAIT_BUDGET_MS - Date.now();
    if (left < 4000) break;

    const result = await attempt(model, apiKey, requestBody(model, systemPrompt, contents), Math.min(FIRST_CHUNK_TIMEOUT_MS, left));
    if (result.ok) {
      console.log("Model answered", model, `${Date.now() - startedAt}ms`);
      return new Response(streamReply(result.first, result.events, result.abort, startedAt + TOTAL_BUDGET_MS), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }

    lastError = result.error;
    if (lastError === "timeout" || lastError === "network" || isModelUnavailable(lastError)) continue;
    return explain(lastError);
  }

  if (lastError === "timeout" || lastError === null)
    return error("Герой слишком долго думает. Попробуйте спросить ещё раз через минуту.", 504);
  if (lastError === "network") return error("Нет связи с сервером модели. Попробуйте снова.", 502);
  return explain(lastError);
}
