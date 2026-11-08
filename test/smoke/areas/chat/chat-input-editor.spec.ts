import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test, writeEditorExtensionFixture } from '../../../automation/test.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Chat context extensions activate on first selection and preserve captured content after disablement', { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace }) => {
	test.setTimeout(180_000);
	const root = join(testWorkspace.directory, 'context-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin/plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/context-smoke', version: '1.0.0', displayName: 'Context provider smoke',
		compatibility: { ash: '>=0.1.0' }, permissions: [],
		contributions: {
			editorExtensions: [{
				id: 'context', runtime: 'javascript', api: 'ash', entrypoint: 'extension.js', runtimeApiVersion: 1,
				activationEvents: [{ type: 'onDemand', capability: 'dataChannel' }], capabilities: ['command', 'dataChannel']
			}]
		},
	}));
	await writeEditorExtensionFixture(root, `
const ash = require('@ash/sdk');
exports.activate = context => {
 context.subscriptions.push(ash.chat.registerChatExplicitContextProvider('records', {
  provideChatContext() { return [{ label: 'Record snapshot', recordId: 'alpha', command: { command: 'acme.context.open', title: 'Open record' } }]; },
  resolveChatContext(item) { return { ...item, value: 'Captured record ' + item.recordId }; }
 }), ash.commands.register('acme.context.open', item => ash.window.showInformationMessage('Record ' + item.recordId + ' from extension')));
};`);
	const manifestPath = join(root, 'package.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	manifest.activationEvents = ['onDemand:dataChannel'];
	manifest.contributes.chatContext = [{ id: 'records', displayName: 'Context records', icon: '$(file)' }];
	await writeFile(manifestPath, JSON.stringify(manifest));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const install = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await install.getByRole('textbox').fill('context-extension');
	await workbench.dialogs.expectMessage(application, 'Information', () => install.getByRole('textbox').press('Enter'));
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	await page.locator('[data-package-id="acme/context-smoke"]').click();
	const details = page.locator('.ash-extension-editor:visible').filter({ hasText: 'acme/context-smoke' });
	await workbench.dialogs.confirm(application, 'Context provider smoke', 'Grant permissions', () => details.getByRole('button', { name: 'Grant permissions', exact: true }).click());
	await expect(details).toHaveAttribute('aria-busy', 'false');
	if (!await details.getByRole('switch').isChecked()) await details.getByRole('switch').press('Space');
	await expect(details.getByRole('switch')).toBeChecked();
	await expect(details).toHaveAttribute('aria-busy', 'false');
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(async () => {
		await chat.getByRole('button', { name: 'Add context', exact: true }).press('Enter');
		try {
			await expect(page.getByRole('option', { name: 'Other context sources', exact: true })).toBeVisible({ timeout: 500 });
		} catch (error) {
			await page.keyboard.press('Escape');
			throw error;
		}
	}).toPass();
	await workbench.quickaccess.select('Other context sources');
	const picker = page.getByRole('dialog');
	await expect(picker).toContainText(/Context records|Record snapshot/);
	const source = picker.getByRole('option', { name: 'Context records', exact: true });
	if (await source.isVisible()) await source.press('Enter');
	await picker.getByRole('option', { name: 'Record snapshot', exact: true }).press('Enter');
	const reference = chat.getByRole('button', { name: 'Open Record snapshot', exact: true });
	await expect(reference).toBeVisible();
	await reference.press('Enter');
	await expect(page.locator('.ash-notification', { hasText: 'Record alpha from extension' })).toBeVisible();
	await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
	await page.locator('[data-package-id="acme/context-smoke"]').click();
	await details.getByRole('switch').press('Space');
	await expect(details.getByRole('switch')).not.toBeChecked();
	await workbench.quickaccess.runCommand('workbench.action.chat.open');
	await expect(reference).toBeVisible();
	await reference.hover();
	await expect(page.locator('.ash-hover pre')).toContainText('Captured record alpha');
});

test('Empty chat anchors its input and secondary toolbar to the bottom pane edge', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(chat).toHaveClass(/empty/u);
	const { surfaceHeight, surfaceCount, ...layout } = await chat.evaluate(element => {
		const list = element.querySelector<HTMLElement>('.ash-chat-list-widget');
		const input = element.querySelector<HTMLElement>('.ash-chat-input-part');
		const composer = element.querySelector<HTMLElement>('.ash-chat-input-container');
		const toolbar = element.querySelector<HTMLElement>('.ash-chat-input-toolbars');
		const editor = element.querySelector<HTMLElement>('.ash-chat-input-editor');
		const action = element.querySelector<HTMLElement>('.ash-chat-input-mode-action');
		const secondary = element.querySelector<HTMLElement>('.ash-chat-secondary-toolbar');
		if (!list || !input || !composer || !toolbar || !editor || !action || !secondary) throw new Error('Chat layout is incomplete');
		const chatBounds = element.getBoundingClientRect();
		const inputBounds = input.getBoundingClientRect();
		const composerBounds = composer.getBoundingClientRect();
		const editorBounds = editor.getBoundingClientRect();
		const toolbarBounds = toolbar.getBoundingClientRect();
		// A disconnected host can report a notice above an otherwise empty input.
		// Its content height varies; the stack must add exactly one gap per visible surface.
		const surfaces = Array.from(input.children).filter((child): child is HTMLElement =>
			child instanceof HTMLElement && child !== composer
			&& child.classList.contains('ash-chat-input-stack-slot')
			&& !!(child.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING)
			&& child.getBoundingClientRect().height > 0);
		return {
			surfaceHeight: surfaces.reduce((height, surface) => height + surface.getBoundingClientRect().height, 0),
			surfaceCount: surfaces.length,
			listHeight: list.getBoundingClientRect().height,
			inputBottomInset: chatBounds.bottom - inputBounds.bottom,
			composerTopInset: composerBounds.top - inputBounds.top,
			composerBottomInset: inputBounds.bottom - composerBounds.bottom,
			secondaryHeight: secondary.getBoundingClientRect().height,
			secondaryTopInset: secondary.getBoundingClientRect().top - composerBounds.bottom,
			secondaryBottomInset: inputBounds.bottom - secondary.getBoundingClientRect().bottom,
			composerLeftInset: composerBounds.left - inputBounds.left,
			composerRightInset: inputBounds.right - composerBounds.right,
			composerHeight: composerBounds.height,
			editorTopInset: editorBounds.top - composerBounds.top,
			editorLeftInset: editorBounds.left - composerBounds.left,
			editorRightInset: composerBounds.right - editorBounds.right,
			toolbarLeftInset: toolbarBounds.left - composerBounds.left,
			toolbarRightInset: composerBounds.right - toolbarBounds.right,
			toolbarHeight: toolbar.getBoundingClientRect().height,
			actionHeight: action.getBoundingClientRect().height,
			actionBottomInset: composerBounds.bottom - action.getBoundingClientRect().bottom,
		};
	});
	expect(layout).toEqual({
		listHeight: 0,
		inputBottomInset: 0,
		composerTopInset: 4 + surfaceHeight + surfaceCount * 8,
		composerBottomInset: 30,
		secondaryHeight: 22,
		secondaryTopInset: 4,
		secondaryBottomInset: 4,
		composerLeftInset: 12,
		composerRightInset: 12,
		composerHeight: 84,
		editorTopInset: 9,
		editorLeftInset: 9,
		editorRightInset: 9,
		toolbarLeftInset: 9,
		toolbarRightInset: 9,
		toolbarHeight: 22,
		actionHeight: 22,
		actionBottomInset: 9,
	});
});

test('Chat mode changes reach the input and keyboard help restores its selected action', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const picker = chat.locator('[data-action-id="ash.chat.input.mode"] button');
	const welcome = chat.locator('.ash-chat-welcome');
	await expect(welcome.getByRole('heading', { name: 'Build with Agent' })).toBeVisible();
	await expect(chat.locator('.ash-chat-list-widget')).toHaveCSS('display', 'none');
	await expect(chat.getByRole('textbox', { name: 'Chat message' })).toBeVisible();
	for (const [name, title] of [['Plan', 'Start a conversation'], ['Ask', 'Ask about your code'], ['Agent', 'Build with Agent']]) {
		await picker.press('ArrowDown');
		await page.getByRole('menuitemradio', { name, exact: true }).click();
		await expect(picker).toHaveText(name);
		await expect(welcome.getByRole('heading', { name: title, exact: true })).toBeVisible();
	}
	await picker.press('ArrowDown');
	const widget = page.locator('.ash-action-widget.ash-chat-input-mode-menu');
	const agent = widget.getByRole('menuitemradio', { name: 'Agent', exact: true });
	await expect(agent).toBeFocused();
	await expect(agent).toHaveAttribute('aria-checked', 'true');
	await agent.press('Alt+F1');
	const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help).toBeVisible();
	await expect(help.getByRole('textbox')).toHaveValue(/Use Up and Down Arrow to move between available actions/);
	await help.press('Escape');
	await expect(help).toHaveCount(0);
	await expect(agent).toBeFocused();
	await agent.press('ArrowDown');
	await expect(widget.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(widget).toHaveCount(0);
	await expect(picker).toBeFocused();
});

test('Desktop Chat guides a missing local model to Dictation settings without opening the microphone', { tag: ['@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	const original = await (async () => {
		return (await readUserSettings(page)).content;
	})();
	await (async () => {
		const snapshot = await readUserSettings(page);
		const settings = JSON.parse(snapshot.content) as Record<string, unknown>;
		settings['dictation.backend'] = 'local';
		settings['dictation.model'] = 'ash-playwright-missing-model';
		await writeUserSettings(page, JSON.stringify(settings), snapshot.revision);
	})();
	try {
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const composer = chat.locator('.ash-chat-input-container');
		await expect(composer).toHaveCSS('height', '84px');
		const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('Keep this draft');
		const button = chat.locator('[data-action-id="workbench.action.chat.toggleSpeechToText"] .ash-chat-input-mic-action');
		await expect(button).toBeEnabled();
		await expect(button).toHaveAttribute('aria-label', 'Dictate message');
		await button.focus();
		await page.keyboard.press('Enter');
		const voice = page.getByRole('dialog', { name: 'Ash Settings' });
		await expect(voice.getByRole('group', { name: 'Local dictation models' })).toBeVisible();
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(voice.locator('[data-model-id="ash-playwright-missing-model"]')).toBeVisible();
		const microphone = voice.getByRole('combobox', { name: 'Microphone', exact: true });
		const language = voice.getByRole('combobox', { name: 'Transcription language', exact: true });
		await expect(microphone).toBeEnabled();
		await expect(language).toHaveCount(0);
		await microphone.click();
		await page.getByRole('option', { name: 'System', exact: true }).click();
		await voice.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Cloud', exact: true }).click();
		await expect(language).toBeEnabled();
		await language.focus();
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await voice.locator('.ash-modal-editor-close').click();
		await expect(chat.locator('.ash-chat-input-part [role="status"]').filter({ hasText: 'Could not read dictation model package' })).toHaveCount(0);
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(composer).toHaveCSS('height', '84px');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await button.focus();
		await workbench.quickaccess.runCommand('workbench.action.chat.showSpeechToTextIntroduction');
		const introduction = page.getByRole('region', { name: 'Dictation introduction', exact: true });
		await expect(introduction).toBeVisible();
		await expect(introduction.getByRole('combobox', { name: 'Microphone', exact: true })).toBeEnabled();
		await introduction.getByRole('button', { name: 'Done', exact: true }).focus();
		await page.keyboard.press('Escape');
		await expect(introduction).toHaveCount(0);
	} finally {
		await (async source => {
			const snapshot = await readUserSettings(page);
			await writeUserSettings(page, source, snapshot.revision);
		})(original);
	}
});

test('Chat input grows upward with wrapped text and retains keyboard focus', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const host = page.locator('.ash-chat-input-editor-host');
	const editor = host.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await expect(editor).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion')).toHaveCount(1);
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-container');
	const initialBounds = await composer.boundingBox();
	expect(initialBounds).not.toBeNull();
	await host.evaluate(element => element.style.width = '180px');
	await input.focus();
	await page.keyboard.insertText('word '.repeat(80));
	await expect(editor).toHaveCSS('height', '314px');
	await expect(input).toBeFocused();
	const expandedBounds = await composer.boundingBox();
	expect(expandedBounds).not.toBeNull();
	expect(expandedBounds!.y).toBeLessThan(initialBounds!.y);
	expect(expandedBounds!.y + expandedBounds!.height).toBeCloseTo(initialBounds!.y + initialBounds!.height, 0);

	await host.evaluate(element => element.style.width = '1000px');
	await expect.poll(() => editor.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(314);
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '180px');
	await expect(editor).toHaveCSS('height', '314px');
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(editor).toHaveCSS('height', '40px');
	await expect(input).toBeFocused();
	const restoredBounds = await composer.boundingBox();
	expect(restoredBounds).toEqual(initialBounds);
});

test('Chat completes catalog commands from the keyboard and restores the empty input', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-view-pane .ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/history argument');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Home');
	for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Control+Space');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/history', { exact: true })).toBeVisible();
	await editor.locator('.stanza-editor-completion-label').getByText('/config', { exact: true }).click();
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/config argument');
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	await expect(editor.locator('.stanza-editor-completion.visible')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-placeholder-text')).toBeVisible();
	await expect(input).toBeFocused();
	await page.keyboard.insertText('/permission ');
	await expect.poll(async () => (await editor.locator('.ash-chat-command-argument-hint').allTextContents()).join('')).toBe('<manual|auto|bypassPermissions>');
	await page.keyboard.insertText('manual');
	await expect(editor.locator('.ash-chat-command-argument-hint')).toHaveCount(0);
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	await input.press('Shift+Enter');
	await input.pressSequentially('  /');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/new', { exact: true })).toBeVisible();
	await editor.locator('.stanza-editor-completion-label').getByText('/new', { exact: true }).click();
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['', '  /new ']);
	await input.press('Backspace');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['', '  ']);
	await input.press('ControlOrMeta+z');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['', '  /new ']);
	await input.press('ControlOrMeta+Shift+z');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText(['', '  ']);
	await expect(input).toBeFocused();
	await input.press('ControlOrMeta+a');
	await input.press('Backspace');
	await expect(editor.locator('.stanza-editor-placeholder-text')).toBeVisible();
	await expect(input).toBeFocused();
});
