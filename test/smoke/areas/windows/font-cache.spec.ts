import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import type { IStorageSnapshot } from '../../../../src/ash/platform/storage/common/storageIpc.js';
import type { ISerializedFontInfo } from '../../../../src/ash/editor/browser/config/fontMeasurements.js';
import { expect, test } from '../../../automation/test.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test.use({ openWorkspace: false });

test('Workbench saves font metrics through shutdown and replaces a corrupt persisted cache', async ({
	application,
	workbench,
	reloadWorkbench,
}) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const identity = { scope: StorageScope.APPLICATION, id: 'application' };
	await page.reload();
	await workbench.waitForReady();
	const saved = (await readStorageEntries(application, page, identity)).editorFontInfo;
	expect(saved?.target).toBe('machine');
	const fonts = JSON.parse(saved!.value) as ISerializedFontInfo[];
	expect(fonts.length).toBeGreaterThan(0);
	expect(fonts.every(font => font.typicalHalfwidthCharacterWidth > 2)).toBe(true);
	const restored = JSON.stringify(
		fonts.map(font => ({ ...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1 })),
	);
	await seedStorageOnNextLoad(application, page, identity, {
		editorFontInfo: { value: restored, target: StorageTarget.MACHINE },
	});
	await page.reload();
	await workbench.waitForReady();
	const reloaded = await reloadWorkbench();
	await expect
		.poll(
			async () =>
				(await readStorageEntries(reloaded.application, reloaded.workbench.page, identity)).editorFontInfo,
		)
		.toEqual({ value: restored, target: 'machine' });
	const active = reloaded.workbench;
	await seedStorageOnNextLoad(reloaded.application, active.page, identity, {
		editorFontInfo: { value: '{', target: StorageTarget.MACHINE },
	});
	await active.page.reload();
	await active.waitForReady();
	await expect
		.poll(async () => {
			const saved = (await readStorageEntries(reloaded.application, active.page, identity)).editorFontInfo;
			return saved?.value !== '{' && saved?.value !== undefined;
		})
		.toBe(true);
	const fresh = (await readStorageEntries(reloaded.application, active.page, identity)).editorFontInfo!;
	expect(fresh.target).toBe('machine');
	const measured = JSON.parse(fresh.value) as ISerializedFontInfo[];
	expect(measured.length).toBeGreaterThan(0);
	expect(
		measured.every(
			font =>
				font.version === 2 &&
				Number.isFinite(font.typicalHalfwidthCharacterWidth) &&
				font.typicalHalfwidthCharacterWidth > 2,
		),
	).toBe(true);
});

test(
	'Browser migrates retired storage before restoring font metrics',
	{ tag: ['@browser-ui', '@browser-app-server'] },
	async ({ application, workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		const identity = { scope: StorageScope.APPLICATION, id: 'application' };
		await page.reload();
		await workbench.waitForReady();
		const fonts = JSON.parse(
			(await readStorageEntries(application, page, identity)).editorFontInfo!.value,
		) as ISerializedFontInfo[];
		const value = JSON.stringify(
			fonts.map(font => ({ ...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1 })),
		);
		await page.addInitScript(value => {
			if (sessionStorage.getItem('storage-migration-seeded')) {
				return;
			}
			localStorage.setItem(
				'ash.storage.application',
				JSON.stringify({ version: 1, entries: { editorFontInfo: { value, target: 'machine' } } }),
			);
			localStorage.setItem(
				'ash.code.storage.application',
				JSON.stringify({
					version: 1,
					entries: {
						editorFontInfo: { value: 'conflicting-font-cache', target: 'machine' },
						savedPreference: { value: 'retained', target: 'user' },
					},
				}),
			);
			sessionStorage.setItem('storage-migration-seeded', 'true');
		}, value);
		await page.reload();
		await workbench.waitForReady();
		expect(await readStorageEntries(application, page, identity)).toMatchObject({
			editorFontInfo: { value, target: 'machine' },
			savedPreference: { value: 'retained', target: 'user' },
		});
		expect(await page.evaluate(() => localStorage.getItem('ash.code.storage.application'))).toBeNull();
		expect(
			await page.evaluate(
				() => JSON.parse(localStorage.getItem('ash.storage.v1.code.application')!).entries.editorFontInfo.value,
			),
		).toBe('conflicting-font-cache');
		await page.reload();
		await workbench.waitForReady();
		expect((await readStorageEntries(application, page, identity)).editorFontInfo).toEqual({
			value,
			target: 'machine',
		});
	},
);

for (const restoreAgents of [false, true]) {
	test(
		`Desktop migrates retired storage and preserves Workbench fonts and Sessions layout through immediate exit and restart (auto-restore Agents: ${restoreAgents})`,
		{ tag: ['@electron-ui', '@electron-app-server'] },
		async ({ target }, testInfo) => {
			test.setTimeout(120_000);
			// Keep the managed server's local socket below the host path-length limit.
			const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
			const options = { userDataDirectory, appServerMode: target.appServerMode };
			let session: Awaited<ReturnType<typeof launchElectron>> | undefined;
			try {
				session = await launchElectron(options);
				const agents = await session.driver.workbench.openAgentsWindow('electron');
				await agents
					.locator('.ash-sessions-titlebar-actions')
					.getByRole('button', { name: 'Hide sidebar', exact: true })
					.click();
				await expect(agents.locator('[data-part="sidebar"]')).toBeHidden();
				if (!restoreAgents) {
					// Exercise the single-window migration separately from concurrent Sessions startup.
					const agentsWindow = await session.application.browserWindow(agents);
					const agentsClosed = agents.waitForEvent('close');
					try {
						await agentsWindow.evaluate(window => window.close());
						await agentsClosed;
					} finally {
						await agentsWindow.dispose();
					}
				}
				await session.quit();
				await testInfo.attach('setup-diagnostics', {
					body: JSON.stringify({
						pageErrors: session.diagnostics.pageErrors,
						consoleErrors: session.diagnostics.consoleErrors,
					}),
					contentType: 'application/json',
				});
				expect(session.diagnostics.errors).toEqual([]);
				const file = join(userDataDirectory, 'workbench-state.json');
				const document = JSON.parse(await readFile(file, 'utf8')) as {
					version: number;
					storages: IStorageSnapshot[];
				};
				const application = document.storages.find(
					storage => storage.identity.scope === StorageScope.APPLICATION,
				)!;
				const fonts = JSON.parse(application.entries.editorFontInfo!.value) as ISerializedFontInfo[];
				const value = JSON.stringify(
					fonts.map(font => ({
						...font,
						typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1,
					})),
				);
				const storages = document.storages.map(snapshot => ({
					...snapshot,
					identity: { ...snapshot.identity, applicationId: 'code' },
				}));
				const index = storages.findIndex(storage => storage.identity.scope === StorageScope.APPLICATION);
				storages[index] = {
					...storages[index]!,
					entries: {
						...application.entries,
						editorFontInfo: { value, target: StorageTarget.MACHINE },
						savedPreference: { value: 'retained', target: StorageTarget.USER },
					},
				};
				const source = JSON.stringify({ version: 1, storages });
				await writeFile(file, source);
				session = await launchElectron(options);
				// Quit at the first ready boundary, before opening another window or requesting storage.
				if (!restoreAgents) {
					expect(session.application.windows()).toHaveLength(1);
				}
				await session.quit();
				await testInfo.attach('immediate-quit-diagnostics', {
					body: JSON.stringify({
						pageErrors: session.diagnostics.pageErrors,
						consoleErrors: session.diagnostics.consoleErrors,
					}),
					contentType: 'application/json',
				});
				const closedDocument = JSON.parse(await readFile(file, 'utf8')) as {
					version: number;
					storages: IStorageSnapshot[];
				};
				expect(closedDocument.version).toBe(2);
				expect(
					closedDocument.storages.find(snapshot => snapshot.identity.scope === StorageScope.APPLICATION)
						?.entries.savedPreference,
				).toEqual({ value: 'retained', target: StorageTarget.USER });
				expect(await readFile(`${file}.v1`, 'utf8')).toBe(source);
				expect(session.diagnostics.errors).toEqual([]);
				session = await launchElectron(options);
				const restored = session;
				await expect
					.poll(
						async () =>
							(
								await readStorageEntries(restored.application, restored.driver.workbench.page, {
									scope: StorageScope.APPLICATION,
									id: 'application',
								})
							).editorFontInfo,
					)
					.toEqual({ value, target: 'machine' });
				if (restoreAgents) {
					await expect
						.poll(() =>
							restored.application
								.windows()
								.some(page => /\/sessions\.html(?:[?#].*)?$/u.test(page.url())),
						)
						.toBe(true);
				}
				const restoredAgents = restoreAgents
					? session.application.windows().find(page => /\/sessions\.html(?:[?#].*)?$/u.test(page.url()))!
					: await session.driver.workbench.openAgentsWindow('electron');
				await expect(restoredAgents.locator('.ash-sessions-window')).toHaveAttribute('aria-busy', 'false');
				await expect(restoredAgents.locator('[data-part="sidebar"]')).toBeHidden();
				const migrated = JSON.parse(await readFile(file, 'utf8')) as {
					version: number;
					storages: IStorageSnapshot[];
				};
				expect(migrated.version).toBe(2);
				expect(migrated.storages.every(snapshot => !('applicationId' in snapshot.identity))).toBe(true);
				expect(
					(
						await readStorageEntries(session.application, session.driver.workbench.page, {
							scope: StorageScope.APPLICATION,
							id: 'application',
						})
					).savedPreference,
				).toEqual({ value: 'retained', target: 'user' });
				expect(await readFile(`${file}.v1`, 'utf8')).toBe(source);
				await session.quit();
				await testInfo.attach('restart-diagnostics', {
					body: JSON.stringify({
						pageErrors: session.diagnostics.pageErrors,
						consoleErrors: session.diagnostics.consoleErrors,
					}),
					contentType: 'application/json',
				});
				expect(session.diagnostics.errors).toEqual([]);
			} finally {
				try {
					await session?.close();
				} finally {
					try {
						await cp(userDataDirectory, testInfo.outputPath('storage-profile'), { recursive: true });
					} finally {
						await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
					}
				}
			}
		},
	);
}
