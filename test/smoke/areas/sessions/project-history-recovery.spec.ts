import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import type { AppServerConnectionRelay } from '../../../../src/ash/platform/agentHost/electron-main/appServerConnectionRelay.js';
import type { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import type { ISandboxGlobals } from '../../../../src/ash/base/parts/sandbox/electron-browser/sandboxTypes.js';
import { developmentAshPackagePath } from '../../../../src/ash/platform/environment/node/developmentArtifacts.js';
import { DEVELOPMENT_DIR_PERMISSIONS } from '../../../../src/ash/platform/workspace/common/workspaceTrust.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, sshAgentHostProviderId } from '../../../../src/ash/sessions/common/agentHostSessionsProvider.js';
import { sessionIdentity } from '../../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { createSshFixture } from '../../../automation/ssh.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

type CatalogInterruption = { method: 'session/catalog/subscribe' | 'session/list'; kind: 'disconnect' | 'reject'; };
type CatalogFault = {
	next?: CatalogInterruption;
	interrupted: number;
	state(): string | undefined;
	release(): void;
};

test('Project history survives an interrupted catalog, repair and Desktop restart', { tag: '@electron-app-server' }, async ({ application, target, testWorkspace, workbench, reloadWorkbench }, testInfo) => {
	test.setTimeout(90_000);
	if (!('windows' in application)) throw new Error('Expected Electron');
	const root = await realpath(testWorkspace.directory);
	const migrationFolder = join(root, 'Migration fixture');
	const repairFolder = join(root, 'Repair fixture');
	await Promise.all([mkdir(migrationFolder), mkdir(repairFolder)]);

	let connection = await connectProfile(application, undefined, root, workbench.page);
	const request = () => connection.client;
	const createSession = async (title: string, folder: string) => (await createCodeSession(request(), title, folder)).sessionId;
	const readSession = async (sessionId: string) => (await request().request(APP_SERVER_METHODS['session/catalog/read'], { sessionId })).session;
	const createProject = async (name: string, folder?: string) => (await request().request(APP_SERVER_METHODS['project/create'], {
		commandId: randomUUID(), projectId: randomUUID(), name, description: '', scope: 'code',
		materials: folder ? [{ path: pathToFileURL(folder).href, name, kind: 'folder' }] : [],
	})).project;
	const read = async (projectId: string) => (await request().request(APP_SERVER_METHODS['project/read'], { projectId })).project;
	const projects = async () => (await request().request(APP_SERVER_METHODS['project/list'], { scope: 'code' })).projects;
	const link = async (projectId: string, sessionId: string) => request().request(APP_SERVER_METHODS['project/session/link'], {
		commandId: randomUUID(), projectId, sessionId, expectedRevision: (await read(projectId)).revision,
	});
	const statuses = async (...ids: string[]) => {
		const { sessions } = await request().request(APP_SERVER_METHODS['session/list'], {});
		return ids.map(id => sessions.find(session => session.sessionId === id)?.status);
	};

	try {
		const project = await createProject('Archive retry fixture');
		const member = await createSession('Archive retry member', root);
		await link(project.projectId, member);
		const migration = await createSession('Legacy folder conversation', migrationFolder);

		const fault = await installCatalogFault(application, { method: 'session/catalog/subscribe', kind: 'disconnect' });

		let page = await workbench.openAgentsWindow(target.kind);
		const showCode = async () => page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();

		await test.step('Reconnect and retry the pending folder migration', async () => {
			await showCode();
			try {
				await expect.poll(fault.read).toEqual({ interrupted: 1, state: 'crashed' });
				expect((await projects()).map(value => value.projectId)).toEqual([project.projectId]);
				expect(await statuses(member, migration)).toEqual(['active', 'active']);
			} finally { await fault.release(); }
			await expect.poll(fault.read).toEqual({ interrupted: 1, state: 'ready' });
			await expect(page.getByRole('button', { name: 'Migration fixture', exact: true })).toBeVisible();
			const migrated = (await projects()).find(value => value.name === 'Migration fixture');
			expect(migrated).toBeDefined();
			expect((await read(migrated!.projectId)).sessionIds).toEqual([migration]);
		});

		await test.step('Archive fails on the interrupted catalog and succeeds on retry', async () => {
			const before = await read(project.projectId);
			await fault.arm({ method: 'session/list', kind: 'disconnect' });
			try {
				await archiveProject(page, project.name);
				await expect.poll(fault.read).toEqual({ interrupted: 2, state: 'crashed' });
				await expect(page.getByText('Could not finish archiving "Archive retry fixture". Try again to continue.', { exact: true }).first()).toBeVisible();
				expect(await read(project.projectId)).toEqual(before);
				expect(await statuses(member, migration)).toEqual(['active', 'active']);
			} finally { await fault.release(); }
			await expect.poll(fault.read).toEqual({ interrupted: 2, state: 'ready' });
			await archiveProject(page, project.name);
			await expect.poll(async () => (await read(project.projectId)).status).toBe('archived');
			expect(await statuses(member, migration)).toEqual(['archived', 'active']);
		});

		await test.step('Apply only the selected historical repairs and reject a changed target', async () => {
			const archivedSelected = await createSession('Archive repair selected', root);
			const archivedUnselected = await createSession('Archive repair unselected', root);
			// Seed the legacy inconsistency through the backend's project-only mutation.
			const legacy = await createProject('Legacy archived fixture');
			await link(legacy.projectId, archivedSelected);
			await link(legacy.projectId, archivedUnselected);
			await request().request(APP_SERVER_METHODS['project/archive'], {
				commandId: randomUUID(), projectId: legacy.projectId, expectedRevision: (await read(legacy.projectId)).revision,
			});

			const folder = await createProject('Folder repair target', repairFolder);
			const folderSelected = await createSession('Folder repair selected', repairFolder);
			const folderUnselected = await createSession('Folder repair unselected', repairFolder);
			const readUnselected = () => Promise.all([readSession(archivedUnselected), readSession(folderUnselected)]);
			const unselectedBefore = await readUnselected();
			const picker = new QuickAccess(page);
			const pick = async (command: string, title: string, selected: string, unselected: string) => {
				await picker.runCommand(command);
				await expect(page.getByText(title, { exact: true })).toBeVisible();
				await expect(picker.items.filter({ hasText: unselected })).toHaveAttribute('aria-checked', 'false');
				await picker.select(selected);
				await expect(picker.items.filter({ hasText: selected })).toHaveAttribute('aria-checked', 'true');
			};
			const apply = async () => {
				await page.keyboard.press('Enter');
				await expect(picker.element).toBeHidden();
			};
			await pick('projects.repairArchived', 'Select conversations to archive', 'Archive repair selected', 'Archive repair unselected');
			await apply();
			await expect.poll(() => statuses(archivedSelected, archivedUnselected)).toEqual(['archived', 'active']);

			await pick('projects.repairCodeFolders', 'Select Code conversations to link', 'Folder repair selected', 'Folder repair unselected');
			const archivedTarget = (await request().request(APP_SERVER_METHODS['project/archive'], {
				commandId: randomUUID(), projectId: folder.projectId, expectedRevision: folder.revision,
			})).project;
			expect(archivedTarget.revision).toBeGreaterThan(folder.revision);
			await apply();
			await expect(page.getByText('The selected conversations or projects changed. Run the repair command again to review them.', { exact: true }).first()).toBeVisible();
			expect(await read(folder.projectId)).toEqual(archivedTarget);

			await request().request(APP_SERVER_METHODS['project/restore'], {
				commandId: randomUUID(), projectId: folder.projectId, expectedRevision: archivedTarget.revision,
			});
			await pick('projects.repairCodeFolders', 'Select Code conversations to link', 'Folder repair selected', 'Folder repair unselected');
			await apply();
			await expect.poll(async () => (await read(folder.projectId)).sessionIds).toEqual([folderSelected]);
			expect(await statuses(folderSelected, folderUnselected)).toEqual(['active', 'active']);
			expect(await readUnselected()).toEqual(unselectedBefore);

			const projectSnapshot = async () => Promise.all((await projects()).sort((a, b) => a.projectId.localeCompare(b.projectId)).map(value => read(value.projectId)));
			const before = await projectSnapshot();
			expect(before.map(value => value.name).sort()).toEqual(['Archive retry fixture', 'Folder repair target', 'Legacy archived fixture', 'Migration fixture']);
			expect(before.every(value => !value.sessionIds.includes(folderUnselected))).toBe(true);
			const faults = await fault.read();
			const version = await application.evaluate(({ app }) => ({ pid: process.pid, app: app.getVersion(), electron: process.versions.electron }));
			const backendBefore = await backendIdentity(application);
			await connection.close();
			const restarted = await reloadWorkbench();
			if (!('windows' in restarted.application)) throw new Error('Expected restarted Electron');
			expect(await restarted.application.evaluate(() => process.pid)).not.toBe(version.pid);
			connection = await connectProfile(restarted.application, undefined, root, restarted.workbench.page);
			page = await restarted.workbench.openAgentsWindow(target.kind);
			await showCode();
			await expect(page.locator(`[data-item="session:${folderUnselected}"]`).first()).toBeVisible();
			const backendAfter = await backendIdentity(restarted.application);
			expect(backendAfter.instanceId).not.toBe(backendBefore.instanceId);
			const after = await projectSnapshot();
			expect(after).toEqual(before);
			expect(await readUnselected()).toEqual(unselectedBefore);
			const sessionStatuses = await statuses(member, migration, archivedSelected, archivedUnselected, folderSelected, folderUnselected);
			expect(sessionStatuses).toEqual(['archived', 'active', 'archived', 'active', 'active', 'active']);
			const path = testInfo.outputPath('project-history-state.json');
			await writeFile(path, JSON.stringify({ version, backendBefore, backendAfter, faults, projects: after, sessionStatuses }, null, 2));
			await testInfo.attach('project-history-state', { path, contentType: 'application/json' });
		});
	} finally {
		await connection.close();
	}
});

test('Project archive and repair preserve a matching Session through SSH reconnect', { tag: ['@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	test.setTimeout(90_000);
	const packageRoot = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const ssh = await createSshFixture(join(packageRoot, 'bin/ash-app-server-daemon'));
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	let local: Awaited<ReturnType<typeof connectProfile>> | undefined;
	let remote: Awaited<ReturnType<typeof connectProfile>> | undefined;
	try {
		const root = await realpath(ssh.root);
		const localRoot = join(root, 'local-workspace');
		const remoteRoot = join(root, 'remote-workspace');
		await Promise.all([mkdir(localRoot), mkdir(remoteRoot)]);
		desktop = await launchElectron({
			appServerMode: 'required', userDataDirectory: join(root, 'desktop'), workspaceDirectory: localRoot, workspacePermissions: 'development',
			environment: { ...process.env, ASH_SSH_PATH: ssh.ssh, ASH_REMOTE_ASH_PATH: join(packageRoot, 'bin/ash-remote-server') },
		});
		const { workbench } = desktop.driver;
		local = await connectProfile(desktop.application, undefined, localRoot, workbench.page);
		remote = await connectProfile(desktop.application, undefined, remoteRoot, workbench.page, { profileRoot: join(root, 'remote-profile'), directoryGrantsHost: true });
		const grants = await remote.client.request(APP_SERVER_METHODS['config/directoryGrants/list'], {});
		await remote.client.request(APP_SERVER_METHODS['config/directoryGrants/set'], {
			commandId: randomUUID(), expectedRevision: grants.revision, path: remoteRoot,
			permissions: [...DEVELOPMENT_DIR_PERMISSIONS],
		});
		const commandId = randomUUID();
		const title = 'Same conversation on two hosts';
		const localSession = await createCodeSession(local.client, title, localRoot, commandId);
		const remoteSession = await createCodeSession(remote.client, title, remoteRoot, commandId);
		expect(remoteSession.sessionId).toBe(localSession.sessionId);
		const sessionId = localSession.sessionId;
		const { project } = await local.client.request(APP_SERVER_METHODS['project/create'], {
			commandId: randomUUID(), projectId: randomUUID(), name: 'Local project with an SSH collision', description: '', scope: 'code', materials: [],
		});
		await local.client.request(APP_SERVER_METHODS['project/session/link'], {
			commandId: randomUUID(), projectId: project.projectId, expectedRevision: project.revision, sessionId,
		});

		const name = 'project-recovery-ssh-fixture';
		const definition = { name, host: ssh.host, workspace: remoteRoot };
		await workbench.page.evaluate(connection => (globalThis as unknown as { ash: ISandboxGlobals; }).ash.ipcRenderer.invoke('ash:remote:connection:save', { connection }), definition);
		const fault = await installCatalogFault(desktop.application);
		const page = await workbench.openAgentsWindow('electron');
		await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
		await new QuickAccess(page).runCommand('sessions.action.manageAgentHosts');
		const hosts = page.getByRole('dialog', { name: 'Remote Environments' });
		await hosts.getByRole('button', { name: `Connect: ${name}`, exact: true }).click();
		await expect(hosts.getByRole('row').filter({ hasText: name })).toContainText('Connected', { timeout: 30_000 });
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		const remoteId = sessionIdentity(sshAgentHostProviderId(definition), sessionId, LOCAL_AGENT_HOST_PROVIDER_ID);
		const remoteRow = page.locator(`[data-item=${JSON.stringify(`session:${remoteId}`)}]`);
		await expect(remoteRow).toBeVisible();
		await expect(remoteRow).toContainText(title);
		await expect(page.locator(`[data-item="session:${sessionId}"][data-parent-project-id="${project.projectId}"]`)).toBeVisible();

		const localProject = async () => (await local!.client.request(APP_SERVER_METHODS['project/read'], { projectId: project.projectId })).project;
		const status = async (client: AppServerProtocolClient) => (await client.request(APP_SERVER_METHODS['session/list'], {})).sessions.find(item => item.sessionId === sessionId)?.status;
		const before = await localProject();
		await fault.arm({ method: 'session/list', kind: 'reject' });
		await archiveProject(page, project.name);
		await expect.poll(fault.read).toEqual({ interrupted: 1, state: 'ready' });
		await expect(page.getByText(`Could not finish archiving "${project.name}". Try again to continue.`, { exact: true }).first()).toBeVisible();
		expect(await localProject()).toEqual(before);
		expect(await status(local.client)).toBe('active');
		expect(await status(remote.client)).toBe('active');
		await expect(remoteRow).toBeVisible();

		await archiveProject(page, project.name);
		await expect.poll(async () => (await localProject()).status).toBe('archived');
		expect(await status(local.client)).toBe('archived');
		expect(await status(remote.client)).toBe('active');
		await expect(remoteRow).toBeVisible();

		await local.client.request(APP_SERVER_METHODS['session/request'], { commandId: randomUUID(), sessionId, request: { type: 'restore' } });
		const picker = new QuickAccess(page);
		await picker.runCommand('projects.repairArchived');
		const candidate = picker.items.filter({ hasText: title });
		await expect(candidate).toHaveCount(1);
		await picker.select(title);
		await page.keyboard.press('Enter');
		await expect.poll(() => status(local!.client)).toBe('archived');
		expect(await status(remote.client)).toBe('active');
		await expect(remoteRow).toBeVisible();

		const beforeDrop = ssh.connectionCount;
		ssh.disconnect();
		await expect.poll(() => ssh.connectionCount, { timeout: 30_000 }).toBeGreaterThan(beforeDrop);
		await new QuickAccess(page).runCommand('sessions.action.manageAgentHosts');
		await expect(hosts.getByRole('row').filter({ hasText: name })).toContainText('Connected', { timeout: 30_000 });
		await hosts.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(remoteRow).toBeVisible();
		expect(await status(remote.client)).toBe('active');
		expect(desktop.diagnostics.errors).toEqual([]);

		const path = testInfo.outputPath('ssh-session-isolation.json');
		await writeFile(path, JSON.stringify({
			sessionId, title, local: 'archived', ssh: 'active', fault: await fault.read(), sshReconnected: ssh.connectionCount > beforeDrop,
		}, null, 2));
		await testInfo.attach('ssh-session-isolation', { path, contentType: 'application/json' });
	} catch (error) {
		if (desktop) {
			await testInfo.attach('ssh-diagnostics', { body: JSON.stringify(desktop.diagnostics), contentType: 'application/json' });
		}
		throw error;
	} finally {
		try { await Promise.all([local?.close(), remote?.close()]); }
		finally {
			try { await desktop?.close(); }
			finally { await ssh.close(); }
		}
	}
});

async function createCodeSession(client: AppServerProtocolClient, title: string, folder: string, commandId = randomUUID()) {
	return (await client.request(APP_SERVER_METHODS['session/create'], {
		commandId, kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root: folder },
	})).session;
}

async function archiveProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name, exact: true }).press('Shift+F10');
	await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
	const confirmation = page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true });
	await expect(confirmation).toBeVisible();
	await confirmation.click();
}

// Fault only the local Agents carrier. Durable assertions use independent App Server connections.
async function installCatalogFault(application: ElectronApplication, initial?: CatalogInterruption) {
	await application.evaluate((_electron, { modulePath, initial }) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const { AppServerConnectionRelay: Relay } = require(modulePath) as { AppServerConnectionRelay: typeof AppServerConnectionRelay; };
		type RelayInternals = { attach(renderer: unknown, nonce: string, transport: ChildProcessJsonlTransport): void; };
		const prototype = Relay.prototype as unknown as RelayInternals;
		const attach = prototype.attach;
		let relay: AppServerConnectionRelay | undefined;
		let resume = Promise.withResolvers<void>();
		resume.resolve();
		const guarded = new WeakSet<object>();
		const probe: CatalogFault = {
			next: initial, interrupted: 0,
			state: () => relay?.state,
			release: () => resume.resolve(),
		};
		(globalThis as unknown as { catalogFault: CatalogFault; }).catalogFault = probe;
		prototype.attach = function (renderer, nonce, transport) {
			const current = this as unknown as AppServerConnectionRelay;
			if (current.options.enabled && 'environment' in current.options.processLauncher
				&& (current.options.processLauncher.environment as NodeJS.ProcessEnv).ASH_APP_SERVER_CONNECTION_ROLE === 'agents') {
				relay = current;
				const launcher = current.options.processLauncher;
				if (!guarded.has(launcher)) {
					guarded.add(launcher);
					const validate = launcher.validate.bind(launcher);
					launcher.validate = async () => { await resume.promise; await validate(); };
				}
				const send = transport.sendBytes.bind(transport);
				transport.sendBytes = async bytes => {
					const next = probe.next;
					if (next) {
						const request = JSON.parse(Buffer.from(bytes).toString());
						if (request.method === next.method) {
							probe.next = undefined;
							probe.interrupted++;
							if (next.kind === 'disconnect') {
								resume = Promise.withResolvers<void>();
								if (!transport.process.kill()) throw new Error('Could not terminate the fixture carrier');
							} else {
								// Keep the request ID and let the real backend return MethodNotFound.
								await send(Buffer.from(JSON.stringify({ ...request, method: 'fixture/rejectCatalog' }) + '\n'));
							}
							return;
						}
					}
					await send(bytes);
				};
			}
			attach.call(this, renderer, nonce, transport);
		};
	}, {
		initial,
		modulePath: resolve(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? '.', '.build/desktop/main/src/ash/platform/agentHost/electron-main/appServerConnectionRelay.js'),
	});
	return {
		read: () => application.evaluate(() => {
			const probe = (globalThis as unknown as { catalogFault: CatalogFault; }).catalogFault;
			return { interrupted: probe.interrupted, state: probe.state() };
		}),
		arm: (next: CatalogInterruption) => application.evaluate((_electron, next) => {
			(globalThis as unknown as { catalogFault: CatalogFault; }).catalogFault.next = next;
		}, next),
		release: () => application.evaluate(() => (globalThis as unknown as { catalogFault: CatalogFault; }).catalogFault.release()),
	};
}

async function backendIdentity(application: ElectronApplication): Promise<{ pid: number; instanceId: string; }> {
	const profile = await application.evaluate(() => process.env.ASH_HOME);
	if (!profile) throw new Error('Expected the isolated fixture profile');
	const runtime = developmentAshPackagePath(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve('.'));
	const daemon = join(runtime, 'bin', process.platform === 'win32' ? 'ash-app-server-daemon.exe' : 'ash-app-server-daemon');
	const { stdout } = await promisify(execFile)(daemon, ['diagnostic-target'], {
		env: { ...process.env, ASH_HOME: profile }, timeout: 5_000, windowsHide: true,
	});
	return JSON.parse(stdout);
}
