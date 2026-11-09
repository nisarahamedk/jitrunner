import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hetzner } from '../src/hetzner.ts';

const options = { name: 'jit-1', serverType: 'cx33', image: 'ubuntu-24.04', userData: '', sshKey: 'k' };

afterEach(() => vi.unstubAllGlobals());

function answer(...responses: [number, unknown][]) {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			calls.push((JSON.parse(String(init.body)) as { location: string }).location);
			const [status, body] = responses.shift()!;
			return new Response(JSON.stringify(body), { status });
		}),
	);
	return calls;
}

const placement = [412, { error: { code: 'resource_unavailable', message: 'error during placement' } }] as [
	number,
	unknown,
];

describe('Hetzner.create', () => {
	it('moves on to the next location when one has no room', async () => {
		const calls = answer(placement, [201, { server: { id: 1 } }]);
		const result = await new Hetzner('t', 'jit').create({ ...options, locations: ['fsn1', 'hel1'] });
		expect(result).toEqual({ created: 'hel1' });
		expect(calls).toEqual(['fsn1', 'hel1']);
	});

	it('gives up with the last error when every location is full', async () => {
		answer(placement, placement);
		await expect(new Hetzner('t', 'jit').create({ ...options, locations: ['fsn1', 'hel1'] })).rejects.toThrow(
			/placement/,
		);
	});

	it('treats a server that already exists as done', async () => {
		answer([409, { error: { code: 'uniqueness_error', message: 'name is already used' } }]);
		expect(await new Hetzner('t', 'jit').create({ ...options, locations: ['fsn1'] })).toBe('exists');
	});
});
