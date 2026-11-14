# 적용 지시문 — 되는날 (우리 팀 되는 날 보드) 1단계

## 확정된 요구사항

기존 `ddggdd.tech`의 `/team/`에 팀 보드 앱을 추가한다. 새 외부 서비스는 쓰지 않는다.
기존 Hostinger VPS의 Docker/nginx를 사용한다. 로그인 없이 카톡 초대 링크와 이름으로 참여한다.
**이 묶음은 미배포 상태다. 기존 홈페이지·nginx·cron·DNS를 임의로 바꾸지 않는다.**

## 현재 운영 정보 (사용자가 전달한 내용)

- `ddggdd-dev/ddggdd` 코드 → 서버 cron이 매분 확인 → 웹 폴더 통째 교체
- `web` nginx 컨테이너가 운영 서비스를 제공
- 따라서 앱 실행 폴더·DB·환경변수 파일을 cron 웹 폴더 안에 두면 안 됨

## 적용 순서

1. 저장소와 VPS의 지침 파일(AGENTS.md, CLAUDE.md 등)을 먼저 읽는다. cron의 배포 브랜치·웹 경로, nginx 볼륨과 네트워크는 읽기만 한다.
2. `ddggdd-dev/ddggdd`에 새 개발 브랜치를 만들고 이 폴더를 `team/`에 넣는다. main에 바로 push/merge하지 않는다.
3. Node 24로 `npm ci && npm run typecheck && npm run build && npm test`를 실행한다.
4. 실행 폴더를 예: `/opt/ddongko-team/app`에 준비한다. cron이 관리하는 웹 폴더와 분리한다.
5. 기존 `web` 컨테이너가 쓰는 Docker 사용자 정의 네트워크 이름을 확인해 `WEB_NETWORK`에 지정한다. 추측한 이름을 쓰지 않는다.
6. `/opt/ddongko-team/team.env`를 `deploy/team.env.example`로 만든다. 권한을 제한한다.
   `KAKAO_JS_KEY`는 선택이다. 비워 두면 공유는 휴대폰 공유창·링크 복사로 동작한다.
7. `WEB_NETWORK=<확인한 이름> docker compose -f deploy/compose.yaml up -d --build`. 볼륨 `ddongko_team_data`는 지우지 않는다.
8. `ddggdd.tech` HTTPS server 블록을 백업하고 `deploy/nginx-team.conf`의 location 두 개만 추가한다.
   `access_log off`를 유지한다 (개인 링크에 열쇠가 들어 있음). nginx 설정이 cron으로 교체되는 파일인지 확인한다.
   `nginx -t` 통과 후에만 reload한다. 최종 배포 여부는 사용자가 결정한다.

## 실서비스 확인

- 안드로이드·아이폰 카카오톡 안에서 `/team/` 열기, 팀 만들기
- 초대 링크를 단톡방에 올렸을 때 미리보기 카드 제목·설명 표시
- 두 번째 폰에서 초대 링크로 참여 → 안 되는 날 표시 → 첫 폰 보드에 30초 안에 반영
- 날짜 시트에서 "이날로 하자" → 모임 링크 공유 → 다른 폰에서 참석/어려워요 → 어려워요가 보드에 반영
- 확정 후 응답 잠김, .ics가 아이폰·삼성 캘린더에서 열리는지, 구글 캘린더 링크
- 개인 링크로 다른 기기에서 이어 쓰기, 팀장의 초대 링크 재발급 후 예전 링크 차단
- 컨테이너 재시작과 cron 1회 실행 후에도 데이터 유지, 기존 홈페이지 경로 정상
