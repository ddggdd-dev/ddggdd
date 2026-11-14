#!/bin/sh
# Rebuild and restart the team app from the feat/team-board-phase1 branch (or BRANCH=...).
# Run on the VPS as root:  sh /opt/ddongko-team/app/deploy/update.sh
set -e
BRANCH=${BRANCH:-feat/team-board-phase1}
cd /opt/ddongko-team
git -C src fetch -q --depth 1 origin "$BRANCH" && git -C src checkout -q -B "$BRANCH" FETCH_HEAD
rm -rf app.new && cp -r src/team app.new
TAG=$(git -C src rev-parse --short HEAD)
docker build -q -t "ddongko-team:$TAG" app.new
docker exec ddongko-team node admin.mjs backup || true
docker rm -f ddongko-team
docker run -d --name ddongko-team --restart unless-stopped -p 127.0.0.1:8081:8080 \
  -v ddongko_team_data:/data --env-file /opt/ddongko-team/team.env \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 256m \
  "ddongko-team:$TAG"
rm -rf app && mv app.new app
sleep 3 && curl -fsS http://127.0.0.1:8081/healthz && echo " ddongko-team:$TAG running"
