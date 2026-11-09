import { createHmac, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootScript } from '../src/cloud-init.ts';
import { appJwt, verifyWebhook } from '../src/github.ts';
import { lockoutPublicKey } from '../src/hetzner.ts';

describe('appJwt', () => {
	it('signs with the PKCS#1 key GitHub hands out', async () => {
		const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		expect(pem).toContain('BEGIN RSA PRIVATE KEY');
		const jwt = await appJwt('12345', pem, Date.parse('2026-11-09T12:00:00Z'));
		const [header, payload, signature] = jwt.split('.') as [string, string, string];
		expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
			iat: 1794225540,
			exp: 1794226140,
			iss: '12345',
		});
		const ok = verify('sha256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
		expect(ok).toBe(true);
	});
});

describe('verifyWebhook', () => {
	const body = '{"action":"queued"}';
	const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;

	it('accepts the right signature', async () => {
		expect(await verifyWebhook('secret', body, signature)).toBe(true);
	});

	it('refuses a wrong secret, a changed body, or no signature', async () => {
		expect(await verifyWebhook('other', body, signature)).toBe(false);
		expect(await verifyWebhook('secret', `${body} `, signature)).toBe(false);
		expect(await verifyWebhook('secret', body, null)).toBe(false);
	});
});

describe('lockoutPublicKey', () => {
	it('is a valid OpenSSH ed25519 key', async () => {
		const line = await lockoutPublicKey();
		expect(line).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ jitrunner-lockout$/);
		const blob = Buffer.from(line.split(' ')[1]!, 'base64');
		expect(blob.readUInt32BE(0)).toBe(11);
		expect(blob.subarray(4, 15).toString()).toBe('ssh-ed25519');
		const raw = blob.subarray(19);
		expect(raw).toHaveLength(32);
		const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
		expect(createPublicKey({ key: spki, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('ed25519');
	});
});

describe('bootScript', () => {
	it('quotes the JIT config for the shell', () => {
		const script = bootScript("abc'def", 300);
		expect(script).toContain(`--jitconfig 'abc'\\''def'`);
		expect(script.startsWith('#!/bin/bash\n')).toBe(true);
	});
});
