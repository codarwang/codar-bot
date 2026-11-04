# codar-bot per-Bot sandbox image (M0-S4 spike).
# Pinned base + pinned pi (A7: version pin; upgrades go through an explicit
# bump + regression gate). node:24-alpine satisfies pi's engines >=22.19 and
# ships the unprivileged `node` user (uid 1000) — no adduser needed.
FROM docker.m.daocloud.io/library/node:24-alpine

# tini for proper PID-1 signal forwarding (docker run without --init).
RUN apk add --no-cache tini

RUN npm install -g @earendil-works/pi-coding-agent@1.5.0 --omit=dev

USER node
WORKDIR /home/bot/work

ENTRYPOINT ["/sbin/tini", "--", "pi"]

# Supply-chain note (M1 backlog): base is a moving tag via the daocloud
# mirror; pin by digest + verify npm integrity when the sandbox becomes a
# shipped artifact (architecture v0.9 M1 list).
