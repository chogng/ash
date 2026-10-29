import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.ts';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';

test.use({ openWorkspace: false });

test(
	'Channel calls connect two Desktop profiles and apply live membership changes',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, testWorkspace }, testInfo) => {
		test.skip(
			!process.env.ASH_TEST_LIVEKIT_SERVER,
			'Requires the pinned LiveKit server executable and physical audio devices.',
		);
		test.setTimeout(180_000);
		const children: ChildProcess[] = [];
		let peer: Awaited<ReturnType<typeof launchElectron>> | undefined;
		const port = await tcpPort();
		const signal = await tcpPort();
		const socket = createSocket('udp4');
		socket.bind(0, '127.0.0.1');
		await once(socket, 'listening');
		const udp = socket.address().port;
		socket.close();
		const secret = randomBytes(32).toString('hex');
		const administrator = randomBytes(32).toString('hex');
		const url = `http://127.0.0.1:${port}`;
		const config = join(testWorkspace.directory, 'livekit.yaml');
		await writeFile(
			config,
			`port: ${signal}\nbind_addresses: [127.0.0.1]\nrtc:\n  udp_port: ${udp}\n  tcp_port: 0\n  node_ip: 127.0.0.1\n  use_external_ip: false\nkeys:\n  ash-test: ${secret}\nlogging:\n  level: error\n`,
			{ mode: 0o600 },
		);
		const start = (binary: string, args: string[], env: NodeJS.ProcessEnv) => {
			const child = spawn(binary, args, { env, stdio: 'pipe', windowsHide: true });
			children.push(child);
			let failure: Error | undefined;
			child.on('error', error => {
				failure = error;
			});
			child.stdout?.resume();
			child.stderr?.resume();
			return () => {
				if (failure) throw failure;
				expect(child.exitCode).toBeNull();
				expect(child.signalCode).toBeNull();
			};
		};
		try {
			const mediaAlive = start(process.env.ASH_TEST_LIVEKIT_SERVER!, ['--config', config], process.env);
			await expect
				.poll(async () => {
					mediaAlive();
					try {
						return (await fetch(`http://127.0.0.1:${signal}`)).status;
					} catch {
						return 0;
					}
				})
				.toBe(200);
			const packageRoot = developmentAshPackagePath(
				resolve(import.meta.dirname, '../../../..'),
				'host-provided-node',
			);
			const serverAlive = start(
				join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-collab-server.exe' : 'ash-collab-server'),
				[`127.0.0.1:${port}`, join(testWorkspace.directory, 'channels.sqlite3')],
				{
					...process.env,
					ASH_COLLABORATION_BEARER_TOKEN: administrator,
					ASH_COLLABORATION_ALLOWED_ORIGIN: await workbench.page.evaluate(() => location.origin),
					ASH_LIVEKIT_SERVER_URL: `ws://127.0.0.1:${signal}`,
					ASH_LIVEKIT_API_URL: `http://127.0.0.1:${signal}`,
					ASH_LIVEKIT_API_KEY: 'ash-test',
					ASH_LIVEKIT_API_SECRET: secret,
				},
			);
			await expect
				.poll(async () => {
					serverAlive();
					try {
						return (await fetch(`${url}/v1/channels/read`)).status;
					} catch {
						return 0;
					}
				})
				.toBe(401);
			const ownerKey = randomBytes(32).toString('hex');
			const peerKey = randomBytes(32).toString('hex');
			const request = async (
				path: string,
				key: string,
				body: unknown,
			): Promise<{ id: string; revision: number }> => {
				const response = await fetch(`${url}/v1/channels/${path}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(200);
				return await response.json();
			};
			let space = await request('create', administrator, {
				name: 'LiveKit collaboration',
				memberName: 'Alice',
				credential: ownerKey,
			});
			space = await request('edit', ownerKey, {
				spaceId: space.id,
				revision: space.revision,
				change: { type: 'create', name: 'engineering' },
			});
			await request('invite', ownerKey, {
				params: { spaceId: space.id, revision: space.revision, name: 'Bob', role: 'editor' },
				credential: peerKey,
			});
			peer = await launchElectron({
				appServerMode: 'required',
				userDataDirectory: join(testWorkspace.directory, 'peer'),
			});
			const alice = workbench.page;
			const bob = peer.driver.workbench.page;
			await peer.application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
			await joinChannel(alice, url, ownerKey);
			await joinChannel(bob, url, peerKey);
			const ownerCall = alice.locator('.ash-call');
			const peerCall = bob.locator('.ash-call');
			for (const call of [ownerCall, peerCall]) {
				await expect(call.getByRole('status')).toHaveText('Connected · Microphone off', { timeout: 30_000 });
				await expect(call.getByRole('button', { name: 'Invite speaker', exact: true })).toBeHidden();
				await expect(call.getByRole('list', { name: 'People in this call' }).getByRole('listitem')).toHaveCount(
					2,
				);
			}
			for (const [speaker, receiver] of [
				[peerCall, ownerCall],
				[ownerCall, peerCall],
			] as const) {
				await speaker.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
				if (process.env.ASH_TEST_CALL_ALLOW_NO_MICROPHONE === '1') {
					await expect(speaker.getByRole('status')).toContainText(
						/Connected · Microphone on|microphone unavailable/,
					);
					if ((await speaker.getByRole('status').textContent())?.includes('microphone unavailable')) {
						testInfo.annotations.push({
							type: 'device-limitation',
							description:
								'No microphone input device: physical capture was not validated; real transport is covered by the Rust channels test.',
						});
						// A rejected unmute must preserve playback and all other call controls.
						await speaker.getByRole('button', { name: 'Stop listening', exact: true }).click();
						await expect(speaker.getByRole('status')).toHaveText('Connected · Microphone off');
						await speaker.getByRole('button', { name: 'Resume listening', exact: true }).click();
						continue;
					}
				}
				await expect(speaker.getByRole('status')).toHaveText('Connected · Microphone on');
				await expect(receiver.getByRole('listitem').filter({ hasText: /^Participant \d+$/ })).toHaveCount(1);
				await speaker.getByRole('button', { name: 'Mute microphone', exact: true }).click();
				await expect(receiver.getByRole('listitem').filter({ hasText: /microphone off/ })).toHaveCount(2);
			}
			await peerCall.getByRole('button', { name: 'Stop listening', exact: true }).click();
			await peerCall.getByRole('button', { name: 'Resume listening', exact: true }).click();
			await alice.screenshot({ path: testInfo.outputPath('owner-connected.png') });
			await bob.screenshot({ path: testInfo.outputPath('peer-connected.png') });

			await command(alice, 'ash.collaboration.open');
			await alice.getByRole('button', { name: 'Members and Permissions', exact: true }).click();
			await alice.getByRole('option', { name: /^Bob/ }).click();
			await alice.getByRole('option', { name: 'Change Role', exact: true }).click();
			await alice.getByRole('option', { name: 'Viewer', exact: true }).click();
			await expect(peerCall.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeDisabled({
				timeout: 30_000,
			});
			await expect(peerCall.getByRole('status')).toHaveText('Connected · Microphone off', { timeout: 30_000 });
			await command(alice, 'ash.call.open');
			await expect(ownerCall.getByRole('status')).toHaveText('Connected · Microphone off', { timeout: 30_000 });
			await expect(ownerCall.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeEnabled();
			await bob.screenshot({ path: testInfo.outputPath('peer-viewer.png') });

			await command(alice, 'ash.collaboration.open');
			await alice.getByRole('button', { name: 'Members and Permissions', exact: true }).click();
			await alice.getByRole('option', { name: /^Bob/ }).click();
			await alice.getByRole('option', { name: 'Remove Member', exact: true }).click();
			await alice.getByRole('option', { name: 'Revoke access for Bob', exact: true }).click();
			await expect(peerCall.getByRole('status')).toContainText('call access denied', { timeout: 30_000 });
			await expect(peerCall.getByRole('list', { name: 'People in this call' })).toBeHidden();
			await bob.screenshot({ path: testInfo.outputPath('peer-revoked.png') });
			await command(alice, 'ash.call.open');
			await expect(ownerCall.getByRole('status')).toHaveText('Connected · Microphone off', { timeout: 30_000 });
			await ownerCall.getByRole('button', { name: 'End for everyone', exact: true }).click();
			await expect(ownerCall.getByRole('status')).toHaveText('Call ended · Microphone off');
		} finally {
			try {
				if (peer) {
					await peer.application
						.context()
						.tracing.stop({ path: testInfo.outputPath('peer-trace.zip') })
						.catch(() => undefined);
					await peer.close();
				}
			} finally {
				for (const child of children.reverse()) {
					if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
					const exited = once(child, 'exit');
					const force = setTimeout(() => child.kill('SIGKILL'), 5000);
					force.unref();
					child.kill();
					try {
						await exited;
					} finally {
						clearTimeout(force);
					}
				}
			}
		}
	},
);

async function command(page: Page, commandId: string): Promise<void> {
	await page.bringToFront();
	await new QuickAccess(page).runCommand(commandId);
}

async function joinChannel(page: Page, url: string, credential: string): Promise<void> {
	await command(page, 'ash.collaboration.open');
	await page.getByRole('button', { name: 'Connect Channels', exact: true }).click();
	await page.getByRole('option', { name: 'Join with Invitation', exact: true }).click();
	const invitation = page.getByRole('textbox', { name: 'Join with Invitation', exact: true });
	await invitation.fill(JSON.stringify({ serverUrl: url, credential }));
	await invitation.press('Enter');
	await page.getByRole('treeitem', { name: 'engineering', exact: true }).click();
	await page.getByRole('button', { name: 'Join or start channel call', exact: true }).click();
	await command(page, 'ash.call.open');
}

async function tcpPort(): Promise<number> {
	const socket = createServer();
	await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
	const address = socket.address();
	if (!address || typeof address === 'string') throw new Error('Missing test service port');
	await new Promise<void>((resolve, reject) => socket.close(error => (error ? reject(error) : resolve())));
	return address.port;
}
