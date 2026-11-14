# 실제 배포 기록 (2026-11-14)

서버 구조는 처음 예상과 달랐습니다. 아래가 실제 상태입니다.

- 서버 자체 nginx(호스트)가 80/443과 인증서를 맡고, `/` 를 홈페이지 컨테이너 `web`(127.0.0.1:8080)로 넘김
- cron `/usr/local/bin/ddggdd-sync`는 main을 받아 `web` 컨테이너 안 파일만 교체. 호스트 nginx 설정은 건드리지 않음
- 서버에 `docker compose`가 없어서 compose 대신 `docker run`으로 실행

## 설치된 것

| 항목 | 위치 |
| --- | --- |
| 코드 | `/opt/ddongko-team/src` (이 브랜치), 실행 복사본 `/opt/ddongko-team/app` |
| 환경변수 | `/opt/ddongko-team/team.env` (권한 600) |
| 컨테이너 | `ddongko-team`, 127.0.0.1:8081 → 8080, 재시작 자동 |
| 데이터 | Docker 볼륨 `ddongko_team_data` (`/data/team.sqlite`) |
| nginx | `/etc/nginx/sites-available/ddggdd.tech` 443 블록 맨 위에 `/team` 두 위치 추가 (`deploy/nginx-team.conf`와 같고 proxy_pass만 127.0.0.1:8081) |
| nginx 백업 | `/opt/ddongko-team/ddggdd.tech.nginx.bak` |

## 자주 쓰는 명령

- 코드 바꾼 뒤 반영: `sh /opt/ddongko-team/app/deploy/update.sh` (DB 백업 후 새 이미지로 교체)
- 상태: `docker ps --filter name=ddongko-team`, 로그: `docker logs --tail 50 ddongko-team`
- 통계: `docker exec ddongko-team node admin.mjs stats`
- 되돌리기(nginx): `cp /opt/ddongko-team/ddggdd.tech.nginx.bak /etc/nginx/sites-available/ddggdd.tech && nginx -t && systemctl reload nginx`

## main에 합칠 때

호스트 nginx가 `/team/`을 앱으로 넘기므로, 이 브랜치를 main에 합쳐 `team/` 폴더가 web 컨테이너에 복사돼도 밖에서는 보이지 않습니다.
그래도 nginx 설정을 되돌린 상태에서는 합치지 마세요. 그때는 `team/` 폴더의 소스가 그대로 공개됩니다.
