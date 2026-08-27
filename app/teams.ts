/**
 * 구단 배지.
 *
 * [확인된 사실] ref-stats 의 `team` 은 1~2자 약호다 — 12구단이 모두 나온다:
 *   広 ソ 中 ヤ オ ロ De 神 西 楽 巨 日 (각 980~1,090장).
 * [확인된 사실] 게임 원본 구단 로고는 **SELECT2220 스프라이트**에 있다:
 *   public/sprites/SELECT2220/156_1024x1024_31b235f144c9.png.
 *   알파 투영으로 32셀 검출 — 0행 6칸 = 센트럴(巨中広ヤDe神),
 *   1행 6칸 = 퍼시픽(楽日西オロソ), 2행 = 리그 마크, 3~5행 = 국기.
 * [처리] 12구단을 잉크 경계로 잘라 96x96 정사각 PNG 로 저장(public/img/team/*.png).
 *   색상값은 로고 로드 실패 시 폴백 배경으로만 쓴다.
 */
export type League = "central" | "pacific";

export type TeamInfo = { code: string; name: string; league: League; bg: string; fg: string; icon: string };

export const TEAMS: Record<string, TeamInfo> = {
  "巨": { code: "巨", name: "読売ジャイアンツ",        league: "central", bg: "#f97316", fg: "#1a1207", icon: "/img/team/kyo.png" },
  "神": { code: "神", name: "阪神タイガース",          league: "central", bg: "#facc15", fg: "#1a1500", icon: "/img/team/han.png" },
  "De": { code: "De", name: "横浜DeNAベイスターズ",     league: "central", bg: "#1d5fd6", fg: "#ffffff", icon: "/img/team/den.png" },
  "広": { code: "広", name: "広島東洋カープ",          league: "central", bg: "#d62828", fg: "#ffffff", icon: "/img/team/hir.png" },
  "中": { code: "中", name: "中日ドラゴンズ",          league: "central", bg: "#1e4bb8", fg: "#ffffff", icon: "/img/team/chu.png" },
  "ヤ": { code: "ヤ", name: "東京ヤクルトスワローズ",   league: "central", bg: "#0f7a3d", fg: "#ffffff", icon: "/img/team/yak.png" },
  "ソ": { code: "ソ", name: "福岡ソフトバンクホークス", league: "pacific", bg: "#f2c200", fg: "#161000", icon: "/img/team/sof.png" },
  "日": { code: "日", name: "北海道日本ハムファイターズ", league: "pacific", bg: "#1b3f8b", fg: "#ffffff", icon: "/img/team/nip.png" },
  "ロ": { code: "ロ", name: "千葉ロッテマリーンズ",     league: "pacific", bg: "#111827", fg: "#ffffff", icon: "/img/team/rot.png" },
  "楽": { code: "楽", name: "東北楽天ゴールデンイーグルス", league: "pacific", bg: "#8b1a1a", fg: "#ffffff", icon: "/img/team/rak.png" },
  "西": { code: "西", name: "埼玉西武ライオンズ",       league: "pacific", bg: "#0a3d91", fg: "#ffffff", icon: "/img/team/sei.png" },
  "オ": { code: "オ", name: "オリックス・バファローズ",  league: "pacific", bg: "#1f2937", fg: "#c8a24a", icon: "/img/team/ori.png" },
};

export const teamOf = (code?: string | null): TeamInfo | null =>
  (code && TEAMS[code]) || null;
