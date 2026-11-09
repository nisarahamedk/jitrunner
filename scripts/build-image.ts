#!/usr/bin/env node
// Builds a Hetzner snapshot with the GitHub runner (and anything else you add) already installed, so a JIT server
// is ready for its job in well under a minute instead of installing everything on every boot.
//
//   HCLOUD_TOKEN=... node scripts/build-image.ts [--extra setup.sh] [--type cx23] [--location fsn1] [--prefix jit]
//
// It creates a temporary server, runs the bake script, waits for it to power off, snapshots it, deletes the server
// and prints the snapshot id. Put that id in IMAGE in wrangler.jsonc. Snapshots cost about $0.02 per GB a month.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bakeScript } from '../src/cloud-init.ts';
import { Hetzner } from '../src/hetzner.ts';

const { values } = parseArgs({
	options: {
		extra: { type: 'string' },
		type: { type: 'string', default: 'cx23' },
		location: { type: 'string', default: 'fsn1' },
		prefix: { type: 'string', default: 'jit' },
	},
});
const token = process.env.HCLOUD_TOKEN;
if (!token) throw new Error('Set HCLOUD_TOKEN to a Hetzner Cloud API token (read and write).');

const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
	const response = await fetch(`https://api.hetzner.cloud/v1${path}`, {
		method,
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`Hetzner ${method} ${path}: ${response.status} ${await response.text()}`);
	return (await response.json()) as T;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extra = values.extra ? readFileSync(values.extra, 'utf8') : '';
const name = `${values.prefix}-bake-${Date.now()}`;
const sshKey = await new Hetzner(token, values.prefix).lockoutKey();
const { server } = await api<{ server: { id: number } }>('POST', '/servers', {
	name,
	server_type: values.type,
	location: values.location,
	image: 'ubuntu-24.04',
	user_data: bakeScript(extra),
	ssh_keys: [sshKey],
	labels: { 'jitrunner-bake': values.prefix },
	public_net: { enable_ipv4: true, enable_ipv6: false },
});
console.log(`Baking on ${name} (server ${server.id}); this takes a few minutes.`);

try {
	const deadline = Date.now() + 30 * 60_000;
	for (;;) {
		await sleep(15_000);
		const { server: current } = await api<{ server: { status: string } }>('GET', `/servers/${server.id}`);
		if (current.status === 'off') break;
		if (Date.now() > deadline) throw new Error('The bake script did not power the server off within 30 minutes.');
	}
	const { image, action } = await api<{ image: { id: number }; action: { id: number } }>(
		'POST',
		`/servers/${server.id}/actions/create_image`,
		{
			type: 'snapshot',
			description: `${values.prefix} runner ${new Date().toISOString().slice(0, 10)}`,
			labels: { jitrunner: values.prefix },
		},
	);
	for (;;) {
		await sleep(10_000);
		const { action: current } = await api<{ action: { status: string } }>('GET', `/actions/${action.id}`);
		if (current.status === 'success') break;
		if (current.status === 'error') throw new Error('Hetzner failed to create the snapshot.');
	}
	console.log(`Snapshot ready. Set IMAGE to "${image.id}" in wrangler.jsonc and deploy.`);
} finally {
	await api('DELETE', `/servers/${server.id}`);
	console.log(`Deleted ${name}.`);
}
