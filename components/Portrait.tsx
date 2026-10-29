import Image from "next/image";
import clsx from "clsx";
import type { Character } from "@/lib/characters";
import { PHOTOS } from "@/lib/photos";

const photos = new Set(PHOTOS);

function initials(name: string) {
  return name
    .replace(/\(.*?\)/g, "")
    .split(/[\s-]+/)
    .filter((w) => /^[А-ЯЁA-Z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}

type Props = {
  character: Character;
  variant?: "card" | "square";
  sizes: string;
  priority?: boolean;
  className?: string;
};

// Фото героя или, если его нет, инициалы на цветном фоне.
export default function Portrait({ character, variant = "card", sizes, priority, className }: Props) {
  const { person, name, color } = character;

  if (photos.has(person)) {
    return (
      <Image
        src={`/img/people/${person}${variant === "square" ? "-sq" : ""}.webp`}
        alt={name}
        fill
        sizes={sizes}
        priority={priority}
        className={clsx("object-cover", className)}
      />
    );
  }

  return (
    <div
      className={clsx("absolute inset-0 grid place-items-center font-serif font-bold text-white/90", className)}
      style={{ background: `linear-gradient(160deg, ${color}, color-mix(in srgb, ${color} 50%, #000))` }}
    >
      <span className={variant === "square" ? "text-[0.9em]" : "text-6xl"}>{initials(name)}</span>
    </div>
  );
}
