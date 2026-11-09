// Every decision jitrunner makes, as pure functions of what GitHub and Hetzner report. No state of its own: the
// servers (by name and label) and GitHub's runner list are the whole truth, so a lost webhook or a restart loses
// nothing. The cron reconcile runs these every minute; the webhook runs them early to save that minute.

import type { Config } from './config.ts';

export interface Server {
	id: number;
	name: string;
	created: number; // ms since epoch
}

export interface Runner {
	id: number;
	name: string;
	status: 'online' | 'offline';
	busy: boolean;
	labels: string[];
}

export interface QueuedJob {
	id: number;
	labels: string[];
	created: number; // ms since epoch
}

export type Action =
	| { kind: 'create'; jobId: number; name: string; labels: string[] }
	| { kind: 'delete'; serverId: number; name: string; runnerId?: number; reason: string };

export function serverName(config: Config, jobId: number): string {
	return `${config.prefix}-${jobId}`;
}

export function isJitName(config: Config, name: string): boolean {
	return name.startsWith(`${config.prefix}-`);
}

/** The runner an agent on one of your machines starts for a job. GitHub refuses a second runner with the same name,
 * so minting its JIT config doubles as a lock: one job, one claim, across every agent. */
export function agentRunnerName(config: Config, jobId: number): string {
	return `agent-${config.prefix}-${jobId}`;
}

export function isAgentName(config: Config, name: string): boolean {
	return name.startsWith(`agent-${config.prefix}-`);
}

const lower = (labels: string[]) => labels.map((label) => label.toLowerCase());

/** The job asked for jitrunner: its runs-on includes the configured label. */
export function wantsJit(config: Config, labels: string[]): boolean {
	return lower(labels).includes(config.label.toLowerCase());
}

/** GitHub gives a job to a runner that has every label the job asks for (case-insensitive). */
export function runnerFits(runner: Runner, jobLabels: string[]): boolean {
	const have = new Set(lower(runner.labels));
	return lower(jobLabels).every((label) => have.has(label));
}

/** Your own machines (not JIT servers) that are online and idle right now. */
export function freeOwnRunners(config: Config, runners: Runner[]): Runner[] {
	return runners.filter(
		(runner) =>
			!isJitName(config, runner.name) &&
			!isAgentName(config, runner.name) &&
			runner.status === 'online' &&
			!runner.busy,
	);
}

/** The labels a JIT server's runner registers with: exactly what the job asked for, plus GitHub's defaults. */
export function runnerLabels(jobLabels: string[], arch: 'X64' | 'ARM64'): string[] {
	const labels = ['self-hosted', 'Linux', arch];
	for (const label of jobLabels) {
		if (!lower(labels).includes(label.toLowerCase())) labels.push(label);
	}
	return labels;
}

/** Servers to delete: finished, never registered, gone offline, idle too long, or simply too old. */
export function cleanup(config: Config, now: number, servers: Server[], runners: Runner[]): Action[] {
	const actions: Action[] = [];
	for (const server of servers) {
		if (!isJitName(config, server.name)) continue;
		const age = (now - server.created) / 1000;
		const runner = runners.find((candidate) => candidate.name === server.name);
		const remove = (reason: string): void => {
			actions.push({ kind: 'delete', serverId: server.id, name: server.name, runnerId: runner?.id, reason });
		};
		if (age > config.maxAgeSeconds) remove('older than MAX_AGE_SECONDS');
		else if (age <= config.bootGraceSeconds) continue;
		// An ephemeral runner removes itself when its job ends, so no runner after boot means done (or never started).
		else if (!runner) remove('no runner: job finished or the runner never registered');
		else if (runner.status === 'offline') remove('runner offline');
		else if (!runner.busy && age > config.idleSeconds) remove('runner idle longer than IDLE_SECONDS');
	}
	return actions;
}

/**
 * Servers to create for queued jobs. A job waits GRACE_SECONDS first when one of your own machines could take it,
 * then gets a server of its own. MAX_SERVERS counts every JIT server, including ones about to be deleted.
 */
export function provision(
	config: Config,
	now: number,
	jobs: QueuedJob[],
	servers: Server[],
	runners: Runner[],
	arch: 'X64' | 'ARM64',
	/** An agent asked for work in the last few minutes, so young jobs are left for it to claim. */
	agentsAlive = false,
): Action[] {
	const actions: Action[] = [];
	const names = new Set(servers.map((server) => server.name));
	const claimed = new Set(runners.map((runner) => runner.name));
	let count = servers.filter((server) => isJitName(config, server.name)).length;
	// Each free machine of yours is expected to take one waiting job, so only that many jobs wait for them.
	const free = freeOwnRunners(config, runners);
	for (const job of [...jobs].sort((a, b) => a.created - b.created)) {
		if (!wantsJit(config, job.labels)) continue;
		const name = serverName(config, job.id);
		if (names.has(name) || claimed.has(agentRunnerName(config, job.id))) continue;
		const waited = (now - job.created) / 1000;
		// With agents, a young job is theirs to claim first.
		if (agentsAlive && waited < config.agentGraceSeconds) continue;
		if (waited < config.graceSeconds) {
			const index = free.findIndex((runner) => runnerFits(runner, job.labels));
			if (index !== -1) {
				free.splice(index, 1);
				continue;
			}
		}
		if (count >= config.maxServers) break;
		actions.push({ kind: 'create', jobId: job.id, name, labels: runnerLabels(job.labels, arch) });
		names.add(name);
		count += 1;
	}
	return actions;
}

/**
 * Jobs an agent may claim: they asked for jitrunner, every label they ask for is one the agent has (so a job that
 * asks for `ephemeral` never reaches an agent that lacks it), and no server or other agent has them yet.
 */
export function claimable(
	config: Config,
	jobs: QueuedJob[],
	servers: Server[],
	runners: Runner[],
	agentLabels: string[],
	slots: number,
): QueuedJob[] {
	const have = new Set(lower(agentLabels));
	const serverNames = new Set(servers.map((server) => server.name));
	const runnerNames = new Set(runners.map((runner) => runner.name));
	return [...jobs]
		.sort((a, b) => a.created - b.created)
		.filter(
			(job) =>
				wantsJit(config, job.labels) &&
				lower(job.labels).every((label) => have.has(label)) &&
				!serverNames.has(serverName(config, job.id)) &&
				!runnerNames.has(agentRunnerName(config, job.id)),
		)
		.slice(0, Math.max(0, slots));
}

/** Hetzner server types starting with "cax" are Arm (Ampere); the rest are x86. */
export function archOf(serverType: string): 'X64' | 'ARM64' {
	return serverType.startsWith('cax') ? 'ARM64' : 'X64';
}
