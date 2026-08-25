#!/usr/bin/env python3
"""인게임 UI · 배경 CHK 에서 스프라이트 시트(PNG)를 뽑는다.

컨테이너는 카드 이펙트(ANSS_EF_*.CHK)와 같은 'CHK ' 포맷이다:
  'CHK ' u32 hdrsize u32 flags u32 totalsize
  이어서 16바이트 태그 섹션: tag[4] id[2] pad[2] u32 padded u32 raw
    CLMP<nn> -> PNG 텍스처 시트 한 장
    PRCT<nn> -> AnimSS 파트
    DESC     -> 디스크립터
PNG 크기는 IHDR 을 직접 읽는다(PIL 불필요).
"""
import json, os, struct, sys, hashlib

SRC = "/Users/yi-rang/Documents/ChatGPT/프로스피/extracted/download/JP"
OUT = "public/sprites"


PNG_SIG = b"\x89PNG\r\n\x1a\n"


def png_blobs(d):
    """파일 안의 PNG 를 시그니처부터 IEND 까지 정확히 잘라 낸다.

    [문제] 16바이트 태그 섹션을 순회하는 방식은 DESC/PRCT 가 자기 길이를 따로
      선언해 padded=0 으로 나오는 지점에서 멈춘다. 그래서 파일당 1장만 나왔다.
    [처리] PNG 청크(length u32be + type + data + crc)를 IEND 까지 걸어 길이를
      구한다. 컨테이너 구조와 무관하게 전부 잡힌다.
    """
    i = 0
    while True:
        i = d.find(PNG_SIG, i)
        if i < 0:
            return
        off = i + 8
        ok = False
        while off + 8 <= len(d):
            ln = struct.unpack_from(">I", d, off)[0]
            typ = d[off + 4:off + 8]
            off += 12 + ln                      # length + type + data + crc
            if typ == b"IEND":
                ok = True
                break
            if ln > len(d):                     # 깨진 청크
                break
        if ok:
            yield i, d[i:off]
            i = off
        else:
            i += 8


def png_size(b):
    if b[:8] != PNG_SIG or b[12:16] != b"IHDR":
        return None
    return struct.unpack_from(">II", b, 16)


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = []
    seen = {}
    for name in sorted(os.listdir(SRC)):
        if not name.endswith(".CHK"):
            continue
        d = open(os.path.join(SRC, name), "rb").read()
        base = name[:-4]
        n = 0
        for idx, (off, body) in enumerate(png_blobs(d)):
            size = png_size(body)
            if not size or size[0] < 2 or size[1] < 2:
                continue
            h = hashlib.md5(body).hexdigest()[:12]
            fn = f"{idx:03d}_{size[0]}x{size[1]}_{h}.png"
            rel = f"{base}/{fn}"
            if h not in seen:
                os.makedirs(os.path.join(OUT, base), exist_ok=True)
                open(os.path.join(OUT, base, fn), "wb").write(body)
                seen[h] = rel
            manifest.append({"source": base, "index": idx, "offset": off,
                             "w": size[0], "h": size[1], "bytes": len(body),
                             "file": seen[h], "md5": h})
            n += 1
        if n:
            print(f"  {base:32s} {n:4d}장")

    json.dump(manifest, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    uniq = len(seen)
    total = sum(m["bytes"] for m in manifest if m["file"].endswith(m["md5"] + ".png"))
    print(f"\n시트 {len(manifest)}장 (고유 {uniq}장) · {total/1e6:.1f} MB · {OUT}/index.json")


if __name__ == "__main__":
    main()
