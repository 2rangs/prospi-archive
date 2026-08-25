"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 목록 상태를 주소창에 싣는다.
 *
 * [문제] 검색어·탭·페이지가 전부 useState 라 선수를 눌러 들어갔다 뒤로 오면
 *   처음 화면으로 돌아갔다. 스크롤도 맨 위로 튄다.
 * [처리] 상태를 쿼리스트링에 replaceState 로 계속 덮어쓴다. 상세로 이동하면
 *   그 주소가 히스토리에 남으므로 뒤로가기가 그대로 복원한다. 스크롤은
 *   sessionStorage 에 주소별로 적어 두었다가 목록이 그려진 뒤 되돌린다.
 */
export function useUrlState<T extends Record<string, string | number>>(
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const [state, setState] = useState<T>(defaults);
  const ready = useRef(false);

  // 첫 렌더에서 주소를 읽는다. 서버 렌더 결과와 어긋나지 않도록 effect 안에서 한다.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const next = { ...defaults };
    let touched = false;
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      const raw = q.get(String(k));
      if (raw == null) continue;
      touched = true;
      (next as Record<string, string | number>)[k as string] =
        typeof defaults[k] === "number" ? Number(raw) : raw;
    }
    ready.current = true;
    if (touched) setState(next);
    // defaults 는 매 렌더 새 객체라 의존성에서 뺀다. 마운트 1회만 읽으면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = useCallback((p: Partial<T>) => {
    setState(prev => {
      const next = { ...prev, ...p };
      if (ready.current && typeof window !== "undefined") {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(next)) {
          if (v === "" || v === defaults[k as keyof T]) continue;   // 기본값은 안 싣는다
          q.set(k, String(v));
        }
        const s = q.toString();
        window.history.replaceState(
          window.history.state, "",
          s ? `${window.location.pathname}?${s}` : window.location.pathname);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [state, patch];
}

/** 목록이 그려진 뒤 이전 스크롤 위치로 되돌린다. */
export function useScrollRestore(key: string, ready: boolean) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const save = () => sessionStorage.setItem(`scroll:${key}`, String(window.scrollY));
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    // 같은 문서 안에서 링크를 누를 때도 저장해야 한다
    const onClick = () => save();
    document.addEventListener("click", onClick, true);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("click", onClick, true);
    };
  }, [key]);

  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || typeof window === "undefined") return;
    const y = Number(sessionStorage.getItem(`scroll:${key}`) || 0);
    if (y > 0) {
      done.current = true;
      // 목록 높이가 잡힌 다음 프레임에 옮긴다
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
    } else {
      done.current = true;
    }
  }, [ready, key]);
}
