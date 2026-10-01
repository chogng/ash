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
	const sidebarWidth = (await sidebar.boundingBox())!.width;
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(auxiliarybar).toBeVisible();
	const auxiliaryWidth = (await auxiliarybar.boundingBox())!.width;
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
	await expect(auxiliarybar).toBeHidden();
	await titlebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(sidebar).toBeVisible();
	expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(auxiliarybar).toBeVisible();
	expect(Math.abs((await auxiliarybar.boundingBox())!.width - auxiliaryWidth)).toBeLessThanOrEqual(1);
	await editor.waitForEditorContents(value => value === 'Retained Code draft');
	await input?.dispose();
	expect(failures).toEqual([]);
});

test('Sessions restores independent pane arrangements, active selections and drafts after reload', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code');
	let page = workbench.page;
	if (target.kind === 'browser') {
		await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	} else {
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const opened = application.waitForEvent('window');
		await page.locator('[data-action-id="workbench.action.chat.openAgentsWindow.titleBar"] button').click();
		page = await opened;
	}
	const failures: string[] = [];
	page.on('pageerror', error => failures.push(error.message));
	await page.setViewportSize({ width: 1_900, height: 950 });
	const navigation = page.locator('.ash-sessions-activity-content');
	const panes = page.locator('.ash-sessions-chat-view:visible .ash-sessions-chat-slot');
	const add = page.locator('.ash-sessions-list-controls').getByRole('button', { name: 'New session', exact: true });
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
	await typeDraft('Chat first draft');
	await add.click();
	await typeDraft('Chat second draft');
	await add.click();
	await typeDraft('Chat third draft');
	await expect(panes).toHaveCount(3);
	await panes.first().locator('.ash-sessions-chat-slot-title').click();
	const beforeDrag = (await panes.first().boundingBox())!.width;
	await drag(-80);
	await expect.poll(async () => (await panes.first().boundingBox())!.width).toBeLessThan(beforeDrag - 50);
	const chat = await snapshot();
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await typeDraft('Code first draft');
	await add.click();
	await typeDraft('Code second draft');
	await expect(panes).toHaveCount(2);
	await drag(-60);
	const code = await snapshot();
	await navigation.getByRole('button', { name: 'Library', exact: true }).click();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(panes).toHaveCount(3);
	await expect.poll(async () => (await snapshot()).map(({ width, ...state }) => state)).toEqual(chat.map(({ width, ...state }) => state));
	for (let index = 0; index < chat.length; index++) {
		expect(Math.abs((await panes.nth(index).boundingBox())!.width - chat[index]!.width)).toBeLessThanOrEqual(1);
	}
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panes).toHaveCount(2);
	await expect.poll(async () => (await snapshot()).map(({ width, ...state }) => state)).toEqual(code.map(({ width, ...state }) => state));
	for (let index = 0; index < code.length; index++) {
		expect(Math.abs((await panes.nth(index).boundingBox())!.width - code[index]!.width)).toBeLessThanOrEqual(1);
	}
	await panes.first().locator('.ash-sessions-chat-slot-close').click();
	await expect(panes).toHaveCount(1);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(panes).toHaveCount(3);
	await navigation.getByRole('button', { name: 'Code', exact: true }).click();
	await expect(panes).toHaveCount(1);
	await new Editor(panes.first()).waitForEditorContents(text => text === 'Code second draft');
	await expect.poll(async () => page.evaluate(identities => {
		for (let index = 0; index < localStorage.length; index++) {
			const name = localStorage.key(index)!;
			if (!name.endsWith('.storage.workspace.sessions')) continue;
			const state = JSON.parse(localStorage.getItem(name)!);
			if (state.entries['sessions.viewState']) {
				return {
					removed: Boolean(state.entries[`sessions.codeDraftState:untitled:${identities[0]}`]),
					retained: Boolean(state.entries[`sessions.codeDraftState:untitled:${identities[1]}`]),
				};
			}
		}
		return undefined;
	}, code.map(pane => pane.identity))).toEqual({ removed: false, retained: true });
	expect(failures).toEqual([]);
});
