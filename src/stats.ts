// Who ran which job: one KV key per job handed out (to one of your machines, a reused server, or a new server), with
// everything in the key's metadata so a page of stats costs a few KV lists and no reads. Kept for 90 days.

export type JobKind = 'agent' | 'reused' | 'server';

export interface JobRecord {
	job: number;
	/** When the job was handed out, ms since epoch. */
	at: number;
	kind: JobKind;
	/** The agent's name for `agent`, the server's name for `reused`, the server type for `server`. */
	by: string;
	/** Why a new server was needed (`server` only): see serverReason. */
	reason?: ServerReason;
}

/**
 * Why a job got a new server instead of one of your machines: none was online, none offers all the labels the job
 * asks for, or they were full (or did not claim it within AGENT_GRACE_SECONDS).
 */
export type ServerReason = 'offline' | 'labels' | 'busy';

/** One of your machines, as it last told the Worker. */
export interface AgentInfo {
	name: string;
	/** Last poll the Worker noted, ms since epoch (noted at most every NOTE_EVERY_MS). */
	seen: number;
	labels: string[];
	/** Jobs it runs at once; unknown for agents older than this field. */
	capacity?: number;
}

/** KV writes are the free plan's tight limit (1,000 a day): note each machine at most this often. */
const NOTE_EVERY_MS = 10 * 60_000;
/** A machine not heard from for this long counts as offline. */
const ONLINE_MS = NOTE_EVERY_MS + 5 * 60_000;

/** What this Worker instance last noted per machine, so most polls skip the KV read too (agents poll every 5 s). */
const noted = new Map<string, AgentInfo>();

const sameAs = (last: AgentInfo | null | undefined, info: AgentInfo): boolean =>
	!!last &&
	last.capacity === info.capacity &&
	last.labels.join(',') === info.labels.join(',') &&
	info.seen - last.seen < NOTE_EVERY_MS;

export async function noteAgent(kv: KVNamespace | undefined, info: AgentInfo): Promise<void> {
	if (!kv || sameAs(noted.get(info.name), info)) return;
	const key = `agent:${info.name}`;
	const { metadata: last } = await kv.getWithMetadata<AgentInfo>(key);
	if (last && sameAs(last, info)) {
		noted.set(info.name, last);
		return;
	}
	await kv.put(key, '', { metadata: info, expirationTtl: KEEP_SECONDS });
	noted.set(info.name, info);
}

export async function listAgents(kv: KVNamespace): Promise<AgentInfo[]> {
	const { keys } = await kv.list<AgentInfo>({ prefix: 'agent:' });
	return keys.flatMap((key) => (key.metadata ? [key.metadata] : []));
}

export const isOnline = (agent: AgentInfo, now: number): boolean => now - agent.seen < ONLINE_MS;

/** Labels every runner has anyway; the architecture is the server's choice, not the job's. */
const IMPLIED = new Set(['self-hosted', 'linux', 'x64', 'arm64']);

export function serverReason(jobLabels: string[], agents: AgentInfo[], now: number): ServerReason {
	const online = agents.filter((agent) => isOnline(agent, now));
	if (online.length === 0) return 'offline';
	const needed = jobLabels.map((label) => label.toLowerCase()).filter((label) => !IMPLIED.has(label));
	const fits = online.some((agent) => {
		const has = new Set(agent.labels.map((label) => label.toLowerCase()));
		return needed.every((label) => has.has(label));
	});
	return fits ? 'busy' : 'labels';
}

const KEEP_SECONDS = 90 * 86_400;

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function recordJob(kv: KVNamespace | undefined, record: JobRecord): Promise<void> {
	if (!kv) return;
	const jobId = record.job;
	// A job can get a second server (the first one died before taking it); each is its own key, as each is billed.
	const key = `job:${utcDay(record.at)}:${jobId}:${record.kind}:${record.kind === 'server' ? record.at : record.by}`;
	await kv.put(key, '', { metadata: record, expirationTtl: KEEP_SECONDS });
}

/** Every record from the last `days` days (plus one, so local days that start before UTC midnight are whole). */
export async function loadJobs(kv: KVNamespace, days: number, now = Date.now()): Promise<JobRecord[]> {
	const records: JobRecord[] = [];
	for (let back = 0; back <= days; back++) {
		let cursor: string | undefined;
		do {
			const page: KVNamespaceListResult<JobRecord, string> = await kv.list<JobRecord>({
				prefix: `job:${utcDay(now - back * 86_400_000)}:`,
				cursor,
			});
			for (const key of page.keys) if (key.metadata) records.push(key.metadata);
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);
	}
	return records;
}

export interface DayStats {
	day: string;
	/** Jobs per machine of yours, by agent name. */
	machines: Map<string, number>;
	/** Jobs taken by a server that was already up and paid for. */
	reused: number;
	/** New servers per server type: each one is billed at least an hour. */
	servers: Map<string, number>;
	total: number;
}

/** Records grouped by day in `timeZone`, newest first, the last `days` days only. */
export function summarize(records: JobRecord[], timeZone: string, days: number, now = Date.now()): DayStats[] {
	const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
	const byDay = new Map<string, DayStats>();
	for (let back = days - 1; back >= 0; back--) {
		const day = dayOf.format(now - back * 86_400_000);
		byDay.set(day, { day, machines: new Map(), reused: 0, servers: new Map(), total: 0 });
	}
	for (const record of records) {
		const stats = byDay.get(dayOf.format(record.at));
		if (!stats) continue;
		stats.total += 1;
		if (record.kind === 'agent') stats.machines.set(record.by, (stats.machines.get(record.by) ?? 0) + 1);
		else if (record.kind === 'reused') stats.reused += 1;
		else stats.servers.set(record.by, (stats.servers.get(record.by) ?? 0) + 1);
	}
	return [...byDay.values()].reverse();
}

/** What a new server costs: its type's hourly price plus a primary IPv4, billed per started hour. */
export interface Prices {
	currency: string;
	perServer: Map<string, number>;
}

/** What is up right now: jitrunner's Hetzner servers, and the runners GitHub knows for jitrunner's jobs. */
export interface Now {
	servers: { name: string; status: string; ageMinutes: number; reuse: boolean }[];
	runners: { name: string; where: string; state: 'busy' | 'idle' | 'offline' }[];
	/** Your machines: online or not, and how many of their slots run a job now. */
	machines: Machine[];
}

export interface Machine {
	name: string;
	online: boolean;
	/** Minutes since the Worker last noted a poll from it. */
	seenMinutes: number;
	running: number;
	capacity?: number;
}

/** Your machines as the Worker knows them, with the busy runners each one hosts right now. */
export function machinesNow(agents: AgentInfo[], runners: Now['runners'], now: number): Machine[] {
	return agents
		.map((agent) => ({
			name: agent.name,
			online: isOnline(agent, now),
			seenMinutes: Math.round((now - agent.seen) / 60_000),
			running: runners.filter((runner) => runner.where === agent.name && runner.state === 'busy').length,
			capacity: agent.capacity,
		}))
		.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** Today in detail: who ran jobs hour by hour, and why each new server was needed. */
export interface Today {
	hours: { hour: string; mine: number; reused: number; servers: number }[];
	reasons: Map<ServerReason | 'unknown', number>;
	mine: number;
	total: number;
}

export function today(records: JobRecord[], timeZone: string, now = Date.now()): Today {
	const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
	const hourOf = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
	const day = dayOf.format(now);
	const hours = new Map<string, Today['hours'][number]>();
	const reasons: Today['reasons'] = new Map();
	let mine = 0;
	let total = 0;
	for (const record of [...records].sort((a, b) => a.at - b.at)) {
		if (dayOf.format(record.at) !== day) continue;
		const hour = `${hourOf.format(record.at)}:00`;
		const row = hours.get(hour) ?? { hour, mine: 0, reused: 0, servers: 0 };
		hours.set(hour, row);
		total += 1;
		if (record.kind === 'agent') {
			row.mine += 1;
			mine += 1;
		} else if (record.kind === 'reused') row.reused += 1;
		else {
			row.servers += 1;
			const reason = record.reason ?? 'unknown';
			reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
		}
	}
	return { hours: [...hours.values()].reverse(), reasons, mine, total };
}

const REASON_TEXT: Record<ServerReason | 'unknown', string> = {
	offline: 'No machine online',
	busy: 'Machines full or slow to claim',
	labels: 'No machine has its labels',
	unknown: 'Not recorded',
};

/** Where a runner runs: its own server (`jit-<job>`), or the machine or reused server that claimed its job. */
export function runnerHost(name: string, prefix: string, records: JobRecord[]): string {
	if (name.startsWith(`${prefix}-`)) return `Hetzner ${name}`;
	const job = Number(name.slice(`agent-${prefix}-`.length));
	const claim = records.find((record) => record.job === job && record.kind !== 'server');
	if (!claim) return 'unknown';
	return claim.kind === 'reused' ? `Hetzner ${claim.by} (reused)` : claim.by;
}

const ago = (minutes: number): string =>
	minutes < 120
		? `${minutes} min ago`
		: minutes < 2880
			? `${Math.round(minutes / 60)} h ago`
			: `${Math.round(minutes / 1440)} days ago`;

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function statsPage(
	rows: DayStats[],
	timeZone: string,
	prices: Prices | undefined,
	now?: Now,
	day?: Today,
): string {
	const machines = [...new Set(rows.flatMap((row) => [...row.machines.keys()]))].sort();
	const cost = (row: DayStats): number | undefined => {
		if (!prices) return undefined;
		let sum = 0;
		for (const [type, count] of row.servers) {
			const price = prices.perServer.get(type);
			if (price === undefined) return undefined;
			sum += price * count;
		}
		return sum;
	};
	const money = (amount: number | undefined): string =>
		amount === undefined ? '?' : `${amount.toFixed(2)} ${escape(prices?.currency ?? '')}`;
	const serverCell = (row: DayStats): string =>
		String([...row.servers.values()].reduce((sum, count) => sum + count, 0));
	const head = ['Day', ...machines.map(escape), 'Reused', 'New', 'Total', 'Cost'];
	// Today always shows; earlier days only when something ran.
	const shown = rows.filter((row, index) => index === 0 || row.total > 0);
	const body = shown.map((row) => [
		new Date(`${row.day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }),
		...machines.map((machine) => String(row.machines.get(machine) ?? 0)),
		String(row.reused),
		serverCell(row),
		String(row.total),
		money(cost(row)),
	]);
	const table = (cells: string[][], tag: string): string =>
		cells.map((line) => `<tr>${line.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`).join('\n');
	const machinesHtml = !now
		? ''
		: `<h2>Your machines</h2>
<div class="wrap"><table>
${table([['Machine', 'Status', 'Running']], 'th')}
${
	now.machines.length
		? table(
				now.machines.map((machine) => [
					escape(machine.name),
					machine.online ? 'online' : `offline (seen ${ago(machine.seenMinutes)})`,
					`${machine.running} of ${machine.capacity ?? '?'}`,
				]),
				'td',
			)
		: '<tr><td colspan="3">None has polled yet</td></tr>'
}
</table></div>`;
	const todayHtml = !day
		? ''
		: `<h2>Today</h2>
<p>${day.mine} of ${day.total} jobs ran on your machines${day.total ? ` (${Math.round((100 * day.mine) / day.total)}%)` : ''}.</p>
${
	day.reasons.size
		? `<div class="wrap"><table>
${table([['Why a new server', 'Servers']], 'th')}
${table(
	[...day.reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => [REASON_TEXT[reason], String(count)]),
	'td',
)}
</table></div>`
		: ''
}
${
	day.hours.length
		? `<div class="wrap"><table>
${table([['Hour', 'Yours', 'Reused', 'New']], 'th')}
${table(
	day.hours.map((row) => [row.hour, String(row.mine), String(row.reused), String(row.servers)]),
	'td',
)}
</table></div>`
		: ''
}`;
	const nowHtml = !now
		? '<p>Could not read what is running.</p>'
		: `${machinesHtml}
<h2>Running now</h2>
<div class="wrap"><table>
${table([['Runner', 'Where', 'State']], 'th')}
${
	now.runners.length
		? table(
				now.runners.map((runner) => [escape(runner.name), escape(runner.where), runner.state]),
				'td',
			)
		: '<tr><td colspan="3">No runners</td></tr>'
}
</table></div>
<h2>Hetzner servers</h2>
<div class="wrap"><table>
${table([['Server', 'Status', 'Up for']], 'th')}
${
	now.servers.length
		? table(
				now.servers.map((server) => [
					escape(server.name) + (server.reuse ? ' (reuse)' : ''),
					escape(server.status),
					`${server.ageMinutes} min`,
				]),
				'td',
			)
		: '<tr><td colspan="3">None</td></tr>'
}
</table></div>`;
	const all = rows.reduce((sum, row) => sum + (cost(row) ?? 0), 0);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jitrunner stats</title>
<style>
	:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --line: #ddd; --muted: #666; }
	@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --line: #333; --muted: #999; } }
	body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
	h1 { font-size: 20px; margin: 0 0 4px; }
	h2 { font-size: 16px; margin: 20px 0 8px; }
	p { color: var(--muted); margin: 0 0 16px; }
	.wrap { overflow-x: auto; }
	table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
	th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
	th:first-child, td:first-child { text-align: left; }
	th { font-weight: 600; }
	.wrap + .wrap { margin-top: 16px; }
</style>
</head>
<body>
<h1>jitrunner</h1>
${nowHtml}
${todayHtml}
<h2>Jobs per day</h2>
<p>Jobs per day (${escape(timeZone)}), by who ran them. Only new servers cost money: each is billed at least an hour.
Last ${rows.length} days: ${money(prices ? all : undefined)}.</p>
<div class="wrap"><table>
${table([head], 'th')}
${table(body, 'td')}
</table></div>
</body>
</html>
`;
}
