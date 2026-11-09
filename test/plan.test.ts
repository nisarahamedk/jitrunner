import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { archOf, cleanup, provision, runnerLabels, type Runner, type Server } from '../src/plan.ts';

const config: Config = {
	label: 'jit',
	prefix: 'jit',
	serverType: 'cx23',
	location: 'fsn1',
	image: 'ubuntu-24.04',
	maxServers: 2,
	graceSeconds: 30,
	bootGraceSeconds: 600,
	idleSeconds: 900,
	maxAgeSeconds: 21600,
	allowPublicRepos: false,
};
const now = Date.parse('2026-11-09T12:00:00Z');
const ago = (seconds: number) => now - seconds * 1000;
const laptop = (busy = false): Runner => ({
	id: 1,
	name: 'old-laptop',
	status: 'online',
	busy,
	labels: ['self-hosted', 'Linux', 'X64', 'jit'],
});
const job = (id: number, waited: number, labels = ['self-hosted', 'jit']) => ({ id, labels, created: ago(waited) });

describe('provision', () => {
	it('ignores jobs that did not ask for the jit label', () => {
		expect(provision(config, now, [job(1, 0, ['ubuntu-latest'])], [], [], 'X64')).toEqual([]);
	});

	it('creates a server at once when none of your machines is free', () => {
		expect(provision(config, now, [job(7, 0)], [], [laptop(true)], 'X64')).toEqual([
			{ kind: 'create', jobId: 7, name: 'jit-7', labels: ['self-hosted', 'Linux', 'X64', 'jit'] },
		]);
	});

	it('lets a free machine of yours take the job during the grace period', () => {
		expect(provision(config, now, [job(7, 5)], [], [laptop()], 'X64')).toEqual([]);
	});

	it('creates a server once the grace period is over, free machine or not', () => {
		expect(provision(config, now, [job(7, 31)], [], [laptop()], 'X64')).toHaveLength(1);
	});

	it('holds back only as many jobs as there are free machines', () => {
		const actions = provision(config, now, [job(1, 1), job(2, 2)], [], [laptop()], 'X64');
		expect(actions.map((action) => action.kind === 'create' && action.jobId)).toEqual([1]);
	});

	it('does not count a machine that lacks a label the job asks for', () => {
		const actions = provision(config, now, [job(7, 0, ['self-hosted', 'jit', 'ephemeral'])], [], [laptop()], 'X64');
		expect(actions).toHaveLength(1);
	});

	it('never makes a second server for the same job', () => {
		const servers: Server[] = [{ id: 1, name: 'jit-7', created: ago(10) }];
		expect(provision(config, now, [job(7, 60)], servers, [], 'X64')).toEqual([]);
	});

	it('stops at MAX_SERVERS, oldest job first', () => {
		const servers: Server[] = [{ id: 1, name: 'jit-1', created: ago(10) }];
		const actions = provision(config, now, [job(3, 40), job(2, 50)], servers, [], 'X64');
		expect(actions.map((action) => action.kind === 'create' && action.jobId)).toEqual([2]);
	});
});

describe('cleanup', () => {
	const server = (age: number): Server => ({ id: 9, name: 'jit-9', created: ago(age) });
	const runner = (patch: Partial<Runner>): Runner => ({
		id: 90,
		name: 'jit-9',
		status: 'online',
		busy: true,
		labels: [],
		...patch,
	});

	it('leaves a booting server alone', () => {
		expect(cleanup(config, now, [server(60)], [])).toEqual([]);
	});

	it('deletes a server whose runner is gone after boot', () => {
		expect(cleanup(config, now, [server(700)], [])).toMatchObject([{ kind: 'delete', serverId: 9 }]);
	});

	it('keeps a server whose runner is busy', () => {
		expect(cleanup(config, now, [server(3000)], [runner({})])).toEqual([]);
	});

	it('deletes a server whose runner has been idle too long', () => {
		expect(cleanup(config, now, [server(1000)], [runner({ busy: false })])).toMatchObject([
			{ kind: 'delete', runnerId: 90 },
		]);
	});

	it('deletes a server whose runner went offline', () => {
		expect(cleanup(config, now, [server(700)], [runner({ status: 'offline' })])).toHaveLength(1);
	});

	it('deletes any server older than MAX_AGE_SECONDS, even a busy one', () => {
		expect(cleanup(config, now, [server(30000)], [runner({})])).toHaveLength(1);
	});

	it('never touches servers without the prefix', () => {
		expect(cleanup(config, now, [{ id: 1, name: 'web-1', created: ago(99999) }], [])).toEqual([]);
	});
});

describe('labels', () => {
	it('adds GitHub defaults without duplicating them', () => {
		expect(runnerLabels(['self-hosted', 'linux', 'jit'], 'ARM64')).toEqual(['self-hosted', 'Linux', 'ARM64', 'jit']);
	});

	it('knows Hetzner Arm types', () => {
		expect(archOf('cax11')).toBe('ARM64');
		expect(archOf('cx23')).toBe('X64');
	});
});
