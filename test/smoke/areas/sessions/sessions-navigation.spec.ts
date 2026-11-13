import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { Menus } from '../../../automation/menus.js';
import { Editor } from '../../../automation/editor.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { readStorageEntries, seedStorageOnNextLoad } from '../../../automation/storage.js';
import { URI } from '../../../../src/ash/base/common/uri.js';
import { FileKind } from '../../../../src/ash/platform/files/common/files.js';
import { getSingleFolderWorkspaceIdentifier } from '../../../../src/ash/platform/workspaces/node/workspaces.js';
import { StorageScope, StorageTarget } from '../../../../src/ash/platform/storage/common/storage.js';

test('Bots keeps Code navigation and search separate', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const modeControl = page.locator('.ash-window-mode-control');
	const code = modeControl.getByRole('button', { name: 'Code', exact: true });
	await code.click();
	const navigation = page.locator('.ash-sessions-activity-content');
	await navigation.getByRole('button', { name: 'Bots', exact: true }).click();
	const sidebar = page.getByRole('region', { name: 'Bots', exact: true }).filter({ has: page.getByRole('button', { name: 'Back', exact: true }) });
	const back = sidebar.getByRole('button', { name: 'Back', exact: true });
	const search = sidebar.getByRole('searchbox', { name: 'Search Bots and Threads' });
	const bot = sidebar.getByRole('button', { name: 'Code Review', exact: true });
	await expect(back).toBeVisible();
	await expect(page.locator('.ash-bots-page').getByRole('heading', { name: 'Code Review' })).toBeVisible();
	await expect(navigation).toBeHidden();
	await expect(modeControl).toBeHidden();
	await expect(page.getByRole('toolbar', { name: 'Workspace mode', exact: true })).toHaveCount(0);
	const titlebar = page.locator('[data-part="titlebar"]');
	await titlebar.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await titlebar.getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(back).toBeVisible();
	await expect(modeControl).toBeHidden();
	await expect(bot).toHaveAttribute('aria-expanded', 'true');
	await bot.press('Enter');
	await expect(bot).toHaveAttribute('aria-expanded', 'false');
	await search.fill('no matching thread');
	await expect(sidebar.getByText('No matching bots or threads.')).toBeVisible();
	await expect(bot).toBeHidden();
	await search.fill('Code Review');
	await expect(bot).toBeVisible();
	await expect(bot).toHaveAttribute('aria-expanded', 'true');
	await search.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Bots groups conversations by assistant/);
	await page.keyboard.press('Escape');
	await expect(search).toBeFocused();
	await back.click();
	await expect(sidebar).toBeHidden();
	await expect(navigation.getByRole('button', { name: 'Bots', exact: true })).toBeVisible();
	await expect(code).toBeVisible();
	await expect(code).toHaveAttribute('aria-pressed', 'true');
});

test('Sessions discards an unavailable saved entry and completes restoration without losing the draft', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const draft = 'Keep this draft when a saved entry disappears';
	const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText(draft);
	const identity = { scope: StorageScope.WORKSPACE, id: 'sessions' };
	await seedStorageOnNextLoad(application, page, identity, {
		'sessions.layout.activeEntry': { value: 'sessions.show.library', target: StorageTarget.MACHINE },
	});
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await workbench.reloadWindow(page);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chatMode = page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true });
	await expect(chatMode).toHaveAttribute('aria-pressed', 'true');
	await new Editor(page.locator('.ash-sessions-chat-slot.active:visible')).waitForEditorContents(text => text === draft);
	await expect.poll(async () => (await readStorageEntries(application, page, identity))['sessions.layout.activeEntry']?.value).toBe('sessions.open.chat');
	await chatMode.click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('.ash-projects')).toBeVisible();
	page = await workbench.reopenAgentsWindow(application, page);
	await expect(page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('.ash-projects')).toBeVisible();
	expect(errors).toEqual([]);
});

test('Sessions New opens ChatGPT in the retained Sessions Part', { tag: ['@electron-app-server'] }, async ({ application, target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const chatgpt = navigation.getByRole('button', { name: 'New', exact: true });
	await expect(navigation.getByRole('button', { name: 'ChatGPT', exact: true })).toHaveCount(0);
	await chatgpt.click();
	const chat = page.locator('[data-part="sessions"] .ash-sessions-chat-grid .ash-sessions-chat-slot .ash-chatgpt-widget');
	const sidebar = page.locator('[data-part="sidebar"] [data-view-container-id="sessions.chatgpt.navigation"]');
	await expect(chat).toBeVisible();
	await expect(sidebar).toBeVisible();
	await expect(chatgpt).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="editor"] .ash-chatgpt-widget')).toHaveCount(0);
	await expect(sidebar.getByRole('searchbox')).toHaveCount(0);
	const retained = await chat.elementHandle();
	await expect(sidebar.locator('details')).toHaveCount(0);
	const input = chat.getByRole('textbox', { name: 'Ask ChatGPT (Experimental)', exact: true });
	await input.focus();
	await input.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/ChatGPT \(Experimental\) uses your existing Codex login/);
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await testInfo.attach('chatgpt-parts', { body: await page.screenshot(), contentType: 'image/png' });
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Hide sidebar', exact: true }).click();
	await expect(sidebar).toBeHidden();
	await expect(chat).toBeVisible();
	await page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Show sidebar', exact: true }).click();
	await expect(sidebar).toBeVisible();
	const menus = new Menus(page);
	await menus.select(application, () => chatgpt.click({ button: 'right' }), ['Reload']);
	await expect(chatgpt).toHaveAttribute('aria-current', 'page');
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(chat).toBeHidden();
	await chatgpt.click();
	await expect(chat).toBeVisible();
	await expect(sidebar).toBeVisible();
	expect(await chat.evaluate((element, previous) => element === previous, retained)).toBe(true);
	await input.focus();
	await input.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/ChatGPT/);
	await page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('.ash-projects')).toBeVisible();
});

test.describe('Code conversation navigation', () => {
	test.use({ electronWindowMode: 'active' });

	test('Code sidebar and Search open and focus the same draft from Customize', { tag: ['@electron-app-server'] }, async ({ target, workbench }) => {
		const page = await workbench.openAgentsWindow(target.kind);
		const sidebar = page.locator('[data-part="sidebar"] .ash-sessions-list[data-mode="code"]');
		const navigation = page.locator('.ash-sessions-activity-content');
		const modes = page.locator('.ash-window-mode-control');
		const code = modes.getByRole('button', { name: 'Code', exact: true });
		await code.click();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await expect(sidebar).toBeVisible();
		const editor = new Editor(page.locator('.ash-sessions-chat-slot.active:visible'));
		await editor.waitForEditorFocus();
		const draft = 'Retain the Code draft from Customize';
		await editor.waitForTypeInEditor(draft);
		const row = sidebar.locator('[data-item^="untitled:"] .ash-sessions-list-item');
		await expect(row).toHaveAttribute('aria-current', 'page');

		await navigation.getByRole('button', { name: 'Customize', exact: true }).click();
		const customize = page.getByRole('tablist', { name: 'Customization categories' });
		await expect(customize).toBeVisible();
		await expect(code).toHaveAttribute('aria-pressed', 'true');
		await expect(row).not.toHaveAttribute('aria-current', 'page');
		await row.press('Enter');
		await expect(customize).toBeHidden();
		await expect(row).toHaveAttribute('aria-current', 'page');
		await expect(editor.input).toBeFocused();
		await editor.waitForEditorContents(text => text === draft);

		const draftId = await page.locator('.ash-sessions-chat-slot.active:visible [data-untitled-session-id]').getAttribute('data-untitled-session-id');
		await navigation.getByRole('button', { name: 'Customize', exact: true }).click();
		await expect(customize).toBeVisible();
		await expect(row).not.toHaveAttribute('aria-current', 'page');
		await page.locator('[data-action-id="sessions.search"] button').click();
		const search = page.getByRole('dialog', { name: 'Search', exact: true });
		await search.locator(`[role="option"][data-list-id="draft:${draftId}"]`).click();
		await expect(search).toBeHidden();
		await expect(customize).toBeHidden();
		await expect(row).toHaveAttribute('aria-current', 'page');
		await expect(editor.input).toBeFocused();
		await editor.waitForEditorContents(text => text === draft);
	});
});

test('Sessions restores the Projects entry and its pane visibility through entry startup', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const chatEditor = () => new Editor(page.locator(':is(.chat-composer, .native-chat-composer):visible'));
	const draft = 'Keep the conversation when Projects is restored';
	await chatEditor().waitForEditorFocus();
	await chatEditor().waitForTypeInEditor(draft);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	page = await workbench.reopenAgentsWindow(application, page);
	const navigation = page.locator('.ash-sessions-activity-content');
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await expect(page.locator('.ash-projects').getByRole('button', { name: 'New project', exact: true }).first()).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await chatEditor().waitForEditorContents(text => text === draft);
});

test('Artifacts creation cards select a Chat draft type without creating an artifact', { tag: ['@browser-ui', '@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const artifacts = page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true });
	const home = page.locator('.ash-creator-home');
	const sessions = page.locator('[data-part="sessions"]');
	const conversation = new Editor(sessions.locator(':is(.chat-composer, .native-chat-composer):visible'));
	const pill = sessions.locator('.ash-chat-input-artifact-pill:visible');
	for (const kind of ['docs', 'slides', 'design', 'sheet', 'whiteboard', 'data', 'motion']) {
		await artifacts.click();
		const card = home.locator(`.ash-artifacts-create.${kind}`);
		if (kind === 'docs') await card.click();
		else await card.press('Enter');
		await expect(home).toBeHidden();
		await expect(page.locator('[data-part="editor"]')).toBeHidden();
		await expect(conversation.input).toBeFocused();
		await expect(pill).toHaveAttribute('data-artifact-kind', kind);
	}
	await conversation.waitForTypeInEditor('Animate this draft');
	await pill.getByRole('button', { name: 'Remove Ash Motion', exact: true }).press('Enter');
	await expect(pill).toHaveCount(0);
	await expect(conversation.input).toBeFocused();
	await conversation.waitForEditorContents(text => text === 'Animate this draft');
	await artifacts.click();
	await home.getByRole('tab', { name: 'Yours', exact: true }).press('Enter');
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(0);
});

test('Artifacts examples use the retained editor and conversation', { tag: ['@browser-ui', '@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.setViewportSize({ width: 1440, height: 860 });
	const navigation = page.locator('.ash-sessions-activity-content');
	const artifacts = navigation.getByRole('button', { name: 'Artifacts', exact: true });
	const editor = page.locator('[data-part="editor"] .ash-code-page-group');
	const titlebar = page.locator('[data-part="titlebar"]');
	const header = titlebar.locator('.ash-sessions-titlebar-editor-page');
	const sessions = page.locator('[data-part="sessions"]');
	const sidebar = page.locator('[data-part="sidebar"]');
	const details = page.locator('[data-part="auxiliarybar"]');
	const conversation = new Editor(sessions.locator(':is(.chat-composer, .native-chat-composer):visible'));
	await conversation.waitForTypeInEditor('Keep this conversation alongside Artifacts');
	const retained = await sessions.elementHandle();
	const cases = [
		['docs', '.ash-docs-workspace-body'],
		['slides', '.ash-sessions-design-stage'],
		['design', '.ash-sessions-design-stage'],
		['sheet', '.ash-artifact-table-workspace'],
		['whiteboard', '.ash-sessions-design-stage'],
		['data', '.ash-artifact-table-workspace'],
		['motion', '.ash-sessions-design-stage'],
	] as const;
	for (const [kind, bodySelector] of cases) {
		await artifacts.click();
		await editor.locator(`[data-artifact-example="${kind}"]`).press('Enter');
		const body = editor.locator(`${bodySelector}:visible`);
		await expect(header.getByRole('heading')).toBeVisible();
		await expect(body).toBeVisible();
		await expect(editor.locator('.ash-editor-tabs')).toBeHidden();
		await expect(editor.locator('.stanza-editor-pane:visible')).toHaveCount(0);
		await expect(sidebar).toBeVisible();
		await expect(sessions).toBeVisible();
		await expect(details).toBeHidden();
		const titlebarBounds = (await titlebar.boundingBox())!;
		const headerBounds = (await header.boundingBox())!;
		expect(headerBounds.y).toBe(titlebarBounds.y);
		expect(headerBounds.x).toBeCloseTo((await editor.boundingBox())!.x, 0);
		expect(headerBounds.y + headerBounds.height).toBeLessThanOrEqual((await body.boundingBox())!.y);
		await expect(editor.getByRole('button', { name: /^(Artifacts home|Back to Artifacts|Document tools|Show Secondary Side Bar)$/u })).toHaveCount(0);
		const toggle = header.getByRole('button', { name: kind === 'docs' ? 'Document tools' : 'Show Secondary Side Bar', exact: true });
		if (kind === 'sheet' || kind === 'data') {
			await expect(body.getByRole('table')).toBeVisible();
			await expect(toggle).toHaveCount(0);
		} else {
			await toggle.click();
			await expect(details).toBeVisible();
			expect(await details.evaluate(element => element.closest('[data-part="editor"]') !== null)).toBe(true);
			if (kind === 'slides') continue;
			await header.getByRole('button', { name: kind === 'docs' ? 'Document tools' : 'Hide Secondary Side Bar', exact: true }).click();
			await expect(details).toBeHidden();
		}
	}

	expect(await sessions.evaluate((element, original) => element === original, retained)).toBe(true);
	await retained!.dispose();
	await conversation.waitForEditorContents(text => text === 'Keep this conversation alongside Artifacts');
});

test('Artifacts restores editable Sheet and Data drafts after reopening', { tag: ['@electron-ui', '@browser-ui', '@electron-app-server'] }, async ({ target, application, workbench, testWorkspace }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const drafts = [['sheet', 'Quarterly budget'], ['data', 'Pilot cohort']] as const;
	const files = drafts.map(([kind, value]) => ({
		name: `${randomUUID()}.json`, content: JSON.stringify({ kind, rows: [[value, '', '']] }),
	}));
	if ('windows' in application) {
		const profile = await application.evaluate(() => process.env.ASH_HOME!);
		const workspaceId = getSingleFolderWorkspaceIdentifier(URI.file(await realpath(testWorkspace.directory))).id;
		const directory = join(profile, 'creator', workspaceId, 'tables');
		await mkdir(directory, { recursive: true });
		await Promise.all(files.map(file => writeFile(join(directory, file.name), file.content)));
	} else {
		const workspaceId = await page.evaluate(() => globalThis.ashWebWorkbenchHost?.workspace?.id ?? 'sessions');
		const directory = URI.from({ scheme: 'ash-userdata', path: '/user/creator' }).joinPathSegment(encodeURIComponent(workspaceId)).joinPathSegment('tables');
		await page.evaluate(async ({ directory, files, directoryKind, fileKind }) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-user-data-files', 1);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					const transaction = database.transaction('files', 'readwrite');
					const store = transaction.objectStore('files');
					const put = (key: string, kind: FileKind, bytes: Uint8Array) =>
						store.put({ kind, bytes, revision: crypto.randomUUID(), modifiedAtMillis: Date.now() }, key);
					put(directory, directoryKind, new Uint8Array());
					for (const { resource, content } of files) put(resource, fileKind, new TextEncoder().encode(content));
					transaction.oncomplete = () => resolve();
					transaction.onabort = () => reject(transaction.error);
				});
			} finally { database.close(); }
		}, {
			directory: directory.toString(), directoryKind: FileKind.Directory, fileKind: FileKind.File,
			files: files.map(file => ({ ...file, resource: directory.joinPathSegment(file.name).toString() })),
		});
	}

	const waitForBrowserSave = async (value: string) => {
		if (target.kind !== 'browser') { return; }
		// Browser reload cannot join a native shutdown. Wait for the background write.
		await expect.poll(() => page.evaluate(async expected => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('ash-user-data-files', 1);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<boolean>((resolve, reject) => {
					const request = database.transaction('files').objectStore('files').getAll();
					request.onsuccess = () => resolve(request.result.some(entry => entry.kind === 'file' && new TextDecoder().decode(entry.bytes).includes(JSON.stringify(expected))));
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		}, value)).toBe(true);
	};
	const openArtifacts = () => page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	const openTable = (kind: string) => page.locator(`.ash-artifacts-card.${kind}[data-artifact-workspace]`).press('Enter');
	const table = (kind: string) => page.locator(`.ash-artifact-table-workspace.editable.${kind}:visible`);
	const exportCsv = () => page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Export CSV', exact: true });
	for (const [kind, value] of drafts) {
		await openArtifacts();
		await openTable(kind);
		const body = table(kind);
		await expect(exportCsv()).toBeVisible();
		await expect(body.getByRole('textbox', { name: 'Cell A1', exact: true })).toHaveValue(value);
		await body.getByRole('button', { name: 'Add row', exact: true }).press('Enter');
		const cell = body.getByRole('textbox', { name: 'Cell A2', exact: true });
		await expect(cell).toBeFocused();
		await cell.fill(`${value} details`);
		await body.getByRole('button', { name: 'Add column', exact: true }).press('Enter');
		await expect(body.getByRole('textbox', { name: 'Cell D1', exact: true })).toBeFocused();
		if (kind === 'sheet' && target.appServerMode === 'required' && 'windows' in application) {
			const output = join(await realpath(testWorkspace.directory), 'artifact-sheet.csv');
			await application.evaluate(({ dialog }, filePath) => {
				dialog.showSaveDialog = async () => ({ canceled: false, filePath });
			}, output);
			await exportCsv().click();
			await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('"Quarterly budget","","",""\r\n"Quarterly budget details","","",""');
		}
	}

	await waitForBrowserSave('Pilot cohort details');
	page = await workbench.reopenAgentsWindow(application, page);
	for (const [kind, value] of drafts) {
		await openArtifacts();
		await page.getByRole('tab', { name: 'Yours', exact: true }).press('Enter');
		await openTable(kind);
		const body = table(kind);
		await expect(body.getByRole('textbox', { name: 'Cell A1', exact: true })).toHaveValue(value);
		await expect(body.getByRole('textbox', { name: 'Cell A2', exact: true })).toHaveValue(`${value} details`);
		await body.getByRole('textbox', { name: 'Cell A2', exact: true }).fill(`Edited ${value}`);
	}
	await waitForBrowserSave('Edited Pilot cohort');
	page = await workbench.reopenAgentsWindow(application, page);
	await openArtifacts();
	await openTable('data');
	await expect(table('data').getByRole('textbox', { name: 'Cell A2', exact: true })).toHaveValue('Edited Pilot cohort');
});

test('Artifacts home keeps the conversation sidebar and offers seven creation types', async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.setViewportSize({ width: 1280, height: 860 });
	const navigation = page.locator('.ash-sessions-activity-content');
	const sidebar = page.locator('[data-part="sidebar"]');
	const originalList = await sidebar.locator('[data-view-container-id]:visible').elementHandle();
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	const home = page.locator('.ash-creator-home');
	await expect(home).toBeVisible();
	await expect(page.locator('[data-part="titlebar"] .ash-sessions-titlebar-editor-page h1')).toHaveText('Artifacts');
	await expect(sidebar.locator('[data-view-container-id="sessions.creator.navigation"]')).toHaveCount(0);
	expect(await sidebar.locator('[data-view-container-id]:visible').evaluate((element, retained) => element === retained, originalList)).toBe(true);
	const tiles = home.locator('.ash-artifacts-create');
	await expect(tiles).toHaveText(['Docs', 'Slides', 'Design', 'Sheet', 'Whiteboard', 'Data', 'Motion']);
	await expect(home.locator('[data-artifact-example]')).toHaveCount(7);
	await expect.poll(() => tiles.evaluateAll(elements => new Set(elements.map(element => element.getBoundingClientRect().top)).size)).toBe(1);
	await expect(home.locator('.ash-artifacts-create > .ash-artifacts-illustration').first()).toHaveCSS('height', '88px');
	const docs = home.getByRole('button', { name: 'Docs', exact: true });
	const preview = docs.locator('.ash-artifacts-illustration');
	await expect(home.getByRole('button', { name: 'Choose Docs editor', exact: true })).toHaveCount(0);
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	const restingWidth = (await preview.boundingBox())!.width;
	await docs.hover();
	await expect.poll(async () => (await preview.boundingBox())!.width).toBeGreaterThan(restingWidth);
	await expect(docs).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await expect(preview).toHaveCSS('transform', 'none');
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-editor-tabs')).toBeHidden();
	await home.getByRole('tab', { name: 'All', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await expect(home.getByRole('tab', { name: 'Yours', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	const shared = home.getByRole('tab', { name: 'Shared with you', exact: true });
	await expect(shared).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(shared).toHaveAttribute('aria-selected', 'true');
	await expect(home.getByText('No artifacts have been shared with you.')).toBeVisible();
	await home.getByRole('tab', { name: 'All', exact: true }).click();
	const design = home.getByRole('button', { name: 'Design', exact: true });
	await design.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Press Enter on a creation card[\s\S]*Sheet\s+Whiteboard\s+Data\s+Motion/);
	await page.keyboard.press('Escape');
	await expect(design).toBeFocused();
	await page.screenshot({ path: testInfo.outputPath('artifacts-home.png') });
	await home.getByRole('tab', { name: 'Yours', exact: true }).click();
	await new QuickAccess(page).runCommand('sessions.creator.open.design');
	const canvas = page.getByRole('region', { name: 'Design canvas', exact: true });
	await canvas.press('r');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(1);
	await home.getByRole('button', { name: 'Search artifacts', exact: true }).click();
	await home.getByRole('searchbox').fill('missing_artifact');
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(0);
	await expect(home.getByText('No artifacts match your search.')).toBeVisible();
	await home.getByRole('searchbox').fill('');
	await home.getByRole('button', { name: 'Layout grid', exact: true }).click();
	await expect(home.locator('.ash-artifacts-results')).toHaveClass(/list-view/);
	await home.locator('.ash-artifacts-card').click();
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	const quick = new QuickAccess(page);
	await quick.runCommand('sessions.creator.chooseDocsEditor');
	await quick.select('Markdown');
	await quick.runCommand('sessions.creator.chooseDocsEditor');
	await quick.select('New blank document');
	const document = new Editor(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)'));
	await document.waitForEditorFocus();
	await document.waitForTypeInEditor('Retained artifact document');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await expect(home.locator('.ash-artifacts-card')).toHaveCount(2);
	await home.locator('.ash-artifacts-card.docs').click();
	await document.waitForEditorContents(text => text === 'Retained artifact document');
	await navigation.getByRole('button', { name: 'Artifacts', exact: true }).click();
	await page.setViewportSize({ width: 620, height: 860 });
	await expect.poll(() => home.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
	await page.screenshot({ path: testInfo.outputPath('artifacts-narrow.png') });
});

test('Artifacts keeps creation and ownership controls legible across themes', { tag: ['@electron-app-server'] }, async ({ target, workbench }, testInfo) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.locator('.ash-sessions-activity-content').getByRole('button', { name: 'Artifacts', exact: true }).click();
	for (const [label, id] of [['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']] as const) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const picker = workbench.page.locator('.ash-quick-pick').getByRole('combobox');
		await picker.fill(label);
		await workbench.quickaccess.select(label);
		await expect(workbench.page.locator('.ash-quick-pick')).toHaveCount(0);
		await expect(page.locator('#app')).toHaveAttribute('data-color-theme', id);
		const home = page.locator('.ash-creator-home');
		await expect(home.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute('aria-selected', 'true');
		await expect(home.locator('.ash-artifacts-create')).toHaveCount(7);
		for (const illustration of await home.locator('.ash-artifacts-create > .ash-artifacts-illustration').all()) {
			await expect(illustration).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
			if (id.includes('contrast')) { await expect(illustration).toHaveCSS('border-top-width', '1px'); }
		}
		await page.screenshot({ path: testInfo.outputPath(`artifacts-${id}.png`) });
	}
});

test('Sessions pages keep Code tabs separate and retain dirty files and Design state', async ({ target, workbench }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	await page.setViewportSize({ width: 1440, height: 860 });
	const navigation = page.locator('.ash-sessions-activity-content');
	const modes = page.locator('.ash-window-mode-control');
	const code = modes.getByRole('button', { name: 'Code', exact: true });
	const chat = modes.getByRole('button', { name: 'Chat / Agents', exact: true });
	const creator = navigation.getByRole('button', { name: 'Artifacts', exact: true });
	const projects = navigation.getByRole('button', { name: 'Projects', exact: true });
	await code.click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	const codeEditor = page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)');
	const file = new Editor(codeEditor);
	await file.waitForEditorFocus();
	await file.waitForTypeInEditor('Keep this unsaved Code file');
	await chat.click();
	await creator.click();
	await new QuickAccess(page).runCommand('sessions.creator.open.design');
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(codeEditor).toBeVisible();
	await expect(file.input).toBeHidden();
	const canvas = page.getByRole('region', { name: 'Design canvas' });
	await expect(canvas).toBeVisible();
	await canvas.focus();
	await page.keyboard.press('r');
	await page.keyboard.press('+');
	const world = canvas.locator('.ash-canvas-world');
	const transform = await world.evaluate(element => (element as HTMLElement).style.transform);
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await expect(page.getByRole('tab', { name: 'Untitled design', exact: true, includeHidden: true })).toHaveCount(0);
	await expect(codeEditor.locator('.ash-code-page-group').getByRole('tab', { name: /^Untitled-1/u, includeHidden: true })).toHaveCount(0);
	await projects.click();
	await expect(projects).toHaveAttribute('aria-current', 'page');
	await page.locator('.ash-projects').getByRole('button', { name: 'Search projects', exact: true }).click();
	const search = page.locator('.ash-projects').getByRole('searchbox');
	await search.fill('Keep this Projects search');
	await expect(canvas).toBeHidden();
	await expect(page.locator('.ash-projects').getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
	await code.click();
	await expect(codeEditor).toBeVisible();
	await file.waitForEditorContents(text => text === 'Keep this unsaved Code file');
	await chat.click();
	await creator.press('Enter');
	await new QuickAccess(page).runCommand('sessions.creator.open.design');
	await expect(canvas).toBeVisible();
	await expect.poll(() => world.evaluate(element => (element as HTMLElement).style.transform)).toBe(transform);
	await expect(canvas.locator('[data-shape-id]')).toHaveCount(1);
	await new QuickAccess(page).runCommand('sessions.creator.toggleDetails');
	await expect(page.locator('[data-part="auxiliarybar"]').getByRole('spinbutton', { name: 'X', exact: true })).toBeVisible();
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await projects.click();
	await expect(search).toHaveValue('Keep this Projects search');
});

test('Sessions registered pages coordinate Parts and retain drafts through drag and keyboard ordering', async ({ application, target, workbench }) => {
	let page = await workbench.openAgentsWindow(target.kind);
	const navigation = page.locator('.ash-sessions-activity-content');
	const items = navigation.locator('.ash-sessions-navigation > .ash-action-view-item');
	const readOrder = () => items.evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.actionId)
		.filter(id => id !== 'sessions.activity.more' && id !== 'sessions.open.collaboration'));
	const trace = navigation.getByRole('button', { name: 'Trace', exact: true });
	await expect(trace).toHaveCount(0);
	const chat = navigation.getByRole('button', { name: 'New', exact: true });
	const creator = navigation.getByRole('button', { name: 'Artifacts', exact: true });
	const editor = new Editor(page.locator('.ash-chatgpt-widget:visible'));
	await editor.waitForEditorFocus();
	await page.keyboard.insertText('Retain the navigation draft');
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	const retainedChat = await chat.elementHandle();
	const currentBeforeDrag = await chat.getAttribute('aria-current');
	const [first, ...remaining] = await readOrder();
	expect(first).toBe('sessions.newSession');
	const otherActions = remaining.filter(id => id !== 'sessions.open.creator');
	await navigation.locator('[data-action-id="sessions.open.creator"]').dragTo(navigation.locator('[data-action-id="sessions.newSession"]'), { targetPosition: { x: 8, y: 2 } });
	await expect(items.first()).toHaveAttribute('draggable', 'true');
	await expect.poll(readOrder).toEqual(['sessions.open.creator', first, ...otherActions]);
	await expect.poll(() => chat.getAttribute('aria-current')).toBe(currentBeforeDrag);
	expect(await chat.evaluate((element, retained) => element === retained, retainedChat)).toBe(true);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await new QuickAccess(page).runCommand('workbench.action.files.newUntitledFile');
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await creator.click();
	await new QuickAccess(page).runCommand('sessions.creator.open.design');
	await expect(creator).toHaveAttribute('aria-current', 'page');
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-creator')).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Untitled design', exact: true })).toHaveCount(0);
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await expect(page.locator('[data-part="panel"]')).toBeHidden();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await navigation.getByRole('button', { name: 'Projects', exact: true }).click();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid) .ash-projects')).toBeVisible();
	await expect(page.locator('[data-part="sidebar"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)')).toBeVisible();
	await expect(page.locator('[data-part="auxiliarybar"]')).toBeHidden();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await creator.focus();
	const currentBeforeKeyboardMove = await chat.getAttribute('aria-current');
	await new Menus(page).select(application, () => page.keyboard.press('Shift+F10'), ['Move later']);
	await expect(creator).toBeFocused();
	await expect.poll(readOrder).toEqual([first, 'sessions.open.creator', ...otherActions]);
	await expect.poll(() => chat.getAttribute('aria-current')).toBe(currentBeforeKeyboardMove);
	await page.keyboard.press('Home');
	await expect(chat).toBeFocused();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await navigation.getByRole('button', { name: 'New', exact: true }).focus();
	const codeAuxiliary = page.locator('[data-part="auxiliarybar"]');
	const codeAuxiliaryWasVisible = await codeAuxiliary.isVisible();
	await page.keyboard.press('End');
	const more = navigation.getByRole('button', { name: 'More', exact: true });
	await expect(more).toBeFocused();
	await page.keyboard.press('Enter');
	await page.getByRole('menuitemradio', { name: 'Symphony', exact: true }).press('Enter');
	await expect(page.locator('.ash-symphony-monitor')).toBeVisible();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(page.locator('[data-part="sessions"]')).toBeVisible();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect.poll(() => codeAuxiliary.isVisible()).toBe(codeAuxiliaryWasVisible);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Chat / Agents', exact: true }).click();
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await new Menus(page).select(application, () => chat.click({ button: 'right' }), ['Activity Bar Position', 'Top']);
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await expect(navigation.locator('.ash-sessions-navigation[role="toolbar"]')).toHaveAttribute('aria-orientation', 'horizontal');
	const currentBeforeHorizontalDrag = await chat.getAttribute('aria-current');
	await navigation.locator('[data-action-id="sessions.open.projects"]').dragTo(navigation.locator('[data-action-id="sessions.open.creator"]'), { targetPosition: { x: 2, y: 8 } });
	const horizontalOrder = [first, 'sessions.open.projects', 'sessions.open.creator', ...otherActions.filter(id => id !== 'sessions.open.projects')];
	await expect.poll(readOrder).toEqual(horizontalOrder);
	await expect.poll(() => chat.getAttribute('aria-current')).toBe(currentBeforeHorizontalDrag);
	await chat.focus();
	await page.keyboard.press('ArrowRight');
	await expect(navigation.getByRole('button', { name: 'Projects', exact: true })).toBeFocused();
	await page.reload();
	await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
	await expect.poll(() => chat.getAttribute('aria-current')).toBe(currentBeforeHorizontalDrag);
	await expect.poll(readOrder).toEqual(horizontalOrder);
	await editor.waitForEditorContents(text => text === 'Retain the navigation draft');
	await new QuickAccess(page).runCommand('sessions.trace.import');
	await expect(trace).toHaveCount(0);
	const viewer = page.locator('.ash-agent-trace:visible');
	await expect(viewer).toBeVisible();
	const offline = { formatVersion: 3, sessionId: 'shell-navigation-offline', historyPrefixes: [], threads: [{ threadId: 'shell-thread', events: [{ eventId: 'shell-event', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'shell-thread', title: 'Shell navigation offline fixture' } }] }] };
	await viewer.locator('input[type=file]').setInputFiles({ name: 'shell-navigation.trace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(offline)) });
	await expect(viewer.getByRole('status')).toContainText('Imported');
	// Debug Logs hides its unused sidebar, including the Top navigation host.
	await new Menus(page).select(application, () => page.getByRole('button', { name: 'Accounts', exact: true }).click({ button: 'right' }), ['Activity Bar Position', 'Default']);
	await page.locator('.ash-window-mode-control').getByRole('button', { name: 'Code', exact: true }).click();
	await expect(viewer).toBeHidden();
	await expect(page.locator('[data-part="editor"]:not(.ash-sessions-chat-grid)').getByRole('tab', { name: 'Untitled-1', exact: true })).toBeVisible();
	await new QuickAccess(page).runCommand('sessions.open.trace');
	await expect(viewer).toBeVisible();
	await expect(trace).toHaveCount(0);
	await expect(page.locator('[data-part="editor"] .ash-editor-title-control').getByRole('tab', { name: 'Agent Debug Logs', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(viewer.getByRole('status')).toContainText('Imported');
	await retainedChat!.dispose();
});
