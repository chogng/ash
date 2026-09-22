import type { Page } from '@playwright/test';
import type { ISerializedFontInfo } from '../../../../src/ash/editor/browser/config/fontMeasurements.js';
import { expect, test } from '../../../automation/test.js';

interface FontCacheEntry {
	readonly value: string;
	readonly target: string;
}

async function readFontCache(page: Page, key: string): Promise<FontCacheEntry | undefined> {
	return page.evaluate(key => {
		const document = JSON.parse(localStorage.getItem(key) ?? '{"entries":{}}');
		return document.entries.editorFontInfo;
	}, key);
}

test('Workbench saves font metrics on reload and preserves restored data through shutdown', async ({ workbench, target }) => {
	const page = workbench.page;
	const key = `ash.${target.workbenchMode}.storage.application`;
	await page.reload();
	await workbench.waitForReady();
	const saved = await readFontCache(page, key);
	expect(saved?.target).toBe('machine');
	const fonts = JSON.parse(saved!.value) as ISerializedFontInfo[];
	expect(fonts.length).toBeGreaterThan(0);
	expect(fonts.every(font => font.typicalHalfwidthCharacterWidth > 2)).toBe(true);
	const restored = JSON.stringify(fonts.map(font => ({
		...font, typicalHalfwidthCharacterWidth: font.typicalHalfwidthCharacterWidth + 1,
	})));
	await page.addInitScript(({ key, restored }) => {
		const document = JSON.parse(localStorage.getItem(key)!);
		document.entries.editorFontInfo = { value: restored, target: 'machine' };
		localStorage.setItem(key, JSON.stringify(document));
	}, { key, restored });
	await page.reload();
	await workbench.waitForReady();
	await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
	await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
	expect(await readFontCache(page, key)).toEqual({ value: restored, target: 'machine' });
});

for (const invalid of ['{', '{"fonts":[]}']) {
	test(`Workbench discards malformed font cache ${invalid} and saves a fresh measurement`, async ({ workbench, target }) => {
		const page = workbench.page;
		const key = `ash.${target.workbenchMode}.storage.application`;
		await page.addInitScript(({ key, invalid }) => {
			const document = JSON.parse(localStorage.getItem(key) ?? '{"version":1,"entries":{}}');
			document.entries.editorFontInfo = { value: invalid, target: 'machine' };
			localStorage.setItem(key, JSON.stringify(document));
		}, { key, invalid });
		await page.reload();
		await workbench.waitForReady();
		await expect.poll(async () => (await readFontCache(page, key))?.value).toBeDefined();
		const saved = await readFontCache(page, key);
		const fonts = JSON.parse(saved!.value) as ISerializedFontInfo[];
		expect(saved!.target).toBe('machine');
		expect(fonts.length).toBeGreaterThan(0);
		expect(fonts.every(font => font.version === 2 && Number.isFinite(font.typicalHalfwidthCharacterWidth) && font.typicalHalfwidthCharacterWidth > 2)).toBe(true);
	});
}
