import { strict as assert } from 'node:assert';
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { createSshRemoteWorkspaceUri } from '../../common/remote.js';
import { SshPortForwardingService, type SshPortForwardChange } from '../../electron-main/sshPortForwardingService.js';
import type { IAnyWorkspaceIdentifier } from '../../../workspace/common/workspace.js';

test('local and non-SSH workspaces cannot start a forward', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	fixture.workspace = { id: 'local', uri: URI.file('/tmp/project') };
	await assert.rejects(service.open({ remotePort: 3000 }), /SSH Remote Workspace/);
	fixture.workspace = { id: 'other', remoteAuthority: 'fixture+backend' };
	await assert.rejects(service.open({ remotePort: 3000 }), /SSH Remote Workspace/);
	assert.deepEqual(fixture.launches, []);
});

test('Ports waits for Rust readiness and projects same-port recovery', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	const changes: SshPortForwardChange[] = [];
	using subscription = service.onDidChange(change => changes.push(change));
	const opening = service.open({ remotePort: 3000 });
	assert.deepEqual(await service.list(), []);
	const [launch] = fixture.launches;
	assert.equal(launch.executable, 'ash-remote-host');
	assert.deepEqual(launch.args, ['forward', 'build-server', '3000', 'ssh']);
	assert.deepEqual(launch.environment, { SSH_AUTH_SOCK: '/tmp/agent.sock' });

	launch.child.stdout.write('{"kind":"rea');
	launch.child.stdout.write('dy","localPort":41234}\n');
	const tunnel = await opening;
	assert.deepEqual(tunnel, { id: 'remote-tunnel-1', localPort: 41234, remoteHost: '127.0.0.1', remotePort: 3000, state: 'open' });

	launch.child.stdout.write('{"kind":"recovering"}\n{"kind":"recovering"}\n{"kind":"ready","localPort":41234}\n');
	assert.deepEqual(changes, [
		{ kind: 'upsert', tunnel },
		{ kind: 'upsert', tunnel: { ...tunnel, state: 'recovering' } },
		{ kind: 'upsert', tunnel },
	]);
	assert.equal(fixture.launches.length, 1);

	const closing = service.close(tunnel.id);
	assert.equal(launch.child.stdin.writableEnded, true);
	assert.deepEqual(await service.list(), []);
	assert.equal(changes.length, 3);
	launch.child.exit();
	await closing;
	assert.deepEqual(changes.at(-1), { kind: 'removed', id: tunnel.id });
});

test('a failed startup is rejected without entering the Ports catalog', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	const opening = service.open({ remotePort: 3000 });
	const { child } = fixture.launches[0];
	child.stdout.write('{"kind":"failed","message":"OpenSSH exited"}\n');
	child.exit();
	await assert.rejects(opening, /OpenSSH exited/);
	assert.deepEqual(await service.list(), []);
});

test('a host exit after readiness leaves a failed catalog entry', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	const opening = service.open({ remotePort: 3000 });
	const { child } = fixture.launches[0];
	child.stdout.write('{"kind":"ready","localPort":41234}\n');
	const tunnel = await opening;
	child.exit();
	assert.deepEqual(await service.list(), [{ ...tunnel, state: 'failed' }]);
	await service.close(tunnel.id);
	assert.deepEqual(await service.list(), []);
});

test('invalid host output closes the lease without publishing a tunnel', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	const opening = service.open({ remotePort: 3000 });
	const { child } = fixture.launches[0];
	child.stdout.write('{"kind":"ready","localPort":65536}\n');
	await assert.rejects(opening, /localPort/);
	assert.equal(child.stdin.writableEnded, true);
	child.exit();
	assert.deepEqual(await service.list(), []);
});

test('closing all forwards retires pending starts and ignores late status from the old Workspace', async () => {
	const fixture = createFixture();
	using service = fixture.service;
	const first = service.open({ remotePort: 3000 });
	const pending = service.open({ remotePort: 3001 });
	const [active, starting] = fixture.launches;
	active.child.stdout.write('{"kind":"ready","localPort":41234}\n');
	await first;
	const closing = service.closeAll();
	await assert.rejects(pending, isCancellationError);
	assert.equal(active.child.stdin.writableEnded, true);
	assert.equal(starting.child.stdin.writableEnded, true);
	starting.child.stdout.write('{"kind":"ready","localPort":41235}\n');
	assert.deepEqual(await service.list(), []);
	active.child.exit();
	starting.child.exit();
	await closing;

	fixture.workspace = { id: 'other', remoteAuthority: 'ssh+other-server' };
	const next = service.open({ remotePort: 3001 });
	const { args, child } = fixture.launches[2];
	assert.deepEqual(args, ['forward', 'other-server', '3001', 'ssh']);
	child.stdout.write('{"kind":"ready","localPort":41236}\n');
	assert.equal((await next).localPort, 41236);
	service.dispose();
	assert.equal(child.stdin.writableEnded, true);
	child.exit();
});

test('window disposal releases the real subprocess through stdin EOF', async () => {
	const closed = new DeferredPromise<void>();
	const script = `
		process.stdin.resume();
		process.stdin.once('end', () => process.exit(0));
		console.log(JSON.stringify({kind: 'ready', localPort: 41234}));
	`;
	using service = new SshPortForwardingService({
		getWorkspace: remoteWorkspace,
		forwardExecutable: () => process.execPath,
		sshExecutable: 'ssh',
		localEnvironment: process.env,
		spawnProcess: (executable, _args, env) => {
			const child = spawn(executable, ['-e', script], { env, stdio: ['pipe', 'pipe', 'inherit'] });
			child.once('close', code => {
				if (code === 0) void closed.complete(undefined);
				else void closed.error(new Error(`Forward fixture exited with ${code}`));
			});
			return child;
		},
	});
	await Promise.all([
		service.open({ remotePort: 3000 }).then(() => service.dispose()),
		closed.p,
	]);
});

class ForwardProcess extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();

	exit(): void {
		this.stdout.end();
		this.emit('close');
	}
}

function remoteWorkspace(): IAnyWorkspaceIdentifier {
	return { id: 'remote', uri: createSshRemoteWorkspaceUri('build-server', '/srv/project') };
}

function createFixture() {
	const launches: { executable: string; args: readonly string[]; environment: NodeJS.ProcessEnv; child: ForwardProcess; }[] = [];
	const fixture = {
		launches,
		workspace: remoteWorkspace(),
		service: new SshPortForwardingService({
			getWorkspace: (): IAnyWorkspaceIdentifier => fixture.workspace,
			forwardExecutable: () => 'ash-remote-host',
			sshExecutable: 'ssh',
			localEnvironment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
			spawnProcess: (executable, args, environment) => {
				const child = new ForwardProcess();
				launches.push({ executable, args, environment, child });
				return child as unknown as ChildProcessByStdio<Writable, Readable, null>;
			},
		}),
	};
	return fixture;
}
