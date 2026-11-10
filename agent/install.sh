#!/bin/bash
# Turns an Ubuntu or Debian machine into a jitrunner agent: Docker, the job image, and a systemd service.
#
#   sudo JITRUNNER_URL=https://jitrunner.you.workers.dev bash agent/install.sh
#
# It makes this machine's agent token, keeps it in /etc/jitrunner/agent.env (readable by root only) and prints the
# token's SHA-256 for the Worker's AGENT_TOKEN_SHA256, so the token itself never leaves the machine.
#
# Optional: JITRUNNER_UBUNTU_MIRROR (a faster Ubuntu mirror for the job image), JITRUNNER_SLOTS, JITRUNNER_AGENT_NAME, JITRUNNER_LABELS, JITRUNNER_DOCKER_ARGS (see agent.mjs), and
# JITRUNNER_REPO / JITRUNNER_REF to install from a fork or branch. Run it again to update; it keeps the token.
set -euo pipefail

: "${JITRUNNER_URL:?Set JITRUNNER_URL to your Worker}"
repo=${JITRUNNER_REPO:-https://github.com/nisarahamedk/jitrunner}
ref=${JITRUNNER_REF:-main}

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq docker.io nodejs git curl xz-utils
systemctl enable --now docker

# The agent needs Node.js 18 or newer. Older releases (Ubuntu 22.04, Mint 21) ship 12, so fetch Node 22 instead.
node=/usr/bin/node
if [ "$("$node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
	case "$(uname -m)" in aarch64) node_arch=arm64 ;; *) node_arch=x64 ;; esac
	node_version=v22.12.0
	install -d /opt/jitrunner-node
	curl -fsSL --retry 5 "https://nodejs.org/dist/$node_version/node-$node_version-linux-$node_arch.tar.xz" \
		| tar -xJ -C /opt/jitrunner-node --strip-components 1
	node=/opt/jitrunner-node/bin/node
fi

if [ -d /opt/jitrunner/.git ]; then
	git -C /opt/jitrunner fetch -q origin "$ref"
	git -C /opt/jitrunner checkout -q FETCH_HEAD
else
	git clone -q --branch "$ref" "$repo" /opt/jitrunner
fi
docker build -t jitrunner-runner --build-arg UBUNTU_MIRROR="${JITRUNNER_UBUNTU_MIRROR:-}" /opt/jitrunner/runner

install -d -m 0700 /etc/jitrunner
umask 077
token=$(sed -n 's/^JITRUNNER_AGENT_TOKEN=//p' /etc/jitrunner/agent.env 2>/dev/null || true)
[ -n "$token" ] || token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
{
	echo "JITRUNNER_URL=$JITRUNNER_URL"
	echo "JITRUNNER_AGENT_TOKEN=$token"
	for name in JITRUNNER_SLOTS JITRUNNER_AGENT_NAME JITRUNNER_LABELS JITRUNNER_DOCKER_ARGS JITRUNNER_CACHE; do
		if [ -n "${!name:-}" ]; then echo "$name=${!name}"; fi
	done
} > /etc/jitrunner/agent.env

cat > /etc/systemd/system/jitrunner-agent.service <<UNIT
[Unit]
Description=jitrunner agent
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
EnvironmentFile=/etc/jitrunner/agent.env
ExecStart=$node /opt/jitrunner/agent/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable jitrunner-agent
systemctl restart jitrunner-agent
hash=$(printf %s "$token" | sha256sum | cut -d' ' -f1)
echo "jitrunner agent running. Logs: journalctl -u jitrunner-agent -f"
echo "Add this machine's token hash to the Worker's AGENT_TOKEN_SHA256 (comma separated, one per machine):"
echo "  $hash"
