import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { developmentAshPackagePath } from '../../../../build/desktop/runtimeStore.ts';
import { expect, test } from '../../../automation/test.js';
import type { Locator } from '@playwright/test';

// Remote selections can switch a paragraph from textarea to the rich text surface.
const noteText = (input: Locator) => input.evaluate(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');

test('Persistent collaboration channels share across windows and enforce member permissions', { tag: ['@electron-app-server', '@browser-app-server'] }, async ({ target, application, workbench, reloadWorkbench, testWorkspace }, testInfo) => {
	test.setTimeout(180_000);
	const reservation = createServer();
	await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
	const address = reservation.address();
	if (!address || typeof address === 'string') throw new Error('Missing collaboration port');
	await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
	const url = `http://127.0.0.1:${address.port}`;
	const administrator = randomBytes(32).toString('hex');
	const origin = await workbench.page.evaluate(() => location.origin);
	const packageRoot = developmentAshPackagePath(resolve(import.meta.dirname, '../../../..'), target.kind === 'browser' ? 'packaged-node' : 'host-provided-node');
	let child: ChildProcess | undefined;
	let originalClipboard: string | undefined;
	const start = async () => {
		child = spawn(join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-collab-server.exe' : 'ash-collab-server'), [`127.0.0.1:${address.port}`, join(testWorkspace.directory, 'channels.sqlite')], { env: { ...process.env, ASH_COLLABORATION_BEARER_TOKEN: administrator, ASH_COLLABORATION_ALLOWED_ORIGIN: origin }, stdio: 'ignore', windowsHide: true });
		let failure: Error | undefined;
		child.on('error', error => { failure = error; });
		await expect.poll(async () => { if (failure) throw failure; try { return (await fetch(`${url}/v1/channels/read`)).status; } catch { return 0; } }, { timeout: 15_000 }).toBe(401);
	};
	const stop = async () => {
		const host = child; child = undefined;
		if (!host?.pid || host.exitCode !== null || host.signalCode !== null) return;
		const exited = once(host, 'exit');
		const force = setTimeout(() => host.kill('SIGKILL'), 5000); force.unref();
		host.kill();
		try { await exited; } finally { clearTimeout(force); }
	};
	try {
		await start();
		let page = workbench.page;
		if (target.kind === 'browser') {
			// The isolated headless profile has no interactive system keyring. Select its
			// supported private-file mode through the same explicit confirmation as a user.
			await workbench.settingsEditor.openUserSettingsUI();
			await workbench.settingsEditor.selectGroup('agents');
			await workbench.settingsEditor.selectCategory('models');
			await page.getByRole('button', { name: 'Use file storage', exact: true }).click();
			await page.getByRole('button', { name: 'Use file storage', exact: true }).last().click();
			await expect(page.getByRole('button', { name: 'Use encrypted storage', exact: true })).toBeVisible();
			await page.keyboard.press('Escape');
		}
		if ('windows' in application) {
			originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
			await application.evaluate(({ clipboard }) => clipboard.writeText('ash-channel-test'));
		} else {
			await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
			originalClipboard = await page.evaluate(() => navigator.clipboard.readText());
			await page.evaluate(() => navigator.clipboard.writeText('ash-channel-test'));
		}
		await workbench.quickaccess.runCommand('ash.collaboration.open');
		await page.getByRole('button', { name: 'Connect Channels', exact: true }).click();
		await page.getByRole('option', { name: 'Create Collab Space', exact: true }).click();
		for (const [name, value] of [['Collab Server', url], ['Server Administrator Credential', administrator], ['Space Name', 'Ash shared space'], ['Your Display Name', 'Owner']]) {
			const input = page.getByRole('textbox', { name, exact: true }); await input.fill(value!); await input.press('Enter');
		}
		await expect(page.locator('.collaboration-connection')).toContainText('Ash shared space');
		await page.getByRole('searchbox', { name: 'Search channels' }).focus();
		await page.getByRole('button', { name: 'New Channel', exact: true }).click();
		const name = page.getByRole('textbox', { name: 'New Channel', exact: true }); await name.fill('engineering'); await name.press('Enter');
		await expect(page.getByRole('treeitem', { name: 'engineering', exact: true })).toBeVisible();
		await page.getByRole('treeitem', { name: 'engineering', exact: true }).dblclick();
		await expect(page.locator('.stanza-document-collaboration-toolbar')).toHaveAttribute('data-state', 'connected');
		const notes = page.getByRole('textbox', { name: 'Paragraph', exact: true }).first();
		await notes.fill('Channel notes survive restart');
		const agents = await workbench.openAgentsWindow(target.kind);
		await agents.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Collab', exact: true }).click();
		await expect(agents.getByRole('treeitem', { name: 'engineering', exact: true })).toBeVisible();
		await agents.getByRole('treeitem', { name: 'engineering', exact: true }).dblclick();
		await expect(agents.locator('.stanza-document-collaboration-toolbar')).toHaveAttribute('data-state', 'connected');
		const sharedNotes = agents.getByRole('textbox', { name: 'Paragraph', exact: true }).first();
		await expect.poll(() => noteText(sharedNotes)).toBe('Channel notes survive restart');
		await sharedNotes.fill('Channel notes survive restart and sync across clients');
		await expect.poll(() => noteText(notes)).toBe('Channel notes survive restart and sync across clients');

		await workbench.quickaccess.runCommand('ash.collaboration.open');
		await page.getByRole('searchbox', { name: 'Search channels' }).focus();
		await page.getByRole('button', { name: 'Members and Permissions', exact: true }).click();
		await page.getByRole('option', { name: 'Invite Member', exact: true }).click();
		const member = page.getByRole('textbox', { name: 'Member Display Name', exact: true }); await member.fill('Viewer'); await member.press('Enter');
		await page.getByRole('option', { name: 'Viewer', exact: true }).click();
		await page.getByRole('option', { name: 'Copy Invitation', exact: true }).click();
		const copied = 'windows' in application ? await application.evaluate(({ clipboard }) => clipboard.readText()) : await page.evaluate(() => navigator.clipboard.readText());
		const invitation = JSON.parse(copied) as { credential: string; };
		const headers = { authorization: `Bearer ${invitation.credential}`, 'content-type': 'application/json' };
		const snapshot = await (await fetch(`${url}/v1/channels/read`, { headers })).json() as { id: string; revision: number; channels: { name: string; }[]; };
		expect(snapshot.channels.map(channel => channel.name)).toEqual(['engineering']);
		const denied = await fetch(`${url}/v1/channels/edit`, { method: 'POST', headers, body: JSON.stringify({ spaceId: snapshot.id, revision: snapshot.revision, change: { type: 'create', name: 'forbidden', parentId: null } }) });
		expect(denied.status).toBe(403);
		await stop(); await start();
		({ application, workbench } = await reloadWorkbench()); page = workbench.page;
		await workbench.quickaccess.runCommand('ash.collaboration.open');
		await expect(page.getByRole('treeitem', { name: 'engineering', exact: true })).toBeVisible();
		await page.getByRole('treeitem', { name: 'engineering', exact: true }).dblclick();
		await expect(page.locator('.stanza-document-collaboration-toolbar')).toHaveAttribute('data-state', 'connected');
		await expect.poll(() => noteText(page.getByRole('textbox', { name: 'Paragraph', exact: true }).first())).toBe('Channel notes survive restart and sync across clients');
		await workbench.quickaccess.runCommand('ash.collaboration.open');
		await page.getByRole('searchbox', { name: 'Search channels' }).focus();
		await page.getByRole('button', { name: 'Members and Permissions', exact: true }).click();
		await page.getByRole('option', { name: /^Viewer/ }).click();
		await page.getByRole('option', { name: 'Remove Member', exact: true }).click();
		await page.getByRole('option', { name: 'Revoke access for Viewer', exact: true }).click();
		await expect.poll(async () => (await fetch(`${url}/v1/channels/read`, { headers })).status).toBe(403);
		await page.screenshot({ path: testInfo.outputPath('collaboration-connected.png') });
	} finally {
		if (originalClipboard !== undefined) {
			if ('windows' in application) await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard).catch(() => undefined);
			else await workbench.page.evaluate(value => navigator.clipboard.writeText(value), originalClipboard).catch(() => undefined);
		}
		await stop();
	}
});
