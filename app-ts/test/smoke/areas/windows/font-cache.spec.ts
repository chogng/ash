import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import type { IStorageSnapshot } from '../../../../src/ash/platform/storage/common/storageIpc.js';
import type { ISerializedFontInfo } from '../../../../src/ash/editor/browser/config/fontMeasurements.js';
import { expect, test } from '../../../automation/test.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test.use({ openWorkspace: false });

test('Workbench saves font metrics on reload and preserves restored data through shutdown', async ({ application, workbench, reloadWorkbench }) => {
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
	const restored = JSON.stringify(fonts.map(font => ({
		...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1,
	})));
	await seedStorageOnNextLoad(application, page, identity, { editorFontInfo: { value: restored, target: StorageTarget.MACHINE } });
	await page.reload();
	await workbench.waitForReady();
	const reloaded = await reloadWorkbench();
	await expect.poll(async () => (await readStorageEntries(reloaded.application, reloaded.workbench.page, identity)).editorFontInfo).toEqual({ value: restored, target: 'machine' });
});

for (const invalid of ['{', '{"fonts":[]}']) {
	test(`Workbench discards malformed font cache ${invalid} and saves a fresh measurement`, async ({ application, workbench }) => {
		const page = workbench.page;
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		const identity = { scope: StorageScope.APPLICATION, id: 'application' };
		await seedStorageOnNextLoad(application, page, identity, { editorFontInfo: { value: invalid, target: StorageTarget.MACHINE } });
		await page.reload();
		await workbench.waitForReady();
		await expect.poll(async () => {
			const saved = (await readStorageEntries(application, page, identity)).editorFontInfo;
			return saved?.value !== invalid && saved?.value !== undefined;
		}).toBe(true);
		const saved = (await readStorageEntries(application, page, identity)).editorFontInfo;
		const fonts = JSON.parse(saved!.value) as ISerializedFontInfo[];
		expect(saved!.target).toBe('machine');
		expect(fonts.length).toBeGreaterThan(0);
		expect(fonts.every(font => font.version === 2 && Number.isFinite(font.typicalHalfwidthCharacterWidth) && font.typicalHalfwidthCharacterWidth > 2)).toBe(true);
	});
}


test('Browser migrates retired storage before restoring font metrics', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'browser', 'Browser namespace migration uses localStorage.');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const identity = { scope: StorageScope.APPLICATION, id: 'application' };
	await page.reload();
	await workbench.waitForReady();
	const fonts = JSON.parse((await readStorageEntries(application, page, identity)).editorFontInfo!.value) as ISerializedFontInfo[];
	const value = JSON.stringify(fonts.map(font => ({ ...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1 })));
	await page.addInitScript(value => {
		if (sessionStorage.getItem('storage-migration-seeded')) { return; }
		localStorage.removeItem('ash.storage.application');
		localStorage.setItem('ash.code.storage.application', JSON.stringify({ version: 1, entries: { editorFontInfo: { value, target: 'machine' } } }));
		localStorage.setItem('ash.academic.storage.application', JSON.stringify({ version: 1, entries: { editorFontInfo: { value: 'conflicting-font-cache', target: 'machine' }, academicSaved: { value: 'retained', target: 'user' } } }));
		sessionStorage.setItem('storage-migration-seeded', 'true');
	}, value);
	await page.reload();
	await workbench.waitForReady();
	expect(await readStorageEntries(application, page, identity)).toMatchObject({ editorFontInfo: { value, target: 'machine' }, academicSaved: { value: 'retained', target: 'user' } });
	expect(await page.evaluate(() => [localStorage.getItem('ash.code.storage.application'), localStorage.getItem('ash.academic.storage.application')])).toEqual([null, null]);
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ash.storage.v1.academic.application')!).entries.editorFontInfo.value)).toBe('conflicting-font-cache');
	await page.reload();
	await workbench.waitForReady();
	expect((await readStorageEntries(application, page, identity)).editorFontInfo).toEqual({ value, target: 'machine' });
});

test('Desktop migrates retired storage and restores Workbench fonts and Sessions layout after restart', async ({ target }, testInfo) => {
	test.skip(target.kind !== 'electron', 'Desktop migration is owned by the Main process.');
	test.setTimeout(90_000);
	const userDataDirectory = testInfo.outputPath('storage-profile');
	await mkdir(userDataDirectory, { recursive: true });
	const options = { userDataDirectory, appServerMode: target.appServerMode };
	let session = await launchElectron(options);
	try {
		const agents = await session.driver.workbench.openAgentsWindow('electron');
		await agents.locator('.ash-sessions-titlebar-actions').getByRole('button', { name: 'Hide sidebar', exact: true }).click();
		await expect(agents.locator('[data-part="sidebar"]')).toBeHidden();
		await session.quit();
		const file = join(userDataDirectory, 'workbench-state.json');
		const document = JSON.parse(await readFile(file, 'utf8')) as { version: number; storages: IStorageSnapshot[] };
		const application = document.storages.find(storage => storage.identity.scope === StorageScope.APPLICATION)!;
		const fonts = JSON.parse(application.entries.editorFontInfo!.value) as ISerializedFontInfo[];
		const value = JSON.stringify(fonts.map(font => ({ ...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1 })));
		const storages = document.storages.map(snapshot => ({ ...snapshot, identity: { ...snapshot.identity, applicationId: 'code' } }));
		const index = storages.findIndex(storage => storage.identity.scope === StorageScope.APPLICATION);
		storages[index] = { ...storages[index]!, entries: { ...application.entries, editorFontInfo: { value, target: StorageTarget.MACHINE } } };
		// Academic comes first to prove file order does not decide collision ownership.
		storages.unshift({ ...application, identity: { ...application.identity, applicationId: 'academic' }, entries: { editorFontInfo: { value: 'academic-font-cache', target: StorageTarget.MACHINE }, academicSaved: { value: 'retained', target: StorageTarget.USER } } });
		const source = JSON.stringify({ version: 1, storages });
		await writeFile(file, source);
		session = await launchElectron(options);
		await expect.poll(async () => (await readStorageEntries(session.application, session.driver.workbench.page, { scope: StorageScope.APPLICATION, id: 'application' })).editorFontInfo).toEqual({ value, target: 'machine' });
		const restoredAgents = await session.driver.workbench.openAgentsWindow('electron');
		await expect(restoredAgents.locator('[data-part="sidebar"]')).toBeHidden();
		const migrated = JSON.parse(await readFile(file, 'utf8')) as { version: number; storages: IStorageSnapshot[] };
		expect(migrated.version).toBe(2);
		expect(migrated.storages.every(snapshot => !('applicationId' in snapshot.identity))).toBe(true);
		expect((await readStorageEntries(session.application, session.driver.workbench.page, { scope: StorageScope.APPLICATION, id: 'application' })).academicSaved).toEqual({ value: 'retained', target: 'user' });
		expect(await readFile(`${file}.v1`, 'utf8')).toBe(source);
		expect(session.diagnostics.errors).toEqual([]);
	} finally { await session.close(); }
});
