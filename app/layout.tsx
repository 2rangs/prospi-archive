import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const image = `${protocol}://${host}/og.png`;
  const title = "PROSPI ARCHIVE — プロスピA 選手図鑑";
  const description = "アプリから直接抽出・検証したプロスピA の選手画像とデータのアーカイブ";
  return {
    title,
    description,
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" data-theme="dark">
      <head>
        {/*
          저장된 테마를 **첫 페인트 전에** 적용한다. useEffect 로만 적용하면
          하이드레이션 전까지 기본값 화면이 한 번 번쩍인다. 기본값은 다크다.
        */}
        <script dangerouslySetInnerHTML={{ __html:
          `try{var t=localStorage.getItem('prospi.theme')||'dark';`
          + `document.documentElement.dataset.theme=t}catch(e){}` }}/>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
