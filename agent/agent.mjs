#!/usr/bin/env node
// jitrunner agent: lets one of your own machines take jobs before jitrunner pays for a Hetzner server.
//
// Every few seconds it tells the Worker how many free slots it has. The Worker answers with one-time runner configs
// for queued jobs this machine can run, and the agent starts each in a fresh Docker container (runner/Dockerfile).
// The container registers its runner, runs the one job, exits and is removed. Nothing listens on this machine.
//
// Plain JavaScript with no dependencies, so it runs on the Node.js your distribution ships (18 or newer).
//
// Environment:
//   JITRUNNER_URL            the Worker, e.g. https://jitrunner.you.workers.dev (required)
//   JITRUNNER_AGENT_TOKEN    the Worker's AGENT_TOKEN secret (required)
//   JITRUNNER_AGENT_NAME     shown in logs (default: the host name)
//   JITRUNNER_SLOTS          jobs at once (default 1)
//   JITRUNNER_LABELS         labels this machine offers (default: self-hosted,Linux,<X64|ARM64>,jit). Never add
//                            `ephemeral`: jobs asking for it need a machine that is wiped, and this one is not.
//   JITRUNNER_IMAGE          the job container image (default jitrunner-runner)
//   JITRUNNER_DOCKER_ARGS    extra `docker run` arguments, e.g. "--cpus 2 --memory 6g"
//   JITRUNNER_POLL_SECONDS   default 5
//   JITRUNNER_MAX_JOB_SECONDS  a container is stopped at this age (default 21600, GitHub's own job limit)
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

const env = process.env;
const url = env.JITRUNNER_URL?.replace(/\/$/, '');
const token = env.JITRUNNER_AGENT_TOKEN;
if (!url || !token) {
	console.error('Set JITRUNNER_URL and JITRUNNER_AGENT_TOKEN.');
	process.exit(1);
}
const arch = process.arch === 'arm64' ? 'ARM64' : 'X64';
const agent = env.JITRUNNER_AGENT_NAME || hostname();
const slots = Number(env.JITRUNNER_SLOTS || 1);
const labels = (env.JITRUNNER_LABELS || `self-hosted,Linux,${arch},jit`).split(',').map((label) => label.trim());
const image = env.JITRUNNER_IMAGE || 'jitrunner-runner';
const dockerArgs = (env.JITRUNNER_DOCKER_ARGS || '').split(/\s+/).filter(Boolean);
const pollMs = Number(env.JITRUNNER_POLL_SECONDS || 5) * 1000;
const maxJobMs = Number(env.JITRUNNER_MAX_JOB_SECONDS || 21600) * 1000;
const tag = `jitrunner.agent=${agent}`;

if (labels.some((label) => label.toLowerCase() === 'ephemeral')) {
	console.error('Refusing to offer the "ephemeral" label: this machine is not wiped between jobs.');
	process.exit(1);
}

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** This agent's job containers, with their age. Containers from an earlier run of the agent are counted too. */
async function containers() {
	const { stdout } = await run('docker', ['ps', '--quiet', '--filter', `label=${tag}`]);
	const ids = stdout.split('\n').filter(Boolean);
	if (ids.length === 0) return [];
	const inspected = await run('docker', ['inspect', '--format', '{{.Id}} {{.Name}} {{.Created}}', ...ids]);
	return inspected.stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [id, name, created] = line.split(' ');
			return { id, name: name.replace(/^\//, ''), age: Date.now() - Date.parse(created) };
		});
}

async function claim(free) {
	const response = await fetch(`${url}/agent/claim`, {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ agent, labels, arch, slots: free }),
	});
	if (!response.ok) throw new Error(`claim: ${response.status} ${await response.text()}`);
	return (await response.json()).claims;
}

async function start({ runner, jitConfig, repo, jobId }) {
	// `-e JIT_CONFIG` with no value copies it from this process's environment, so it never shows in `ps`.
	await run(
		'docker',
		[
			'run',
			'--detach',
			'--rm',
			'--name',
			runner,
			'--label',
			tag,
			'--label',
			`jitrunner.job=${jobId}`,
			// Chromium needs more shared memory than Docker's 64 MB default.
			'--shm-size',
			'2g',
			'--env',
			'JIT_CONFIG',
			...dockerArgs,
			image,
		],
		{ env: { ...process.env, JIT_CONFIG: jitConfig } },
	);
	log(`started ${runner} for job ${jobId} in ${repo}`);
}

log(`agent ${agent}: ${slots} slot(s), labels ${labels.join(',')}, image ${image}, polling ${url}`);
for (;;) {
	try {
		const running = await containers();
		for (const container of running.filter((entry) => entry.age > maxJobMs)) {
			log(`stopping ${container.name}: older than JITRUNNER_MAX_JOB_SECONDS`);
			await run('docker', ['stop', container.id]);
		}
		const free = slots - running.length;
		if (free > 0) {
			for (const job of await claim(free)) await start(job);
		}
	} catch (error) {
		log(`error: ${error instanceof Error ? error.message : String(error)}`);
	}
	await sleep(pollMs);
}
