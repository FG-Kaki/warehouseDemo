// Content for the demo bot's incoming work. Same pool as src/data/mock/demo.ts (not exported there).
import type { Estimate, Priority } from '../../../src/data/types.ts'

export interface PoolTask {
  p: 'WEB' | 'APP' | 'OPS'
  title: string
  desc: string
  pri: Priority
  est: Estimate
}

export const POOL: PoolTask[] = [
  { p: 'WEB', title: '회원 탈퇴 플로우 점검', desc: '탈퇴 전 안내 문구와 데이터 삭제 시점을 확인하고 누락된 화면을 정리합니다.', pri: 'medium', est: 3 },
  { p: 'WEB', title: '상품 리뷰 작성 화면 개선', desc: '별점과 사진 첨부를 한 화면에서 끝낼 수 있게 입력 흐름을 단순화합니다.', pri: 'medium', est: 5 },
  { p: 'WEB', title: '이메일 인증 메일 템플릿 정리', desc: '인증, 비밀번호 재설정 메일의 문구와 디자인을 통일합니다.', pri: 'low', est: 2 },
  { p: 'WEB', title: '위시리스트 기능 추가', desc: '상품 카드에서 하트를 눌러 찜하고 마이페이지에서 모아 볼 수 있게 합니다.', pri: 'medium', est: 5 },
  { p: 'WEB', title: '공지사항 게시판 페이지 구현', desc: '관리자가 올린 공지를 목록과 상세로 보여주는 페이지를 만듭니다.', pri: 'low', est: 3 },
  { p: 'WEB', title: '페이지 로딩 속도 측정 및 개선', desc: '주요 화면의 LCP를 측정하고 이미지와 번들 크기부터 줄입니다.', pri: 'high', est: 5 },
  { p: 'WEB', title: '약관 동의 화면 문구 수정', desc: '법무팀 검토를 반영해 약관 동의 화면의 문구를 바꿉니다.', pri: 'high', est: 1 },
  { p: 'WEB', title: '관리자 주문 취소 기능 추가', desc: '운영자가 주문을 취소하고 환불 사유를 남길 수 있게 합니다.', pri: 'high', est: 3 },
  { p: 'APP', title: '앱 시작 속도 개선', desc: '콜드 스타트 시간을 측정하고 초기화 작업을 지연 로딩으로 옮깁니다.', pri: 'high', est: 5 },
  { p: 'APP', title: '생체 인증 로그인 지원', desc: '지문과 얼굴 인식으로 간편하게 로그인할 수 있게 합니다.', pri: 'medium', est: 5 },
  { p: 'APP', title: '장바구니 화면 스와이프 삭제', desc: '장바구니 항목을 왼쪽으로 밀어 삭제하고 되돌리기를 제공합니다.', pri: 'low', est: 2 },
  { p: 'APP', title: '앱 내 검색 최근 검색어 저장', desc: '최근 검색어를 기기에 저장하고 개별 삭제와 전체 삭제를 지원합니다.', pri: 'low', est: 2 },
  { p: 'APP', title: '배송 조회 화면 구현', desc: '택배사 연동 정보를 받아 배송 단계를 타임라인으로 보여줍니다.', pri: 'medium', est: 5 },
  { p: 'APP', title: '태블릿 레이아웃 대응', desc: '넓은 화면에서 목록과 상세를 나란히 보여주는 레이아웃을 추가합니다.', pri: 'low', est: 8 },
  { p: 'APP', title: '리뷰 사진 업로드 용량 제한', desc: '큰 사진은 업로드 전에 줄이고 실패 시 안내 문구를 보여줍니다.', pri: 'medium', est: 2 },
  { p: 'APP', title: '딥링크 연결 오류 수정', desc: '마케팅 링크로 앱을 열었을 때 상품 화면으로 가지 않는 문제를 고칩니다.', pri: 'urgent', est: 3 },
  { p: 'OPS', title: '서버 로그 보관 기간 정책 정리', desc: '서비스별 로그 보관 기간과 비용을 비교해 기준을 정합니다.', pri: 'low', est: 2 },
  { p: 'OPS', title: 'SSL 인증서 만료 알림 설정', desc: '인증서 만료 30일, 7일 전에 팀 채널로 알림이 오도록 합니다.', pri: 'high', est: 2 },
  { p: 'OPS', title: '데이터베이스 슬로 쿼리 점검', desc: '지난 주 슬로 쿼리 로그에서 상위 10개를 골라 원인을 분석합니다.', pri: 'medium', est: 3 },
  { p: 'OPS', title: '배포 롤백 절차 문서화', desc: '문제가 생겼을 때 5분 안에 이전 버전으로 돌아가는 절차를 정리합니다.', pri: 'high', est: 3 },
  { p: 'OPS', title: '개발 환경 컨테이너 이미지 갱신', desc: '오래된 베이스 이미지를 최신 버전으로 올리고 빌드 시간을 비교합니다.', pri: 'low', est: 3 },
  { p: 'OPS', title: '장애 대응 매뉴얼 업데이트', desc: '최근 장애 사례를 반영해 연락 체계와 단계별 대응을 고칩니다.', pri: 'medium', est: 2 },
  { p: 'OPS', title: '비밀 키 로테이션 자동화', desc: '외부 서비스 키를 주기적으로 교체하는 작업을 스크립트로 만듭니다.', pri: 'medium', est: 5 },
  { p: 'OPS', title: 'CDN 캐시 규칙 점검', desc: '정적 파일 캐시 기간이 맞는지 확인하고 불필요한 무효화를 줄입니다.', pri: 'low', est: 2 },
]
