import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ProcessRun } from './processes.ts';

const repository = resolve(import.meta.dirname, '..');

for (const ignoresSignal of [false, true]) {
	test(`owned process trees exit when the root ${ignoresSignal ? 'ignores' : 'handles'} termination`, { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
		const child = spawn(process.execPath, ['-e', `
const { spawn } = require('node:child_process');
${ignoresSignal ? 'process.on("SIGTERM", () => {});' : ''}
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', pid => process.send(pid));
setInterval(() => {}, 1000);
`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
		const ready = new Promise<number>(resolveReady => child.once('message', pid => resolveReady(Number(pid))));
		const run = new ProcessRun(repository, undefined, 100);
		t.after(async () => { await run.close(); });
		await run.own(child);
		const descendant = await ready;
		await run.stop('SIGTERM');
		for (const pid of [child.pid!, descendant]) assert.equal(await isAlive(pid), false, `Leaked PID ${pid}`);
		await assert.rejects(run.command(process.execPath, ['-e', 'throw Error("unexpected command")'], process.env), /refusing to start/);
	});
}

test('command completion cleans helpers that outlive their root', { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.process-command-'));
	const marker = join(directory, 'pid');
	const run = new ProcessRun(repository);
	t.after(async () => { await run.close(); await rm(directory, { recursive: true, force: true }); });
	const result = await run.command(process.execPath, ['-e', `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('message', pid => { writeFileSync(${JSON.stringify(marker)}, String(pid)); process.exit(0); });
`], process.env);
	assert.equal(result.code, 0);
	const pid = Number(await readFile(marker, 'utf8'));
	assert.equal(await isAlive(pid), true, 'The fixture must leave its helper running');
	await run.close();
	assert.equal(await isAlive(pid), false);
});

test('a supervisor cleans detached registered resources after its worker exits', { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
	const directory = await mkdtemp(join(repository, 'test/.process-owner-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const marker = join(directory, 'pid');
	const worker = join(directory, 'worker.ts');
	await writeFile(worker, `
import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { registerRunResource } from ${JSON.stringify(join(repository, 'build/processes.ts'))};
const resource = await registerRunResource();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
await resource.process(child);
await writeFile(${JSON.stringify(marker)}, String(child.pid));
process.exit(0);
`);
	const run = new ProcessRun(repository, directory);
	let pid: number | undefined;
	t.after(async () => { await run.close(); if (pid && await isAlive(pid)) process.kill(pid, 'SIGKILL'); });
	const result = await run.command(process.execPath, [worker], { ...process.env, ASH_SMOKE_RUN_DIRECTORY: directory });
	assert.equal(result.code, 0);
	pid = Number(await readFile(marker, 'utf8'));
	await run.close();
	assert.equal(await isAlive(pid), false);
});

async function isAlive(pid: number): Promise<boolean> {
	try { const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=']); return !stdout.trim().startsWith('Z'); }
	catch (error) { if (error.code === 1) return false; throw error; }
}
