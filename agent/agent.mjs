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
//   JITRUNNER_AGENT_TOKEN    this machine's agent token; install.sh makes it (required)
//   JITRUNNER_AGENT_NAME     shown in logs (default: the host name)
//   JITRUNNER_SLOTS          jobs at once (default 1)
//   JITRUNNER_LABELS         labels this machine offers (default: self-hosted,Linux,<X64|ARM64>,jit). Don't add
//                            `ephemeral` here; use JITRUNNER_EPHEMERAL.
//   JITRUNNER_EPHEMERAL      on: also take jobs asking for `ephemeral` (e.g. production deploys). They run in a
//                            container with none of the shared cache volumes, so nothing an earlier job left in a
//                            cache reaches them. The Docker host and its images are still shared with other jobs.
//   JITRUNNER_IMAGE          the job container image for repos without their own (default jitrunner-runner). A repo
//                            with a .jitrunner/Dockerfile on its default branch (FROM jitrunner-runner) gets that
//                            image instead: the agent builds it on the first job after it changes and keeps it.
//   JITRUNNER_DOCKER_ARGS    extra `docker run` arguments, e.g. "--cpus 2 --memory 6g"
//   JITRUNNER_CACHE          off: no shared caches. By default every job container mounts three volumes that outlive
//                            it: tool versions (_work/_tool), ~/.cache (Playwright's browsers) and pnpm's store, so a
//                            job downloads only what changed. The checkout, the job's files and secrets stay per job.
//   JITRUNNER_POLL_SECONDS   default 5
//   JITRUNNER_MAX_JOB_SECONDS  a container is stopped at this age (default 21600, GitHub's own job limit)
//   JITRUNNER_IDLE_SECONDS   a container whose job went to another runner gives up after this long (default 300)
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const idleSeconds = Number(env.JITRUNNER_IDLE_SECONDS || 300);
const tag = `jitrunner.agent=${agent}`;
const cacheMounts =
	env.JITRUNNER_CACHE === 'off'
		? []
		: [
				['jitrunner-tool', '/opt/actions-runner/_work/_tool'],
				['jitrunner-cache', '/home/runner/.cache'],
				['jitrunner-pnpm', '/home/runner/.local/share/pnpm'],
			].flatMap(([volume, path]) => ['--volume', `${volume}:${path}`]);

const isEphemeral = (label) => label.toLowerCase() === 'ephemeral';
if (labels.some(isEphemeral)) {
	console.error('Set JITRUNNER_EPHEMERAL=on instead of adding "ephemeral" to JITRUNNER_LABELS.');
	process.exit(1);
}
if (env.JITRUNNER_EPHEMERAL === 'on') labels.push('ephemeral');

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
		body: JSON.stringify({ agent, labels, arch, slots: free, capacity: slots }),
	});
	if (!response.ok) throw new Error(`claim: ${response.status} ${await response.text()}`);
	return (await response.json()).claims;
}

/** Runs `docker build` with the Dockerfile on stdin (no build context), resolving with its exit code and output. */
function dockerBuild(tag, dockerfile) {
	return new Promise((resolve) => {
		const child = spawn('docker', ['build', '-t', tag, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
		let output = '';
		const keep = (chunk) => (output = (output + chunk).slice(-4000));
		child.stdout.on('data', keep);
		child.stderr.on('data', keep);
		child.on('error', (error) => resolve({ code: 1, output: String(error) }));
		child.on('close', (code) => resolve({ code, output }));
		child.stdin.end(dockerfile);
	});
}

/**
 * The image for a repo's job: its own Dockerfile built on this machine's base image, tagged by a hash of both, so it is
 * built once per change to either. Falls back to JITRUNNER_IMAGE when the repo has none or the build fails.
 */
async function imageFor(repo, dockerfile) {
	if (!dockerfile) return image;
	const { stdout: base } = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'jitrunner-runner']);
	const hash = createHash('sha256').update(`${base.trim()}\n${dockerfile}`).digest('hex').slice(0, 16);
	const name = `jitrunner-repo/${repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
	const tag = `${name}:${hash}`;
	try {
		await run('docker', ['image', 'inspect', tag]);
		return tag;
	} catch {}
	log(`building ${tag} from ${repo}'s .jitrunner/Dockerfile`);
	const { code, output } = await dockerBuild(tag, dockerfile);
	if (code !== 0) {
		log(`building ${tag} failed, running the job in ${image} instead:\n${output}`);
		return image;
	}
	// Drop this repo's older images; one still in use by a running job stays.
	const { stdout } = await run('docker', ['image', 'ls', name, '--format', '{{.Repository}}:{{.Tag}}']);
	for (const old of stdout.split('\n').filter((line) => line && line !== tag)) {
		await run('docker', ['image', 'rm', old]).catch(() => {});
	}
	return tag;
}

async function start({ runner, jitConfig, repo, jobId, labels: jobLabels, dockerfile }) {
	const fresh = jobLabels.some(isEphemeral);
	const jobImage = await imageFor(repo, dockerfile);
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
			'--env',
			`JITRUNNER_IDLE_SECONDS=${idleSeconds}`,
			...(fresh ? [] : cacheMounts),
			...dockerArgs,
			jobImage,
		],
		{ env: { ...process.env, JIT_CONFIG: jitConfig } },
	);
	log(`started ${runner} for job ${jobId} in ${repo} on ${jobImage}${fresh ? ' (no shared caches)' : ''}`);
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
