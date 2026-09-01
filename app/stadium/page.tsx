"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type MeshRec = {
  name: string;
  file: string;
  nvert: number;
  nidx: number;
  stride: number;
  posOff: number;
  fit: number;
  bbox: number[];
};

type Joint = { i: number; name: string; parent: number; world: number[]; chain: string };
type Skeleton = { resource: string; count: number; joints: Joint[] };
type Placement = {
  name: string;
  file: string;
  group: string;
  anchor?: number[];
  basis?: number[][];
  single?: boolean;
};

type MeshData = {
  name: string;
  verts: number[][];
  uvs?: number[][];
  indices: number[];
  bbox: number[];
};

/** Camera presets, in the game's own world units.
 *  Scale is 1 unit = 10 cm, confirmed three ways: pitching rubber sits at
 *  z = -180 (18 m ~ 60.5 ft), a floodlight tower is 451 tall (45 m), and a
 *  player torso spans y 10.8-16.1 (1.08-1.61 m). Home plate is the origin,
 *  second base is at z = -391, the outfield wall at z ~ -1300. */
const VIEWS = {
  batter: { pos: [0, 22, 34], target: [0, 11, -185], fov: 34 },
  pitcher: { pos: [0, 28, -238], target: [0, 11, 10], fov: 40 },
  catcher: { pos: [0, 15, 14], target: [0, 10, -190], fov: 46 },
  high: { pos: [0, 560, 1080], target: [0, 30, -420], fov: 46 },
  // framed from the core stadium bounds: x±997, y -4..452, z -1374..649
  aerial: { pos: [0, 2220, 1185], target: [0, 224, -362], fov: 50 },
  firstbase: { pos: [900, 260, -260], target: [-80, 30, -500], fov: 48 },
  // frames the batter standing in the box (player root at -7.5, 0, 1.5)
  player: { pos: [14, 13, 30], target: [-7.5, 9, 1.5], fov: 42 },
} as const;

type ViewKey = keyof typeof VIEWS;

/** Colour by structural role, parsed out of the resource name. */
function colorFor(name: string): THREE.Color {
  const n = name.toLowerCase();
  if (n.includes("grass") || n.includes("turf")) return new THREE.Color(0x3f7d33);
  if (n.includes("soil") || n.includes("ground_") || n.includes("mound")) return new THREE.Color(0x8a5a38);
  if (n.includes("light")) return new THREE.Color(0xbfc6cc);
  if (n.includes("seat") || n.includes("stand") || n.includes("bench")) return new THREE.Color(0x2f4f6b);
  if (n.includes("net") || n.includes("fence") || n.includes("wire")) return new THREE.Color(0x9aa5ad);
  if (n.includes("wall")) return new THREE.Color(0x1f4a3d);
  if (n.includes("sb_") || n.includes("scorebord") || n.includes("scoreboard")) return new THREE.Color(0x1a1c1f);
  if (n.includes("soto") || n.includes("city") || n.includes("buil")) return new THREE.Color(0x6a6f77);
  if (n.includes("sky") || n.includes("cloud")) return new THREE.Color(0x8fb8de);
  if (n.includes("shadow")) return new THREE.Color(0x24303a);
  return new THREE.Color(0x7e878f);
}

/** Triangle strips come straight off the GPU buffer; degenerate joins are used
 *  to stitch runs, so drop those and flip winding on odd steps. */
function stripToTriangles(idx: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < idx.length; i++) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a === b || b === c || a === c) continue;
    if (i % 2 === 0) out.push(a, b, c);
    else out.push(a, c, b);
  }
  return out;
}

export default function StadiumPage() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("initialising");
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [view, setView] = useState<ViewKey>("aerial");
  const viewRef = useRef<ViewKey>("aerial");
  const [showPlayers, setShowPlayers] = useState(true);
  const [showBackdrop, setShowBackdrop] = useState(false);
  const [showRefs, setShowRefs] = useState(false);
  const [showSkel, setShowSkel] = useState(false);
  const [singleOnly, setSingleOnly] = useState(true);
  const [wire, setWire] = useState(false);

  const apiRef = useRef<{
    setView: (v: ViewKey) => void;
    setPlayers: (b: boolean) => void;
    setBackdrop: (b: boolean) => void;
    setRefs: (b: boolean) => void;
    setSkel: (b: boolean) => void;
    setSingle: (b: boolean) => void;
    setWire: (b: boolean) => void;
  } | null>(null);

  useEffect(() => {
    const mount: HTMLDivElement | null = mountRef.current;
    if (!mount) return;
    const host: HTMLDivElement = mount;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121a24);
    scene.fog = new THREE.Fog(0x0d1117, 2600, 9000);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 30000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xeaf2fb, 0x3a4a3a, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(300, 700, 200);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xc8d8ec, 0.7);
    fill.position.set(-260, 420, -700);
    scene.add(fill);

    // three layers: the playing field + bowl, the far backdrop (city/sky
    // billboards that engulf the camera if left on), and the player parts.
    const stadiumGroup = new THREE.Group();
    const backdropGroup = new THREE.Group();
    const playerGroup = new THREE.Group();
    const skelGroup = new THREE.Group();
    // The rig is authored around the origin with the feet at y=0, so drop the
    // whole player into the batter's box: third-base side of the plate (+x is
    // the first-base side) and level with it on z.
    const playerRoot = new THREE.Group();
    playerRoot.position.set(-7.5, 0, 1.5);
    playerRoot.add(playerGroup, skelGroup);
    scene.add(stadiumGroup, backdropGroup, playerRoot);
    backdropGroup.visible = false;

    // Reference markers in world space: home plate at the origin, the mound at
    // z=-180, and +/-400 on x. They make it obvious whether a gap in the render
    // is a camera-framing problem or genuinely missing geometry.
    const refGroup = new THREE.Group();
    scene.add(refGroup);
    const mk = (x: number, y: number, z: number, color: number, r = 9) => {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(r, 12, 10),
        new THREE.MeshBasicMaterial({ color }),
      );
      m.position.set(x, y, z);
      refGroup.add(m);
    };
    mk(0, 6, 0, 0xffffff, 11);      // home plate
    mk(0, 6, -180, 0xff5555, 9);    // pitching rubber
    mk(400, 6, 0, 0x55ff55, 9);     // +x (first base side)
    mk(-400, 6, 0, 0x5599ff, 9);    // -x (third base side)
    mk(0, 6, -1300, 0xffcc44, 12);  // centre field wall

    let disposed = false;
    const materials: THREE.Material[] = [];
    const singleFiles = new Set<string>();

    function applyView(v: ViewKey) {
      const p = VIEWS[v];
      camera.fov = p.fov;
      camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
      camera.lookAt(p.target[0], p.target[1], p.target[2]);
      camera.updateProjectionMatrix();
    }

    function resize() {
      const w = host.clientWidth || 960;
      const h = host.clientHeight || 600;
      // updateStyle must stay on: without it the canvas keeps its backing-store
      // size as its CSS size and only its top-left corner is visible.
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    (async () => {
      setStatus("loading manifest");
      const [manifest, skel, placements, texCfg]: [
        MeshRec[], Skeleton, Placement[], { maps: Record<string, string> },
      ] = await Promise.all([
        fetch("/prospi/index.json").then((r) => r.json()),
        fetch("/prospi/skeleton.json").then((r) => r.json()),
        fetch("/prospi/player.json").then((r) => r.json()),
        fetch("/prospi/textures.json").then((r) => r.json()).catch(() => ({ maps: {} })),
      ]);
      const texLoader = new THREE.TextureLoader();
      const texCache = new Map<string, THREE.Texture>();
      const getTex = (fileName: string) => {
        let t = texCache.get(fileName);
        if (!t) {
          t = texLoader.load(`/prospi/tex/${fileName}`);
          t.colorSpace = THREE.SRGBColorSpace;
          t.flipY = false;          // game UVs already have v=0 at the top
          texCache.set(fileName, t);
        }
        return t;
      };
      const placeByFile = new Map(placements.map((p) => [p.file, p]));
      placements.filter((p) => p.single).forEach((p) => singleFiles.add(p.file));

      // rest-pose skeleton as lines, so the rig is visible even before parts land
      const jw = skel.joints.map((j) => j.world);
      const bonePts: number[] = [];
      for (const j of skel.joints) {
        if (j.parent < 0) continue;
        const a = jw[j.parent], b = j.world;
        bonePts.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      const boneGeom = new THREE.BufferGeometry();
      boneGeom.setAttribute("position", new THREE.Float32BufferAttribute(bonePts, 3));
      skelGroup.add(new THREE.LineSegments(
        boneGeom, new THREE.LineBasicMaterial({ color: 0xffe066 }),
      ));
      for (const j of skel.joints) {
        const d = new THREE.Mesh(
          new THREE.SphereGeometry(0.28, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xff8844 }),
        );
        d.position.set(j.world[0], j.world[1], j.world[2]);
        skelGroup.add(d);
      }
      const stadium = manifest.filter((m) =>
        /^(DBOCCYAN|BOCCYAN|SKYF)/.test(m.name),
      );
      const players = manifest.filter((m) => /^(MATCH_|FACE_|PLAYER)/.test(m.name));
      const wanted = [...stadium, ...players];
      setTotal(wanted.length);
      setStatus(`loading ${stadium.length} stadium + ${players.length} player meshes`);

      let done = 0;
      for (const rec of wanted) {
        if (disposed) return;
        try {
          const d: MeshData = await fetch(`/prospi/${rec.file}`).then((r) => r.json());
          const positions = new Float32Array(d.verts.length * 3);
          for (let i = 0; i < d.verts.length; i++) {
            positions[i * 3] = d.verts[i][0];
            positions[i * 3 + 1] = d.verts[i][1];
            positions[i * 3 + 2] = d.verts[i][2];
          }
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          if (d.uvs && d.uvs.length === d.verts.length) {
            const uv = new Float32Array(d.uvs.length * 2);
            for (let i = 0; i < d.uvs.length; i++) {
              uv[i * 2] = d.uvs[i][0];
              uv[i * 2 + 1] = d.uvs[i][1];
            }
            geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          }

          const isStadium = /^(DBOCCYAN|BOCCYAN|SKYF)/.test(d.name);
          let obj: THREE.Object3D;
          if (d.indices && d.indices.length > 2) {
            const tris = stripToTriangles(d.indices);
            geom.setIndex(tris);
            geom.computeVertexNormals();
            const texFile = texCfg.maps?.[d.name];
            const mat = new THREE.MeshLambertMaterial({
              color: texFile ? 0xffffff : colorFor(d.name),
              map: texFile && geom.getAttribute("uv") ? getTex(texFile) : null,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.97,
            });
            materials.push(mat);
            obj = new THREE.Mesh(geom, mat);
          } else {
            const mat = new THREE.PointsMaterial({ color: colorFor(d.name), size: 2.2 });
            materials.push(mat);
            obj = new THREE.Points(geom, mat);
          }
          obj.name = d.name;
          obj.userData.file = rec.file;
          const place = placeByFile.get(rec.file);
          if (place?.anchor && place?.basis) {
            // world = anchor + [ex ey ez] * local, with ex/ey/ez as columns
            const [ex, ey, ez] = place.basis;
            const a = place.anchor;
            obj.matrix.set(
              ex[0], ey[0], ez[0], a[0],
              ex[1], ey[1], ez[1], a[1],
              ex[2], ey[2], ez[2], a[2],
              0, 0, 0, 1,
            );
            obj.matrixAutoUpdate = false;
          }
          const isBackdrop = /soto|city|buil|SKYF|cloud|shadow_model/i.test(d.name);
          if (isBackdrop) backdropGroup.add(obj);
          else if (isStadium) stadiumGroup.add(obj);
          else {
            playerGroup.add(obj);
            if (singleFiles.size && !singleFiles.has(rec.file)) obj.visible = false;
          }
        } catch {
          /* skip meshes that fail to load */
        }
        done++;
        if (done % 8 === 0 || done === wanted.length) setLoaded(done);
      }
      setStatus(`경기장 ${stadiumGroup.children.length} · 배경 ${backdropGroup.children.length} · 선수 ${playerGroup.children.length}`);
    })();

    applyView(viewRef.current);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // simple orbit: drag to rotate around the current target, wheel to dolly
    let dragging = false, lx = 0, ly = 0;
    let yaw = 0, pitch = 0, dist = 1;
    const onDown = (e: PointerEvent) => { dragging = true; lx = e.clientX; ly = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      yaw -= (e.clientX - lx) * 0.005;
      pitch -= (e.clientY - ly) * 0.005;
      pitch = Math.max(-1.2, Math.min(1.2, pitch));
      lx = e.clientX; ly = e.clientY;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dist = Math.max(0.25, Math.min(6, dist * (1 + Math.sign(e.deltaY) * 0.12)));
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    addEventListener("pointerup", onUp);
    addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    let raf = 0;
    const render = () => {
      const p = VIEWS[viewRef.current];
      const t = new THREE.Vector3(p.target[0], p.target[1], p.target[2]);
      const base = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]).sub(t);
      const r = base.length() * dist;
      const theta = Math.atan2(base.x, base.z) + yaw;
      const phi = Math.asin(Math.max(-0.99, Math.min(0.99, base.y / base.length()))) + pitch;
      camera.position.set(
        t.x + r * Math.cos(phi) * Math.sin(theta),
        t.y + r * Math.sin(phi),
        t.z + r * Math.cos(phi) * Math.cos(theta),
      );
      camera.lookAt(t);
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };
    render();

    apiRef.current = {
      setView: (v) => { yaw = 0; pitch = 0; dist = 1; applyView(v); },
      setPlayers: (b) => { playerGroup.visible = b; },
      setBackdrop: (b) => { backdropGroup.visible = b; },
      setRefs: (b) => { refGroup.visible = b; },
      setSkel: (b) => { skelGroup.visible = b; },
      setSingle: (b) => {
        playerGroup.children.forEach((c) => {
          c.visible = !b || singleFiles.has(c.userData.file as string);
        });
      },
      setWire: (b) => {
        materials.forEach((m) => {
          if ((m as THREE.MeshLambertMaterial).isMeshLambertMaterial) {
            (m as THREE.MeshLambertMaterial).wireframe = b;
          }
        });
      },
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      removeEventListener("pointerup", onUp);
      removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    viewRef.current = view;
    apiRef.current?.setView(view);
  }, [view]);
  useEffect(() => { apiRef.current?.setPlayers(showPlayers); }, [showPlayers]);
  useEffect(() => { apiRef.current?.setBackdrop(showBackdrop); }, [showBackdrop]);
  useEffect(() => { apiRef.current?.setRefs(showRefs); }, [showRefs]);
  useEffect(() => { apiRef.current?.setSkel(showSkel); }, [showSkel]);
  useEffect(() => { apiRef.current?.setSingle(singleOnly); }, [singleOnly]);
  useEffect(() => { apiRef.current?.setWire(wire); }, [wire]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0d1117", color: "#e6edf3",
                  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif" }}>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      <div style={{ position: "absolute", top: 12, left: 12, padding: "10px 14px",
                    background: "rgba(13,17,23,.82)", border: "1px solid #30363d",
                    borderRadius: 8, fontSize: 13, lineHeight: 1.7, maxWidth: 340 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>프로스피A — 추출 경기장</div>
        <div style={{ opacity: 0.85 }}>{status}</div>
        {total > 0 && loaded < total && (
          <div style={{ opacity: 0.7 }}>{loaded} / {total}</div>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(VIEWS) as ViewKey[]).map((v) => (
            <button key={v} onClick={() => setView(v)}
              style={{ padding: "4px 9px", fontSize: 12, borderRadius: 5, cursor: "pointer",
                       border: "1px solid " + (view === v ? "#58a6ff" : "#30363d"),
                       background: view === v ? "#1f6feb" : "#161b22", color: "#e6edf3" }}>
              {v}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: 12 }}>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={showPlayers}
                   onChange={(e) => setShowPlayers(e.target.checked)} /> 선수
          </label>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={showBackdrop}
                   onChange={(e) => setShowBackdrop(e.target.checked)} /> 배경
          </label>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={singleOnly}
                   onChange={(e) => setSingleOnly(e.target.checked)} /> 단일 선수
          </label>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={showSkel}
                   onChange={(e) => setShowSkel(e.target.checked)} /> 골격
          </label>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={showRefs}
                   onChange={(e) => setShowRefs(e.target.checked)} /> 기준점
          </label>
          <label style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={wire}
                   onChange={(e) => setWire(e.target.checked)} /> 와이어프레임
          </label>
        </div>
        <div style={{ marginTop: 8, opacity: 0.55, fontSize: 11 }}>
          드래그 회전 · 휠 줌
        </div>
      </div>
    </div>
  );
}
