import { Menus } from '../../../automation/menus.js';
import { expect, test } from '../../../automation/test.js';
import { Editor } from '../../../automation/editor.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test('Sessions content shares one raised card with equal right and bottom margins', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const card = page.locator('.ash-sessions-content-card');
	const sidebar = page.locator('[data-part="sidebar"]');
	const sessions = page.locator('[data-part="sessions"]');
	const activitybar = page.locator('[data-part="activitybar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute('aria-hidden', 'true');
	await expect(card).toHaveCSS('pointer-events', 'none');
	await expect(card).toHaveCSS('border-radius', '12px');
	// Chromium rounds strokes to device pixels at Windows display scaling.
	expect(await card.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderRightWidth)))).toBe(1);
	await expect(card).not.toHaveCSS('box-shadow', 'none');
	await expect(activitybar).toHaveCSS('border-width', '0px');
	await expect(activitybar).toHaveCSS('border-radius', '0px');
	await expect(activitybar).toHaveCSS('background-color', await titlebar.evaluate(element => getComputedStyle(element).backgroundColor));
	const accounts = navigation.getByRole('button', { name: 'Accounts', exact: true });
	const expectCardGeometry = async (): Promise<void> => {
		await expect.poll(() => page.evaluate(() => {
			const card = document.querySelector<HTMLElement>('.ash-sessions-content-card')!.getBoundingClientRect();
			const layout = document.querySelector<HTMLElement>('.ash-sessions-workbench-layout')!.getBoundingClientRect();
			const start = document.querySelector<HTMLElement>('.ash-sessions-frame-start')!.getBoundingClientRect();
			const end = document.querySelector<HTMLElement>('.ash-sessions-frame-end')!.getBoundingClientRect();
			const rail = document.querySelector<HTMLElement>('[data-part="activitybar"]')!.getBoundingClientRect();
			const menu = document.querySelector<HTMLElement>('.ash-sessions-titlebar-actions .ash-menubar-item')!.getBoundingClientRect();
			const controlsWidth = document.querySelector<HTMLElement>('.ash-sessions-window-controls-spacer')?.getBoundingClientRect().width ?? 0;
			const center = (layout.left + card.left) / 2;
			const buttonOffsets = [...document.querySelectorAll<HTMLElement>('.ash-sessions-activity-item')].map(button => {
				const bounds = button.getBoundingClientRect();
				return Math.abs(bounds.left + bounds.width / 2 - center);
			});
			return [layout.right - card.right, layout.bottom - card.bottom, card.left - start.left, card.right - end.right, card.bottom - start.bottom, card.bottom - end.bottom, rail.left - layout.left, Math.max(...buttonOffsets), menu.left + menu.width / 2 - controlsWidth - center].map(Math.round);
		})).toEqual([4, 4, 0, 0, 0, 0, 0, 0, 0]);
	};
	await expectCardGeometry();
	const menus = new Menus(page);
	const selectSize = (size: string): Promise<void> => menus.select(application, () => accounts.click({ button: 'right' }), ['Activity Bar Size', size]);
	await selectSize('Compact');
	await expect(navigation).toHaveClass(/compact/u);
	await expectCardGeometry();
	await selectSize('Default');
	await expect(navigation).not.toHaveClass(/compact/u);
	await expectCardGeometry();
	await expect(sidebar).toHaveCSS('border-top-left-radius', '12px');
	await expect(sessions).toHaveCSS('border-bottom-right-radius', '12px');
	await expect(sessions).toHaveCSS('border-right-width', '0px');
	await expect(page.locator('.ash-sessions-chat-slot:visible').last()).toHaveCSS('border-right-width', '0px');
	await page.locator('.ash-sessions-list-add').click();
	await expect(page.locator('.ash-sessions-chat-slot:visible')).toHaveCount(1);
	await expect.poll(async () => {
		const part = (await sessions.boundingBox())!;
		const pane = (await page.locator('.ash-sessions-chat-slot:visible').boundingBox())!;
		return [pane.x - part.x, pane.width - part.width].map(Math.round);
	}).toEqual([0, 0]);
	await expect(page.locator('.ash-sessions-chat-slot:visible').last()).toHaveCSS('border-right-width', '0px');
	await titlebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(sessions).toHaveCSS('border-top-left-radius', '12px');
	await expectCardGeometry();
	await page.setViewportSize({ width: 900, height: 700 });
	await expectCardGeometry();
	await titlebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeVisible();
	// Code Details shares the editor's outer frame and keeps its own content below the tabs.
	await expect(page.locator('[data-part="editor"]')).toHaveClass(/ash-sessions-frame-end/u);
	await expect(page.locator('[data-part="editor"]')).toHaveCSS('border-bottom-right-radius', '12px');
	await expectCardGeometry();
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	await expect(sidebar).toBeVisible();
	await expect(sidebar).toHaveCSS('border-top-left-radius', '12px');
	await expect(sessions).toHaveCSS('border-bottom-right-radius', '12px');
	await expectCardGeometry();
});

test('Sessions shared layout preserves user geometry across views, resize and reload', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	const sidebar = page.locator('[data-part="sidebar"]');
	const auxiliarybar = page.locator('[data-part="auxiliarybar"]');
	const titlebar = page.locator('[data-part="titlebar"]');
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(sidebar).toBeVisible();
	await expect(auxiliarybar).toBeHidden();
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
	await expect.poll(async () => {
		const part = (await page.locator('[data-part="sessions"]').boundingBox())!;
		const pane = (await page.locator('.ash-sessions-chat-slot:visible').boundingBox())!;
		return Math.abs(pane.width - part.width);
	}).toBeLessThanOrEqual(1);
	const sidebarWidth = (await sidebar.boundingBox())!.width;
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(auxiliarybar).toBeVisible();
	const auxiliaryWidth = (await auxiliarybar.boundingBox())!.width;
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Retained Code draft');
	const input = await editor.input.elementHandle();
	await navigation.getByRole('button', { name: 'Collaboration', exact: true }).click();
	await expect(sidebar).toBeVisible();
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
	await expect(sidebar).toBeVisible();
	await expect(sidebar.getByRole('navigation', { name: 'Library categories' })).toBeVisible();
	await expect(auxiliarybar).toBeVisible();
	// Each mode keeps its visibility preference; returning to Code restores its hidden sidebar.
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await titlebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(sidebar).toBeVisible();
	expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
	await expect(auxiliarybar).toBeVisible();
	expect(Math.abs((await auxiliarybar.boundingBox())!.width - auxiliaryWidth)).toBeLessThanOrEqual(1);
	await editor.waitForEditorContents(value => value === 'Retained Code draft');
	await input?.dispose();
	expect(failures).toEqual([]);
});

test('Sessions merges legacy pane arrangements and retains shared selections and drafts after reload', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	await page.setViewportSize({ width: 1_900, height: 950 });
	const navigation = page.locator('.ash-sessions-activity-content');
	const panes = page.locator('.ash-sessions-chat-view:visible .ash-sessions-chat-slot');
	const add = page.locator('.ash-sessions-list-controls').getByRole('button', { name: 'New Session', exact: true });
	const typeDraft = async (text: string): Promise<void> => {
		const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor(text);
	};
	const drag = async (delta: number): Promise<void> => {
		const sash = (await page.locator('.ash-sessions-chat-view:visible .ash-sash').first().boundingBox())!;
		await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
		await page.mouse.down();
		await page.mouse.move(sash.x + sash.width / 2 + delta, sash.y + sash.height / 2, { steps: 5 });
		await page.mouse.up();
	};
	const snapshot = async (): Promise<{ identity: string | undefined; active: boolean; text: string; width: number }[]> => panes.evaluateAll(elements => elements.map(element => {
		const chat = element.querySelector<HTMLElement>('.ash-chat')!;
		return {
			identity: chat.dataset.untitledSessionId ?? chat.dataset.sessionId,
			active: element.classList.contains('active'),
			text: [...element.querySelectorAll('.view-lines > .view-line .stanza-editor-line-text')].map(line => line.textContent).join('\n').replace(/\u00a0/g, ' '),
			width: element.getBoundingClientRect().width,
		};
	}));
	const draftReference = async (): Promise<{ kind: 'untitled'; session: { untitledSessionId: string; title: string; workspace: { type: 'current' } } }> => ({
		kind: 'untitled',
		session: { untitledSessionId: (await panes.locator('.ash-chat').getAttribute('data-untitled-session-id'))!, title: 'New session', workspace: { type: 'current' } },
	});
	await typeDraft('Chat first draft');
	const chatReferences = [await draftReference()];
	await add.click();
	await expect(panes).toHaveCount(1);
	await typeDraft('Chat second draft');
	chatReferences.push(await draftReference());
	await add.click();
	await expect(panes).toHaveCount(1);
	await typeDraft('Chat third draft');
	chatReferences.push(await draftReference());
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await add.click();
	await typeDraft('Code first draft');
	const codeReferences = [await draftReference()];
	await add.click();
	await expect(panes).toHaveCount(1);
	await typeDraft('Code second draft');
	codeReferences.push(await draftReference());
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	// Restore an existing split arrangement; Add is ordinary navigation, not a split command.
	const identity = { scope: StorageScope.WORKSPACE, id: 'sessions' };
	await expect.poll(async () => Boolean((await readStorageEntries(application, page, identity))['sessions.viewState'])).toBe(true);
	await seedStorageOnNextLoad(application, page, identity, {
		'sessions.viewState': { value: JSON.stringify({ version: 1, pages: { chat: { visible: chatReferences, active: 0 }, code: { visible: codeReferences, active: 1 } } }), target: StorageTarget.MACHINE },
		'sessions.gridState': null,
		'sessions.gridState.chat': null,
		'sessions.gridState.code': null,
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await navigation.getByRole('button', { name: /^Chat(?:\.|$)/u }).click();
	await expect(panes).toHaveCount(5);
	await panes.first().locator('.ash-sessions-chat-slot-title').click();
	const beforeDrag = (await panes.first().boundingBox())!.width;
	await drag(-80);
	await expect.poll(async () => Math.round((await panes.first().boundingBox())!.width)).toBe(Math.round(Math.max(300, beforeDrag - 80)));
	const shared = await snapshot();
	expect(shared.map(slot => slot.text)).toEqual(['Chat first draft', 'Chat second draft', 'Chat third draft', 'Code first draft', 'Code second draft']);
	const identities = shared.map(({ width, ...state }) => state);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panes).toHaveCount(5);
	await expect.poll(async () => (await snapshot()).map(({ width, ...state }) => state)).toEqual(identities);
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	for (let index = 0; index < shared.length; index++) {
		await expect.poll(async () => Math.abs((await panes.nth(index).boundingBox())!.width - shared[index]!.width)).toBeLessThanOrEqual(1);
	}
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(panes).toHaveCount(5);
	await expect.poll(async () => (await snapshot()).map(({ width, ...state }) => state)).toEqual(identities);
	for (let index = 0; index < shared.length; index++) {
		await expect.poll(async () => Math.abs((await panes.nth(index).boundingBox())!.width - shared[index]!.width)).toBeLessThanOrEqual(1);
	}
	await panes.first().locator('.ash-sessions-chat-slot-close').click();
	await expect(panes).toHaveCount(4);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(panes).toHaveCount(4);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panes).toHaveCount(4);
	await expect.poll(async () => {
		const entries = await readStorageEntries(application, page, identity);
		return {
			removed: Boolean(entries[`sessions.inputDraft:untitled:${shared[0]!.identity}`]),
			retained: Boolean(entries[`sessions.inputDraft:untitled:${shared[4]!.identity}`]),
		};
	}).toEqual({ removed: false, retained: true });
	// Normal list navigation exits the split and selects one retained draft in every layout.
	const selected = (await snapshot()).find(slot => slot.active)!;
	await page.locator('.ash-sessions-list-item[aria-current="page"]').click();
	await expect(panes).toHaveCount(1);
	await expect(panes.locator('.ash-chat')).toHaveAttribute('data-untitled-session-id', selected.identity!);
	await new Editor(panes.first()).waitForEditorContents(text => text === selected.text);
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(panes).toHaveCount(1);
	await new Editor(panes.first()).waitForEditorContents(text => text === selected.text);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(panes).toHaveCount(1);
	await expect(panes.locator('.ash-chat')).toHaveAttribute('data-untitled-session-id', selected.identity!);
	expect(failures).toEqual([]);
});
