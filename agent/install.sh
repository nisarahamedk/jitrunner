#!/bin/bash
# Turns a machine into a jitrunner agent: Docker, the job image, and a service that keeps the agent running.
#
#   Linux (Ubuntu, Debian, Mint):   sudo JITRUNNER_URL=https://jitrunner.you.workers.dev bash install.sh
#   macOS (needs Homebrew):         JITRUNNER_URL=https://jitrunner.you.workers.dev bash install.sh
#
# On macOS run it as the user the agent should run as, without sudo: the agent runs while that user is logged in.
# It makes this machine's agent token, keeps it on the machine (readable by its owner only) and prints the token's
# SHA-256 for the Worker's AGENT_TOKEN_SHA256, so the token itself never leaves the machine. Run it again to update; it
# keeps the token. It ends with a self-test: a job container must be able to write its work folder and the caches.
#
# Optional:
#   JITRUNNER_NO_SUSPEND=1   Linux: never suspend, lid closed included (for laptops; applies after a reboot).
#                            macOS always keeps the machine awake while it is on power (caffeinate -s); a closed lid
#                            still sleeps it unless a display is connected.
#   JITRUNNER_UBUNTU_MIRROR (a faster Ubuntu mirror for the job image), JITRUNNER_SLOTS, JITRUNNER_AGENT_NAME,
#   JITRUNNER_LABELS, JITRUNNER_DOCKER_ARGS, JITRUNNER_CACHE, JITRUNNER_IMAGE, JITRUNNER_POLL_SECONDS,
#   JITRUNNER_EPHEMERAL, JITRUNNER_IDLE_SECONDS, JITRUNNER_MAX_JOB_SECONDS (see agent.mjs), and JITRUNNER_REPO / JITRUNNER_REF to install from a fork or branch.
set -euo pipefail

: "${JITRUNNER_URL:?Set JITRUNNER_URL to your Worker}"
repo=${JITRUNNER_REPO:-https://github.com/nisarahamedk/jitrunner}
ref=${JITRUNNER_REF:-main}
image=${JITRUNNER_IMAGE:-jitrunner-runner}

# Clones or updates jitrunner into $1.
fetch_code() {
	if [ -d "$1/.git" ]; then
		git -C "$1" fetch -q origin "$ref"
		git -C "$1" checkout -q FETCH_HEAD
	else
		git clone -q --branch "$ref" "$repo" "$1"
	fi
}

# Builds the base job image from $1/runner. A repo's own image (.jitrunner/Dockerfile) is built by the agent itself.
build_images() {
	docker build -t jitrunner-runner --build-arg UBUNTU_MIRROR="${JITRUNNER_UBUNTU_MIRROR:-}" "$1/runner"
}

# A job container must be able to write its work folder and each cache volume the agent mounts (agent.mjs).
self_test() {
	docker run --rm --entrypoint bash \
		--volume jitrunner-tool:/opt/actions-runner/_work/_tool \
		--volume jitrunner-cache:/home/runner/.cache \
		--volume jitrunner-pnpm:/home/runner/.local/share/pnpm \
		"$image" -c 'set -e
			for dir in /opt/actions-runner/_work /opt/actions-runner/_work/_tool ~/.cache ~/.local/share/pnpm; do
				touch "$dir/.jitrunner-write-test" && rm "$dir/.jitrunner-write-test"
			done'
	echo "Self-test OK: $image can write its work folder and caches."
}

# Writes the agent's settings to $1, keeping the token already in it.
write_env() {
	local token
	token=$(sed -n 's/^JITRUNNER_AGENT_TOKEN=//p' "$1" 2>/dev/null || true)
	[ -n "$token" ] || token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
	(
		umask 077
		{
			echo "JITRUNNER_URL=$JITRUNNER_URL"
			echo "JITRUNNER_AGENT_TOKEN=$token"
			for name in JITRUNNER_SLOTS JITRUNNER_AGENT_NAME JITRUNNER_LABELS JITRUNNER_DOCKER_ARGS JITRUNNER_CACHE JITRUNNER_IMAGE JITRUNNER_POLL_SECONDS JITRUNNER_EPHEMERAL JITRUNNER_IDLE_SECONDS JITRUNNER_MAX_JOB_SECONDS; do
				if [ -n "${!name:-}" ]; then echo "$name=${!name}"; fi
			done
		} > "$1"
	)
}

print_hash() {
	local token
	token=$(sed -n 's/^JITRUNNER_AGENT_TOKEN=//p' "$1")
	echo "Add this machine's token hash to the Worker's AGENT_TOKEN_SHA256 (comma separated, one per machine):"
	printf '  %s\n' "$(printf %s "$token" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
}

install_linux() {
	[ "$(id -u)" = 0 ] || { echo "Run it with sudo on Linux." >&2; exit 1; }
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

	fetch_code /opt/jitrunner
	build_images /opt/jitrunner
	self_test

	if [ "${JITRUNNER_NO_SUSPEND:-}" = 1 ]; then
		install -d /etc/systemd/logind.conf.d
		printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\nIdleAction=ignore\n' \
			> /etc/systemd/logind.conf.d/jitrunner-no-suspend.conf
		systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
		echo "Suspend is off (lid closed too) from the next reboot."
	fi

	install -d -m 0700 /etc/jitrunner
	write_env /etc/jitrunner/agent.env
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
	echo "jitrunner agent running. Logs: journalctl -u jitrunner-agent -f"
	print_hash /etc/jitrunner/agent.env
}

install_macos() {
	[ "$(id -u)" != 0 ] || { echo "Run it without sudo on macOS, as the user the agent should run as." >&2; exit 1; }
	command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh" >&2; exit 1; }
	export PATH="$HOME/.orbstack/bin:$(brew --prefix)/bin:$PATH"
	command -v node >/dev/null || brew install node
	command -v git >/dev/null || brew install git
	# OrbStack runs Docker's Linux containers (native Arm on Apple silicon).
	[ -d /Applications/OrbStack.app ] || brew install --cask orbstack
	open -ga OrbStack
	until docker info >/dev/null 2>&1; do echo "Waiting for OrbStack's Docker to start..."; sleep 3; done

	local dir=$HOME/.jitrunner plist=$HOME/Library/LaunchAgents/dev.jitrunner.agent.plist
	mkdir -p "$dir" && chmod 700 "$dir"
	fetch_code "$dir/jitrunner"
	build_images "$dir/jitrunner"
	self_test
	write_env "$dir/agent.env"

	# Starts at login, restarts if it stops, and keeps the Mac awake while it is on power.
	mkdir -p "$HOME/Library/LaunchAgents"
	cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>dev.jitrunner.agent</string>
	<key>ProgramArguments</key><array>
		<string>/bin/bash</string><string>-c</string>
		<string>set -a; . "$dir/agent.env"; set +a; exec /usr/bin/caffeinate -s node "$dir/jitrunner/agent/agent.mjs"</string>
	</array>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$dir/agent.log</string>
	<key>StandardErrorPath</key><string>$dir/agent.log</string>
</dict></plist>
PLIST
	launchctl bootout "gui/$(id -u)/dev.jitrunner.agent" 2>/dev/null || true
	# bootout returns before the old agent is gone, and bootstrap fails ("5: Input/output error") until it is.
	for _ in $(seq 40); do
		launchctl print "gui/$(id -u)/dev.jitrunner.agent" >/dev/null 2>&1 || break
		sleep 0.5
	done
	launchctl bootstrap "gui/$(id -u)" "$plist"
	echo "jitrunner agent running. Logs: tail -f $dir/agent.log"
	print_hash "$dir/agent.env"
}

case "$(uname -s)" in
	Linux) install_linux ;;
	Darwin) install_macos ;;
	*) echo "jitrunner agents run on Linux (Ubuntu, Debian, Mint) or macOS." >&2; exit 1 ;;
esac
