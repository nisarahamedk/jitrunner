// GitHub as a GitHub App: a JWT signed with the app's key buys installation tokens, which do the rest.
// The app needs the repository permissions Administration (read and write: runners) and Actions (read: queued jobs),
// and the workflow_job webhook event.

import type { QueuedJob, Runner } from './plan.ts';

const API = 'https://api.github.com';
const USER_AGENT = 'jitrunner';

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
	const data = typeof bytes === 'string' ? encoder.encode(bytes) : new Uint8Array(bytes);
	let binary = '';
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
	const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.length;
	}
	const length = derLength(body.length);
	const out = new Uint8Array(1 + length.length + body.length);
	out[0] = tag;
	out.set(length, 1);
	out.set(body, 1 + length.length);
	return out;
}

// rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters.
const RSA_ALGORITHM = Uint8Array.of(
	0x30,
	0x0d,
	0x06,
	0x09,
	0x2a,
	0x86,
	0x48,
	0x86,
	0xf7,
	0x0d,
	0x01,
	0x01,
	0x01,
	0x05,
	0x00,
);

/** GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports PKCS#8, so wrap it. */
export function pemToPkcs8(pem: string): Uint8Array {
	const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
	const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
	const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
	if (!pkcs1) return bytes;
	return der(0x30, Uint8Array.of(0x02, 0x01, 0x00), RSA_ALGORITHM, der(0x04, bytes));
}

export async function appJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
	const key = await crypto.subtle.importKey(
		'pkcs8',
		pemToPkcs8(privateKeyPem),
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const seconds = Math.floor(now / 1000);
	// Backdated a minute for clock drift; GitHub allows at most ten minutes.
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const payload = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${payload}`));
	return `${header}.${payload}.${base64url(signature)}`;
}

/** Compares two strings without leaking, through timing, how much of them matches. */
export function safeEqual(a: string, b: string): boolean {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	let diff = left.length ^ right.length;
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return diff === 0;
}

/** Checks X-Hub-Signature-256 against the webhook secret, in constant time. */
export async function verifyWebhook(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!signature?.startsWith('sha256=')) return false;
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	const hex = signature.slice('sha256='.length);
	if (hex.length !== expected.length * 2) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) {
		diff |= expected[index]! ^ Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return diff === 0;
}

export class GitHubError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		method,
		headers: {
			'Accept': 'application/vnd.github+json',
			'Authorization': `Bearer ${token}`,
			'User-Agent': USER_AGENT,
			'X-GitHub-Api-Version': '2022-11-28',
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) {
		throw new GitHubError(response.status, `GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
	}
	return (response.status === 204 ? undefined : await response.json()) as T;
}

export interface Repo {
	owner: string;
	name: string;
	private: boolean;
}

/** One installation's view of GitHub: everything jitrunner does in the repos it was installed on. */
export class Installation {
	private readonly token: string;

	private constructor(token: string) {
		this.token = token;
	}

	// Installation tokens last an hour; agents poll every few seconds, so reuse one for up to 50 minutes.
	private static readonly tokens = new Map<number, { token: string; until: number }>();

	static async open(appId: string, privateKeyPem: string, installationId: number): Promise<Installation> {
		const cached = Installation.tokens.get(installationId);
		if (cached && cached.until > Date.now()) return new Installation(cached.token);
		const jwt = await appJwt(appId, privateKeyPem);
		const { token } = await call<{ token: string }>(jwt, 'POST', `/app/installations/${installationId}/access_tokens`);
		Installation.tokens.set(installationId, { token, until: Date.now() + 50 * 60_000 });
		return new Installation(token);
	}

	static async ids(appId: string, privateKeyPem: string): Promise<number[]> {
		const jwt = await appJwt(appId, privateKeyPem);
		const installations = await call<{ id: number }[]>(jwt, 'GET', '/app/installations?per_page=100');
		return installations.map((installation) => installation.id);
	}

	async repos(): Promise<Repo[]> {
		const { repositories } = await call<{
			repositories: { name: string; private: boolean; owner: { login: string } }[];
		}>(this.token, 'GET', '/installation/repositories?per_page=100');
		return repositories.map((repo) => ({ owner: repo.owner.login, name: repo.name, private: repo.private }));
	}

	async runners(repo: Repo): Promise<Runner[]> {
		const { runners } = await call<{
			runners: { id: number; name: string; status: string; busy: boolean; labels: { name: string }[] }[];
		}>(this.token, 'GET', `/repos/${repo.owner}/${repo.name}/actions/runners?per_page=100`);
		return runners.map((runner) => ({
			id: runner.id,
			name: runner.name,
			status: runner.status === 'online' ? 'online' : 'offline',
			busy: runner.busy,
			labels: runner.labels.map((label) => label.name),
		}));
	}

	/** Jobs still waiting for a runner, from runs that are queued or already running (later jobs of a run). */
	async queuedJobs(repo: Repo): Promise<QueuedJob[]> {
		const jobs: QueuedJob[] = [];
		for (const status of ['queued', 'in_progress']) {
			const { workflow_runs: runs } = await call<{ workflow_runs: { id: number }[] }>(
				this.token,
				'GET',
				`/repos/${repo.owner}/${repo.name}/actions/runs?status=${status}&per_page=50`,
			);
			for (const run of runs) {
				const { jobs: runJobs } = await call<{
					jobs: { id: number; status: string; labels: string[]; created_at: string }[];
				}>(this.token, 'GET', `/repos/${repo.owner}/${repo.name}/actions/runs/${run.id}/jobs?per_page=100`);
				for (const job of runJobs) {
					if (job.status === 'queued') {
						jobs.push({ id: job.id, labels: job.labels, created: Date.parse(job.created_at) });
					}
				}
			}
		}
		return jobs;
	}

	/** A file's text on the repo's default branch, or null when the repo has no such file. */
	async file(repo: Repo, path: string): Promise<string | null> {
		const response = await fetch(`${API}/repos/${repo.owner}/${repo.name}/contents/${path}`, {
			headers: {
				'Accept': 'application/vnd.github.raw',
				'Authorization': `Bearer ${this.token}`,
				'User-Agent': USER_AGENT,
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new GitHubError(response.status, `GitHub GET ${path} in ${repo.owner}/${repo.name}: ${response.status}`);
		}
		return response.text();
	}

	/** A just-in-time config for one ephemeral runner: it registers itself, runs one job, and is removed. */
	async jitConfig(repo: Repo, name: string, labels: string[]): Promise<string> {
		const { encoded_jit_config: config } = await call<{ encoded_jit_config: string }>(
			this.token,
			'POST',
			`/repos/${repo.owner}/${repo.name}/actions/runners/generate-jitconfig`,
			{ name, runner_group_id: 1, labels, work_folder: '_work' },
		);
		return config;
	}

	async jobStatus(repo: Repo, jobId: number): Promise<string> {
		const { status } = await call<{ status: string }>(
			this.token,
			'GET',
			`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}`,
		);
		return status;
	}

	async deleteRunner(repo: Repo, runnerId: number): Promise<void> {
		try {
			await call(this.token, 'DELETE', `/repos/${repo.owner}/${repo.name}/actions/runners/${runnerId}`);
		} catch (error) {
			// 404: the runner already removed itself. 422: it is running a job; deleting the server ends that.
			if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 422)) throw error;
		}
	}
}
