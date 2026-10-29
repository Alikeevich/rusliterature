"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowUp, RotateCcw } from "lucide-react";
import clsx from "clsx";
import type { Character } from "@/lib/characters";
import { clearChat, loadChat, saveChat, type Message } from "@/lib/storage";
import Portrait from "./Portrait";

type Props = { character: Character; onClose: () => void };

export default function Chat({ character: c, onClose }: Props) {
  const greeting: Message = { role: "model", text: c.greeting };
  const [messages, setMessages] = useState<Message[]>([greeting]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMessages(loadChat(c.id) || [greeting]);
    if (window.matchMedia("(hover: hover)").matches) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, error]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const next: Message[] = [...messages, { role: "user", text: question }];
    setMessages(next);
    saveChat(c.id, next);
    setInput("");
    setError(null);
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId: c.id, messages: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.reply) throw new Error(data.error || "Не получилось получить ответ.");
      const done: Message[] = [...next, { role: "model", text: data.reply }];
      setMessages(done);
      saveChat(c.id, done);
    } catch (err) {
      // Убираем вопрос без ответа, чтобы его можно было задать снова.
      setMessages(messages);
      saveChat(c.id, messages);
      setInput(question);
      setError(err instanceof Error ? err.message : "Нет связи с сервером.");
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    if (busy || !confirm("Начать разговор заново? Переписка с этим героем удалится.")) return;
    clearChat(c.id);
    setMessages([greeting]);
    setError(null);
  }

  const asked = messages.some((m) => m.role === "user");

  return (
    <motion.section
      role="dialog"
      aria-modal="true"
      aria-label={`Разговор: ${c.name}`}
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 32 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-0 z-50 flex h-dvh bg-ivory"
    >
      {/* Портрет слева (на больших экранах) */}
      <aside className="relative hidden w-[min(420px,36vw)] shrink-0 overflow-hidden bg-ink lg:block">
        <Portrait character={c} sizes="420px" priority />
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/40" />
        <button
          onClick={onClose}
          className="absolute top-5 left-5 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/25"
        >
          <ArrowLeft size={18} /> Все герои
        </button>
        <div className="absolute inset-x-0 bottom-0 p-8 text-white">
          <span className="mb-3 block h-1 w-10 rounded-full" style={{ background: c.color }} />
          <p className="text-sm text-gold">
            {c.work} · {c.author}
          </p>
          <h2 className="mt-2 font-serif text-4xl leading-tight font-bold">{c.name}</h2>
          <p className="mt-2 text-white/75">{c.role}</p>
        </div>
      </aside>

      <div className="pattern flex min-w-0 flex-1 flex-col">
        {/* Верхняя панель */}
        <header className="flex shrink-0 items-center gap-3 border-b-4 border-gold bg-gradient-to-br from-sky to-sky-deep px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-white lg:border-b lg:border-line lg:bg-none lg:bg-white/70 lg:px-6 lg:py-4 lg:text-ink lg:backdrop-blur">
          <button
            onClick={onClose}
            aria-label="Назад к героям"
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/15 transition hover:bg-white/25 lg:hidden"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="relative size-10 shrink-0 overflow-hidden rounded-full ring-2 ring-white/70 lg:hidden">
            <Portrait character={c} variant="square" sizes="40px" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold lg:hidden">{c.name}</p>
            <p className="truncate text-xs text-white/80 lg:text-sm lg:text-muted">
              <span className="lg:hidden">{c.work}</span>
              <span className="hidden lg:inline">Беседа с героем. Спроси, что тебе непонятно в книге.</span>
            </p>
          </div>
          <button
            onClick={restart}
            aria-label="Начать разговор заново"
            title="Начать заново"
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/15 transition hover:bg-white/25 lg:bg-ink/5 lg:hover:bg-ink/10"
          >
            <RotateCcw size={18} />
          </button>
        </header>

        {/* Сообщения */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
            <div className="mb-6 flex flex-col items-center text-center lg:hidden">
              <div className="relative size-28 overflow-hidden rounded-full ring-4 ring-white shadow-[0_0_0_7px_var(--color-gold)]">
                <Portrait character={c} variant="square" sizes="112px" priority />
              </div>
              <h2 className="mt-5 font-serif text-2xl font-bold">{c.name}</h2>
              <p className="mt-1 text-sm text-muted">
                {c.role} · {c.author}
              </p>
            </div>

            <ul className="flex flex-col gap-4">
              <AnimatePresence initial={false}>
                {messages.map((m, i) => (
                  <Bubble key={`${i}-${m.role}`} message={m} character={c} />
                ))}
                {busy && <Typing key="typing" character={c} />}
              </AnimatePresence>
            </ul>

            {error && (
              <p className="mx-auto mt-5 max-w-md rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-center text-sm text-red-700">
                {error}
              </p>
            )}
          </div>
        </div>

        {/* Ввод */}
        <div className="shrink-0 border-t border-line bg-ivory/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto max-w-3xl px-4 pt-3 sm:px-6">
            {!asked && (
              <div className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
                {c.suggestions.map((q) => (
                  <button
                    key={q}
                    onClick={() => send(q)}
                    className="shrink-0 rounded-full border border-line bg-white px-4 py-2 text-sm text-ink/80 shadow-sm transition hover:border-sky hover:text-sky-deep"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="flex items-end gap-2 rounded-3xl border border-line bg-white p-1.5 pl-4 shadow-sm transition focus-within:border-sky focus-within:ring-4 focus-within:ring-sky/15"
            >
              <textarea
                ref={inputRef}
                rows={1}
                maxLength={1000}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="Напиши свой вопрос"
                aria-label="Ваш вопрос"
                className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent py-2.5 text-base leading-snug outline-none placeholder:text-muted"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                aria-label="Отправить"
                className="grid size-11 shrink-0 place-items-center rounded-full bg-sky text-white transition hover:bg-sky-deep disabled:bg-ink/15"
              >
                <ArrowUp size={20} strokeWidth={2.5} />
              </button>
            </form>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function Avatar({ character }: { character: Character }) {
  return (
    <div className="relative mt-0.5 size-9 shrink-0 overflow-hidden rounded-full ring-2 ring-white shadow">
      <Portrait character={character} variant="square" sizes="36px" />
    </div>
  );
}

function Bubble({ message, character }: { message: Message; character: Character }) {
  const isUser = message.role === "user";
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={clsx("flex gap-2.5", isUser ? "justify-end" : "justify-start")}
    >
      {!isUser && <Avatar character={character} />}
      <div
        className={clsx(
          "max-w-[85%] rounded-3xl px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap sm:max-w-[75%] sm:text-base",
          isUser
            ? "rounded-br-lg bg-gradient-to-br from-sky to-sky-deep text-white shadow-[0_6px_16px_-6px_rgba(0,111,136,0.6)]"
            : "rounded-tl-lg border border-line bg-white shadow-[0_2px_8px_rgba(20,24,31,0.05)]"
        )}
      >
        {message.text}
      </div>
    </motion.li>
  );
}

function Typing({ character }: { character: Character }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="flex gap-2.5"
      aria-label="Герой печатает"
    >
      <Avatar character={character} />
      <div className="flex items-center gap-1.5 rounded-3xl rounded-tl-lg border border-line bg-white px-4 py-4">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-2 rounded-full bg-muted"
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </motion.li>
  );
}
