// Hetzner Cloud API: list, create and delete JIT servers. Every server jitrunner makes carries the label
// `jitrunner=<prefix>`, and only servers with that label are ever listed or deleted.

import type { Server } from './plan.ts';

const API = 'https://api.hetzner.cloud/v1';

export class HetznerError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

export class Hetzner {
	private readonly token: string;
	private readonly prefix: string;

	constructor(token: string, prefix: string) {
		this.token = token;
		this.prefix = prefix;
	}

	private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) {
			const text = await response.text();
			let code = 'unknown';
			try {
				code = (JSON.parse(text) as { error: { code: string } }).error.code;
			} catch {
				// Not Hetzner's JSON error shape; the status and text below still say what happened.
			}
			throw new HetznerError(response.status, code, `Hetzner ${method} ${path}: ${response.status} ${text}`);
		}
		return (response.status === 204 ? undefined : await response.json()) as T;
	}

	private get selector(): string {
		return `jitrunner=${this.prefix}`;
	}

	async servers(): Promise<Server[]> {
		const servers: Server[] = [];
		for (let page = 1; ; page += 1) {
			const { servers: batch, meta } = await this.call<{
				servers: { id: number; name: string; created: string; status: string; labels: Record<string, string> }[];
				meta: { pagination: { next_page: number | null } };
			}>('GET', `/servers?label_selector=${encodeURIComponent(this.selector)}&per_page=50&page=${page}`);
			for (const server of batch)
				servers.push({
					id: server.id,
					name: server.name,
					created: Date.parse(server.created),
					status: server.status,
					reuse: server.labels.reuse === 'yes',
				});
			if (!meta.pagination.next_page) return servers;
		}
	}

	/**
	 * Creates the server in the first location that has room, or does nothing when one with this name already exists
	 * (a webhook and the cron raced). Hetzner answers 412 "error during placement" when a location is out of a type.
	 */
	async create(options: {
		name: string;
		serverType: string;
		locations: string[];
		image: string;
		userData: string;
		sshKey: string;
		reuse?: boolean;
	}): Promise<'exists' | { created: string }> {
		let lastError: unknown;
		for (const location of options.locations) {
			try {
				if ((await this.createIn(location, options)) === 'exists') return 'exists';
				return { created: location };
			} catch (error) {
				if (!(error instanceof HetznerError) || error.status !== 412) throw error;
				lastError = error;
			}
		}
		throw lastError;
	}

	private async createIn(
		location: string,
		options: { name: string; serverType: string; image: string; userData: string; sshKey: string; reuse?: boolean },
	): Promise<'created' | 'exists'> {
		try {
			await this.call('POST', '/servers', {
				name: options.name,
				server_type: options.serverType,
				location,
				image: options.image,
				user_data: options.userData,
				ssh_keys: [options.sshKey],
				labels: { jitrunner: this.prefix, ...(options.reuse ? { reuse: 'yes' } : {}) },
				start_after_create: true,
				// GitHub has no IPv6, so the runner needs IPv4.
				public_net: { enable_ipv4: true, enable_ipv6: false },
			});
			return 'created';
		} catch (error) {
			if (error instanceof HetznerError && error.code === 'uniqueness_error') return 'exists';
			throw error;
		}
	}

	async delete(serverId: number): Promise<void> {
		try {
			await this.call('DELETE', `/servers/${serverId}`);
		} catch (error) {
			if (!(error instanceof HetznerError) || error.status !== 404) throw error;
		}
	}

	/** Deletes the server of a finished job, unless it is a reused one, which goes on to its next job. */
	async deleteByName(name: string): Promise<void> {
		const { servers } = await this.call<{ servers: { id: number; labels: Record<string, string> }[] }>(
			'GET',
			`/servers?name=${encodeURIComponent(name)}`,
		);
		for (const server of servers) {
			if (server.labels.jitrunner === this.prefix && server.labels.reuse !== 'yes') await this.delete(server.id);
		}
	}

	/**
	 * The name of an SSH key to create servers with. Hetzner emails a root password for every server made without
	 * one, so jitrunner uploads the public half of a key pair whose private half it never keeps: nobody can log in.
	 */
	async lockoutKey(): Promise<string> {
		const name = `${this.prefix}-lockout`;
		const { ssh_keys: keys } = await this.call<{ ssh_keys: { name: string }[] }>(
			'GET',
			`/ssh_keys?name=${encodeURIComponent(name)}`,
		);
		if (keys.length > 0) return name;
		try {
			await this.call('POST', '/ssh_keys', {
				name,
				public_key: await lockoutPublicKey(),
				labels: { jitrunner: this.prefix },
			});
		} catch (error) {
			if (!(error instanceof HetznerError) || error.code !== 'uniqueness_error') throw error;
		}
		return name;
	}
}

/** An OpenSSH ed25519 public key line for a fresh key pair; the private key is dropped on return. */
export async function lockoutPublicKey(): Promise<string> {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
	const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
	const type = new TextEncoder().encode('ssh-ed25519');
	const blob = new Uint8Array(4 + type.length + 4 + raw.length);
	const view = new DataView(blob.buffer);
	view.setUint32(0, type.length);
	blob.set(type, 4);
	view.setUint32(4 + type.length, raw.length);
	blob.set(raw, 8 + type.length);
	let binary = '';
	for (const byte of blob) binary += String.fromCharCode(byte);
	return `ssh-ed25519 ${btoa(binary)} jitrunner-lockout`;
}
