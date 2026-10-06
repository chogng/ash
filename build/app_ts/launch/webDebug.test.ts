import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { _electron, expect } from '@playwright/test';
import { developmentAshPackagePath } from '../runtimeStore.ts';

const repository = resolve(import.meta.dirname, '../../..');

interface DebugState {
	readonly sessions: readonly { name: string; parentName?: string }[];
	readonly output: readonly string[];
}

// An installed VS Code supplies the real task runner, server-ready extension and JavaScript debugger.
for (const [serverName, browserName, port, connected] of [
	['Ash Web (Chrome)', 'Ash Web Browser (Chrome)', 5173, false],
	['Ash Sessions Web (Chrome, UI Only)', 'Ash Sessions Web Browser (Chrome)', 5173, false],
	['Ash Sessions Web (Chrome)', 'Browser Debug', 5174, true],
] as const) {
test(`${serverName} F5 releases its server and browser when ${connected ? 'the server' : 'either debug session'} stops and can launch again`, {
	// The connected launch can compile the Rust backend before its first debugger starts.
	timeout: connected ? 360_000 : 180_000,
	skip: !process.env.ASH_VSCODE_EXECUTABLE,
}, async t => {
	await assertPortAvailable(port);
	// Keep the managed socket path below Windows' AF_UNIX path limit.
	const directory = await mkdtemp(join(tmpdir(), 'ash-wd-'));
	const extension = join(directory, 'extension');
	const profile = join(directory, 'profile');
	const endpointFile = join(directory, 'endpoint.json');
	await mkdir(extension);
	await mkdir(join(profile, 'User'), { recursive: true });
	await writeFile(join(profile, 'User/settings.json'), JSON.stringify({
		'security.workspace.trust.enabled': false,
		'update.mode': 'none',
		'telemetry.telemetryLevel': 'off',
		'workbench.startupEditor': 'none',
	}));
	await writeFile(join(extension, 'package.json'), JSON.stringify({
		name: 'ash-web-debug-test', publisher: 'ash-test', version: '1.0.0',
		engines: { vscode: '^1.80.0' }, activationEvents: ['onStartupFinished'], main: './extension.cjs',
	}));
	await writeFile(join(extension, 'extension.cjs'), extensionSource);
	const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
	environment.ASH_WEB_DEBUG_ENDPOINT = endpointFile;
	environment.ASH_WEB_APP_SERVER_PROFILE = join(directory, 'b');
	delete environment.ELECTRON_RUN_AS_NODE;
	// Debugger readiness must work without the terminal tool's inherited color overrides.
	delete environment.NO_COLOR;
	delete environment.FORCE_COLOR;
	const application = await _electron.launch({
		executablePath: process.env.ASH_VSCODE_EXECUTABLE,
		args: [
			`--user-data-dir=${profile}`, `--extensions-dir=${join(directory, 'extensions')}`,
			`--extensionDevelopmentPath=${extension}`, '--disable-workspace-trust',
			'--skip-welcome', '--skip-release-notes', '--new-window', repository,
		],
		env: environment,
		timeout: 30_000,
	});
	let endpoint: string | undefined;
	t.after(async () => {
		if (endpoint) { await command('stopAll'); }
		await application.close();
		if (connected) {
			const executable = join(developmentAshPackagePath(repository, 'packaged-node'), 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
			await promisify(execFile)(executable, ['stop'], { env: { ...environment, ASH_HOME: join(directory, 'b') }, windowsHide: true });
		}
		const temporaryPath = relative(tmpdir(), directory);
		assert.ok(!temporaryPath.startsWith('..') && !isAbsolute(temporaryPath));
		await rm(directory, { recursive: true, force: true });
	});
	await expect.poll(async () => {
		try { endpoint = JSON.parse(await readFile(endpointFile, 'utf8')).endpoint; return true; }
		catch (error) { if (error.code !== 'ENOENT') { throw error; } return false; }
	}, { timeout: 30_000 }).toBe(true);

	async function command<T = unknown>(action: string, name?: string): Promise<T> {
		const response = await fetch(endpoint!, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action, name }),
		});
		const result = await response.json();
		assert.equal(response.status, 200, JSON.stringify(result));
		return result as T;
	}

	for (const stopName of connected ? [serverName] : [serverName, browserName]) {
		assert.equal(await command<boolean>('start', serverName), true);
		try {
			await expect.poll(async () => (await command<DebugState>('state')).sessions.filter(session => !session.parentName).map(session => session.name).sort(), {
				timeout: 60_000,
			}).toEqual([serverName, browserName].sort());
		} catch (error) {
			t.diagnostic(JSON.stringify(await command<DebugState>('state')));
			throw error;
		}
		await expect.poll(async () => (await command<DebugState>('state')).sessions.some(session => session.parentName === browserName), { timeout: 30_000 }).toBe(true);
		await expect.poll(async () => {
			const result = await command<{ result: string }>(connected ? 'evaluateConnected' : 'evaluate', browserName);
			return result.result;
		}, { timeout: 30_000 }).toBe('true');
		const pids = await debugProcessIds(application.process().pid!);
		assert.ok(pids.length >= 2, JSON.stringify(pids));
		await command('stop', stopName);
		await expect.poll(async () => (await command<DebugState>('state')).sessions, { timeout: 10_000 }).toEqual([]);
		await expect.poll(() => pids.every((pid: number) => {
			try { process.kill(pid, 0); return false; }
			catch (error) { if (error.code !== 'ESRCH') { throw error; } return true; }
		}), { timeout: 10_000 }).toBe(true);
		await assertPortAvailable(port);
	}

	const occupied = createServer();
	await new Promise<void>((resolveListen, reject) => {
		occupied.once('error', reject);
		occupied.listen(port, '127.0.0.1', resolveListen);
	});
	try {
		await command('start', serverName);
		await expect.poll(async () => (await command<DebugState>('state')).output.some(output => output.includes(`Port ${port} is already in use`)), { timeout: 30_000 }).toBe(true);
		await expect.poll(async () => (await command<DebugState>('state')).sessions, { timeout: 10_000 }).toEqual([]);
		assert.equal(occupied.listening, true);
		assert.deepEqual(await debugProcessIds(application.process().pid!), []);
	} finally {
		await new Promise<void>((resolveClose, reject) => occupied.close(error => error ? reject(error) : resolveClose()));
	}
	await assertPortAvailable(port);
});
}

async function assertPortAvailable(port: number): Promise<void> {
	const server = createServer();
	await new Promise<void>((resolveListen, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolveListen);
	});
	await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

async function debugProcessIds(root: number): Promise<number[]> {
	const execute = promisify(execFile);
	let processes: { pid: number; parent: number; name: string }[];
	if (process.platform === 'win32') {
		const result = await execute('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object @{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}},@{n="name";e={$_.Name}} | ConvertTo-Json -Compress'], { windowsHide: true });
		processes = JSON.parse(result.stdout);
	} else {
		const result = await execute('ps', ['-eo', 'pid=,ppid=,comm=']);
		processes = result.stdout.trim().split('\n').map(line => {
			const [pid, parent, ...name] = line.trim().split(/\s+/);
			return { pid: Number(pid), parent: Number(parent), name: name.join(' ') };
		});
	}
	const descendants = new Set([root]);
	let previousSize = 0;
	while (descendants.size !== previousSize) {
		previousSize = descendants.size;
		for (const child of processes) { if (descendants.has(child.parent)) { descendants.add(child.pid); } }
	}
	return processes.filter(child => descendants.has(child.pid) && /node|chrome/i.test(child.name)).map(child => child.pid);
}

const extensionSource = String.raw`
const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');

exports.activate = function (context) {
	const sessions = new Map();
	const output = [];
	context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => sessions.set(session.id, session)));
	context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => sessions.delete(session.id)));
	context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
		createDebugAdapterTracker(session) {
			return { onDidSendMessage(message) {
				if (message.event === 'output') { output.push(session.name + ': ' + message.body.output); }
			} };
		},
	}));
	const server = http.createServer(async (request, response) => {
		try {
			let body = '';
			for await (const chunk of request) { body += chunk; }
			const { action, name } = JSON.parse(body);
			let result;
			if (action === 'state') {
				result = { sessions: [...sessions.values()].map(session => ({ name: session.name, parentName: session.parentSession?.name })), output: output.slice(-30) };
			} else if (action === 'start') {
				result = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], name);
			} else if (action === 'stopAll') {
				for (const execution of vscode.tasks.taskExecutions) { execution.terminate(); }
				await Promise.all([...sessions.values()].map(session => vscode.debug.stopDebugging(session)));
				result = true;
			} else {
				const session = [...sessions.values()].find(session => session.name === name);
				if (!session) { throw new Error('Missing session: ' + name); }
				if (action === 'stop') {
					await vscode.debug.stopDebugging(session);
					result = true;
				} else if (action === 'evaluate' || action === 'evaluateConnected') {
					const target = [...sessions.values()].find(candidate => candidate.parentSession?.id === session.id);
					if (!target) { throw new Error('Missing browser target'); }
					result = await target.customRequest('evaluate', {
						expression: action === 'evaluateConnected' ? '!!document.querySelector(".ash-sessions-window") && !!globalThis.ashWebWorkbenchHost' : session.name.includes('Sessions') ? '!!document.querySelector(".ash-sessions-window")' : '!!document.querySelector(".ash-workbench")', context: 'repl',
					});
				} else { throw new Error('Unknown action: ' + action); }
			}
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify(result));
		} catch (error) {
			response.statusCode = 500;
			response.end(JSON.stringify({ error: String(error) }));
		}
	});
	server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.ASH_WEB_DEBUG_ENDPOINT, JSON.stringify({
		endpoint: 'http://127.0.0.1:' + server.address().port,
	})));
	context.subscriptions.push({ dispose: () => server.close() });
};
`;
