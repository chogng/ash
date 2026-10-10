import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessItem } from '../common/processes.js';

const execute = promisify(execFile);

/** Reads the selected process and its descendants without collecting command arguments. */
export async function listProcesses(rootPid: number): Promise<ProcessItem> {
	if (!Number.isSafeInteger(rootPid) || rootPid <= 0) { throw new TypeError('Invalid process ID'); }
	const options = { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' as const };
	const processes = new Map<number, ProcessItem>();
	if (process.platform === 'win32') {
		// Performance counters supply CPU percent rather than cumulative CPU seconds.
		const script = [
			'$ErrorActionPreference="Stop"',
			'[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()',
			'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,CreatingProcessID,Name,PercentProcessorTime,WorkingSet | ConvertTo-Json -Compress',
		].join('; ');
		const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], options);
		const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
		for (const row of Array.isArray(value) ? value : [value]) {
			if (!row || typeof row !== 'object' || typeof row.Name !== 'string') { throw new TypeError('Invalid process counter'); }
			const pid = Number(row.IDProcess);
			if (pid === 0) { continue; }
			processes.set(pid, processItem(row.Name, pid, Number(row.CreatingProcessID), Number(row.PercentProcessorTime), Number(row.WorkingSet)));
		}
	} else {
		const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,comm='], { ...options, env: { ...process.env, LC_ALL: 'C' } });
		for (const line of stdout.split('\n')) {
			if (!line.trim()) { continue; }
			const row = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
			if (!row) { throw new TypeError('Invalid process snapshot'); }
			const item = processItem(row[5]!, Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]) * 1024);
			processes.set(item.pid, item);
		}
	}
	const root = processes.get(rootPid);
	if (!root) { throw new Error('Process exited before diagnostics were collected'); }
	const children = new Map<number, ProcessItem[]>();
	for (const item of processes.values()) {
		const siblings = children.get(item.ppid) ?? [];
		siblings.push(item);
		children.set(item.ppid, siblings);
	}
	const pending = [root];
	const visited = new Set<number>([rootPid]);
	for (const item of pending) {
		const descendants = (children.get(item.pid) ?? []).filter(child => !visited.has(child.pid));
		if (!descendants.length) { continue; }
		item.children = descendants.sort((left, right) => left.pid - right.pid);
		for (const child of descendants) { visited.add(child.pid); pending.push(child); }
	}
	return root;
}

function processItem(command: string, pid: number, ppid: number, load: number, mem: number): ProcessItem {
	if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(load) || load < 0 || !Number.isSafeInteger(mem) || mem < 0) {
		throw new TypeError('Invalid process metrics');
	}
	return { name: command.split(/[\\/]/).pop() || command, cmd: command, pid, ppid, load, mem };
}
