#!/usr/bin/env python3
"""기존 public/effects/anim/*.json 에 애니메이션 반복 플래그를 덧붙인다.

PIL 없이 재추출할 수 없어서, CHK 를 다시 걸어 (파트, 클립, 애님) 순서대로
노드 이름 열을 만들고 JSON 의 parts 와 앞에서부터 맞춰 본다. 이름이 어긋나면
그 이펙트는 건드리지 않는다(정렬 실패로 기록).
"""
import sys, types, struct, json, os, glob, collections

im = types.ModuleType("PIL.Image"); pil = types.ModuleType("PIL"); pil.Image = im
sys.modules["PIL"] = pil; sys.modules["PIL.Image"] = im
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
_src = open(os.path.join(os.path.dirname(__file__), "export_anim.py"), encoding="utf-8").read()
_ns = {"__name__": "ea", "__file__": os.path.abspath(os.path.join(os.path.dirname(__file__), "export_anim.py"))}
exec(compile(_src, "export_anim", "exec"), _ns)
anim_parts, _cstr, clips_ex, find_anim = _ns["anim_parts"], _ns["_cstr"], _ns["clips_ex"], _ns["find_anim"]

CHK_DIR = "/Users/yi-rang/Downloads/prospi-a-card-effects/chk"


def anim_loop(d, cb, t_off, t_cnt):
    for t in range(t_cnt):
        _pi, ao, ac = struct.unpack_from("<QQQ", d, cb + t_off + t*0x18)
        for i in range(ac):
            aid, ko, kc = struct.unpack_from("<QQQ", d, cb + ao + i*0x18)
            if aid != 30 or kc > 4096:
                continue
            for k in range(kc):
                o = cb + ko + k*0x28
                if o + 0x28 > len(d):
                    break
                u = struct.unpack_from("<I", d, o + 0x20)[0]
                if _cstr(d, cb + u + 0x30, 0x40).startswith("[LOOP]"):
                    return True
    return False


def node_seq(path):
    """(이름, 애니길이, 반복) 을 CHK 순회 순서대로."""
    d, ps = anim_parts(path)
    seq = []
    for p in ps:
        cb = p["cb"]
        for clip in clips_ex(d, p):
            a_off, a_cnt = clip["anims"]
            for ai in range(a_cnt):
                got = find_anim(d, cb, clip, index=ai)
                if not got:
                    continue
                _, t_off, t_cnt, _fps, length = got
                lp = anim_loop(d, cb, t_off, t_cnt)
                for t in range(t_cnt):
                    pi, _ao, _ac = struct.unpack_from("<QQQ", d, cb + t_off + t*0x18)
                    nm = clip["nodes"][pi]["name"] if pi < len(clip["nodes"]) else f"#{pi}"
                    seq.append((nm, length, lp))
    return seq


def main():
    ok = bad = skipped = 0
    changed = collections.Counter()
    for jf in sorted(glob.glob("public/effects/anim/*.json")):
        eid = os.path.basename(jf)[:-5]
        chk = os.path.join(CHK_DIR, f"ANSS_EF_{eid}_L.CHK")
        if not os.path.exists(chk):
            skipped += 1
            continue
        doc = json.load(open(jf, encoding="utf-8"))
        try:
            seq = node_seq(chk)
        except Exception:
            bad += 1
            continue
        # (이름, len) 조합별 반복값을 표로 만든다. 같은 조합이 서로 다른
        # 반복값을 가지면 그 조합은 판정 보류(None)로 둔다.
        table = {}
        for nm, ln, lp in seq:
            key = (nm, ln)
            if key in table and table[key] != lp:
                table[key] = None
            else:
                table.setdefault(key, lp)
        hit = miss = 0
        for part in doc["parts"]:
            lp = table.get((part["n"], part.get("len")))
            if lp is None:
                miss += 1
                continue
            part["loop"] = lp
            hit += 1
            changed[lp] += 1
        if hit:
            json.dump(doc, open(jf, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            ok += 1
        else:
            bad += 1
    print(f"이펙트 {ok}개 갱신 · 실패 {bad} · 원본없음 {skipped}")
    print(f"파트 반복 True {changed[True]:,} · False {changed[False]:,}")


if __name__ == "__main__":
    main()
