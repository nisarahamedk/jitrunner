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
	SERVER_TYPE_BY_LABEL?: string;
	LOCATION: string;
	IMAGE: string;
	MAX_SERVERS: string;
	GRACE_SECONDS: string;
	BOOT_GRACE_SECONDS: string;
	IDLE_SECONDS: string;
	MAX_AGE_SECONDS: string;
	ALLOW_PUBLIC_REPOS: string;
	/** The time zone /stats counts days in, e.g. America/Vancouver (default UTC). */
	STATS_TIME_ZONE?: string;
	AGENT_GRACE_SECONDS: string;
	REUSE_SECONDS?: string;
	SWAP_GB?: string;
	/** This Worker's own URL, which reused servers ask for their next job (needed with REUSE_SECONDS). */
	PUBLIC_URL?: string;
}

export interface Config {
	/** A job is ours only when its runs-on includes this label. */
	label: string;
	/** Hetzner server names and runner names start with `${prefix}-`. */
	prefix: string;
	serverType: string;
	/**
	 * Server types for jobs asking for a label, first match wins: "ephemeral=cx23" puts short jobs on a smaller
	 * server. Every type must have SERVER_TYPE's architecture.
	 */
	serverTypeByLabel: [label: string, serverType: string][];
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
	/**
	 * Hetzner bills every server for a whole hour. With this set, a server whose job asked for nothing beyond
	 * self-hosted, LABEL and the GitHub defaults stays up after it and takes more such jobs, until it has been up this
	 * long; then it powers off and is deleted. Leave room for a last job to finish inside the hour. 0: one job per server.
	 */
	reuseSeconds: number;
	/** This Worker's URL, for reused servers. */
	publicUrl: string;
	/** A swap file of this many GB on every server, so a memory peak slows a job down instead of killing it. */
	swapGb: number;
	statsTimeZone: string;
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
	if (env.REUSE_SECONDS && env.REUSE_SECONDS !== '0' && (!env.PUBLIC_URL || !env.AGENTS)) {
		throw new Error("REUSE_SECONDS needs PUBLIC_URL (this Worker's URL) and the AGENTS KV namespace");
	}
	return {
		label: env.LABEL,
		prefix: env.NAME_PREFIX,
		serverType: env.SERVER_TYPE,
		serverTypeByLabel: (env.SERVER_TYPE_BY_LABEL ?? '')
			.split(',')
			.map((pair) => pair.trim())
			.filter(Boolean)
			.map((pair) => {
				const [label, serverType] = pair.split('=').map((part) => part.trim());
				if (!label || !serverType) throw new Error(`SERVER_TYPE_BY_LABEL entries are label=type, got "${pair}"`);
				return [label.toLowerCase(), serverType] as [string, string];
			}),
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
		reuseSeconds: int('REUSE_SECONDS', env.REUSE_SECONDS ?? '0'),
		swapGb: int('SWAP_GB', env.SWAP_GB ?? '0'),
		statsTimeZone: env.STATS_TIME_ZONE || 'UTC',
		publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''),
		agentTokenHashes: (env.AGENT_TOKEN_SHA256 ?? '')
			.split(',')
			.map((hash) => hash.trim().toLowerCase())
			.filter(Boolean),
	};
}
