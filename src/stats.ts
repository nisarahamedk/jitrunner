// Who ran which job: one KV key per job handed out (to one of your machines, a reused server, or a new server), with
// everything in the key's metadata so a page of stats costs a few KV lists and no reads. Kept for 90 days.

export type JobKind = 'agent' | 'reused' | 'server';

export interface JobRecord {
	/** When the job was handed out, ms since epoch. */
	at: number;
	kind: JobKind;
	/** The agent's name for `agent`, the server's name for `reused`, the server type for `server`. */
	by: string;
}

const KEEP_SECONDS = 90 * 86_400;

const utcDay = (at: number): string => new Date(at).toISOString().slice(0, 10);

export async function recordJob(kv: KVNamespace | undefined, jobId: number, record: JobRecord): Promise<void> {
	if (!kv) return;
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

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function statsPage(rows: DayStats[], timeZone: string, prices: Prices | undefined): string {
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
		[...row.servers].map(([type, count]) => `${count}${row.servers.size > 1 ? ` ${escape(type)}` : ''}`).join(', ') ||
		'0';
	const head = ['Day', ...machines.map(escape), 'Reused servers', 'New servers', 'Total', 'Server cost'];
	const body = rows.map((row) => [
		row.day,
		...machines.map((machine) => String(row.machines.get(machine) ?? 0)),
		String(row.reused),
		serverCell(row),
		String(row.total),
		money(cost(row)),
	]);
	const all = rows.reduce((sum, row) => sum + (cost(row) ?? 0), 0);
	const table = (cells: string[][], tag: string): string =>
		cells.map((line) => `<tr>${line.map((cell) => `<${tag}>${cell}</${tag}>`).join('')}</tr>`).join('\n');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jitrunner stats</title>
<style>
	:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fff; --line: #ddd; --muted: #666; }
	@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #121212; --line: #333; --muted: #999; } }
	body { margin: 0; padding: 16px; font: 15px/1.4 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
	h1 { font-size: 20px; margin: 0 0 4px; }
	p { color: var(--muted); margin: 0 0 16px; }
	.wrap { overflow-x: auto; }
	table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
	th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
	th:first-child, td:first-child { text-align: left; }
	th { font-weight: 600; }
</style>
</head>
<body>
<h1>jitrunner</h1>
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
