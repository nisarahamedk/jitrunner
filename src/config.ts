// Settings come from the Worker's vars (wrangler.jsonc) and secrets (wrangler secret put).

export interface Env {
	// Secrets
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string; // the .pem GitHub gives you, PKCS#1 or PKCS#8
	GITHUB_WEBHOOK_SECRET: string;
	HCLOUD_TOKEN: string;
	/**
	 * SHA-256 (hex) of each agent's token, comma separated; agent/install.sh makes the token and prints its hash, so
	 * the token itself never leaves the machine. Unset: no agents, and queued jobs get a server without waiting.
	 */
	AGENT_TOKEN_SHA256?: string;
	/** KV namespace where agents leave a sign of life, so jobs only wait for agents that are actually up. */
	AGENTS?: KVNamespace;
	// Vars
	LABEL: string;
	NAME_PREFIX: string;
	SERVER_TYPE: string;
	LOCATION: string;
	IMAGE: string;
	MAX_SERVERS: string;
	GRACE_SECONDS: string;
	BOOT_GRACE_SECONDS: string;
	IDLE_SECONDS: string;
	MAX_AGE_SECONDS: string;
	ALLOW_PUBLIC_REPOS: string;
	AGENT_GRACE_SECONDS: string;
}

export interface Config {
	/** A job is ours only when its runs-on includes this label. */
	label: string;
	/** Hetzner server names and runner names start with `${prefix}-`. */
	prefix: string;
	serverType: string;
	/** Tried in order; the next one is used when Hetzner has no room for SERVER_TYPE. */
	locations: string[];
	/** A Hetzner image name (ubuntu-24.04) or a snapshot id from scripts/build-image.ts. */
	image: string;
	/** Never more than this many JIT servers at once, across all repos. Caps the bill. */
	maxServers: number;
	/** How long a queued job may wait for one of your own runners before a server is made for it. */
	graceSeconds: number;
	/** How long a new server may take to boot and register its runner. */
	bootGraceSeconds: number;
	/** How long a registered runner may sit idle before its server is deleted. */
	idleSeconds: number;
	/** Every server is deleted at this age, whatever it is doing. */
	maxAgeSeconds: number;
	/** Self-hosted runners on public repos run code from anyone who can open a pull request. */
	allowPublicRepos: boolean;
	/** With agents set up: how long a queued job waits for one to claim it before it gets a server (at most 25). */
	agentGraceSeconds: number;
	/** Hashes of the agent tokens jitrunner accepts; empty means no agents. */
	agentTokenHashes: string[];
}

function int(name: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number, got "${value}"`);
	return parsed;
}

export function readConfig(env: Env): Config {
	if (!/^[a-z][a-z0-9-]{0,30}$/.test(env.NAME_PREFIX)) {
		throw new Error('NAME_PREFIX must be lowercase letters, digits and dashes, up to 31 characters');
	}
	return {
		label: env.LABEL,
		prefix: env.NAME_PREFIX,
		serverType: env.SERVER_TYPE,
		locations: env.LOCATION.split(',')
			.map((location) => location.trim())
			.filter(Boolean),
		image: env.IMAGE,
		maxServers: int('MAX_SERVERS', env.MAX_SERVERS),
		graceSeconds: int('GRACE_SECONDS', env.GRACE_SECONDS),
		bootGraceSeconds: int('BOOT_GRACE_SECONDS', env.BOOT_GRACE_SECONDS),
		idleSeconds: int('IDLE_SECONDS', env.IDLE_SECONDS),
		maxAgeSeconds: int('MAX_AGE_SECONDS', env.MAX_AGE_SECONDS),
		allowPublicRepos: env.ALLOW_PUBLIC_REPOS === 'true',
		agentGraceSeconds: Math.min(25, int('AGENT_GRACE_SECONDS', env.AGENT_GRACE_SECONDS)),
		agentTokenHashes: (env.AGENT_TOKEN_SHA256 ?? '')
			.split(',')
			.map((hash) => hash.trim().toLowerCase())
			.filter(Boolean),
	};
}
