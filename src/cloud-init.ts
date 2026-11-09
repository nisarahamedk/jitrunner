// Shell scripts handed to Hetzner as user data. cloud-init runs them as root on first boot.

/**
 * Installs the GitHub runner into /opt/actions-runner for the user "runner" (passwordless sudo, as on GitHub's own
 * runners). Shared by the boot script (stock Ubuntu image) and the bake script (snapshot image).
 */
export const INSTALL_RUNNER = String.raw`
install_runner() {
	export DEBIAN_FRONTEND=noninteractive
	id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
	echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
	chmod 0440 /etc/sudoers.d/runner
	[ -x /opt/actions-runner/run.sh ] && return 0
	apt-get update -q
	apt-get install -yq curl git jq unzip zstd build-essential ca-certificates
	case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=x64 ;; esac
	version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
	mkdir -p /opt/actions-runner
	curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-$arch-$version.tar.gz" \
		| tar -xz -C /opt/actions-runner
	/opt/actions-runner/bin/installdependencies.sh
	chown -R runner:runner /opt/actions-runner
}
`;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Boots one ephemeral runner for one job, then powers off. The JIT config is single-use and only valid for this
 * runner name; jitrunner deletes the server once GitHub reports the job done (or the cron sees no runner).
 */
export function bootScript(jitConfig: string): string {
	return `#!/bin/bash
set -euo pipefail
${INSTALL_RUNNER}
install_runner
cd /opt/actions-runner
sudo -u runner -H ./run.sh --jitconfig ${shellQuote(jitConfig)} || true
poweroff
`;
}

/** Prepares a snapshot: the runner, its dependencies, and whatever extra setup you add. Powers off when done. */
export function bakeScript(extra: string): string {
	return `#!/bin/bash
set -euo pipefail
${INSTALL_RUNNER}
install_runner
# --- extra setup ---
${extra}
# --- end extra setup ---
apt-get clean
cloud-init clean --logs
poweroff
`;
}
