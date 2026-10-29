import type { Metadata, Viewport } from "next";
import { Inter, PT_Serif } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap",
});

const ptSerif = PT_Serif({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "700"],
  variable: "--font-pt-serif",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Адал азамат. Герои книг",
  description: "Поговори с героями книг из программы по русской литературе для 6-9 классов. Проект «Адал азамат».",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#00a3c4",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${ptSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
