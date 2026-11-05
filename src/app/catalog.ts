// Verified against each restaurant's own Catchtable page, 2026-11-02 KST.
export const CATALOG = [
  { slug: "tempmosuseoul", name: "모수 서울", chef: "안성재", area: "한남·경리단길", status: "OPEN", maxParty: 4, notes: "8세 이상. 예약 후 인원·시간 변경 불가. 취소 및 노쇼 규정 확인 필요.", openingNotes: "공식 예약 페이지의 최신 오픈 공지를 확인해 주세요." },
  { slug: "notre", name: "노뜨르", chef: "윤남노 · 요리하는 돌아이", area: "압구정로데오", status: "OPEN", maxParty: 6, notes: "미성년자 이용 불가. 주류 주문 및 1인 아뮤즈 부쉬 필수.", openingNotes: "11/9 00:00에 11/16~11/29 예약 오픈 안내. 일회성 공지이며 변경 가능." },
  { slug: "viatoledo", name: "베수비오", chef: "권성준 · 나폴리 맛피아", area: "신당", status: "OPEN", maxParty: 5, notes: "기존 비아톨레도 주소가 현재 베수비오로 연결됩니다. 주류 주문 필수. 예약자 본인 방문 필수.", openingNotes: "기존 비아톨레도 예약 규칙을 재사용하지 말고 최신 공지를 확인해 주세요." },
] as const;
