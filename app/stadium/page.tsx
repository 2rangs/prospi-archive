"use client";
/**
 * 인게임 타석 — 추출한 실제 경기장/선수 메시 위에서 도는 투타.
 *
 * /vroad 의 물리·판정과 /stadium 의 추출 에셋을 합친 것. RES 팩 암호는 못 깼지만
 * 런타임 캡처로 지오메트리는 확보했으므로, 절차적으로 그리던 잔디·담장·스탠드를
 * 게임 본체의 메시로 갈아끼웠다.
 *
 * 좌표계: 물리는 미터, 추출 메시는 1유닛=10cm 라 STADIUM_SCALE 0.1 로 맞춘다.
 * 두 좌표계 모두 홈플레이트가 원점이라 그 외 보정은 없다.
 * 타격 모델은 프로스피와 같은 2축:
 *   미트 커서(마우스로 코스 조준) × 타이밍(Space). 미트 스탯이 커서 크기와
 *   타이밍 허용창을 키우고, 파워가 타구 초속을 키워 비거리로 안타/홈런을 가른다.
 * 구속(km/h)->비행시간, 구종 화살표->변화 방향, 구종 파워->변화량.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type Pitch = { name: string; nameJa?: string; arrow: string; power: number | null; level?: number; rank?: string; speed: number | null; direction: number };
type Card = {
  id: string; name: string; playerType: "batter" | "pitcher"; roman?: string;
  group: number; file: string; largeFile: string;
  base?: { meetR: number; meetL: number; power: number; run: number } | null;
  pitching?: { maxSpeed: number; stamina: number; pitches: Pitch[] } | null;
};
const cardArt = (c: Card) => `/api/card-image?group=${c.group}&file=${encodeURIComponent(c.largeFile)}&v=2`;

const PLATE_Z = 0, MOUND_Z = -18.44, G = 9.8;
/**
 * Fence distance by spray angle, measured off the extracted field itself
 * (the warning-track outer edge, which is where the wall sits).
 *
 * The park is perfectly symmetric at every angle, so it is NOT Es Con Field,
 * whose real dimensions are asymmetric (LF 97 m, CF 121 m, RF 100 m). The
 * measurements — 122.5 m to centre, 107.8 m in the power alleys, ~100 m down the
 * lines — match Tokyo Dome. An earlier note in the handoff called this Es Con
 * because TEAM_maku_fighters loaded alongside it, but that banner just reflects
 * the team the tutorial had us pick, not the venue.
 *
 * Angle is degrees from centre field, positive toward right.
 */
const FENCE_PROFILE: Record<number, number> = {
  "-45": 100.0, "-30": 107.8, "-15": 117.1, "0": 122.5,
  "15": 117.1, "30": 107.8, "45": 100.0,
};
function fenceAt(x: number, z: number): number {
  const deg = Math.max(-45, Math.min(45, Math.atan2(x, -z) * 180 / Math.PI));
  const lo = Math.floor(deg / 15) * 15;
  const hi = Math.min(45, lo + 15);
  const a = FENCE_PROFILE[lo] ?? 100, b = FENCE_PROFILE[hi] ?? 100;
  return a + (b - a) * Math.min(1, Math.max(0, (deg - lo) / 15));
}
/** deepest point, for camera framing only */
const FENCE = 122.5;
const ZONE_Y = 1.05, ZONE_HALF_W = 0.55, ZONE_HALF_H = 0.6;
const BREAK_DIR: Record<string, [number, number]> = {
  "←": [-1, 0], "↙": [-0.7, -0.7], "↓": [0, -1], "↘": [0.7, -0.7], "→": [1, 0], "●": [0, 0.15],
};
const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
const OHTANI_PITCHER_ID = "1139455100";
const OHTANI_BATTER_ID = "1139453200";

export default function VRoad() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [batter, setBatter] = useState<Card | null>(null);
  const [pitcher, setPitcher] = useState<Card | null>(null);
  const [count, setCount] = useState({ b: 0, s: 0, o: 0 });
  const [score, setScore] = useState<{ h: number; hr: number; ab: number; tb?: number }>({ h: 0, hr: 0, ab: 0, tb: 0 });
  const [incoming, setIncoming] = useState<string>("");
  const [phase, setPhase] = useState("READY");
  const [overlay, setOverlay] = useState<{ text: string; kind: string } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const api = useRef<{ pitch: () => void; swing: () => void } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/data/cards.json").then(r => r.json()).then((cards: Card[]) => {
      if (!alive) return;
      const ohtani = cards.filter(c => c.name.replace(/\s/g, "") === "大谷翔平");
      const bats = ohtani.filter(c => c.playerType === "batter" && c.base);
      const pits = ohtani.filter(c => c.playerType === "pitcher" && c.pitching?.pitches.length);
      setBatter(cards.find(c => c.id === OHTANI_BATTER_ID) ?? bats.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null);
      setPitcher(cards.find(c => c.id === OHTANI_PITCHER_ID) ?? pits.sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!mountRef.current || !batter || !pitcher) return;
    const mount = mountRef.current;
    let W = mount.clientWidth, H = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b1a2e, 140, 340);
    // 하늘 그라디언트
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { top: { value: new THREE.Color(0x0a2a5e) }, bot: { value: new THREE.Color(0x0b1420) } },
        vertexShader: "varying vec3 p; void main(){ p=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} ",
        fragmentShader: "varying vec3 p; uniform vec3 top; uniform vec3 bot; void main(){ float h=clamp((p.y/400.0)*0.5+0.5,0.0,1.0); gl_FragColor=vec4(mix(bot,top,h),1.0);} ",
      }));
    scene.add(sky);

    const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 1000);
    const camHome = new THREE.Vector3(0, 4.6, 9.6), camLook = new THREE.Vector3(0, 2.4, MOUND_Z * 0.72);
    camera.position.copy(camHome); camera.lookAt(camLook);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(W, H); renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x1a3d1a, 1.0));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
    sun.position.set(35, 70, 25); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, far: 250 });
    scene.add(sun);
    // 조명탑 4개
    for (const [x, z] of [[-70, -60], [70, -60], [-95, -95], [95, -95]] as const) {
      const l = new THREE.SpotLight(0xffffff, 300, 320, 0.7, 0.4, 1.2);
      l.position.set(x, 55, z); l.target.position.set(0, 0, MOUND_Z); scene.add(l); scene.add(l.target);
    }

    /**
     * Real stadium, streamed in from the extracted meshes.
     *
     * The capture is in the game's own units where 1 = 10 cm (pitching rubber at
     * z = -180, floodlight 451 tall), while this scene is metric (MOUND_Z =
     * -18.44). So the whole set scales by 0.1 and lands exactly on the physics
     * coordinates — home plate is the origin in both.
     */
    const STADIUM_SCALE = 0.1;
    const stadium = new THREE.Group();
    stadium.scale.setScalar(STADIUM_SCALE);
    scene.add(stadium);
    /**
     * The extracted player parts are not drawn here.
     *
     * They come out of the capture in a rest pose with no skinning, so they
     * cannot swing, and standing one in the box just puts a frozen T-pose on top
     * of the rig that does animate. The stadium has no such problem — it is
     * static geometry, which is why it swaps in cleanly.
     *
     * Replacing the rig with the real mesh needs the JIF skeleton bound to the
     * vertices (bone weights live in the VBO but the palette was never captured).
     */
    const players = new THREE.Group();
    players.scale.setScalar(STADIUM_SCALE);
    players.visible = false;
    scene.add(players);

    function stripToTris(idx: number[]): number[] {
      const out: number[] = [];
      for (let i = 0; i + 2 < idx.length; i++) {
        const a = idx[i], b = idx[i + 1], c = idx[i + 2];
        if (a === b || b === c || a === c) continue;
        if (i % 2 === 0) out.push(a, b, c); else out.push(a, c, b);
      }
      return out;
    }
    function roleColor(n: string): number {
      const s = n.toLowerCase();
      if (s.includes("grass") || s.includes("turf")) return 0x3f7d33;
      if (s.includes("soil") || s.includes("ground_") || s.includes("mound")) return 0x8a5a38;
      if (s.includes("light")) return 0xbfc6cc;
      if (s.includes("seat") || s.includes("stand") || s.includes("bench")) return 0x2f4f6b;
      if (s.includes("net") || s.includes("fence") || s.includes("wire")) return 0x9aa5ad;
      if (s.includes("wall")) return 0x1f4a3d;
      if (s.includes("sb_") || s.includes("scorebord")) return 0x1a1c1f;
      return 0x7e878f;
    }

    (async () => {
      try {
        const [manifest, place, texCfg] = await Promise.all([
          fetch("/prospi/index.json").then(r => r.json()),
          fetch("/prospi/player.json").then(r => r.json()).catch(() => []),
          fetch("/prospi/textures.json").then(r => r.json()).catch(() => ({ maps: {} })),
        ]);
        const placeByFile = new Map<string, any>((place as any[]).map(p => [p.file, p]));
        const singles = new Set<string>((place as any[]).filter(p => p.single).map(p => p.file));
        const loader = new THREE.TextureLoader();
        const texCache = new Map<string, THREE.Texture>();
        const getTex = (f: string) => {
          let t = texCache.get(f);
          if (!t) {
            t = loader.load(`/prospi/tex/${f}`);
            t.colorSpace = THREE.SRGBColorSpace;
            t.flipY = false;
            texCache.set(f, t);
          }
          return t;
        };
        // the far city/sky billboards swallow the batter camera, so leave them out
        const wanted = (manifest as any[]).filter(m =>
          !/soto|city|buil|SKYF|cloud|shadow_model/i.test(m.name));

        for (const rec of wanted) {
          const d = await fetch(`/prospi/${rec.file}`).then(r => r.json());
          if (!d.indices || d.indices.length < 3) continue;
          const pos = new Float32Array(d.verts.length * 3);
          for (let i = 0; i < d.verts.length; i++) {
            pos[i * 3] = d.verts[i][0]; pos[i * 3 + 1] = d.verts[i][1]; pos[i * 3 + 2] = d.verts[i][2];
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
          if (d.uvs && d.uvs.length === d.verts.length) {
            const uv = new Float32Array(d.uvs.length * 2);
            for (let i = 0; i < d.uvs.length; i++) { uv[i * 2] = d.uvs[i][0]; uv[i * 2 + 1] = d.uvs[i][1]; }
            g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
          }
          g.setIndex(stripToTris(d.indices));
          g.computeVertexNormals();
          const tf = (texCfg as any).maps?.[d.name];
          const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
            color: tf ? 0xffffff : roleColor(d.name),
            map: tf && g.getAttribute("uv") ? getTex(tf) : null,
            side: THREE.DoubleSide,
          }));
          const isPlayerPart = /^(MATCH_|FACE_|PLAYER)/.test(d.name);
          if (isPlayerPart) {
            if (!singles.has(rec.file)) continue;   // one curated player, not the whole part library
            const p = placeByFile.get(rec.file);
            if (p?.anchor && p?.basis) {
              const [ex, ey, ez] = p.basis, a = p.anchor;
              mesh.matrix.set(ex[0], ey[0], ez[0], a[0],
                              ex[1], ey[1], ez[1], a[1],
                              ex[2], ey[2], ez[2], a[2], 0, 0, 0, 1);
              mesh.matrixAutoUpdate = false;
            }
            players.add(mesh);
          } else {
            stadium.add(mesh);
          }
        }
        // stand the extracted player in the batter's box, facing the mound
        players.position.set(-0.75, 0, 0.15);
      } catch {
        /* fall back to a bare field if the extracted set is unavailable */
      }
    })();

    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), new THREE.MeshStandardMaterial({ color: 0xf0f0f0 }));
    plate.position.set(0, 0.03, PLATE_Z); scene.add(plate);
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 3.2, 0.35, 24), new THREE.MeshStandardMaterial({ color: 0x8a5a3b }));
    mound.position.set(0, 0.17, MOUND_Z); scene.add(mound);

    // 스트라이크존
    const zoneEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ZONE_HALF_W * 2, ZONE_HALF_H * 2)),
      new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.55 }));
    zoneEdge.position.set(0, ZONE_Y, PLATE_Z + 0.15); scene.add(zoneEdge);

    // 미트 커서 (마우스 조준)
    const meetStat = batter.base ? (batter.base.meetR + batter.base.meetL) / 2 : 40;
    const power = batter.base?.power ?? 40;
    const runStat = batter.base?.run ?? 40;
    const cursorR = 0.16 + (meetStat / 100) * 0.22;
    const cursor = new THREE.Mesh(new THREE.RingGeometry(cursorR * 0.72, cursorR, 24),
      new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    cursor.position.set(0, ZONE_Y, PLATE_Z + 0.2); scene.add(cursor);
    const cursorDot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), new THREE.MeshBasicMaterial({ color: 0xffcc33 }));
    cursor.add(cursorDot);
    let cursorX = 0, cursorY = ZONE_Y;

    type Rig = {
      root: THREE.Group; torso: THREE.Group; head: THREE.Mesh;
      armL: THREE.Group; armR: THREE.Group; foreL: THREE.Group; foreR: THREE.Group;
      legL: THREE.Group; legR: THREE.Group;
    };
    const capsule = (radius: number, length: number, material: THREE.Material) => {
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 5, 10), material);
      mesh.castShadow = true; return mesh;
    };
    /** 공용 저폴리 선수 리그. 선수별로 모델을 복제하지 않고 유니폼 색만 바꾼다. */
    function playerRig(primary: number, secondary: number): Rig {
      const root = new THREE.Group();
      const uniform = new THREE.MeshStandardMaterial({ color: primary, roughness: 0.72 });
      const accent = new THREE.MeshStandardMaterial({ color: secondary, roughness: 0.7 });
      const skin = new THREE.MeshStandardMaterial({ color: 0xd8a277, roughness: 0.82 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x18202a, roughness: 0.85 });
      const torso = new THREE.Group(); torso.position.y = 1.24; root.add(torso);
      const chest = capsule(0.25, 0.52, uniform); chest.scale.set(1.2, 1, .72); torso.add(chest);
      const belt = new THREE.Mesh(new THREE.CylinderGeometry(.27,.25,.1,12), dark); belt.position.y=-.34;torso.add(belt);
      const head = new THREE.Mesh(new THREE.SphereGeometry(.205,16,12),skin);head.position.y=.57;head.castShadow=true;torso.add(head);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(.215,16,8,0,Math.PI*2,0,Math.PI*.52),accent);cap.position.y=.61;torso.add(cap);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(.28,.025,.16),accent);brim.position.set(0,.61,-.17);torso.add(brim);
      const makeArm=(x:number)=>{const a=new THREE.Group();a.position.set(x,.25,0);torso.add(a);const upper=capsule(.085,.34,uniform);upper.position.y=-.2;a.add(upper);const f=new THREE.Group();f.position.y=-.42;a.add(f);const fore=capsule(.072,.3,skin);fore.position.y=-.17;f.add(fore);const hand=new THREE.Mesh(new THREE.SphereGeometry(.085,10,8),skin);hand.position.y=-.37;f.add(hand);return [a,f] as const;};
      const [armL,foreL]=makeArm(-.34),[armR,foreR]=makeArm(.34);
      const makeLeg=(x:number)=>{const l=new THREE.Group();l.position.set(x,.82,0);root.add(l);const thigh=capsule(.12,.42,uniform);thigh.position.y=-.23;l.add(thigh);const shin=capsule(.1,.43,dark);shin.position.y=-.68;l.add(shin);const shoe=new THREE.Mesh(new THREE.BoxGeometry(.2,.12,.34),dark);shoe.position.set(0,-.96,-.07);l.add(shoe);return l;};
      const legL=makeLeg(-.14),legR=makeLeg(.14);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(.5,20),new THREE.MeshBasicMaterial({color:0,transparent:true,opacity:.3}));
      shadow.rotation.x=-Math.PI/2;shadow.position.y=.015;root.add(shadow);
      return {root,torso,head,armL,armR,foreL,foreR,legL,legR};
    }
    // 네이티브 분석 결과의 조립 단위(공통 리그 + 역할별 모션 + 선수 외형)를
    // 웹에서도 같은 책임으로 분리한다. 실제 CHK 메시 적용 전 임시 공통 리그다.
    const pitcherRig = playerRig(0xf1f3f5, 0x17408b);
    pitcherRig.root.position.set(.3,.17,MOUND_Z+.45); pitcherRig.root.rotation.y=0; scene.add(pitcherRig.root);
    const batterRig = playerRig(0xf1f3f5, 0x17408b);
    batterRig.root.position.set(-1.05,0,PLATE_Z-.25); batterRig.root.rotation.y=Math.PI; scene.add(batterRig.root);
    const bat = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.085, 1.05, 8), new THREE.MeshStandardMaterial({ color: 0xcaa76a }));
    const batRest = { z: 0.7, x: -0.35 };
    bat.position.set(-0.72, 1.55, PLATE_Z - 0.1); bat.rotation.set(-0.3, 0, batRest.z); scene.add(bat);

    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 20),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x555555, emissiveIntensity: 0.6 }));
    ball.castShadow = true; ball.visible = false; scene.add(ball);
    const trailPositions = new Float32Array(90 * 3);
    const trailGeometry = new THREE.BufferGeometry();
    const trailPosition = new THREE.BufferAttribute(trailPositions, 3).setUsage(THREE.DynamicDrawUsage);
    trailGeometry.setAttribute("position", trailPosition);
    trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.8 }));
    scene.add(trail);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffaa, transparent: true, opacity: 0 }));
    scene.add(flash);
    // 투구 예측점 — 공이 홈플레이트를 지날 실제 지점(변화 반영). 타자가 미트커서를 여기 맞춘다.
    const predictRing = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.21, 28),
      new THREE.MeshBasicMaterial({ color: 0x66ddff, transparent: true, opacity: 0, side: THREE.DoubleSide }));
    predictRing.position.set(0, ZONE_Y, PLATE_Z + 0.06); scene.add(predictRing);
    // 변화 페이드 — 공이 휘는 구간에 남기는 색 잔상(구종색). 페이드아웃으로 '변화'를 보여준다.
    const ghosts = Array.from({ length: 8 }, () => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff77cc, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; scene.add(m); return m;
    });
    let ghostIdx = 0;

    // ---- 상태 ----
    type S = "idle" | "windup" | "pitching" | "inplay" | "done";
    let state: S = "idle", t0 = 0, flightT = 1, plateT = 1;
    const breakVec = new THREE.Vector2();
    let startX = 0.3, endX = 0, endY = ZONE_Y, swungAt = -1;
    let swingCurX = 0, swingCurY = ZONE_Y;
    const trailPts: THREE.Vector3[] = [];
    const vel = new THREE.Vector3(), pos = new THREE.Vector3();
    let hitLaDeg = 0, hitExit = 0; // 마지막 타구의 발사각(도)·초속(m/s) — 결과 판정에 쓴다
    let hrCam = false;

    function setTrail(pts: THREE.Vector3[]) {
      const count = Math.min(pts.length, 90);
      for (let i = 0; i < count; i++) {
        const point = pts[pts.length - count + i];
        trailPositions[i * 3] = point.x;
        trailPositions[i * 3 + 1] = point.y;
        trailPositions[i * 3 + 2] = point.z;
      }
      trailPosition.needsUpdate = true;
      trailGeometry.setDrawRange(0, count >= 2 ? count : 0);
      trailGeometry.computeBoundingSphere();
    }

    function throwPitch() {
      if (state !== "idle") return;
      setOverlay(null);
      const p = pick(pitcher!.pitching!.pitches);
      setIncoming(`${p.name} ${p.arrow} · ${p.speed ?? pitcher!.pitching!.maxSpeed}km/h`);
      const speed = (p.speed ?? pitcher!.pitching!.maxSpeed) / 3.6;
      flightT = (Math.abs(MOUND_Z) / speed) * 1.9; plateT = flightT;
      const [bx, by] = BREAK_DIR[p.arrow] ?? [0, 0];
      const breakPower = p.power ?? Math.min(100, (p.level ?? 3) * (100 / 7));
      const brk = (breakPower / 100) * 0.55;
      breakVec.set(bx * brk, by * brk);
      startX = 0.3; endX = (Math.random() - 0.5) * 1.0; endY = 0.7 + Math.random() * 0.8;
      swungAt = -1; trailPts.length = 0; ball.visible = false; hrCam = false;
      // 예측점: 변화까지 반영한 실제 통과 지점에 배치. 구종색으로 페이드 고스트 색도 정한다.
      predictRing.position.set(plateX(), plateY(), PLATE_Z + 0.06);
      (predictRing.material as THREE.MeshBasicMaterial).opacity = 0;
      const gcol = new THREE.Color(Math.abs(breakVec.x) > Math.abs(breakVec.y) ? 0x66ddff : 0xff77cc);
      for (const g of ghosts) { (g.material as THREE.MeshBasicMaterial).color.copy(gcol); (g.material as THREE.MeshBasicMaterial).opacity = 0; g.visible = false; }
      ghostIdx = 0;
      state = "windup"; setPhase("WINDUP"); t0 = performance.now();
    }
    function swing() {
      if (state === "pitching" && swungAt < 0) { swungAt = (performance.now() - t0) / 1000; swingCurX = cursorX; swingCurY = cursorY; bat.rotation.z = -0.9; setPhase("SWING"); }
    }
    api.current = { pitch: throwPitch, swing };

    function ballPos(tt: number) {
      const u = tt / flightT;
      return new THREE.Vector3(
        THREE.MathUtils.lerp(startX, endX, u) + breakVec.x * u * u,
        THREE.MathUtils.lerp(1.9, endY, u) + breakVec.y * u * u - 0.6 * u * u,
        THREE.MathUtils.lerp(MOUND_Z, PLATE_Z, u));
    }
    // 공이 홈플레이트를 실제로 지나는 지점(변화·중력 반영). 예측점·판정·타구 시작점의 기준.
    function plateX() { return endX + breakVec.x; }
    function plateY() { return endY + breakVec.y - 0.6; }
    function inZone() { const px = plateX(), py = plateY(); return Math.abs(px) < ZONE_HALF_W && py > ZONE_Y - ZONE_HALF_H && py < ZONE_Y + ZONE_HALF_H; }

    function judge() {
      const timeWin = 0.05 + (meetStat / 100) * 0.08;
      const spaceTol = cursorR + 0.12;
      const terr = Math.abs(swungAt - plateT);
      if (terr > timeWin * 1.7) return { k: "miss" as const };
      const serr = Math.hypot(swingCurX - plateX(), swingCurY - plateY());
      if (serr > spaceTol) return { k: "miss" as const };
      const q = Math.max(0, (1 - terr / (timeWin * 1.4)) * (1 - serr / spaceTol));
      return { k: "hit" as const, q };
    }
    function launch(q: number) {
      const px = plateX(), py = plateY();
      flash.position.set(px, py, PLATE_Z); (flash.material as THREE.MeshBasicMaterial).opacity = 0.9;
      const exit = (26 + (power / 100) * 34) * (0.5 + 0.5 * q);
      // 발사각: 컨택 품질 높을수록 이상적 라인드라이브(~18도) 근처, 낮으면 땅볼/뜬공으로 흩어짐
      const laDeg = 18 * q + (Math.random() - 0.5) * (52 - 34 * q); // q=1 → 18±9, q=0 → ±26
      const la = laDeg * Math.PI / 180;
      const spray = (swingCurX - px) * 1.7 + px * 1.2 + (Math.random() - 0.5) * 0.55;
      hitLaDeg = laDeg; hitExit = exit;
      vel.set(Math.sin(spray) * Math.cos(la), Math.sin(la), -Math.cos(spray) * Math.cos(la)).multiplyScalar(exit);
      pos.set(px, py, PLATE_Z); state = "inplay"; t0 = performance.now(); trailPts.length = 0;
    }
    // 타구 결과 = 발사각 + 비거리(첫 착지) + 방향 + 주력. 실야구 근사.
    function settle(land: THREE.Vector3, carry: boolean) {
      const dist = Math.hypot(land.x, land.z);
      const lineFrac = dist > 1 ? Math.abs(land.x) / dist : 0; // 1에 가까울수록 라인 쪽(코너)
      const la = hitLaDeg, hard = hitExit >= 46, med = hitExit >= 38;
      const rnd = Math.random();
      const speedy = runStat >= 62;
      // 파울: 45도 파울라인 밖
      if (Math.abs(land.x) > Math.abs(land.z) + 2) return finish("파울", "foul");
      let text: string, kind: string;
      if (carry && dist > fenceAt(land.x, land.z)) { text = `홈런! 🎉 ${dist.toFixed(0)}m`; kind = "hr"; }
      else if (la < 8) {
        // 땅볼: 대부분 아웃, 세게 맞으면 안타(내야/외야 땅볼)
        if (hard && dist > 34 && rnd < 0.4) { text = `안타 (땅볼)`; kind = "single"; }
        else if (med && lineFrac > 0.75 && rnd < 0.25) { text = `안타 (좌/우전)`; kind = "single"; }
        else text = `땅볼 아웃`, kind = "out";
      } else if (la < 22) {
        // 직선타: 안타 확률 높음, 가끔 라인드라이브 아웃
        if (rnd < 0.16) { text = `직선타 아웃`; kind = "out"; }
        else if (dist > 82 && lineFrac > 0.6) { text = `3루타! (직선타)`; kind = "triple"; }
        else if (dist > 70) { text = `2루타 (직선타)`; kind = "double"; }
        else { text = `안타 (직선타)`; kind = "single"; }
      } else if (la < 46) {
        // 뜬공: 깊으면 장타, 아니면 뜬공 아웃
        if (dist > 96 && lineFrac > 0.72) { text = `3루타! (우중간 깊숙히)`; kind = "triple"; }
        else if (dist > 86) { text = `2루타 (외야 갭)`; kind = "double"; }
        else if (dist > 70 && speedy && rnd < 0.4) { text = `안타 (외야 앞)`; kind = "single"; }
        else text = `뜬공 아웃`, kind = "out";
      } else {
        text = `뜬공 아웃 (팝플라이)`; kind = "out";
      }
      finish(text, kind);
    }
    const HITS = new Set(["single", "double", "triple", "hr"]);
    const BASES: Record<string, number> = { single: 1, double: 2, triple: 3, hr: 4 };
    function finish(text: string, kind: string) {
      setOverlay({ text, kind });
      setPhase(kind === "hr" ? "HOME RUN" : HITS.has(kind) ? "HIT" : kind === "foul" ? "FOUL" : "RESULT");
      // 파울은 결과가 아니다: 스트라이크 2 이하에서 스트라이크 추가, 로그/타석 소모 없음
      if (kind === "foul") {
        setCount(c => ({ ...c, s: c.s < 2 ? c.s + 1 : c.s }));
        state = "done";
        setTimeout(() => { if (state === "done") state = "idle"; setPhase("READY"); ball.visible = false; trailPts.length = 0; setTrail([]); }, 1100);
        return;
      }
      setLog(l => [`${pitcher!.name} → ${batter!.name}: ${text}`, ...l].slice(0, 9));
      setCount(c => {
        let { b, s, o } = c;
        if (kind === "strike") { s++; if (s >= 3) { s = 0; b = 0; o = (o + 1) % 3; endAB("out"); } }
        else if (kind === "ball") { b++; if (b >= 4) { b = 0; s = 0; endAB("bb"); } }
        else { b = 0; s = 0; if (kind === "out") o = (o + 1) % 3; endAB(kind); }
        return { b, s, o };
      });
      state = "done";
      setTimeout(() => { if (state === "done") state = "idle"; setPhase("READY"); ball.visible = false; trailPts.length = 0; setTrail([]); }, 1600);
    }
    function endAB(kind: string) {
      setScore(s => ({
        h: s.h + (HITS.has(kind) ? 1 : 0),
        hr: s.hr + (kind === "hr" ? 1 : 0),
        tb: (s.tb ?? 0) + (BASES[kind] ?? 0),
        ab: s.ab + (kind === "bb" ? 0 : 1),
      }));
    }

    let raf = 0;
    function frame() {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      if (state === "windup") {
        const w = Math.min(1,(now-t0)/760);
        const lift = Math.sin(w*Math.PI);
        pitcherRig.torso.rotation.z = -.18*lift;
        pitcherRig.armR.rotation.x = -1.35*lift;
        pitcherRig.foreR.rotation.x = -.8*lift;
        pitcherRig.armL.rotation.x = .75*lift;
        pitcherRig.legL.rotation.x = -.9*lift;
        if(w>=1){state="pitching";setPhase("PITCH");t0=now;ball.visible=true;}
      } else if (state === "pitching") {
        const tt = (now - t0) / 1000;
        if (swungAt >= 0 && tt >= swungAt) {
          const j = judge();
          if (j.k === "hit") launch(j.q); else finish("헛스윙 스트라이크", "strike");
        } else if (swungAt < 0 && tt >= plateT) {
          ball.position.copy(ballPos(plateT));
          finish(inZone() ? "루킹 스트라이크" : "볼", inZone() ? "strike" : "ball");
        } else {
          const u = Math.min(tt, flightT) / flightT;
          ball.position.copy(ballPos(Math.min(tt, flightT)));
          trailPts.push(ball.position.clone()); if (trailPts.length > 36) trailPts.shift(); setTrail(trailPts);
          // 예측점 서서히 드러냄
          (predictRing.material as THREE.MeshBasicMaterial).opacity = Math.min(0.7, u * 1.1);
          // 변화 페이드: 휨이 붙는 구간(u>0.35)에서 색 잔상을 남겨 '변화'를 보여준다
          if (u > 0.35 && Math.abs(breakVec.x) + Math.abs(breakVec.y) > 0.08) {
            const g = ghosts[ghostIdx % ghosts.length]; ghostIdx++;
            g.position.copy(ball.position); g.visible = true; (g.material as THREE.MeshBasicMaterial).opacity = 0.55;
          }
        }
      } else if (state === "inplay") {
        const dt = 1 / 60; vel.y -= G * dt; pos.addScaledVector(vel, dt * 1.7); ball.position.copy(pos);
        trailPts.push(pos.clone()); if (trailPts.length > 90) trailPts.shift(); setTrail(trailPts);
        if (Math.hypot(pos.x, pos.z) > FENCE * 0.5 && pos.y > 6) hrCam = true;
        if (pos.y <= 0.11) settle(pos.clone(), vel.y < 0);
      }
      const swingPose = swungAt >= 0 && (state === "pitching" || state === "inplay") ? 1 : 0;
      batterRig.torso.rotation.y += ((swingPose ? -.85 : 0)-batterRig.torso.rotation.y)*.22;
      batterRig.armL.rotation.x += ((swingPose ? -1.2 : -.3)-batterRig.armL.rotation.x)*.22;
      batterRig.armR.rotation.x += ((swingPose ? -1.05 : -.45)-batterRig.armR.rotation.x)*.22;
      if(state!=="windup"){
        pitcherRig.torso.rotation.z*=.88;pitcherRig.armR.rotation.x*=.86;
        pitcherRig.foreR.rotation.x*=.86;pitcherRig.armL.rotation.x*=.86;pitcherRig.legL.rotation.x*=.86;
      }
      // 배트/커서/카메라/플래시 이징
      bat.rotation.z += (batRest.z - bat.rotation.z) * 0.12;
      cursor.position.set(cursorX, cursorY, PLATE_Z + 0.2);
      const fm = flash.material as THREE.MeshBasicMaterial; if (fm.opacity > 0) fm.opacity *= 0.85;
      // 변화 고스트 감쇠 + 예측점 펄스/정리
      for (const g of ghosts) { const gm = g.material as THREE.MeshBasicMaterial; if (gm.opacity > 0.01) gm.opacity *= 0.86; else if (g.visible) { g.visible = false; gm.opacity = 0; } }
      predictRing.rotation.z += 0.05;
      if (state !== "pitching") { const pm = predictRing.material as THREE.MeshBasicMaterial; if (pm.opacity > 0.01) pm.opacity *= 0.8; }
      const camT = hrCam ? new THREE.Vector3(pos.x * 0.4, 8, 14) : camHome;
      const lookT = hrCam ? ball.position : camLook;
      camera.position.lerp(camT, 0.06); camera.lookAt(lookT);
      renderer.render(scene, camera);
    }
    frame();

    // 입력
    function onKey(e: KeyboardEvent) { if (e.code === "Space") { e.preventDefault(); swing(); } }
    function onMove(e: MouseEvent) {
      const r = renderer.domElement.getBoundingClientRect();
      const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
      cursorX = THREE.MathUtils.clamp(nx * 1.1, -1.1, 1.1);
      cursorY = THREE.MathUtils.clamp(ZONE_Y - ny * 0.85, 0.35, 1.9);
    }
    function onClick() { swing(); }
    window.addEventListener("keydown", onKey);
    renderer.domElement.addEventListener("mousemove", onMove);
    renderer.domElement.addEventListener("click", onClick);
    function onResize() { W = mount.clientWidth; H = mount.clientHeight; camera.aspect = W / H; camera.updateProjectionMatrix(); renderer.setSize(W, H); }
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("mousemove", onMove);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [batter, pitcher]);

  const meet = batter?.base ? Math.round((batter.base.meetR + batter.base.meetL) / 2) : "—";
  const ocol: Record<string, string> = { hr: "#ffd24a", triple: "#7ee0a0", double: "#5ad17a", single: "#8fe0b0", hit: "#5ad17a", out: "#e06060", strike: "#e0a020", ball: "#7fb0e0", foul: "#c9a86a" };

  return (
    <main style={{ minHeight: "100vh", background: "#0a1420", color: "#e8eef5", fontFamily: "system-ui" }}>
      <div style={{ padding: "12px 20px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #1c2c3c" }}>
        {/* vinext dev currently bundles next/link with a second React instance. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" style={{ color: "#7fb0e0", textDecoration: "none", fontWeight: 700 }}>← PROSPI</a>
        <b style={{ fontSize: 18, letterSpacing: ".05em" }}>V-ROAD <span style={{ color: "#e0a020" }}>大谷 翔平 二刀流</span></b>
        <span style={{ opacity: .55, fontSize: 12 }}>投手 2025 Series · 打者 2025 Series · 실제 카드 스탯 구동</span>
      </div>
      <div style={{ display: "flex", gap: 16, padding: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 640px", minWidth: 320, position: "relative" }}>
          <div ref={mountRef} style={{ width: "100%", height: "min(72vh, 600px)", borderRadius: 12, overflow: "hidden", background: "#0a1420", border: "1px solid #1c2c3c", cursor: "crosshair" }} />
          {incoming && <div style={{ position: "absolute", top: 12, left: 12, background: "rgba(10,20,32,.8)", padding: "6px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600 }}>▸ {incoming}</div>}
          <div style={{ position: "absolute", top: 12, right: 12, background: "rgba(10,20,32,.72)", padding: "5px 9px", borderRadius: 6, fontSize: 11, letterSpacing: ".08em", color: "#b8c9d9" }}>{phase}</div>
          {overlay && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <div style={{ fontSize: overlay.kind === "hr" ? 52 : 38, fontWeight: 900, color: ocol[overlay.kind] ?? "#fff", textShadow: "0 4px 20px rgba(0,0,0,.7)", letterSpacing: ".02em" }}>{overlay.text}</div>
          </div>}
        </div>
        <div style={{ flex: "0 1 300px", minWidth: 260, display: "flex", flexDirection: "column", gap: 12 }}>
          {[["PITCHER", pitcher, pitcher ? `최속 ${pitcher.pitching?.maxSpeed}km/h · 스태미나 ${pitcher.pitching?.stamina} · 구종 ${pitcher.pitching?.pitches.length}` : ""],
            ["BATTER", batter, batter ? `미트 ${meet} · 파워 ${batter.base?.power} · 주력 ${batter.base?.run}` : ""]].map(([label, c, sub]) => (
            <div key={label as string} style={{ background: "#111e2c", borderRadius: 10, padding: 10, display: "grid", gridTemplateColumns: "54px 1fr", gap: 10, alignItems: "center" }}>
              {(c as Card | null) && <img src={cardArt(c as Card)} alt="" width={54} height={68} style={{ width: 54, height: 68, objectFit: "cover", objectPosition: "top", borderRadius: 6 }} /> /* eslint-disable-line @next/next/no-img-element */}
              <div>
              <div style={{ fontSize: 11, opacity: .55, letterSpacing: ".1em" }}>{label as string}</div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{(c as Card | null)?.name ?? "…"}</div>
              <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>{sub as string}</div>
              </div>
            </div>))}
          <div style={{ background: "#111e2c", borderRadius: 10, padding: "12px 14px", display: "flex", gap: 16, alignItems: "center" }}>
            {(["b", "s", "o"] as const).map(k => <div key={k}><span style={{ opacity: .5, fontSize: 11 }}>{k.toUpperCase()}</span> <b style={{ fontSize: 20, color: k === "b" ? "#5ad17a" : k === "s" ? "#e0c020" : "#e06060" }}>{count[k]}</b></div>)}
            <div style={{ marginLeft: "auto", fontSize: 12, opacity: .8, textAlign: "right" }}>타석 {score.ab} · 안타 {score.h} · HR {score.hr}<br />타율 {score.ab ? (score.h / score.ab).toFixed(3).replace(/^0/, "") : ".000"} · 장타 {score.ab ? ((score.tb ?? 0) / score.ab).toFixed(3).replace(/^0/, "") : ".000"}</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => api.current?.pitch()} style={btn("#2b6cb0")}>투구 ▶</button>
            <button onClick={() => api.current?.swing()} style={btn("#b23a3a")}>스윙</button>
          </div>
          <div style={{ fontSize: 12, opacity: .78, lineHeight: 1.7, background: "#0d1826", borderRadius: 10, padding: 12 }}>
            <b>조작:</b> <b>[투구]</b> → 날아오는 공 코스에 <b>마우스로 노란 미트커서를 맞추고</b>, 홈플레이트에 닿는 순간 <b>Space</b>(또는 클릭)로 스윙.<br />
            미트↑ = 커서·타이밍 여유↑, 파워↑ = 타구 초속↑ → 비거리로 안타/홈런 결정.
          </div>
          <div style={{ background: "#0d1826", borderRadius: 10, padding: 12, fontSize: 12 }}>
            {log.length === 0 ? <span style={{ opacity: .5 }}>기록 없음</span> : log.map((l, i) => <div key={i} style={{ padding: "2px 0", opacity: 1 - i * 0.09 }}>{l}</div>)}
          </div>
        </div>
      </div>
    </main>
  );
}
const btn = (bg: string): React.CSSProperties => ({ flex: 1, padding: "13px 10px", background: bg, color: "#fff", border: 0, borderRadius: 10, fontWeight: 700, fontSize: 15, cursor: "pointer" });
