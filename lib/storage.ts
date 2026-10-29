// История чатов хранится только в браузере ученика.

export type Message = { role: "user" | "model"; text: string };

export function loadChat(id: string): Message[] | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(`chat:${id}`) || "null");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveChat(id: string, messages: Message[]) {
  try {
    localStorage.setItem(`chat:${id}`, JSON.stringify(messages.slice(-40)));
  } catch {
    /* хранилище недоступно, просто не сохраняем */
  }
}

export function clearChat(id: string) {
  try {
    localStorage.removeItem(`chat:${id}`);
  } catch {
    /* ignore */
  }
}

export function hasStarted(id: string) {
  return !!loadChat(id)?.some((m) => m.role === "user");
}
