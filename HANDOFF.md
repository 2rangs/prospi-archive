# 프로스피A 카드 이펙트/스텟 웹 재현 — 작업 인수인계

> 이 문서는 다른 세션에 붙여넣어 이어서 작업하기 위한 프롬프트다.
> 작업 디렉터리는 반드시 `/Users/yi-rang/prospi-work/site` 에서 한다.

## 0. 목표
프로야구스피리츠A(jp.konami.prospia)의 카드 배경 이펙트와 스텟을,
게임 런타임의 실제 렌더 원리를 역추적해 브라우저(React + PixiJS/WebGL)에서 재현한다.
"값만 추출"이 아니라 "게임이 이 파일을 이렇게 쓴다 → 웹에서 이렇게 재생"까지 연결.

## 1. 환경 / 경로
- 웹 앱: `/Users/yi-rang/prospi-work/site` (vinext + React 19, dev 서버 localhost:3000)
- 파이썬 도구용 venv: `/Users/yi-rang/prospi-work/site/.venv-tools/bin/python` (pillow 설치됨)
- 원본 바이너리: `/Users/yi-rang/Documents/ChatGPT/프로스피/apk_analysis/lib/arm64-v8a/libAll.so`
  (aarch64 stripped 이나 `objdump -T` 로 동적심볼 234,328개 생존 → 타깃 디스어셈블 가능)
- 심볼덤프 캐시: `.../scratchpad/dynsym.txt`
- 이펙트 CHK 원본: `~/Downloads/prospi-a-card-effects/chk/` (ANSS_EF_*.CHK 682개)
- 매니페스트/PK: `~/Documents/ChatGPT/프로스피/emulator-extract/.../download/manifest/`(+`unpacked/`)
- 다운로드 청크: `~/Documents/ChatGPT/프로스피/extracted/download/JP/` (CARDMASTERDATA.CHK 등)
- 카드 이미지: 라이브 CDN `d2tii5d4auswg2.cloudfront.net/arb/cdn/ver2026/CARD{gg}/{CS|CL}...CHK.00N`
  (worker/index.ts 의 /api/card-image 가 프록시)

## 2. 역추적으로 확정한 런타임 파이프라인 (근거: libAll.so 디스어셈블)

### 에셋 전달
```
app_manifest.pk ─(12B헤더+zlib)→ 20개 서브매니페스트(size/version/MD5) + baseURL http://amrrsc.konaminet.jp/
manifest_*.pk ─→ 레코드[u16 nameLen][name][u16 ver][32B MD5 ascii][u32 size]
DownloadChunkLoad::CreateURL(url, md5) → HTTP GET download/JP/<name>.CHK (MD5검증)
ChunkLoad: IsLegalChunk("CHK "+"CHUNKEND") → IsCompressChunk("CMP")면 inflate → 섹션 파싱
```
- PK 헤더: `[0]3D020300 매직 [4]01000000 [8]u32 uncompressed size [C]zlib(789C)`
- CHK 컨테이너: `[0]"CHK " [4]0x10 [8]10101000 [C]filesize`, 섹션 `tag[8] u32 stride u32 payloadSize`, 말미 "CHUNKEND"+0×8
- CS=카드썸네일 PNG(128²), CL=풀아트 PNG(512×1024 RGBA), ANSS_EF=다중 CLMP PNG 시트

### AnimSS 렌더 (카드 배경 이펙트 = SpriteStudio 파생)
- effect 파일: `ANSS_EF_%06d_L.CHK`, effect_id = group(연도)+series+sub+rank 4필드(682종)
- 구동: `AnimssNormalModel::updateModel → updatePartAttribute → updateUserDataKeyFrame → updateWorldMatrix → moveRender`
- 노드구조체 오프셋: `+0x40 parent, +0x44 kind, +0x48 blendType, +0x60 iclip, +0x64 ianim`
- **BlendType(+0x48): 0=Mix 1=Mul 2=Add 3=Sub** (SpriteStudio). 글로우 대부분 2=Add → 가산합성이 정상
- 키프레임 interp: 1=linear 2=hermite
- 인스턴스(kind3) 시차: USERDATA 문자열 `[ADVANCE]#N` → `setFrame(0, N)` 로 서브클립을 N프레임 앞선 지점에서 시작(트랙 끝에서 hold)

### effect_id 출처 (핵심 결론)
- **effect_id 는 서버 전용.** 서버 JSON `"effect_id"` 를 `cJsonUtil::GetS32` 로 읽어 `CardStatus+0x358` 에 무가공 저장.
  클라가 group/series/rank 로 산술 유도하는 코드 없음. rarity(+0x364)와 독립 필드.
- Normal/EX 는 각자 서버가 지정한 effect_id 를 가짐 → 로컬 정적분석으론 같은지 다른지 판정 불가.
- 관련 주소: 파서 `0x3d50fe0`(effect_id@`0x3d512e8`), `SetMinInfo 0x3d79e48`, `EnableEffect 0x3d7a8a0`,
  `GenerateChunkFilePath 0x3d76ed4`, getter/setter `0x3d50a30/0x3d5494c`

### 카드 데이터 모델 (확정)
```
Player ─ SeasonPlayer(CARDMASTERDATA 1행/시즌: 능력·수비·구종, playerId@+0x24) ─ Card ×N(변형)
                                                            └ CS/CL 이미지(변형별 상이) + effect_id(서버)
```
- id = {group}{playerId}{variant4}. 예 1149540900 = 11·4954·0900
- 변형코드 = 시리즈+타입 (01=S1, 37=S2). CL이미지에 자세·시리즈텍스트·(특수)은박사인 baked
- 능력=player-season 공유 / 비주얼·effect_id=per-card

## 3. 이 세션에서 만든/고친 것 (모두 /prospi-work/site)

### 신규
- `app/AnimSSPlayerGL.tsx` — **PixiJS 8 WebGL 렌더러**. solve()로 노드 월드행렬 계산,
  진짜 프리멀티플라이드 가산(blendMode 'add'), vertexColor→tint, back/front 레이어 분리
- `tools/export_anim.py` (v2로 재작성) — 키프레임 interp/인스턴스인라인(iclip·ianim)/
  `[ADVANCE]#N` 파싱/blend필드/셀 플립북 export. (구버전 `.bak` 백업)
- `tools/extract_sprites.py` (다른 복제본에서 복사), `tools/.venv-tools`

### 수정
- `app/AnimSSPlayer.tsx` (DOM 렌더러 v2, matrix 합성·가산 mix-blend-mode·advance). `.bak` 백업
- `app/OriginalCardEffect.tsx` — `effectIdFromVariant()`/`useCardEffectId()` 추가:
  변형→effect_id 결정적 유도(group 정확 + variant 해시로 series/sub 선택, rank5 우선).
  진짜 effect_id 아님(서버 전용) — 변형별로 다르고 안정적인 유도값
- `app/effects/page.tsx` — WebGL/DOM 토글 버튼
- `app/player/[id]/page.tsx` — effect를 useCardEffectId(변형 반영)로, WebGL 렌더러 사용
- `public/effects/anim/*.json` — 675개 v2 재익스포트(101MB)
- **`public/data/cards.json`** — 수비/포지션을 CARDMASTERDATA (playerId,year) 정확조인으로 교정
  (10,109장, 변형별 수비 불일치 918그룹 해소). **원본은 `cards.json.bak`**

## 4. 현재 상태
- 카드 배경 이펙트가 WebGL로 실제 재생됨(가산 글로우·화살표 인스턴스 시차 등)
- 변형마다 다른 effect_id 렌더 (예: 淸宮 2025 5변형 → 1111005/1141005/1113005/1142005/1114105)
- 수비 스텟 변형별 일관성 교정됨

## 5. 미완 / 다음 작업 — 오타니 등 스텟 매칭
문제: 오타니(playerId 3945) 카드가 리스트에서 전부 동일 스텟(70/98/76…)으로 보임.
원인: ref-stats.json 에서 오타니 46장이 `{"team":"日","partial":true}`(스텟 비어있음)라 base(선수당 동일값) 폴백.
→ **데이터 공백이 아님.** rakda3.net 에 오타니 스텟이 카드별로 다 있음(확인함):
- 타자 17행 https://prospi-a.rakda3.net/batter-list?name=大谷 翔平 (예: 2025S2SP파워92, 2024파워85/90…)
- 투수 20행 https://prospi-a.rakda3.net/pitcher-list?name=大谷 翔平
`tools/scrape_ref.py` + `tools/merge_ref.py`가 스크랩·병합하는데, merge가 (이름,수비3종) 또는
(이름,연도) **양쪽 유일**일 때만 매칭 → 오타니는 연도별 카드·ref 다수라 전부 실패(merge_ref.py 주석에 명시).
partial 4,256장 + 미매칭 1,441장.

### 해야 할 일
1. rakda 행(series="2025S2SP(SM1)" 등, spirits/date 보유)을 우리 카드 변형에 매핑하는 더 나은 키 확립
   - 변형↔spirits/series 대응 규칙을 찾거나, (이름,연도) 다대다일 때 정렬 페어링
2. `merge_ref.py` 3차 매칭을 개선해 partial 카드들에 실제 max 스텟 채우기
3. 채운 뒤 `public/data/ref-stats.json` 재생성 → 리스트/상세에서 오타니 카드가 다르게 표시되는지 검증

## 6. 주의
- `players.csv`는 선수당 1행(현재시즌 능력)이라 base는 per-player. per-card/시즌 스텟은 rakda(ref-stats)가 유일 소스
- CARDMASTERDATA엔 배팅(미트/파워/주력)이 평문 u32로 없음(적성·수비·구종만). 배팅은 rakda 표기값 사용
- 되돌리려면: `cards.json.bak`, `app/AnimSSPlayer.tsx.bak`, `tools/export_anim.py.bak` 복원
