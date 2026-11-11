import { describe, expect, it } from 'vitest';
import { type JobRecord, runnerHost, statsPage, summarize } from '../src/stats.ts';

const at = (iso: string): number => Date.parse(iso);

describe('summarize', () => {
	const now = at('2026-11-11T02:00:00Z'); // 18:00 on Nov 10 in Vancouver
	const records: JobRecord[] = [
		{ job: 1, at: at('2026-11-11T01:03:00Z'), kind: 'agent', by: 'agent-mac' },
		{ job: 2, at: at('2026-11-11T01:44:00Z'), kind: 'agent', by: 'agent-mac' },
		{ job: 3, at: at('2026-11-10T09:00:00Z'), kind: 'agent', by: 'asus' },
		{ job: 4, at: at('2026-11-10T09:10:00Z'), kind: 'reused', by: 'jit-1' },
		{ job: 5, at: at('2026-11-10T09:00:00Z'), kind: 'server', by: 'cx33' },
		{ job: 6, at: at('2026-11-11T00:30:00Z'), kind: 'server', by: 'cx23' },
		{ job: 7, at: at('2026-11-10T06:59:00Z'), kind: 'server', by: 'cx33' }, // Nov 9 in Vancouver
	];

	it('counts by day in the given time zone, newest first', () => {
		const [today, yesterday] = summarize(records, 'America/Vancouver', 2, now);
		expect(today?.day).toBe('2026-11-10');
		expect(today?.machines).toEqual(
			new Map([
				['agent-mac', 2],
				['asus', 1],
			]),
		);
		expect(today?.reused).toBe(1);
		expect(today?.servers).toEqual(
			new Map([
				['cx33', 1],
				['cx23', 1],
			]),
		);
		expect(today?.total).toBe(6);
		expect(yesterday?.day).toBe('2026-11-09');
		expect(yesterday?.total).toBe(1);
	});

	it('leaves out records older than the window', () => {
		expect(summarize(records, 'America/Vancouver', 1, now).map((row) => row.total)).toEqual([6]);
	});
});

describe('statsPage', () => {
	it('shows a column per machine and the server cost', () => {
		const rows = summarize(
			[{ job: 8, at: at('2026-11-10T09:00:00Z'), kind: 'server', by: 'cx23' }],
			'UTC',
			1,
			at('2026-11-10T12:00:00Z'),
		);
		const html = statsPage(rows, 'UTC', { currency: 'USD', perServer: new Map([['cx23', 0.0114]]) });
		expect(html).toContain('<th>New</th>');
		expect(html).toContain('0.01 USD');
	});

	it('says ? for the cost when prices are unknown', () => {
		const rows = summarize(
			[{ job: 9, at: at('2026-11-10T09:00:00Z'), kind: 'server', by: 'cx23' }],
			'UTC',
			1,
			at('2026-11-10T12:00:00Z'),
		);
		expect(statsPage(rows, 'UTC', undefined)).toContain('<td>?</td>');
	});
});

describe('runnerHost', () => {
	const records: JobRecord[] = [
		{ job: 11, at: 0, kind: 'agent', by: 'agent-mac' },
		{ job: 12, at: 0, kind: 'reused', by: 'jit-5' },
	];
	it('names the machine or server each runner is on', () => {
		expect(runnerHost('jit-7', 'jit', records)).toBe('Hetzner jit-7');
		expect(runnerHost('agent-jit-11', 'jit', records)).toBe('agent-mac');
		expect(runnerHost('agent-jit-12', 'jit', records)).toBe('Hetzner jit-5 (reused)');
		expect(runnerHost('agent-jit-13', 'jit', records)).toBe('unknown');
	});
});

describe('statsPage running now', () => {
	it('lists runners and servers', () => {
		const html = statsPage([], 'UTC', undefined, {
			servers: [{ name: 'jit-5', status: 'running', ageMinutes: 12, reuse: true }],
			runners: [{ name: 'agent-jit-11', where: 'agent-mac', state: 'busy' }],
		});
		expect(html).toContain('<td>agent-mac</td><td>busy</td>');
		expect(html).toContain('<td>jit-5 (reuse)</td><td>running</td><td>12 min</td>');
	});
});
