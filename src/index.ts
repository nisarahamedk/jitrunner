// jitrunner: GitHub Actions jobs run on your own machines first, and on a fresh Hetzner server when none is free.
//
//   POST /webhook   GitHub's workflow_job events (queued: maybe create a server; completed: delete it)
//   cron            every minute: create servers for jobs still waiting, delete servers that are done or stuck

import { readConfig, type Config, type Env } from './config.ts';
import { bootScript } from './cloud-init.ts';
import { GitHubError, Installation, type Repo, verifyWebhook } from './github.ts';
import { Hetzner } from './hetzner.ts';
import { archOf, cleanup, isJitName, provision, type Action, type Runner, type Server } from './plan.ts';

interface WorkflowJobEvent {
	action: 'queued' | 'in_progress' | 'completed' | 'waiting';
	workflow_job: { id: number; labels: string[]; created_at: string; runner_name: string | null };
	repository: { name: string; private: boolean; owner: { login: string } };
	installation: { id: number };
}

function allowed(config: Config, repo: Repo): boolean {
	return repo.private || config.allowPublicRepos;
}

async function create(
	config: Config,
	hetzner: Hetzner,
	installation: Installation,
	repo: Repo,
	action: Extract<Action, { kind: 'create' }>,
): Promise<void> {
	let jitConfig: string;
	try {
		jitConfig = await installation.jitConfig(repo, action.name, action.labels);
	} catch (error) {
		// 409: a runner with this name exists, so a server for this job is already on its way.
		if (error instanceof GitHubError && error.status === 409) return;
		throw error;
	}
	const result = await hetzner.create({
		name: action.name,
		serverType: config.serverType,
		location: config.location,
		image: config.image,
		userData: bootScript(jitConfig),
		sshKey: await hetzner.lockoutKey(),
	});
	console.log(`${result} ${action.name} for job ${action.jobId} in ${repo.owner}/${repo.name}`);
}

async function onWebhook(env: Env, event: WorkflowJobEvent): Promise<void> {
	const config = readConfig(env);
	const job = event.workflow_job;
	const repo: Repo = {
		owner: event.repository.owner.login,
		name: event.repository.name,
		private: event.repository.private,
	};
	if (!allowed(config, repo)) return;
	const hetzner = new Hetzner(env.HCLOUD_TOKEN, config.prefix);

	if (event.action === 'completed') {
		if (job.runner_name && isJitName(config, job.runner_name)) {
			await hetzner.deleteByName(job.runner_name);
			console.log(`deleted ${job.runner_name}: job ${job.id} completed`);
		}
		return;
	}
	if (event.action !== 'queued') return;

	const installation = await Installation.open(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, event.installation.id);
	const [servers, runners] = await Promise.all([hetzner.servers(), installation.runners(repo)]);
	const queued = [{ id: job.id, labels: job.labels, created: Date.parse(job.created_at) }];
	for (const action of provision(config, Date.now(), queued, servers, runners, archOf(config.serverType))) {
		if (action.kind === 'create') await create(config, hetzner, installation, repo, action);
	}
}

async function reconcile(env: Env): Promise<void> {
	const config = readConfig(env);
	const hetzner = new Hetzner(env.HCLOUD_TOKEN, config.prefix);
	const servers: Server[] = await hetzner.servers();
	const now = Date.now();

	const repos: { installation: Installation; repo: Repo; runners: Runner[] }[] = [];
	for (const id of await Installation.ids(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)) {
		const installation = await Installation.open(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, id);
		for (const repo of await installation.repos()) {
			if (allowed(config, repo)) repos.push({ installation, repo, runners: await installation.runners(repo) });
		}
	}
	const allRunners = repos.flatMap((entry) => entry.runners);

	// Delete first, so finished servers free their place under MAX_SERVERS.
	for (const action of cleanup(config, now, servers, allRunners)) {
		if (action.kind !== 'delete') continue;
		await hetzner.delete(action.serverId);
		const owner = repos.find((entry) => entry.runners.some((runner) => runner.id === action.runnerId));
		if (owner && action.runnerId !== undefined) await owner.installation.deleteRunner(owner.repo, action.runnerId);
		console.log(`deleted ${action.name}: ${action.reason}`);
		const index = servers.findIndex((server) => server.id === action.serverId);
		if (index !== -1) servers.splice(index, 1);
	}

	// Runners left behind by a server that never got made (its JIT config was issued, then creating it failed).
	const names = new Set(servers.map((server) => server.name));
	for (const { installation, repo, runners } of repos) {
		for (const runner of runners) {
			if (isJitName(config, runner.name) && runner.status === 'offline' && !names.has(runner.name)) {
				await installation.deleteRunner(repo, runner.id);
			}
		}
	}

	for (const { installation, repo, runners } of repos) {
		const jobs = await installation.queuedJobs(repo);
		for (const action of provision(config, now, jobs, servers, runners, archOf(config.serverType))) {
			if (action.kind !== 'create') continue;
			await create(config, hetzner, installation, repo, action);
			servers.push({ id: -1, name: action.name, created: now });
		}
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/webhook') return new Response('jitrunner\n');
		if (request.method !== 'POST') return new Response('Method not allowed\n', { status: 405 });
		const body = await request.text();
		if (!(await verifyWebhook(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('X-Hub-Signature-256')))) {
			return new Response('Bad signature\n', { status: 401 });
		}
		if (request.headers.get('X-GitHub-Event') !== 'workflow_job') return new Response('Ignored\n', { status: 202 });
		ctx.waitUntil(
			onWebhook(env, JSON.parse(body) as WorkflowJobEvent).catch((error: unknown) => {
				// The cron reconcile catches up within a minute; the log says why this one failed.
				console.error('webhook handling failed', error);
			}),
		);
		return new Response('Accepted\n', { status: 202 });
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(reconcile(env));
	},
} satisfies ExportedHandler<Env>;
