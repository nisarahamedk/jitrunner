#!/bin/bash
# Turns an Ubuntu or Debian machine into a jitrunner agent: Docker, the job image, and a systemd service.
#
#   sudo JITRUNNER_URL=https://jitrunner.you.workers.dev JITRUNNER_AGENT_TOKEN=... bash agent/install.sh
#
# Optional: JITRUNNER_SLOTS, JITRUNNER_AGENT_NAME, JITRUNNER_LABELS, JITRUNNER_DOCKER_ARGS (see agent.mjs), and
# JITRUNNER_REPO / JITRUNNER_REF to install from a fork or branch. Run it again to update.
set -euo pipefail

: "${JITRUNNER_URL:?Set JITRUNNER_URL to your Worker}"
: "${JITRUNNER_AGENT_TOKEN:?Set JITRUNNER_AGENT_TOKEN to the AGENT_TOKEN secret of your Worker}"
repo=${JITRUNNER_REPO:-https://github.com/nisarahamedk/jitrunner}
ref=${JITRUNNER_REF:-main}

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io nodejs git
systemctl enable --now docker

if [ -d /opt/jitrunner/.git ]; then
	git -C /opt/jitrunner fetch -q origin "$ref"
	git -C /opt/jitrunner checkout -q FETCH_HEAD
else
	git clone -q --branch "$ref" "$repo" /opt/jitrunner
fi
docker build -t jitrunner-runner /opt/jitrunner/runner

install -d -m 0700 /etc/jitrunner
umask 077
{
	echo "JITRUNNER_URL=$JITRUNNER_URL"
	echo "JITRUNNER_AGENT_TOKEN=$JITRUNNER_AGENT_TOKEN"
	for name in JITRUNNER_SLOTS JITRUNNER_AGENT_NAME JITRUNNER_LABELS JITRUNNER_DOCKER_ARGS; do
		if [ -n "${!name:-}" ]; then echo "$name=${!name}"; fi
	done
} > /etc/jitrunner/agent.env

cat > /etc/systemd/system/jitrunner-agent.service <<'UNIT'
[Unit]
Description=jitrunner agent
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
EnvironmentFile=/etc/jitrunner/agent.env
ExecStart=/usr/bin/node /opt/jitrunner/agent/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable jitrunner-agent
systemctl restart jitrunner-agent
echo "jitrunner agent running. Logs: journalctl -u jitrunner-agent -f"
