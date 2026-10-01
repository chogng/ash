import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';

test('Sessions shared layout preserves user geometry across pages, resize and reload', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) {
			throw new Error('Expected Electron windows');
		}
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	const sidebar = page.locator('[data-part="sidebar"]');
	const auxiliarybar = page.locator('[data-part="auxiliarybar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(sidebar).toBeVisible();
	await expect(auxiliarybar).toBeVisible();
	await page.setViewportSize({ width: 1_280, height: 900 });
	const sidebarBounds = (await sidebar.boundingBox())!;
	const sashes = page.locator('.ash-sessions-workbench-layout .ash-sash');
	const sidebarSashIndex = await sashes.evaluateAll((elements, edge) => elements.findIndex(element => {
		const bounds = element.getBoundingClientRect();
		return bounds.height > 200 && Math.abs(bounds.x + bounds.width / 2 - edge) < 8;
	}), sidebarBounds.x + sidebarBounds.width);
	expect(sidebarSashIndex).toBeGreaterThanOrEqual(0);
	const sash = (await sashes.nth(sidebarSashIndex).boundingBox())!;
	await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
	await page.mouse.down();
	await page.mouse.move(sash.x + sash.width / 2 + 40, sash.y + sash.height / 2, { steps: 5 });
	await page.mouse.up();
	await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(sidebarBounds.width + 20);
	const sidebarWidth = (await sidebar.boundingBox())!.width;
	const auxiliaryWidth = (await auxiliarybar.boundingBox())!.width;
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Retained Code draft');
	const input = await editor.input.elementHandle();
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await expect(auxiliarybar).toBeHidden();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(sidebar).toBeVisible();
	await expect(auxiliarybar).toBeVisible();
	await editor.waitForEditorContents(value => value === 'Retained Code draft');
	expect(await editor.input.evaluate((element, original) => element === original, input)).toBe(true);
	expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
	expect(Math.abs((await auxiliarybar.boundingBox())!.width - auxiliaryWidth)).toBeLessThanOrEqual(1);
	await page.setViewportSize({ width: 1_460, height: 900 });
	await expect.poll(async () => Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
	await titlebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(sidebar).toBeHidden();
	await expect(auxiliarybar).toBeVisible();
	await titlebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(sidebar).toBeVisible();
	expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
	expect(Math.abs((await auxiliarybar.boundingBox())!.width - auxiliaryWidth)).toBeLessThanOrEqual(1);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await editor.waitForEditorContents(value => value === 'Retained Code draft');
	await input?.dispose();
	expect(failures).toEqual([]);
});
