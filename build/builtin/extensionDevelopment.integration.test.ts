import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const sdk = process.env.ASH_EDITOR_DEV_TEST_SDK;
const project = process.env.ASH_ACADEMY_DEVELOPMENT_PROJECT;
const enabled = !!sdk && !!project;

test('real independent Academy development host gates local code, describes, reloads and stops', { skip: !enabled }, async () => {
	const cwd = resolve(project!);
	const binary = resolve(sdk!, 'bin', process.platform === 'win32' ? 'editor_dev.exe' : 'editor_dev');
	const refused = spawnSync(binary, [cwd, 'target/debug/ash-academy', 'ash.academy'], { cwd, encoding: 'utf8', timeout: 20_000 });
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /allow-local-code/u);
	const result = spawnSync(process.execPath, [resolve(sdk!, 'dev.mjs'), 'debug', cwd, '--allow-local-code'], { cwd, input: 'status\ndescribe zh-CN\nreload\nquit\n', encoding: 'utf8', timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr + result.stdout);
	const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
	assert.equal(events.filter(event => event.event === 'description').length, 3);
	assert.equal(events.find(event => event.language === 'zh-CN').result.editors[0].displayName, '学术论文文档');
	assert.equal(events.at(-1).event, 'stopped');
	assert.ok(events.some(event => event.event === 'status' && event.registrations.some((item: { registrationId: string; }) => item.registrationId === 'editor.client.v1')));
});

test('development load rejects a stale native/client source binding', { skip: !enabled }, async () => {
	const path = resolve(project!, 'dist/client.json');
	const original = await readFile(path, 'utf8');
	try {
		const client = JSON.parse(original); client.sourceDigest = `sha256:${'0'.repeat(64)}`;
		await writeFile(path, JSON.stringify(client));
		const result = spawnSync(process.execPath, [resolve(sdk!, 'dev.mjs'), 'debug', resolve(project!), '--allow-local-code'], { input: '', encoding: 'utf8', timeout: 20_000 });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Native\/client source mismatch/u);
	} finally { await writeFile(path, original); }
});

test('SIGTERM shuts down a supervised independent Academy process', { skip: !enabled }, async () => {
	const child = spawn(process.execPath, [resolve(sdk!, 'dev.mjs'), 'debug', resolve(project!), '--allow-local-code'], { stdio: ['pipe', 'pipe', 'pipe'] });
	let output = ''; let diagnostics = ''; let signalled = false;
	child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
	child.stderr.on('data', value => diagnostics += value);
	const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
	try {
		await new Promise<void>((accept, reject) => {
			child.once('error', reject);
			child.stdout.on('data', value => {
				output += value;
				if (!signalled && output.includes('"event":"description"')) { signalled = true; child.kill('SIGTERM'); }
			});
			child.once('exit', code => code === 0 ? accept() : reject(new Error(`exit ${code}: ${diagnostics}`)));
		});
		assert.match(output, /"event":"stopped"/u);
	} finally { clearTimeout(timeout); child.stdin.end(); if (child.exitCode === null) child.kill('SIGKILL'); }
});
