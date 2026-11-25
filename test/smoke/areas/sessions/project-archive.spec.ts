import type { ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APP_SERVER_METHODS } from '../../../../.build/protocol/typescript/index.js';
import type { AppServerConnectionRelay } from '../../../../src/ash/platform/agentHost/electron-main/appServerConnectionRelay.js';
import type { ChildProcessJsonlTransport } from '../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js';
import { expect, test } from '../../../automation/test.js';
import { connectProfile } from './sessionProfileFixture.js';

test('Project archive runs member archives concurrently and retries a partial failure', { tag: '@electron-app-server' }, async ({ application, target, testWorkspace, workbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron');
	const root = await realpath(testWorkspace.directory);
	const { client, close } = await connectProfile(application, undefined, root, workbench.page);
	try {
		const createSession = async (title: string) => (await client.request(APP_SERVER_METHODS['session/create'], {
			commandId: randomUUID(), kind: 'code', title, agent: { type: 'default' }, executionTarget: { type: 'local', root },
		})).session.sessionId;
		const { project } = await client.request(APP_SERVER_METHODS['project/create'], {
			commandId: randomUUID(), projectId: randomUUID(), name: 'Archive test project', description: '', scope: 'code', materials: [],
		});
		const member = await createSession('Member to retry');
		const sibling = await createSession('Member that succeeds');
		const unrelated = await createSession('Outside the project');
		const readProject = async () => (await client.request(APP_SERVER_METHODS['project/read'], { projectId: project.projectId })).project;
		for (const sessionId of [member, sibling]) {
			await client.request(APP_SERVER_METHODS['project/session/link'], {
				commandId: randomUUID(), projectId: project.projectId, sessionId, expectedRevision: (await readProject()).revision,
			});
		}
		const statuses = async () => {
			const { sessions } = await client.request(APP_SERVER_METHODS['session/list'], {});
			return [member, sibling, unrelated].map(id => sessions.find(session => session.sessionId === id)?.status);
		};

		const probe = await holdArchives(application, [member, sibling]);
		try {
			const page = await workbench.openAgentsWindow(target.kind);
			await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
			const archiveProject = async () => {
				await page.getByRole('button', { name: project.name, exact: true }).press('Shift+F10');
				await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
				await page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }).click();
			};
			await archiveProject();
			await expect.poll(probe.started).toEqual([member, sibling].sort());
			expect(await statuses()).toEqual(['active', 'active', 'active']);
			await probe.release(sibling, true);
			await expect.poll(statuses).toEqual(['active', 'archived', 'active']);
			expect((await readProject()).status).toBe('active');

			await probe.release(member, false);
			await expect(page.getByText('Could not finish archiving "Archive test project". Try again to continue.', { exact: true }).first()).toBeVisible();
			expect((await readProject()).status).toBe('active');
			await archiveProject();
			await expect.poll(async () => (await readProject()).status).toBe('archived');
			expect(await statuses()).toEqual(['archived', 'archived', 'active']);
		} finally {
			await probe.release(member, false);
			await probe.release(sibling, false);
		}
	} finally {
		await close();
	}
});

type ArchiveProbe = {
	readonly pending: Map<string, PromiseWithResolvers<boolean>>;
	readonly started: string[];
};

// Hold the selected requests on the Agents connection. The fixture connection reads durable state independently.
async function holdArchives(application: ElectronApplication, sessionIds: string[]) {
	await application.evaluate((_electron, { modulePath, sessionIds }) => {
		const require = process.getBuiltinModule('module').createRequire(process.execPath);
		const { AppServerConnectionRelay: Relay } = require(modulePath) as { AppServerConnectionRelay: typeof AppServerConnectionRelay; };
		type RelayInternals = { attach(renderer: unknown, nonce: string, transport: ChildProcessJsonlTransport): void; };
		const prototype = Relay.prototype as unknown as RelayInternals;
		const attach = prototype.attach;
		const probe: ArchiveProbe = { pending: new Map(sessionIds.map(id => [id, Promise.withResolvers<boolean>()])), started: [] };
		(globalThis as unknown as { projectArchiveProbe: ArchiveProbe; }).projectArchiveProbe = probe;
		prototype.attach = function (renderer, nonce, transport) {
			const { options } = this as unknown as AppServerConnectionRelay;
			if (options.enabled && 'environment' in options.processLauncher
				&& (options.processLauncher.environment as NodeJS.ProcessEnv).ASH_APP_SERVER_CONNECTION_ROLE === 'agents') {
				const send = transport.sendBytes.bind(transport);
				transport.sendBytes = async bytes => {
					if (!probe.pending.size) return send(bytes);
					const request = JSON.parse(Buffer.from(bytes).toString());
					if (request.method !== 'session/request' || request.params?.request?.type !== 'archive') return send(bytes);
					const gate = probe.pending.get(request.params.sessionId);
					if (!gate) return send(bytes);
					probe.started.push(request.params.sessionId);
					if (await gate.promise) return send(bytes);
					// Keep the request ID so the real App Server returns a rejection for this archive.
					await send(Buffer.from(JSON.stringify({ ...request, method: 'fixture/rejectArchive' }) + '\n'));
				};
			}
			attach.call(this, renderer, nonce, transport);
		};
	}, {
		sessionIds,
		modulePath: resolve(process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? '.', '.build/desktop/main/src/ash/platform/agentHost/electron-main/appServerConnectionRelay.js'),
	});
	return {
		started: () => application.evaluate(() => (globalThis as unknown as { projectArchiveProbe: ArchiveProbe; }).projectArchiveProbe.started.slice().sort()),
		release: (id: string, succeed: boolean) => application.evaluate((_electron, { id, succeed }) => {
			const { pending } = (globalThis as unknown as { projectArchiveProbe: ArchiveProbe; }).projectArchiveProbe;
			pending.get(id)?.resolve(succeed);
			pending.delete(id);
		}, { id, succeed }),
	};
}
