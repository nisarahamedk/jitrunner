// Shell scripts handed to Hetzner as user data. cloud-init runs them as root on first boot.

/**
 * Installs the GitHub runner into /opt/actions-runner for the user "runner" (passwordless sudo, as on GitHub's own
 * runners). Shared by the boot script (stock Ubuntu image) and the bake script (snapshot image).
 */
export const INSTALL_RUNNER = String.raw`
fetch() {
	curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 "$@"
}

install_runner() {
	export DEBIAN_FRONTEND=noninteractive
	id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
	echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
	chmod 0440 /etc/sudoers.d/runner
	[ -x /opt/actions-runner/run.sh ] && return 0
	apt-get -o Acquire::Retries=5 update -q
	apt-get -o Acquire::Retries=5 install -yq curl git jq unzip zstd build-essential ca-certificates
	case "$(uname -m)" in aarch64) arch=arm64 ;; *) arch=x64 ;; esac
	# The release page redirects to .../tag/v<version>. Unlike api.github.com, it has no 60-an-hour limit per IP,
	# and Hetzner hands the same addresses out again and again.
	version=$(fetch -o /dev/null -w '%{url_effective}' https://github.com/actions/runner/releases/latest | sed 's#.*/v##')
	mkdir -p /opt/actions-runner
	fetch "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-$arch-$version.tar.gz" \
		| tar -xz -C /opt/actions-runner
	/opt/actions-runner/bin/installdependencies.sh
	chown -R runner:runner /opt/actions-runner
}
`;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Gives up when no job has started after IDLE_SECONDS: GitHub may hand the job this runner was made for to another
 * runner, and then this one would wait forever. The runner writes _diag/Worker_*.log when a job starts.
 */
export const IDLE_WATCHDOG = String.raw`
watch_idle() {
	sleep "$1"
	if ! compgen -G "$2/_diag/Worker_*" >/dev/null; then
		echo "jitrunner: no job after $1s, giving up"
		pkill -TERM -f Runner.Listener || true
	fi
}
`;

/** How a reused server asks the Worker for its next job (REUSE_SECONDS). */
export interface Reuse {
	/** The Worker's /agent/claim URL. */
	claimUrl: string;
	/** "server <name>:<HMAC of the name>", which the Worker checks without storing anything. */
	authorization: string;
	server: string;
	labels: string[];
	arch: 'X64' | 'ARM64';
	/** Stop asking once the server has been up this long. */
	untilSeconds: number;
}

/**
 * After its first job, a reused server asks for the next one every 10 seconds, as an agent would, and runs it with
 * the same runner install. It stops asking at untilSeconds of uptime and powers off.
 */
function reuseLoop(reuse: Reuse, idleSeconds: number): string {
	const body = JSON.stringify({ agent: reuse.server, labels: reuse.labels, arch: reuse.arch, slots: 1 });
	return `
trap - ERR
set +e
while [ "$(cut -d. -f1 /proc/uptime)" -lt ${reuse.untilSeconds} ]; do
	jit=$(curl -fsS --max-time 30 -X POST -H ${shellQuote(`Authorization: ${reuse.authorization}`)} \
		-H 'Content-Type: application/json' -d ${shellQuote(body)} ${shellQuote(reuse.claimUrl)} \
		| jq -r '.claims[0].jitConfig // empty')
	if [ -z "$jit" ]; then sleep 10; continue; fi
	echo "jitrunner: next job"
	# A fresh start for each runner: no settings or logs left from the last one.
	rm -rf /opt/actions-runner/_diag /opt/actions-runner/.runner /opt/actions-runner/.credentials*
	watch_idle ${idleSeconds} /opt/actions-runner &
	watcher=$!
	sudo -u runner -H ./run.sh --jitconfig "$jit"
	kill "$watcher" 2>/dev/null
done
echo "jitrunner: reuse time is up"
`;
}

/**
 * Boots one ephemeral runner for one job (and, with reuse, more jobs after it), then powers off; jitrunner deletes
 * powered-off servers. The JIT config is single-use and only valid for this runner name.
 */
export function bootScript(jitConfig: string, idleSeconds: number, reuse?: Reuse, swapGb = 0): string {
	return `#!/bin/bash
set -Eeuo pipefail
# A failed setup powers off at once, so jitrunner deletes the server and makes a new one within a minute or two,
# instead of waiting BOOT_GRACE_SECONDS for a runner that will never connect.
trap 'echo "jitrunner: setup failed"; poweroff' ERR
${INSTALL_RUNNER}
${IDLE_WATCHDOG}
${
	swapGb > 0
		? `# Swap, so a job that briefly needs more memory than the server has slows down instead of dying.
fallocate -l ${swapGb}G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
`
		: ''
}install_runner
cd /opt/actions-runner
watch_idle ${idleSeconds} /opt/actions-runner &
watcher=$!
sudo -u runner -H ./run.sh --jitconfig ${shellQuote(jitConfig)} || true
kill "$watcher" 2>/dev/null || true
${reuse ? reuseLoop(reuse, idleSeconds) : ''}
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
