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

const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-2.5-flash"];
const MAX_HISTORY = 20;
const MAX_MESSAGE_LENGTH = 1000;

// Vercel обрывает функцию через maxDuration, поэтому держим запас.
// Если модель молчит HEDGE_MS, параллельно запускаем следующую и берём ту, что ответит первой.
const HEDGE_MS = 8_000;
const FIRST_CHUNK_TIMEOUT_MS = 30_000;
const WAIT_BUDGET_MS = 40_000;
const TOTAL_BUDGET_MS = 57_000;

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
  // API требует, чтобы диалог начинался с реплики пользователя (приветствие героя есть в системном промпте).
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;
  return messages;
}

function error(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function modelsToTry() {
  const list = [process.env.GEMINI_MODEL, ...FALLBACK_MODELS].filter((m): m is string => !!m?.trim());
  return [...new Set(list.map((m) => m.trim()))];
}

function requestBody(model: string, systemPrompt: string, contents: Content[]) {
  const isGemini3 = model.startsWith("gemini-3");
  return JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      // Для моделей 3.x Google советует не трогать temperature; «думать» долго в живом чате не нужно.
      ...(isGemini3 ? { thinkingConfig: { thinkingLevel: "low" } } : { temperature: 0.9 }),
    },
    // Программа по литературе полна войны, смерти и жестокости, поэтому блокируем только явно опасное.
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  });
}

type ApiError = { status: number; message: string; reason: string };
type Failure = ApiError | "timeout" | "network";

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

// Ошибка, при которой нет смысла пробовать другие модели (ключ, доступ, регион).
function isFatal(f: Failure): f is ApiError {
  return typeof f !== "string" && !isModelUnavailable(f) && f.status !== 429 && f.status < 500;
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

type GeminiEvent = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: unknown;
};
type Events = AsyncGenerator<GeminiEvent, void, unknown>;

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

function stopReason(event: GeminiEvent) {
  return event.promptFeedback?.blockReason || event.candidates?.[0]?.finishReason;
}

type Started = { model: string; first: string; firstStop?: string; events: Events; abort: AbortController };

// Один запрос к модели: ждём первый кусочек текста. Отменяется через abort.
async function attempt(model: string, apiKey: string, body: string, abort: AbortController): Promise<Started> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) throw "timeout";
    console.error("Model request failed", model, err);
    throw "network";
  }

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    console.error("Model API error", model, response.status, JSON.stringify(data));
    throw readApiError(response.status, data);
  }

  const events = sseEvents(response.body);
  try {
    while (true) {
      const next = await events.next();
      if (next.done) return { model, first: "", events, abort };
      if (next.value.error) {
        console.error("Model stream error", model, JSON.stringify(next.value.error));
        throw "network";
      }
      const text = eventText(next.value);
      const stop = stopReason(next.value);
      if (text || (stop && stop !== "STOP")) return { model, first: text, firstStop: stop, events, abort };
    }
  } catch (err) {
    if (typeof err === "string") throw err;
    throw abort.signal.aborted ? "timeout" : "network";
  }
}

// Запускаем модели по очереди с подстраховкой: если текущая молчит HEDGE_MS,
// стартует следующая, но и первая продолжает работать. Побеждает первая ответившая.
function race(models: string[], apiKey: string, makeBody: (model: string) => string, deadline: number) {
  return new Promise<Started | Failure>((resolve) => {
    const running = new Map<string, AbortController>();
    let index = 0;
    let finished = false;
    let lastFailure: Failure = "timeout";
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: Started | Failure) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      const winner = typeof result === "object" && "events" in result ? result.model : null;
      for (const [model, abort] of running) if (model !== winner) abort.abort();
      resolve(result);
    };

    const startNext = () => {
      clearTimeout(hedgeTimer);
      if (finished) return;
      const left = deadline - Date.now();
      if (index >= models.length || left < 3000) {
        if (!running.size) finish(lastFailure);
        return;
      }

      const model = models[index++];
      const abort = new AbortController();
      running.set(model, abort);
      const timeout = setTimeout(() => abort.abort(), Math.min(FIRST_CHUNK_TIMEOUT_MS, left));
      const startedAt = Date.now();

      attempt(model, apiKey, makeBody(model), abort)
        .then((started) => {
          console.log("Model answered", model, `${Date.now() - startedAt}ms`);
          finish(started);
        })
        .catch((failure: Failure) => {
          if (finished) return; // отменили, потому что другая модель ответила раньше
          if (failure === "timeout") console.error("Model timeout", model, `${Date.now() - startedAt}ms`);
          running.delete(model);
          lastFailure = failure;
          if (isFatal(failure)) finish(failure);
          else startNext();
        })
        .finally(() => clearTimeout(timeout));

      hedgeTimer = setTimeout(startNext, HEDGE_MS);
    };

    startNext();
  });
}

const SAFE_ENDING = " ...Прости, дальше мне тяжело об этом говорить. Спроси меня о другом.";

function streamReply({ model, first, firstStop, events, abort }: Started, deadline: number) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const kill = setTimeout(() => abort.abort(), Math.max(1000, deadline - Date.now()));
      let sent = first.length > 0;
      let stop = firstStop;
      if (sent) controller.enqueue(encoder.encode(cleanChunk(first)));
      try {
        while (!stop || stop === "STOP") {
          const next = await events.next();
          if (next.done) break;
          const text = eventText(next.value);
          stop = stopReason(next.value) || stop;
          if (text) {
            controller.enqueue(encoder.encode(cleanChunk(text)));
            sent = true;
          }
        }
      } catch {
        stop = stop || "ABORTED";
      } finally {
        clearTimeout(kill);
        if (stop && stop !== "STOP") {
          console.error("Model stopped early", model, stop);
          controller.enqueue(encoder.encode(sent ? SAFE_ENDING : SAFE_ENDING.slice(4)));
        } else if (!sent) {
          controller.enqueue(encoder.encode("Хм... Об этом мне трудно говорить. Спроси меня лучше о чём-нибудь другом из книги."));
        }
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
  const result = await race(
    modelsToTry(),
    apiKey,
    (model) => requestBody(model, systemPrompt, contents),
    startedAt + WAIT_BUDGET_MS
  );

  if (typeof result === "object" && "events" in result) {
    return new Response(streamReply(result, startedAt + TOTAL_BUDGET_MS), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (result === "timeout") return error("Герой слишком долго думает. Попробуйте спросить ещё раз через минуту.", 504);
  if (result === "network") return error("Нет связи с сервером модели. Попробуйте снова.", 502);
  return explain(result);
}
