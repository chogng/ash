import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitHubIssueState } from '../../../../src/ash/platform/github/common/githubService.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestWorkspace, disposeTestWorkspace } from '../../../automation/testWorkspace.js';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

// The same renderer interaction is exercised in Browser, Electron UI and connected Electron.
test('Workbench context picker uploads, previews and removes attachments with the keyboard', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	await expect(page.getByRole('dialog', { name: 'Search attachments', exact: true })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles([
		{ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Workbench attachment brief') },
		{ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==', 'base64') },
	]);
	const attachments = chat.getByRole('list', { name: 'Attached context' });
	await expect(attachments.getByRole('listitem')).toHaveCount(2);
	await expect(page.locator('input[type="file"][aria-label="Attach files"]')).toHaveCount(0);
	await expect(attachments.getByRole('img', { name: 'preview.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
	const remove = chat.getByRole('button', { name: 'Remove brief.txt', exact: true });
	await remove.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/including unsaved text/);
	await page.keyboard.press('Escape');
	await expect(remove).toBeFocused();
	await remove.press('Enter');
	await expect(chat.getByRole('button', { name: 'Remove preview.png', exact: true })).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue('preview.png');
	await page.keyboard.press('Escape');
	await chat.getByRole('button', { name: 'Remove preview.png', exact: true }).press('Enter');
	await expect(attachments).toBeHidden();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});

test('cancelling attachment selection removes the picker and lets the composer attach again', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	await add.press('Enter');
	const cancelledUpload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await cancelledUpload;
	const input = page.locator('input[type="file"][aria-label="Attach files"]');
	await input.dispatchEvent('cancel');
	await expect(input).toHaveCount(0);
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	const upload = page.waitForEvent('filechooser');
	await page.getByRole('dialog', { name: 'Search attachments', exact: true }).getByRole('combobox').fill('Attach files');
	await page.keyboard.press('Enter');
	await (await upload).setFiles({ name: 'after-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('Attach after cancellation') });
	await expect(chat.getByRole('button', { name: 'Remove after-cancel.txt', exact: true })).toBeVisible();
	await expect(input).toHaveCount(0);
});


test('host clipboard image becomes a decoded context attachment in Workbench and Sessions', async ({ workbench, target, application }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const png = await page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = 2560; canvas.height = 1280;
		canvas.getContext('2d')!.fillRect(0, 0, 2560, 1280);
		return canvas.toDataURL('image/png').split(',')[1];
	});
	const electron = application as ElectronApplication;
	if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	// Snapshot every available format before writing so the smoke test restores the user's clipboard.
	const previous = target.kind === 'electron' ? await electron.evaluate(async ({ clipboard }) => Promise.all((await clipboard.read()).map(async item => {
		const formats: Record<string, { bytes: number[]; } | { bookmark: { title: string; url: string; }; }> = {};
		for (const type of item.types) {
			const value = await item.getType(type);
			formats[type] = value instanceof Blob ? { bytes: Array.from(new Uint8Array(await value.arrayBuffer())) } : { bookmark: value };
		}
		return formats;
	}))) : await page.evaluate(async () => Promise.all((await navigator.clipboard.read()).map(async item => {
		const formats: Record<string, { bytes: number[]; }> = {};
		for (const type of item.types) formats[type] = { bytes: Array.from(new Uint8Array(await (await item.getType(type)).arrayBuffer())) };
		return formats;
	})));
	try {
		if (target.kind === 'electron') {
			await electron.evaluate(async ({ clipboard, ClipboardItem }, data) => clipboard.write([new ClipboardItem({ 'image/png': new Blob([Buffer.from(data, 'base64')], { type: 'image/png' }) })]), png);
		} else {
			await page.evaluate(async data => navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(atob(data), character => character.charCodeAt(0))], { type: 'image/png' }) })]), png);
		}
		for (const surface of ['workbench', 'sessions']) {
			const surfacePage = surface === 'workbench' ? page : await workbench.openAgentsWindow(target.kind);
			const composer = surface === 'workbench' ? chat : surfacePage.locator('.ash-sessions-chat-slot.active:visible');
			await composer.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
			await surfacePage.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
			const image = composer.getByRole('img', { name: 'Pasted Image', exact: true });
			await expect(image).toBeVisible();
			await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([2048, 1024]);
			await expect(surfacePage.getByRole('dialog')).toHaveCount(0);
			await expect(composer.locator('.stanza-editor-input')).toBeFocused();
			await composer.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
			await surfacePage.getByRole('dialog').getByRole('option', { name: 'Image from Clipboard', exact: true }).click();
			await expect(surfacePage.getByRole('dialog')).toHaveCount(0);
			await expect(composer.getByRole('listitem')).toHaveCount(1);
			await composer.getByRole('button', { name: 'Remove Pasted Image', exact: true }).press('Enter');
		}
	} finally {
		if (target.kind === 'electron') {
			await electron.evaluate(async ({ clipboard, ClipboardItem }, saved) => {
				saved = saved.filter(formats => Object.keys(formats).length > 0);
				if (!saved.length) { clipboard.clear(); return; }
				await clipboard.write(saved.map(formats => new ClipboardItem(Object.fromEntries(Object.entries(formats).map(([type, value]) => [type, 'bytes' in value ? new Blob([new Uint8Array(value.bytes)], { type }) : value.bookmark])))));
			}, previous);
		} else {
			await page.evaluate(async saved => {
				saved = saved.filter(formats => Object.keys(formats).length > 0);
				if (!saved.length) { await navigator.clipboard.writeText(''); return; }
				await navigator.clipboard.write(saved.map(formats => new ClipboardItem(Object.fromEntries(Object.entries(formats).map(([type, value]) => [type, new Blob([new Uint8Array('bytes' in value ? value.bytes : [])], { type })])))));
			}, previous);
		}
	}
});

test('host screenshot captures a PNG and releases the browser capture stream', async ({ workbench, target }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	if (target.kind === 'browser') {
		await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 48; canvas.height = 36;
			canvas.getContext('2d')!.fillRect(0, 0, 48, 36);
			const stream = canvas.captureStream(10);
			Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => stream });
			(window as Window & { ashContextCapture?: MediaStream; }).ashContextCapture = stream;
		});
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: target.kind === 'browser' ? 'Screenshot…' : 'Screenshot Window', exact: true }).click();
	const image = chat.getByRole('img', { name: 'Screenshot', exact: true });
	await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
	if (target.kind === 'browser') {
		await expect.poll(() => page.evaluate(() => (window as Window & { ashContextCapture?: MediaStream; }).ashContextCapture!.getTracks().map(track => track.readyState))).toEqual(['ended']);
		await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([48, 36]);
	}
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await chat.getByRole('button', { name: 'Remove Screenshot', exact: true }).press('Enter');
});


test('browser screen chooser cancellation returns to the attachment picker', async ({ workbench, target }) => {
	test.skip(target.kind !== 'browser', 'Only Browser uses the system screen chooser');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	await page.evaluate(() => {
		Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => { throw new DOMException('Cancelled', 'NotAllowedError'); } });
	});
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Screenshot…', exact: true }).click();
	await expect(page.getByRole('dialog').getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(chat.getByRole('list', { name: 'Attached context' })).toBeHidden();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});

test('Sessions direct image pastes use the shared resizing and preview path', async ({ workbench, target }) => {
	const page = await workbench.openAgentsWindow(target.kind);
	const composer = page.locator('.ash-sessions-chat-slot.active:visible');
	await composer.locator('.stanza-editor-input').evaluate(element => {
		const canvas = document.createElement('canvas'); canvas.width = 3072; canvas.height = 1536;
		canvas.getContext('2d')!.fillRect(0, 0, 3072, 1536);
		const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
		const clipboardData = new DataTransfer();
		clipboardData.items.add(new File([bytes], 'direct-paste.png', { type: 'image/png' }));
		element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	});
	const image = composer.getByRole('img', { name: 'direct-paste.png', exact: true });
	await expect.poll(() => image.evaluate(element => [(element as HTMLImageElement).naturalWidth, (element as HTMLImageElement).naturalHeight])).toEqual([2048, 1024]);
	await expect(composer.getByRole('list', { name: 'Attached context' }).getByRole('listitem')).toHaveCount(1);
	await composer.getByRole('button', { name: 'Remove direct-paste.png', exact: true }).press('Enter');
	await expect(composer.locator('.stanza-editor-input')).toBeFocused();
});

test('terminal, symbol and search context source buttons return to their product owners', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires workspace search, symbols and a real shell.');
	const page = workbench.page;
	await page.getByRole('button', { name: 'Toggle Panel Visibility', exact: true }).click();
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeAttached();
	await workbench.terminal.runCommand(`node -e "console.log(['ash','context-ready'].join('-'))"`);
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-context-ready');
	await workbench.search.open();
	await workbench.search.search('const value');
	await expect(workbench.search.status).toHaveText('1 results');
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const add = chat.getByRole('button', { name: 'Add context', exact: true });
	const picker = page.getByRole('dialog');
	await add.press('Enter');
	await picker.getByRole('option', { name: 'Terminal…', exact: true }).click();
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Select a terminal to attach its selection or recent output');
	await page.keyboard.press('Control+Enter');
	await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
	await picker.getByRole('option', { name: 'Symbols…', exact: true }).click();
	await picker.getByRole('combobox').fill('main');
	await expect(picker.getByRole('option', { name: /main/ }).first()).toBeVisible();
	await picker.getByRole('option', { name: /main/ }).first().click();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await add.press('Enter');
	await picker.getByRole('option', { name: 'Search Results', exact: true }).click();
	await expect(chat.getByRole('list', { name: 'Attached context' }).getByRole('listitem')).toHaveCount(3);
	await chat.getByRole('button', { name: 'Open Search Results: const value', exact: true }).press('Enter');
	await expect(workbench.search.query).toBeFocused();
	await chat.getByRole('button', { name: 'Open main', exact: true }).press('Enter');
	await expect(page.getByRole('tab', { name: 'main.rs', exact: true })).toHaveAttribute('aria-selected', 'true');
	await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
	await expect(workbench.terminal.tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
	await chat.getByRole('button', { name: /^Open Terminal:/ }).press('Enter');
	await expect(workbench.terminal.tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await expect(workbench.terminal.activeInstance.locator('.xterm-rows')).toContainText('ash-context-ready');
});

const instructionTest = test.extend({
	testWorkspace: async ({ }, use) => {
		const workspace = await createTestWorkspace();
		try {
			await mkdir(join(workspace.directory, '.ash/instructions'), { recursive: true });
			await writeFile(join(workspace.directory, '.ash/instructions/review.md'), '---\nname: review\ndescription: Check public contracts\nload: on-demand\n---\nCheck API compatibility before making changes.');
			await use(workspace);
		} finally {
			await disposeTestWorkspace(workspace);
		}
	},
});

instructionTest('instruction context discovers the authorized directory and opens its source', async ({ target, workbench }) => {
	instructionTest.skip(target.appServerMode !== 'required', 'Requires the backend instruction catalog.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Instructions…', exact: true }).click();
	await page.getByRole('dialog').getByRole('combobox').fill('contracts');
	await page.getByRole('dialog').getByRole('option', { name: /review/ }).click();
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	await chat.getByRole('button', { name: 'Open review', exact: true }).press('Enter');
	await expect(page.getByRole('tab', { name: 'review.md', exact: true })).toHaveAttribute('aria-selected', 'true');
	await expect(workbench.editors.groupAt(0).content.locator('.stanza-editor-input:visible')).toBeFocused();
});

test('live GitHub account attaches a real issue and pull request through the context picker', async ({ target, workbench, webAppServer }) => {
	test.skip(target.kind !== 'browser' || !webAppServer || process.env.ASH_TEST_GITHUB_LIVE !== '1', 'Opt-in account integration against an isolated Web test profile.');
	const page = workbench.page;
	let accountId: string | undefined;
	try {
		// Authentication uses the existing browser connection while tracing is stopped;
		// the credential is confined to this disposable profile and never recorded in an artifact.
		await page.context().tracing.stop();
		try {
			const { stdout } = await promisify(execFile)('gh', ['auth', 'token'], { encoding: 'utf8' });
			accountId = await page.evaluate(async accessToken => {
				const account = await globalThis.ashWebWorkbenchHost!.api.github.connectToken('github.com', accessToken);
				return account.id;
			}, stdout.trim());
		} finally {
			await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
		}
		const { issue, pr } = await page.evaluate(async ({ accountId, state }) => {
			const github = globalThis.ashWebWorkbenchHost!.api.github;
			const repository = { accountId, host: 'github.com', owner: 'microsoft', name: 'vscode' };
			return {
				issue: (await github.listIssues(repository, state, '', 1)).items[0]!,
				pr: (await github.listPullRequests(repository, state, 1)).items[0]!,
			};
		}, { accountId: accountId!, state: GitHubIssueState.Open });
		expect(issue.number).toBeGreaterThan(0);
		expect(pr.number).toBeGreaterThan(0);
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		for (const item of [{ label: 'Issue…', url: issue.url, number: issue.number }, { label: 'Pull Request…', url: pr.url, number: pr.number }]) {
			await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
			await page.getByRole('dialog').getByRole('option', { name: item.label, exact: true }).click();
			await page.getByRole('dialog').getByRole('combobox').fill(item.url);
			await page.keyboard.press('Enter');
			await expect(chat.getByRole('list', { name: 'Attached context' })).toContainText(`microsoft/vscode #${item.number}`);
		}
		await expect(chat.getByRole('list', { name: 'Attached context' }).getByRole('listitem')).toHaveCount(2);
		await expect(chat.locator('.stanza-editor-input')).toBeFocused();
	} finally {
		if (accountId) {
			await page.evaluate(accountId => globalThis.ashWebWorkbenchHost!.api.accounts.logout({ provider: 'github', accountId }), accountId);
		}
	}
});

test('tool context reads the current backend catalog and opens Tools settings', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the backend tool catalog.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Tools…', exact: true }).click();
	await page.getByRole('dialog').getByRole('combobox').fill('read_file');
	await page.getByRole('dialog').getByRole('option', { name: /^read_file(?:\s|$)/ }).click();
	await chat.getByRole('button', { name: 'Open Tool: read_file', exact: true }).press('Enter');
	await expect(page.locator('[data-active-settings-category="tools"]')).toBeVisible();
	await expect(page.locator('.ash-agent-capabilities-list')).toContainText('read_file');
});


test('Sessions tool context opens the current Tools catalog in its settings dialog', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the backend tool catalog.');
	const page = await workbench.openAgentsWindow(target.kind);
	const chat = page.locator('.ash-sessions-chat-slot.active:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Tools…', exact: true }).click();
	await page.getByRole('dialog').getByRole('combobox').fill('read_file');
	await page.getByRole('dialog').getByRole('option', { name: /^read_file(?:\s|$)/ }).click();
	await chat.getByRole('button', { name: 'Open Tool: read_file', exact: true }).press('Enter');
	const settings = page.getByRole('dialog', { name: 'Sessions Settings', exact: true });
	await expect(settings.getByRole('button', { name: 'Tools', exact: true })).toHaveAttribute('aria-current', 'page');
	await expect(settings.locator('.ash-agent-capabilities-list')).toContainText('read_file');
	await page.keyboard.press('Escape');
	await expect(settings).toBeHidden();
	await expect(chat.getByRole('button', { name: 'Open Tool: read_file', exact: true })).toBeFocused();
});


instructionTest('Sessions instruction context is available before its first turn', async ({ target, workbench }) => {
	instructionTest.skip(target.appServerMode !== 'required', 'Requires the backend instruction catalog.');
	const page = await workbench.openAgentsWindow(target.kind);
	const chat = page.locator('.ash-sessions-chat-slot.active:visible');
	await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
	await page.getByRole('dialog').getByRole('option', { name: 'Instructions…', exact: true }).click();
	await page.getByRole('dialog').getByRole('combobox').fill('contracts');
	await page.getByRole('dialog').getByRole('option', { name: /review/ }).click();
	await expect(chat.getByRole('list', { name: 'Attached context' })).toContainText('review');
	await expect(chat.locator('.stanza-editor-input')).toBeFocused();
});

for (const surface of ['Workbench', 'Sessions']) {
	test(`${surface} tool selection controls the backend catalog and removal restores tools`, async ({ target, workbench }) => {
		test.skip(target.appServerMode !== 'required', 'Requires the backend tool catalog.');
		const page = surface === 'Sessions' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		if (surface === 'Workbench' && !await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const chat = page.locator(surface === 'Sessions' ? '.ash-sessions-chat-slot.active:visible' : '.ash-chat-view-pane .ash-chat:visible');
		const picker = page.getByRole('dialog');
		const openTools = async (): Promise<void> => {
			await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
			await picker.getByRole('option', { name: 'Tools…', exact: true }).click();
		};
		await openTools();
		await picker.getByRole('option', { name: 'Configure tools…', exact: true }).click();
		await picker.getByRole('combobox').fill('read_file');
		await picker.getByRole('option', { name: /^read_file(?:\s|$)/ }).press('Enter');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText('Disabled');
		await picker.getByRole('option', { name: 'Apply tool selection', exact: true }).click();
		await expect(chat.getByRole('list', { name: 'Attached context' })).toContainText('Tool selection: 1 disabled');
		await openTools();
		await picker.getByRole('combobox').fill('read_file');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toHaveCount(0);
		await picker.getByRole('option', { name: 'Configure tools…', exact: true }).click();
		await picker.getByRole('combobox').fill('read_file');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toContainText('Disabled');
		await page.keyboard.press('Escape');
		await expect(picker.getByRole('combobox')).toHaveAttribute('placeholder', 'Search attachments');
		await page.keyboard.press('Escape');
		await chat.getByRole('button', { name: 'Remove Tool selection: 1 disabled', exact: true }).click();
		await openTools();
		await picker.getByRole('combobox').fill('read_file');
		await expect(picker.getByRole('option', { name: /^read_file(?:\s|$)/ })).toHaveCount(1);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
	});
}
