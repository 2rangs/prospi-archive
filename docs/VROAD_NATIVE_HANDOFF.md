# 프로스피A `/vroad` 네이티브 재구현 인수인계 프롬프트

아래 내용을 새 작업에 그대로 전달한다.

## 역할과 목표

`/Users/yi-rang/prospi-work/site`의 프로스피A 카드 아카이브 사이트를 작업한다. 핵심 목표는 `/vroad`에 프로스피A의 타석 경험을 웹 기술로 재구현하는 것이다. 원본 APK 실행 파일을 웹에 올리거나 네이티브 코드를 그대로 이식하지 않는다. 정적으로 확인한 리소스 조립 구조, 실제 카드 데이터와 합법적으로 확보한 로컬 에셋을 사용해 독립적인 Three.js 구현을 만든다.

현재 기본 매치업은 선수 ID `3945`, 大谷 翔平의 투타 조합이다.

- 투수 카드: `1139455100` (`CL1139455100.CHK`)
- 타자 카드: `1139453200` (`CL1139453200.CHK`)
- 데이터: `public/data/cards.json`
- 화면: `app/vroad/page.tsx`
- 실행: 이미 개발 서버가 실행 중이며 `http://localhost:3000/vroad`에서 확인한다.

## 확인된 원본 조립 구조

원본은 선수 하나를 단일 모델 파일로 보관하지 않고 런타임에 다음 계층을 결합한다.

- 공통 몸체·스켈레톤 후보: `PLNSD.CHK`, `PLNSD_AN01.CHK`, `PLNSD_DJ01.CHK`, `PLNSD_UG01.CHK`
- 타자 공통 리소스: `BTCOMMON.CHK`
- 투수 공통 리소스: `PTCOMMON.CHK`
- 타격 폼·모션: `BT_S*.CHK` 계열
- 투구 폼·모션: `PT_S*.CHK` 계열
- 얼굴·유니폼: `PlayerResourceManager::LoadPlayerFace`, `LoadPlayerUniform`에서 별도 결합
- 주요 파서 심볼: `ChunkLoad::GetGEOHeader`, `GetJointInfo`, `GetMotionData`
- 렌더 관련 심볼: `PlayerMeshFrameUtility::RenderPlayerMesh`
- 동작 관련 심볼: `BatterMotion::DoSwing`, `PitcherMotion2::UpdateJoint`

APK Manifest의 요구 버전은 GLES `0x30002`, 즉 OpenGL ES 3.2다. 현재 Android 에뮬레이터는 GLES 3.1이라 원본 앱의 경기 진입은 차단된다. 이 제한을 웹 렌더링 요구사항으로 오해하지 않는다. Three.js/WebGL 구현은 독립적으로 유지한다.

## 현재 웹 구현

`app/vroad/page.tsx`는 다음을 구현한다.

- 오타니 투수·타자 카드를 ID로 고정하고, 해당 ID가 없을 때 최신 오타니 역할별 카드로 대체
- 실제 투수 구속·구종 방향·변화 레벨과 타자 미트·파워를 물리와 판정에 사용
- 원본의 책임 분리와 유사하게 공통 저폴리 리그와 투구/타격 모션을 분리
- CHK 지오메트리 디코더가 완성되기 전에는 공통 몸체를 저폴리 임시 리그로만 표시한다. 카드아트를 3D 선수 모델처럼 경기장 안에 배치하지 않는다.
- 투수·타자 정보 패널에도 실제 카드아트를 표시
- 카드 교체 시 Three.js 장면을 완전히 정리하고 텍스처와 머티리얼을 폐기

## 분석 작업 위치

- APK 분석 루트: `/Users/yi-rang/Documents/ChatGPT/프로스피`
- APK: `/Users/yi-rang/Downloads/professional-baseball-spirits-a-22-4-0.apk`
- 네이티브 라이브러리: `apk_analysis/lib/arm64-v8a/libAll.so`
- 다운로드 리소스: `extracted/download-2138/download`
- RDI 복호 도구: `tools/decrypt_rdi.py`
- RDB 직접 추출기 초안: `tools/extract_rdb_files.py`
- CHK 검사기: `tools/inspect_match_chk.py`
- 추출 결과 예정 위치: `output/ohtani-native`

## 현재 막힌 지점

인앱 `HeapChunkLoad` 호출은 GLES 검사 시점에 게임 전용 힙이 아직 초기화되지 않아 실패한다. 정적 RDI 파싱은 완료했지만 보유한 RDB 세트와 메모리에서 얻은 최신 RDI 사이에 세대 차이가 있다. 암호화 RDI와 함께 받은 RDB도 슬롯 복호 결과가 아직 맞지 않으므로, 추출 성공을 주장하거나 임의 데이터를 CHK로 저장하지 않는다.

다음 우선순위는 다음과 같다.

1. `RES0001.RDI`의 그룹 값 3과 `RES0001/RES0101/RES0201.RDB` 매핑 및 파일별 키를 네이티브 `ChunkLoad::CalcFileSize` 경로와 대조한다.
2. `BTCOMMON.CHK`, `PTCOMMON.CHK`, `PLNSD*.CHK`를 무결성 검증과 함께 추출한다.
3. 선수 ID 3945의 실제 타격 폼·투구 폼 enum을 마스터 데이터 또는 접근자에서 구한다.
4. `GetBatterMotionFileName`과 `GetPitcherMotionFileName`으로 정확한 `BT_S*`, `PT_S*` 파일을 결정한다.
5. GEO·joint·motion 청크 디코더를 작성하고 glTF 또는 웹용 버퍼로 변환한다.
6. `/vroad`의 저폴리 리그를 원본 추출 모델로 교체하되 물리·HUD 계층은 유지한다.

## 주의점

- 카드아트와 실제 3D 선수 모델을 혼동하지 않는다. `CL*.CHK`는 현재 선수 식별용 카드아트다.
- 파일명이나 오프셋만으로 추출 성공을 판단하지 않는다. CHK 매직, 내부 청크 범위, 예상 크기를 모두 검증한다.
- 원본 에셋이 없는데 비슷한 모델을 원본이라고 표기하지 않는다.
- 실제 카드의 구종 `power`가 없으면 `level / 7`을 변화량으로 환산한다.
- Three.js 리소스는 화면 이탈·카드 교체 시 반드시 `dispose()`한다.
- 기존 사이트의 데이터·상세화면·이펙트 렌더러 변경사항을 훼손하지 않는다.
- 개발 서버가 실행 중이라는 전제이므로 새 서버를 중복 실행하지 말고 브라우저에서 기존 `/vroad`를 확인한다.

## 완료 기준

- `/vroad` 첫 진입 시 투수와 타자가 모두 大谷 翔平으로 표시된다.
- 투수는 `1139455100`, 타자는 `1139453200`의 카드 데이터와 이미지를 사용한다.
- 투구 구속·변화와 타격 판정이 해당 카드 수치에서 계산된다.
- 콘솔 오류와 Three.js 리소스 누수가 없다.
- 원본 CHK 모델을 적용할 때 저폴리 대체 구현을 쉽게 제거할 수 있도록 역할별 계층이 유지된다.
