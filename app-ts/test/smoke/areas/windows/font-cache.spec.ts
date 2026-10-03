import type { ISerializedFontInfo } from '../../../../src/ash/editor/browser/config/fontMeasurements.js';
import { expect, test } from '../../../automation/test.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test('Workbench saves font metrics on reload and preserves restored data through shutdown', async ({ application, workbench, target }) => {
	const page = workbench.page;
	const identity = { applicationId: target.workbenchMode, scope: StorageScope.APPLICATION, id: 'application' };
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
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
	await expect.poll(async () => (await readStorageEntries(application, page, identity)).editorFontInfo).toEqual({ value: restored, target: 'machine' });
});

for (const invalid of ['{', '{"fonts":[]}']) {
	test(`Workbench discards malformed font cache ${invalid} and saves a fresh measurement`, async ({ application, workbench, target }) => {
		const page = workbench.page;
		const identity = { applicationId: target.workbenchMode, scope: StorageScope.APPLICATION, id: 'application' };
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
