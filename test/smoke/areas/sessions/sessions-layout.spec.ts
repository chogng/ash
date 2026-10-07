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
	const snapshot = async (): Promise<{ identity: string | undefined; active: boolean; text: string; width: number; }[]> => panes.evaluateAll(elements => elements.map(element => {
		const chat = element.querySelector<HTMLElement>(':is(.ash-chat,.ash-cowork)')!;
		return {
			identity: chat.dataset.untitledSessionId ?? chat.dataset.sessionId,
			active: element.classList.contains('active'),
			// These drafts are one model line; a narrow editor can wrap it into several visual rows.
			text: [...element.querySelectorAll('.view-lines > .view-line .stanza-editor-line-text')].map(line => line.textContent).join('').replace(/\u00a0/g, ' '),
			width: element.getBoundingClientRect().width,
		};
	}));
	const draftReference = async (): Promise<{ kind: 'untitled'; session: { untitledSessionId: string; title: string; workspace: { type: 'current'; }; }; }> => ({
		kind: 'untitled',
		session: { untitledSessionId: (await panes.locator(':is(.ash-chat,.ash-cowork)').getAttribute('data-untitled-session-id'))!, title: 'New session', workspace: { type: 'current' } },
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
	await page.locator('[data-part="sessions"] [role="tab"]').first().click();
	const beforeDrag = (await panes.first().boundingBox())!.width;
	await drag(-80);
	// Sessions uses EditorPart's 120px minimum for each group.
	await expect.poll(async () => Math.round((await panes.first().boundingBox())!.width)).toBe(Math.round(Math.max(120, beforeDrag - 80)));
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
	await page.locator('[data-part="sessions"] .ash-tab-close-action button').first().click();
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
	// Selecting an already visible Session focuses its group without collapsing its siblings.
	const selected = (await snapshot()).find(slot => slot.active)!;
	await page.locator('.ash-sessions-list-item[aria-current="page"]').click();
	await expect(panes).toHaveCount(4);
	await expect(page.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)')).toHaveAttribute('data-untitled-session-id', selected.identity!);
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text.replace(/\n/g, '') === selected.text);
	await navigation.getByRole('button', { name: 'Chat', exact: true }).click();
	await expect(panes).toHaveCount(4);
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text.replace(/\n/g, '') === selected.text);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(panes).toHaveCount(4);
	await expect(page.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)')).toHaveAttribute('data-untitled-session-id', selected.identity!);
	expect(failures).toEqual([]);
});

test('Sessions restores nested editor geometry, active conversation and drafts after reopening the window', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await page.setViewportSize({ width: 1900, height: 950 });
	const references: { kind: 'untitled'; session: { untitledSessionId: string; title: string; workspace: { type: 'current'; }; }; }[] = [];
	for (let index = 0; index < 3; index++) {
		if (index) await page.locator('.ash-sessions-list-add').click();
		const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
		await editor.input.focus();
		await editor.waitForTypeInEditor(`Retained draft ${index}`);
		const chat = page.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)');
		references.push({ kind: 'untitled', session: { untitledSessionId: (await chat.getAttribute('data-untitled-session-id'))!, title: `Conversation ${index}`, workspace: { type: 'current' } } });
	}
	const identity = { scope: StorageScope.WORKSPACE, id: 'sessions' };
	await expect.poll(async () => {
		const stored = (await readStorageEntries(application, page, identity))['sessions.viewState'];
		return stored && JSON.parse(stored.value).drafts.length;
	}).toBe(3);
	const entries = await readStorageEntries(application, page, identity);
	const selection = JSON.parse(entries['sessions.viewState'].value);
	const groupIds = ['saved-left', 'saved-top', 'saved-bottom'];
	const leaf = (groupId: string, size: number) => ({ type: 'leaf', data: { groupId }, size, visible: true, priority: 'normal' });
	await seedStorageOnNextLoad(application, page, identity, {
		'sessions.viewState': { value: JSON.stringify({ ...selection, visible: references, active: 2 }), target: StorageTarget.MACHINE },
		'sessions.gridState': {
			value: JSON.stringify({
				version: 2, groups: references.map((reference, index) => ({ groupId: groupIds[index], id: `untitled:${reference.session.untitledSessionId}` })),
				layout: { type: 'branch', orientation: 'horizontal', size: 1200, priority: 'normal', children: [leaf(groupIds[0]!, 400), { type: 'branch', orientation: 'vertical', size: 800, priority: 'normal', children: [leaf(groupIds[1]!, 200), leaf(groupIds[2]!, 400)] }] },
			}), target: StorageTarget.MACHINE
		},
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	const expectRestored = async (): Promise<void> => {
		const host = page.locator('[data-part="sessions"]');
		await expect(host.locator('.ash-editor-group')).toHaveCount(3);
		const expectedIds = references.map(reference => reference.session.untitledSessionId);
		await expect.poll(() => host.locator('.ash-sessions-chat-slot').evaluateAll((slots, expected) => expected.map(id => {
			const slot = slots.find(slot => slot.querySelector<HTMLElement>(':is(.ash-chat,.ash-cowork)')?.dataset.untitledSessionId === id)!;
			const bounds = slot.closest('.ash-editor-group')!.getBoundingClientRect();
			return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
		}), expectedIds).then(([left, top, bottom]) => ({
			leftOf: left.x < top.x, stacked: top.y < bottom.y && Math.abs(top.x - bottom.x) < 1,
			widthRatio: Math.round(top.width / left.width), heightRatio: Math.round(bottom.height / top.height),
		}))).toEqual({ leftOf: true, stacked: true, widthRatio: 2, heightRatio: 2 });
		await expect(host.locator('.ash-sessions-chat-slot.active :is(.ash-chat,.ash-cowork)')).toHaveAttribute('data-untitled-session-id', expectedIds[2]!);
		for (let index = 0; index < references.length; index++) {
			const slot = host.locator('.ash-sessions-chat-slot').filter({ has: page.locator(`[data-untitled-session-id="${expectedIds[index]}"]`) });
			await new Editor(slot).waitForEditorContents(text => text === `Retained draft ${index}`);
		}
	};
	await expectRestored();
	page = await workbench.reopenAgentsWindow(application, page);
	await page.setViewportSize({ width: 1900, height: 950 });
	await expectRestored();
	const saved = JSON.parse((await readStorageEntries(application, page, identity))['sessions.gridState'].value);
	expect(saved.version).toBe(2);
	expect(saved.layout.children[1].orientation).toBe('vertical');
	expect(saved.groups.map((group: { id: string; }) => group.id)).toEqual(references.map(reference => `untitled:${reference.session.untitledSessionId}`));
});
