import os, re, json, sys
from collections import Counter, defaultdict
sys.path.insert(0, "/private/tmp/claude-501/-Users-yi-rang-Documents-ChatGPT------site/905f6d7c-db44-436e-9a5b-0d71e769275c/scratchpad")
from animss import parts, clips
CHK = "/Users/yi-rang/Downloads/prospi-a-card-effects/chk"
files = sorted(f for f in os.listdir(CHK) if f.endswith("_L.CHK"))

graph = {}
kindtot = Counter(); ext = Counter()
for n, fn in enumerate(files):
    eid = re.match(r"ANSS_EF_(\d+)_L\.CHK$", fn).group(1)
    if n % 200 == 0: print(f"  ...{n}", flush=True)
    d, ps = parts(os.path.join(CHK, fn))
    entry = {"parts": [], "refs": Counter()}
    for part in ps:
        cs = list(clips(d, part))
        if not cs: continue
        main = cs[0]
        kinds = Counter(nd["kind"] for nd in main["nodes"])
        kindtot.update(kinds)
        inst = [nd["name"] for nd in main["nodes"] if nd["kind"] == 3]
        for nm in inst:
            m = re.match(r"^ef_(\d+)_", nm)
            if m: entry["refs"][m.group(1)] += 1
        entry["parts"].append({"name": part["name"], "clips": len(cs),
                               "nodes": len(main["nodes"]),
                               "groups": kinds.get(0,0), "sprites": kinds.get(1,0),
                               "instances": kinds.get(3,0)})
    outside = {k: v for k, v in entry["refs"].items() if k != eid}
    if outside: ext[eid] = sum(outside.values())
    graph[eid] = {"parts": entry["parts"], "refs": dict(entry["refs"])}

json.dump(graph, open("/tmp/effect_graph.json","w"), separators=(",",":"))
print(f"\neffects={len(graph)}  node kinds overall: {dict(kindtot)}")
print(f"effects that instance ANOTHER effect: {len(ext)} / {len(graph)}")

# rank relationship: does rank5 reference rank4 of the same series?
pairs = Counter()
for eid, g in graph.items():
    for ref, c in g["refs"].items():
        if ref == eid: continue
        pairs[(eid[-1], ref[-1])] += 1
print("\nreferencing rank -> referenced rank (count of edges):")
for (a,b), c in sorted(pairs.items()):
    print(f"  rank {a} -> rank {b}: {c}")

tot = Counter()
for eid, g in graph.items():
    for p in g["parts"]:
        tot["clips"] += p["clips"]; tot["nodes"] += p["nodes"]
        tot["groups"] += p["groups"]; tot["sprites"] += p["sprites"]; tot["instances"] += p["instances"]
print("\ntotals:", dict(tot))
