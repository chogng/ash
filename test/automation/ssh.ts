import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from '@playwright/test';
import { registerRunResource } from '../../build/processes.ts';

const execute = promisify(execFile);
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Real OpenSSH with disposable keys/profile; the TCP gate can interrupt only this fixture's connections. */
export async function createSshFixture(daemon: string, address = '127.0.0.1') {
	if (
		address !== '127.0.0.1' &&
		!Object.values(networkInterfaces())
			.flat()
			.some(item => item?.address === address && item.family === 'IPv4')
	) {
		throw new Error('SSH fixture address must be a local IPv4 interface (including a local Tailscale address)');
	}
	const root = await mkdtemp(join(tmpdir(), 'ash-desktop-ssh-'));
	const profile = join(root, 'remote-profile');
	const resource = await registerRunResource({ executable: daemon, profile });
	const peers = new Set<Socket>();
	let sshd: ReturnType<typeof spawn> | undefined;
	let errors = '';
	const gateway = createServer(socket => {
		const upstream = connect(sshdPort, '127.0.0.1');
		peers.add(socket);
		peers.add(upstream);
		socket.on('error', () => upstream.destroy());
		upstream.on('error', () => socket.destroy());
		socket.on('close', () => {
			peers.delete(socket);
			upstream.destroy();
		});
		upstream.on('close', () => {
			peers.delete(upstream);
			socket.destroy();
		});
		socket.pipe(upstream).pipe(socket);
	});
	let sshdPort = 0;
	const disconnect = (): void => {
		for (const peer of peers) peer.destroy();
	};
	const close = async (): Promise<void> => {
		disconnect();
		if (gateway.listening)
			await new Promise<void>((resolve, reject) => gateway.close(error => (error ? reject(error) : resolve())));
		try {
			if (sshd) await execute(daemon, ['stop'], { env: { ...process.env, ASH_HOME: profile }, timeout: 30_000 });
		} finally {
			if (sshd && sshd.exitCode === null && sshd.signalCode === null) {
				sshd.kill();
				await new Promise<void>(resolve => sshd!.once('exit', () => resolve()));
			}
			await resource.dispose();
			await rm(root, { recursive: true, force: true });
		}
	};
	try {
		await mkdir(profile);
		await mkdir(join(root, 'codex'));
		for (const name of ['host', 'client'])
			await execute('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]);
		const reservation = createServer();
		await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
		sshdPort = (reservation.address() as import('node:net').AddressInfo).port;
		await new Promise<void>(resolve => reservation.close(() => resolve()));
		await writeFile(
			join(root, 'sshd_config'),
			[
				`Port ${sshdPort}`,
				'ListenAddress 127.0.0.1',
				`HostKey ${root}/host`,
				`PidFile ${root}/sshd.pid`,
				`AuthorizedKeysFile ${root}/client.pub`,
				'StrictModes no',
				'PasswordAuthentication no',
				'KbdInteractiveAuthentication no',
				'UsePAM no',
				`AllowUsers ${userInfo().username}`,
				'AllowTcpForwarding yes',
				'GatewayPorts no',
				'LogLevel ERROR',
				`SetEnv ASH_HOME=${profile} CODEX_HOME=${root}/codex`,
				'',
			].join('\n'),
		);
		sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		sshd.stderr!.on('data', chunk => {
			errors = (errors + String(chunk)).slice(-8000);
		});
		await resource.process(sshd);
		await new Promise<void>((resolve, reject) => {
			gateway.once('error', reject);
			gateway.listen(0, address, resolve);
		});
		const port = (gateway.address() as import('node:net').AddressInfo).port;
		await writeFile(
			join(root, 'known_hosts'),
			`[${address}]:${port} ${await readFile(join(root, 'host.pub'), 'utf8')}`,
		);
		await writeFile(
			join(root, 'ssh_config'),
			[
				'Host ash-desktop-fixture',
				` HostName ${address}`,
				` Port ${port}`,
				` User ${userInfo().username}`,
				` IdentityFile ${root}/client`,
				' IdentitiesOnly yes',
				' StrictHostKeyChecking yes',
				` UserKnownHostsFile ${root}/known_hosts`,
				' BatchMode yes',
				' ConnectTimeout 5',
				' LogLevel ERROR',
				'',
			].join('\n'),
		);
		const ssh = join(root, 'ssh');
		await writeFile(ssh, `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(root, 'ssh_config'))} "$@"\n`, {
			mode: 0o700,
		});
		const run = async (command: string): Promise<string> =>
			(await execute(ssh, ['ash-desktop-fixture', command], { timeout: 15_000 })).stdout;
		await expect
			.poll(
				async () => {
					if (sshd!.exitCode !== null) throw new Error(`OpenSSH fixture exited: ${errors}`);
					return run('printf SSH_READY').catch(() => '');
				},
				{ timeout: 15_000, message: 'Disposable OpenSSH accepts its generated client key' },
			)
			.toBe('SSH_READY');
		return { root, ssh, host: 'ash-desktop-fixture', address, disconnect, close };
	} catch (error) {
		await close();
		throw error;
	}
}
