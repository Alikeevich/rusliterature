"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, MessageCircle } from "lucide-react";
import clsx from "clsx";
import { CHARACTERS, GRADES, getCharacter, type Character } from "@/lib/characters";
import { hasStarted } from "@/lib/storage";
import Portrait from "./Portrait";
import Chat from "./Chat";

function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export default function Wall() {
  const [grade, setGrade] = useState<number>(GRADES[0].id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [started, setStarted] = useState<Set<string>>(new Set());

  const refreshStarted = useCallback(() => {
    setStarted(new Set(CHARACTERS.filter((c) => hasStarted(c.id)).map((c) => c.id)));
  }, []);

  // Класс из адреса (#7) и кнопка «Назад» в браузере для закрытия чата.
  useEffect(() => {
    const fromHash = Number(window.location.hash.slice(1));
    if (GRADES.some((g) => g.id === fromHash)) setGrade(fromHash);
    refreshStarted();

    const onPop = (e: PopStateEvent) => setOpenId(e.state?.chat ?? null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [refreshStarted]);

  useEffect(() => {
    document.body.style.overflow = openId ? "hidden" : "";
    if (!openId) refreshStarted();
  }, [openId, refreshStarted]);

  const selectGrade = (id: number) => {
    setGrade(id);
    window.history.replaceState(null, "", `#${id}`);
  };

  const openChat = (c: Character) => {
    window.history.pushState({ chat: c.id }, "", `#${c.grade}`);
    setOpenId(c.id);
  };

  const closeChat = () => {
    if (window.history.state?.chat) window.history.back();
    else setOpenId(null);
  };

  const list = CHARACTERS.filter((c) => c.grade === grade);
  const works = new Set(list.map((c) => c.work)).size;
  const open = openId ? getCharacter(openId) : undefined;

  return (
    <>
      <header className="relative overflow-hidden bg-gradient-to-br from-sky to-sky-deep text-white">
        <div className="ornament" aria-hidden />
        <div className="pattern-light">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="mx-auto max-w-3xl px-4 pt-12 pb-16 text-center sm:pt-16 sm:pb-20"
          >
            <p className="text-xs font-semibold tracking-[0.18em] text-gold uppercase sm:text-sm">
              Русская литература · Русский язык
            </p>
            <h1 className="mt-2 font-serif text-5xl leading-none font-bold drop-shadow-sm sm:text-7xl">Адал азамат</h1>
            <p className="mx-auto mt-5 max-w-2xl text-base text-white/90 sm:text-lg">
              Выбери класс и героя книги. Спроси его о том, что тебе непонятно: почему он так поступил, что чувствовал, о
              чём думал.
            </p>
          </motion.div>
        </div>
        <div className="ornament ornament-flip" aria-hidden />
      </header>

      <nav aria-label="Классы" className="sticky top-0 z-20 -mt-8 px-4 pt-3 pb-3">
        <div
          role="tablist"
          className="mx-auto grid max-w-xl grid-cols-4 gap-1 rounded-full border border-line bg-white/90 p-1.5 shadow-[0_10px_30px_-10px_rgba(0,60,80,0.35)] backdrop-blur"
        >
          {GRADES.map((g) => {
            const active = g.id === grade;
            return (
              <button
                key={g.id}
                role="tab"
                aria-selected={active}
                onClick={() => selectGrade(g.id)}
                className={clsx(
                  "relative rounded-full py-2.5 text-sm font-semibold transition-colors sm:text-base",
                  active ? "text-white" : "text-ink/70 hover:text-ink"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="grade-pill"
                    className="absolute inset-0 rounded-full bg-sky shadow-md"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  />
                )}
                <span className="relative">{g.title}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="pattern mx-auto max-w-6xl px-4 pt-6 pb-20">
        <div className="mb-6 flex items-end justify-between gap-4 border-b border-line pb-4">
          <h2 className="font-serif text-3xl font-bold sm:text-4xl">{grade} класс</h2>
          <p className="pb-1 text-sm text-muted">
            {list.length} {plural(list.length, "герой", "героя", "героев")} · {works}{" "}
            {plural(works, "произведение", "произведения", "произведений")}
          </p>
        </div>

        <AnimatePresence mode="wait">
          <motion.ul
            key={grade}
            initial="hidden"
            animate="show"
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            variants={{ show: { transition: { staggerChildren: 0.045 } } }}
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-5 lg:grid-cols-4"
          >
            {list.map((c, i) => (
              <motion.li
                key={c.id}
                variants={{
                  hidden: { opacity: 0, y: 18 },
                  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
                }}
              >
                <HeroCard character={c} started={started.has(c.id)} priority={i < 4} onOpen={() => openChat(c)} />
              </motion.li>
            ))}
          </motion.ul>
        </AnimatePresence>
      </main>

      <footer className="text-center text-sm text-muted">
        <div className="ornament opacity-90" style={{ height: 14, backgroundSize: "28px 14px" }} aria-hidden />
        <p className="px-4 py-6">Проект «Адал азамат» · уроки русской литературы и русского языка</p>
      </footer>

      <AnimatePresence>{open && <Chat key={open.id} character={open} onClose={closeChat} />}</AnimatePresence>
    </>
  );
}

function HeroCard({
  character: c,
  started,
  priority,
  onOpen,
}: {
  character: Character;
  started: boolean;
  priority: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Поговорить: ${c.name}`}
      className="group relative block aspect-[3/4] w-full overflow-hidden rounded-2xl bg-ink text-left shadow-[0_2px_10px_rgba(20,24,31,0.08)] ring-1 ring-black/5 transition duration-300 hover:-translate-y-1 hover:shadow-[0_18px_40px_-12px_rgba(20,24,31,0.45)] focus-visible:ring-4 focus-visible:ring-gold focus-visible:outline-none sm:rounded-3xl"
    >
      <Portrait
        character={c}
        sizes="(min-width: 1024px) 280px, (min-width: 640px) 33vw, 50vw"
        priority={priority}
        className="transition-transform duration-700 ease-out group-hover:scale-105"
      />

      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/45 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/55 to-transparent" />

      <span className="absolute top-2.5 right-2.5 left-2.5 line-clamp-2 sm:right-14 text-[11px] leading-tight font-medium text-white/90 sm:top-3.5 sm:left-3.5 sm:text-xs">
        {c.work}
      </span>

      <span className="absolute top-2.5 right-2.5 hidden size-9 place-items-center rounded-full bg-white/15 text-white opacity-0 backdrop-blur transition duration-300 group-hover:opacity-100 sm:grid">
        <ArrowUpRight size={18} />
      </span>

      <div className="absolute inset-x-0 bottom-0 p-3 text-white sm:p-4">
        <span className="mb-2 block h-1 w-8 rounded-full" style={{ background: c.color }} />
        <p className="font-serif text-lg leading-tight font-bold sm:text-xl">{c.name}</p>
        <p className="mt-1 line-clamp-1 text-xs text-white/75 sm:text-sm">{c.role}</p>
        <p className="mt-0.5 text-xs text-gold">{c.author}</p>
        {started && (
          <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium backdrop-blur">
            <MessageCircle size={12} /> Продолжить
          </span>
        )}
      </div>
    </button>
  );
}
