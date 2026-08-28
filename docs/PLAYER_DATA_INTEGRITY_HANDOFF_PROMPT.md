# 프로스피A 선수 데이터 무결성·복구 작업 인수인계 프롬프트

아래 내용을 새 Codex 작업의 첫 요청으로 사용한다.

---

당신은 프로스피A 선수 카드 아카이브 사이트의 데이터 무결성 작업을 이어받는다.

## 최종 목표

`prospi-a.rakda3.net`과 로컬 게임 원본을 교차 검증하여 전체 선수 데이터의 누락,
중복, 오매칭을 제거한다. 구종, 제2구종, 구속, 변화량, 성장 Lv.0~10, 능력치,
스킬, 수비 정보를 근거가 있는 범위에서 모두 웹 UI에 구현한다. 추정값을 실제값처럼
넣지 말고, 출처가 없는 값은 명시적으로 미확인 상태로 남긴다.

## 작업 위치

- 웹 프로젝트: `/Users/yi-rang/prospi-work/site`
- 원본 분석 프로젝트: `/Users/yi-rang/Documents/ChatGPT/프로스피`
- APK: `/Users/yi-rang/Downloads/professional-baseball-spirits-a-22-4-0.apk`
- 로컬 카드 마스터 CSV:
  `/Users/yi-rang/Documents/ChatGPT/프로스피/output/current/cards_with_images.csv`
- 사이트 목록 원장: `output/rakda3/cards.jsonl`
- 사이트 상세 원장: `output/rakda3/details.jsonl`
- 보관된 상세 HTML: `output/rakda3/players/*.html.gz`
- 최종 카드 데이터: `public/data/cards.json`
- 카드별 사이트 데이터: `public/data/ref-stats.json`
- 최신 감사 보고서: `output/integrity/player-data-audit.json`

개발 서버는 이미 실행 중일 수 있다. 기존 작업트리가 매우 더러우므로 관련 없는
사용자 변경을 되돌리거나 정리하지 않는다.

## 현재 검증 수량

- 전체 카드: 15,222
- 타자 카드: 8,574
- 투수 카드: 6,648
- 사이트 목록/상세 페이지: 각각 9,681
- 정확한 사이트 카드 연결: 10,195
- 부분 연결: 3,595
- 실제 성장표 Lv.0~10: 10,195
- 구종 보유 투수: 6,626 / 6,648
  - rakda3 출처: 5,170
  - 기존 로컬 원장: 1,200
  - 새 CARDMASTER 복구: 256
- 남은 구종 공백: 22
- 현재 자동 감사 오류는 `pitch_missing` 22건뿐이다.
- 성장 단계, 성장 MAX, 유형 오매칭, 구속 0, 방향 중복 오류는 0건이다.

## 이미 구현한 도구와 역할

- `tools/parse_detail_archive.py`
  - 9,681개 상세 HTML에서 전체 구종과 특훈 성장표를 파싱한다.
  - `10(MAX)`가 `isdigit()`에서 빠지던 오류를 고쳤다. 숫자 접두사를 읽는다.
- `tools/merge_ref.py`
  - 카드와 사이트 상세를 시리즈/연도/유형/수비 근거로 연결한다.
  - 다른 연도 행을 절대 붙이지 않는다.
  - 2022 `47xx → OBI`, `91xx → 侍ジャパン` 규칙이 있다.
  - 등록명 별칭 `佐藤 由規 ↔ 由規`, `金子 千尋 ↔ 金子 弌大`가 있다.
- `tools/merge_pitches.py`
  - 사이트 상세의 전체 구종표로 교체하여 제2구종 누락을 복구한다.
  - 같은 선수·연도의 구종 구조가 모두 같을 때만 공통 구종을 상속한다.
  - 2015 大谷의 단일 오타는 구조 일치와 다수값으로 109km/h를 선택한다.
  - 사이트 HTML이 깨진 ref 399/541은 `tools/pitch_source_repairs.json`에서
    로컬 원장 근거로 각각 138/142km/h를 복구한다.
- `tools/recover_local_pitches.py`
  - 사이트에 없는 카드 구종을 로컬 CARDMASTER에서 복구한다.
  - `표시 연도 - 1`의 내부 마스터만 사용한다.
  - 후보의 12방향 `(kind, power, level)` 배열이 하나로 확정될 때만 사용한다.
  - `--refresh`는 기존 `source=local-card-master` 결과를 지우고 재계산한다.
- `tools/card_rules.py`
  - 大谷의 투타 카드 visual family와 根尾의 전향 시기를 처리한다.
  - 根尾 2019~2021은 타자, 2023 이후는 투수다.
- `tools/audit_player_data.py`
  - ID 중복, orphan ref, 유형, 성장 0~10, MAX, 구종 방향/변화량/구속,
    출처별 커버리지와 누락 사유를 전수 검사한다.
- `tools/shard_detail_data.py`
  - 상세 데이터 샤드를 다시 만든다.

## 절대 반복하면 안 되는 오류

1. 다른 연도 카드 연결 금지
   - 수비 3종이 같아도 다른 연도 성장표를 붙이면 안 된다.
   - 과거 矢澤 2024에 2026, 根尾 2019에 2020 데이터가 붙었던 오류가 있었다.
2. 로컬 CARDMASTER 연도 해석
   - 전 연도 사이트 앵커 대조 결과 `표시 연도-1`이 정답이다.
   - 같은 내부 연도 완전일치율은 20~34%, 연도-1은 56~87%였다.
   - 기존 `masterSeason`, `defense.version`만 보고 같은 연도 행을 고르지 않는다.
3. 후보 중 첫 행 임의 선택 금지
   - 후보가 여러 개고 구종/성장값이 다르면 보류한다.
4. 다른 시즌 구종 복사 금지
   - 동일 선수라도 시즌별 구종, 등급, 변화량이 바뀐다.
5. `kind=-1` 구종 삭제 금지
   - 최신/고유 구종은 `nameJa`, 방향, 등급, 변화량, 구속이 있으므로 UI에서
     정상 표시된다. 숫자 kind를 모른다는 이유로 버리지 않는다.

## CARDMASTER 연도 근거

사이트 구종이 있는 카드와 로컬 레코드의 `(direction, kind, level)`을 전수 비교했다.

- 2015: 연도-1 완전일치 74.8%, 같은 연도 48.8%
- 2016: 86.6% / 28.9%
- 2017: 83.5% / 30.3%
- 2018: 84.5% / 20.0%
- 2019: 82.1% / 26.0%
- 2020: 77.6% / 22.8%
- 2021: 69.3% / 23.0%
- 2022: 68.2% / 28.1%
- 2023: 69.0% / 34.3%
- 2024: 64.5% / 21.0%
- 2025: 60.9% / 24.4%

따라서 같은 연도 fallback은 금지한다. 연도-1 후보도 배열이 유일할 때만 확정한다.

## 남은 구종 공백 22장

```text
936720100 島本 浩也 2023 0100
951170100 根尾 昂 2023 0100
802370500 豊田 清 2022 0500
635050100 中澤 雅人 2020 0100
614370100 中田 賢一 2020 0100
648690100 堀岡 隼人 2020 0100
619270100 村田 透 2020 0100
650110100 櫻井 周斗 2020 0100
636060100 武藤 祐太 2020 0100
648180100 田村 伊知郎 2020 0100
608580700 山井 大介 2020 0700
547750100 小林 慶祐 2019 0100
535390100 川原 弘之 2019 0100
536550100 斎藤 佑樹 2019 0100
439030100 森 雄大 2018 0100
346880100 高橋 樹也 2017 0100
217890100 山田 大樹 2016 0100
244990100 横山 雄哉 2016 0100
237630100 高木 京介 2016 0100
101120161 松坂大輔 2015 0161
101050342 高崎健太郎 2015 0342
101060631 石崎剛 2015 0631
```

이 22장은 사이트에 동일 연도 행이 없고, 로컬 `표시 연도-1` 마스터에도 유일한
구종 배열이 없다. 같은 연도 로컬 행을 붙이면 앵커 검증상 거의 확실히 다음 시즌
데이터가 되므로 사용하지 않는다.

## 다음 조사 우선순위

1. `CONPLAYERDATA.CHK`, `PLAYERDATA.CHK`, `contents_personal.csv`에서 카드별
   구종 배열 또는 과거 revision 키가 남아 있는지 조사한다.
2. 22장의 카드 파일명/이미지 ID와 CARDMASTER 실제 조인 키를 역추적한다.
   순번 비례, 이름, 첫 후보 방식은 금지한다.
3. 사이트의 등록명 변경/한자 이체자 때문에 누락된 선수가 더 있는지 playerId 단위로
   별칭을 조사한다.
4. 근거를 확보한 카드만 복구 규칙과 자동 회귀 검사를 함께 추가한다.
5. 구종 공백이 남으면 상세 UI의 “동일 연도 확인 가능한 데이터 없음” 표시는 유지한다.

## 데이터 재생성 순서

```bash
cd /Users/yi-rang/prospi-work/site
python3 tools/parse_detail_archive.py
python3 tools/merge_ref.py
python3 tools/merge_pitches.py --scraped output/rakda3/details.jsonl --replace --apply
python3 tools/recover_local_pitches.py --refresh --apply > output/integrity/local-pitch-recovery.json
python3 tools/shard_detail_data.py
python3 tools/audit_player_data.py
```

그다음 `public/data/cards.json`, `ref-stats.json`, `card-shards/*.json`,
`ref-shards/*.json`의 결정론적 gzip을 갱신하고 빌드한다.

```bash
PATH='/Users/yi-rang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run build
```

## UI 구현 상태

- `app/player/[id]/page.tsx`
  - 사이트 MAX 능력치, 실제 Lv.0~10 성장표, 전체 제1/제2구종을 표시한다.
  - 한국어에서는 성장 라벨을 번역한다.
  - 구종 원본이 없으면 빈칸 대신 확인 가능한 데이터 없음 메시지를 표시한다.
- `app/refStats.ts`
  - `growth.labels`, `growth.rows` 타입이 있다.
- `app/i18n.tsx`
  - 성장표와 구종 미확인 문구의 일본어/한국어 번역이 있다.
- `app/globals.css`
  - 성장표와 미확인 데이터 표시 스타일이 있다.

## 완료 조건

- 자동 감사에서 근거 없이 잘못 붙은 유형, 성장표, 구종이 0건이어야 한다.
- 남은 누락은 각 카드마다 원본 부재가 입증되거나 새로운 원본으로 복구되어야 한다.
- 데이터 출처와 복구 규칙이 재실행 가능해야 한다.
- 모든 샤드와 gzip이 최신이어야 한다.
- 프로덕션 빌드가 통과해야 한다.
- 상세 화면에서 타자/투수, 성장표, 구종, 스킬이 일본어 기본 UI와 한국어 언어팩에서
  일관되게 표시되어야 한다.

목표가 실제로 모두 충족되기 전에는 완료 처리하지 않는다.

