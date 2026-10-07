import { expect, test } from '../../../automation/test.js';

test('Empty chat keeps its input near the pane edges', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	await expect(chat).toHaveClass(/empty/u);
	await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
	const layout = await chat.evaluate(element => {
		const list = element.querySelector<HTMLElement>('.ash-chat-list-widget');
		const input = element.querySelector<HTMLElement>('.ash-chat-input-part');
		const composer = element.querySelector<HTMLElement>('.ash-chat-input-container');
		const toolbar = element.querySelector<HTMLElement>('.ash-chat-input-toolbars');
		const editor = element.querySelector<HTMLElement>('.ash-chat-input-editor');
		const action = element.querySelector<HTMLElement>('.ash-chat-input-mode-action');
		if (!list || !input || !composer || !toolbar || !editor || !action) throw new Error('Chat layout is incomplete');
		const chatBounds = element.getBoundingClientRect();
		const inputBounds = input.getBoundingClientRect();
		const composerBounds = composer.getBoundingClientRect();
		const editorBounds = editor.getBoundingClientRect();
		const toolbarBounds = toolbar.getBoundingClientRect();
		return {
			listHeight: list.getBoundingClientRect().height,
			inputTopInset: inputBounds.top - chatBounds.top,
			composerTopInset: composerBounds.top - inputBounds.top,
			composerBottomInset: inputBounds.bottom - composerBounds.bottom,
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
		inputTopInset: 0,
		composerTopInset: 4,
		composerBottomInset: 4,
		composerLeftInset: 12,
		composerRightInset: 12,
		composerHeight: 144,
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

test('Agent mode picker compacts when the model needs room', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-container');
	const picker = composer.locator('[data-action-id="ash.chat.input.mode"] button');
	const label = picker.locator('.ash-icon-label-container');
	try {
		await composer.evaluate(element => { element.style.width = '380px'; });
		await expect(label).toBeVisible();
		await composer.evaluate(element => { element.style.width = '320px'; });
		await expect(label).toBeVisible();
		await composer.evaluate(element => { element.style.width = '180px'; });
		await expect(label).toBeHidden();
		await expect(picker.locator('.ash-icon-label-icon')).toBeVisible();
		await expect(picker.locator('.ash-chat-input-mode-indicator')).toBeVisible();
		await expect(picker).toHaveAttribute('aria-label', /^Mode: /);
		const triggerBounds = await picker.evaluate(button => {
			const icon = button.querySelector<HTMLElement>('.ash-icon-label-icon');
			const indicator = button.querySelector<HTMLElement>('.ash-chat-input-mode-indicator');
			if (!icon || !indicator) throw new Error('Agent mode trigger is incomplete');
			const buttonBounds = button.getBoundingClientRect();
			return {
				iconInside: icon.getBoundingClientRect().left >= buttonBounds.left,
				indicatorInside: indicator.getBoundingClientRect().right <= buttonBounds.right,
			};
		});
		expect(triggerBounds).toEqual({ iconInside: true, indicatorInside: true });
		await picker.press('ArrowDown');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await expect(menu).toBeVisible();
		await menu.press('Escape');
		await expect(picker).toBeFocused();
		await composer.evaluate(element => { element.style.width = '380px'; });
		await expect(label).toBeVisible();
	} finally {
		await composer.evaluate(element => { element.style.removeProperty('width'); });
	}
});

test('Chat can switch from Plan back to Agent without selecting a different Agent', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	await picker.press('ArrowDown');
	let menu = page.locator('.ash-chat-input-mode-menu');
	await menu.getByRole('menuitemradio', { name: 'Plan', exact: true }).click();
	await expect(picker).toHaveText('Plan');
	await picker.press('ArrowDown');
	menu = page.locator('.ash-chat-input-mode-menu');
	await expect(menu.getByRole('menuitemradio', { name: 'Plan', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
	const agent = menu.getByRole('menuitemradio', { name: 'Agent', exact: true });
	await expect(agent).toBeEnabled();
	await agent.click();
	await expect(picker).toHaveText('Agent');
	await picker.press('ArrowDown');
	await expect(menu.getByRole('menuitemradio', { name: 'Agent', exact: true })).toHaveAttribute('aria-checked', 'true');
	await expect(menu.getByRole('menuitemradio', { name: 'Agent', exact: true })).toBeFocused();
	await menu.press('Escape');
	await expect(picker).toBeFocused();
});

test('Chat mode picker exposes all five modes with one checked selection', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	for (const name of ['Agent', 'Plan', 'Debug', 'Multitask', 'Ask']) {
		await picker.press('ArrowDown');
		const menu = page.locator('.ash-chat-input-mode-menu');
		await menu.getByRole('menuitemradio', { name, exact: true }).click();
		await expect(picker).toHaveText(name);
		await picker.press('ArrowDown');
		await expect(menu.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
		await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeFocused();
		// Agent choices are a separate radio group; the five mode actions have exactly one choice.
		await expect(menu.getByRole('menuitemradio', { name: /^(Agent|Plan|Debug|Multitask|Ask)$/ }).and(menu.locator('[aria-checked="true"]'))).toHaveCount(1);
		await menu.press('Escape');
		await expect(picker).toBeFocused();
	}
});

test('Chat mode choices use the shared action widget and floating elevation across themes', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const picker = page.locator('.ash-chat-view-pane .ash-chat:visible [data-action-id="ash.chat.input.mode"] button');
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		const search = page.locator('.ash-quick-pick').getByRole('combobox');
		await search.fill(theme);
		await search.press('Enter');
		await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
		await picker.press('ArrowDown');
		const widget = page.locator('.ash-action-widget.ash-chat-input-mode-menu');
		await expect(widget).toBeVisible();
		const geometry = await widget.evaluate(element => ({
			width: element.getBoundingClientRect().width,
			overflow: element.scrollWidth - element.clientWidth,
			truncated: [...element.querySelectorAll('.ash-button-label')].some(label => label.scrollWidth > label.clientWidth),
		}));
		expect(geometry.width).toBeGreaterThanOrEqual(100);
		expect(geometry.width).toBeLessThan(240);
		expect(geometry.overflow).toBe(0);
		expect(geometry.truncated).toBe(false);
		const shell = widget.locator('..');
		await expect(shell).toHaveCSS('box-shadow', 'none');
		await expect(shell).toHaveCSS('border-width', '0px');
		await expect(shell).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(widget).toHaveCSS('box-shadow', theme.includes('High Contrast') ? 'none' : 'rgba(0, 0, 0, 0.14) 0px 0px 12px 0px');
		await expect(widget).toHaveCSS('border-radius', '8px');
		await expect(widget).toHaveCSS('border-style', 'solid');
		expect(await widget.evaluate(element => Math.round(parseFloat(getComputedStyle(element).borderTopWidth)))).toBe(1);
		await expect(widget).toHaveCSS('font-size', '13px');
		const agent = widget.getByRole('menuitemradio', { name: 'Agent', exact: true });
		await expect(agent).toBeFocused();
		await expect(agent).toHaveAttribute('aria-checked', 'true');
		await expect(agent.locator('.ash-icon-label-icon svg[data-ash-icon-id="unlimited"]')).toBeVisible();
		await expect(agent.locator('.ash-menu-leading-check > svg[data-ash-icon-id="check"]')).toBeVisible();
		if (theme === 'Ash Light') {
			await agent.press('Alt+F1');
			const help = page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
			await expect(help).toBeVisible();
			await expect(help.getByRole('textbox')).toHaveValue(/Use Up and Down Arrow to move between available actions/);
			await help.press('Escape');
			await expect(help).toHaveCount(0);
			await expect(agent).toBeFocused();
		}
		await agent.press('ArrowDown');
		await expect(widget.getByRole('menuitemradio', { name: 'Plan', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(widget).toHaveCount(0);
		await expect(picker).toBeFocused();
	}
});

test('Model picker uses free toolbar space before truncating its label', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const composer = page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-input-container');
	const modelLabel = composer.locator('.ash-chat-input-model-action .ash-chat-input-picker-label');
	// The disconnected catalog only exposes a short label; exercise the toolbar with a longer model name.
	await modelLabel.evaluate(element => { element.textContent = 'GPT-5.6 Sol Extended Context Preview'; });
	const overflow = async (): Promise<number> => modelLabel.evaluate(element => element.scrollWidth - element.clientWidth);
	try {
		await composer.evaluate(element => { element.style.width = '520px'; });
		await expect.poll(overflow).toBeLessThanOrEqual(1);
		await composer.evaluate(element => { element.style.width = '280px'; });
		await expect.poll(overflow).toBeGreaterThan(1);
		const narrowLayout = await composer.evaluate(element => {
			const toolbar = element.querySelector<HTMLElement>('.ash-chat-input-toolbars');
			const model = element.querySelector<HTMLElement>('.ash-chat-input-model-selector');
			const mic = element.querySelector<HTMLElement>('.ash-chat-input-mic');
			const send = element.querySelector<HTMLElement>('.ash-chat-input-send, .ash-chat-input-voice');
			if (!toolbar || !model || !mic || !send) throw new Error('Chat toolbar is incomplete');
			return {
				modelBeforeMic: model.getBoundingClientRect().right <= mic.getBoundingClientRect().left,
				sendInsideToolbar: send.getBoundingClientRect().right <= toolbar.getBoundingClientRect().right + 1,
			};
		});
		expect(narrowLayout).toEqual({ modelBeforeMic: true, sendInsideToolbar: true });
		await composer.evaluate(element => { element.style.width = '520px'; });
		await expect.poll(overflow).toBeLessThanOrEqual(1);
	} finally {
		await composer.evaluate(element => { element.style.removeProperty('width'); });
	}
});

test('Chat input omits the unused find control and keeps the prompt evenly inset', async ({ workbench }) => {
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const findOptions = page.locator('.ash-chat:visible .stanza-editor-find-options-widget');
	await expect(findOptions).toHaveCount(0);
	const editorChrome = await page.locator('.ash-chat:visible .ash-chat-input-editor').evaluate(editor => {
		const viewport = editor.querySelector<HTMLElement>('.stanza-editor');
		const placeholder = editor.querySelector<HTMLElement>('.stanza-editor-placeholder-text');
		const ruler = editor.querySelector<HTMLElement>('.decorationsOverviewRuler');
		const container = editor.closest<HTMLElement>('.ash-chat-input-container');
		const attachments = container?.querySelector<HTMLElement>('.ash-chat-input-attachments');
		if (!viewport || !placeholder || !ruler || !container || !attachments) throw new Error('Chat editor viewport is incomplete');
		const placeholderBounds = placeholder.getBoundingClientRect();
		const containerBounds = container.getBoundingClientRect();
		return {
			textInset: placeholderBounds.left - viewport.getBoundingClientRect().left,
			textTopInset: placeholderBounds.top - containerBounds.top,
			textLeftInset: placeholderBounds.left - containerBounds.left,
			editorTopInset: viewport.getBoundingClientRect().top - containerBounds.top,
			textInsetWithinEditor: placeholderBounds.top - viewport.getBoundingClientRect().top,
			attachmentsDisplay: getComputedStyle(attachments).display,
			rulerDisplay: getComputedStyle(ruler).display,
			viewportBackground: getComputedStyle(viewport).backgroundColor,
			editorBackground: getComputedStyle(viewport).getPropertyValue('--ash-editor-background').trim(),
			inputBackground: getComputedStyle(viewport).getPropertyValue('--ash-input-background').trim(),
		};
	});
	expect(editorChrome.textInset).toBe(0);
	expect(editorChrome.textTopInset).toBe(9);
	expect(editorChrome.textLeftInset).toBe(9);
	expect(editorChrome.editorTopInset).toBe(9);
	expect(editorChrome.textInsetWithinEditor).toBe(0);
	expect(editorChrome.attachmentsDisplay).toBe('none');
	expect(editorChrome.rulerDisplay).toBe('none');
	expect(editorChrome.viewportBackground).toBe('rgba(0, 0, 0, 0)');
	expect(editorChrome.editorBackground).toBe(editorChrome.inputBackground);
});

test('Chat input places the microphone beside voice or send at the right edge', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
	const toolbar = chat.locator('.ash-chat-input-toolbars');
	const rightActionLayout = async (actionId: string) => toolbar.evaluate((element, id) => {
		const mic = element.querySelector<HTMLElement>('[data-action-id="ash.chat.input.mic"]');
		const action = element.querySelector<HTMLElement>(`[data-action-id="${id}"]`);
		if (!mic || !action) throw new Error('Chat input actions are incomplete');
		const micBounds = mic.getBoundingClientRect();
		const actionBounds = action.getBoundingClientRect();
		return {
			micLeft: micBounds.left,
			toolbarMiddle: element.getBoundingClientRect().left + element.getBoundingClientRect().width / 2,
			gap: actionBounds.left - micBounds.right,
			rightInset: element.getBoundingClientRect().right - actionBounds.right,
		};
	}, actionId);
	await expect(toolbar.locator('[data-action-id="ash.chat.input.attachment"]')).toHaveCount(0);
	await expect(toolbar.locator('[data-action-id="ash.chat.input.mic"] button')).toHaveCount(1);
	const voiceButton = toolbar.locator('[data-action-id="ash.chat.input.voice"] button');
	await expect(voiceButton).toBeVisible();
	const emptyLayout = await rightActionLayout('ash.chat.input.voice');
	expect(emptyLayout.micLeft).toBeGreaterThan(emptyLayout.toolbarMiddle);
	expect(emptyLayout.gap).toBeGreaterThanOrEqual(0);
	expect(emptyLayout.gap).toBeLessThanOrEqual(16);
	expect(emptyLayout.rightInset).toBeLessThanOrEqual(2);
	await expect(voiceButton.locator('[data-ash-icon-id="voice-mode"]')).toHaveCount(1);
	const shape = await voiceButton.evaluate(button => {
		const bounds = button.getBoundingClientRect();
		return { width: bounds.width, height: bounds.height, radius: getComputedStyle(button).borderRadius, background: getComputedStyle(button).backgroundColor };
	});
	expect(shape.width).toBe(shape.height);
	expect(shape.radius).toBe('50%');
	expect(shape.background).not.toBe('rgba(0, 0, 0, 0)');
	const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('Hello');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"]')).toHaveCount(0);
	const sendButton = toolbar.locator('[data-action-id="ash.chat.input.send"] button');
	await expect(sendButton.locator('[data-ash-icon-id="arrow-up"]')).toHaveCount(1);
	await expect(sendButton).toHaveCSS('border-radius', '50%');
	const messageLayout = await rightActionLayout('ash.chat.input.send');
	expect(messageLayout.micLeft).toBeGreaterThan(messageLayout.toolbarMiddle);
	expect(messageLayout.gap).toBeGreaterThanOrEqual(0);
	expect(messageLayout.gap).toBeLessThanOrEqual(16);
	expect(messageLayout.rightInset).toBeLessThanOrEqual(2);
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.voice"] button')).toBeVisible();
	await page.keyboard.insertText('/config');
	await expect(toolbar.locator('[data-action-id="ash.chat.input.mic"]')).toHaveCount(0);
	const commandRightInset = await toolbar.evaluate(element => {
		const send = element.querySelector<HTMLElement>('[data-action-id="ash.chat.input.send"]');
		if (!send) throw new Error('Chat send action is missing');
		return element.getBoundingClientRect().right - send.getBoundingClientRect().right;
	});
	expect(commandRightInset).toBeLessThanOrEqual(2);
});

test('Desktop Chat guides a missing local model to Dictation settings without opening the microphone', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the connected desktop');
	const page = workbench.page;
	const original = await page.evaluate(async () => {
		return (await globalThis.ashTestMainProcess.call('configuration', 'read') as { document: { source: string; }; }).document.source;
	});
	await page.evaluate(async () => {
		const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; document: { source: string; }; };
		const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
		settings['dictation.backend'] = 'local';
		settings['dictation.localModel'] = 'ash-playwright-missing-model';
		await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
	});
	try {
		if (!await page.locator('.ash-chat-view-pane').isVisible()) {
			await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
		}
		const chat = page.locator('.ash-chat-view-pane .ash-chat:visible');
		const composer = chat.locator('.ash-chat-input-container');
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(composer).toHaveCSS('height', '144px');
		const input = chat.locator('.ash-chat-input-editor .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('Keep this draft');
		const button = chat.locator('[data-action-id="ash.chat.input.mic"] button');
		await expect(button).toBeEnabled();
		await expect(button).toHaveAttribute('aria-label', 'Dictate message');
		await button.focus();
		await page.keyboard.press('Enter');
		const voice = page.getByRole('dialog', { name: 'Ash Settings' });
		await expect(voice.getByRole('grid', { name: 'Local dictation models' })).toBeVisible();
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(voice.getByRole('row').filter({ hasText: 'ash-playwright-missing-model' })).toBeVisible();
		const microphone = voice.getByRole('combobox', { name: 'Microphone', exact: true });
		const language = voice.getByRole('combobox', { name: 'Transcription language', exact: true });
		await expect(microphone).toBeEnabled();
		await expect(language).toBeDisabled();
		await microphone.click();
		await page.getByRole('option', { name: 'System default microphone', exact: true }).click();
		await voice.locator('[data-configuration-key="dictation.backend"]').getByRole('combobox').click();
		await page.getByRole('option', { name: 'Cloud', exact: true }).click();
		await expect(language).toBeEnabled();
		await language.focus();
		await page.keyboard.press('Home');
		await page.keyboard.press('Enter');
		await voice.locator('.ash-modal-editor-close').click();
		await expect(page.locator('.ash-chat-view-pane .ash-chat:visible .ash-chat-status')).not.toContainText('Could not read dictation model package');
		await expect(button).not.toHaveAttribute('aria-pressed', 'true');
		await expect(chat.locator('.ash-chat-model-preparation')).toHaveCount(0);
		await expect(composer).toHaveCSS('height', '144px');
		await expect(chat.locator('.stanza-editor-line-text')).toHaveText('Keep this draft');
		await button.focus();
		await workbench.quickaccess.runCommand('workbench.action.chat.dictation.showIntroduction');
		const introduction = page.getByRole('region', { name: 'Dictation introduction', exact: true });
		await expect(introduction).toBeVisible();
		await expect(introduction.getByRole('combobox', { name: 'Microphone', exact: true })).toBeEnabled();
		await introduction.getByRole('button', { name: 'Done', exact: true }).focus();
		await page.keyboard.press('Escape');
		await expect(introduction).toHaveCount(0);
	} finally {
		await page.evaluate(async source => {
			const snapshot = await globalThis.ashTestMainProcess.call('configuration', 'read') as { revision: number; };
			await globalThis.ashTestMainProcess.call('configuration', 'update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Chat input resizes with wrapped text and retains keyboard focus', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const host = page.locator('.ash-chat-input-editor-host');
	const editor = host.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await expect(editor).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion')).toHaveCount(1);
	await host.evaluate(element => element.style.width = '180px');
	await input.focus();
	await page.keyboard.insertText('word '.repeat(80));
	await expect(editor).toHaveCSS('height', '314px');
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '1000px');
	await expect(editor).toHaveCSS('height', '100px');
	await expect(input).toBeFocused();

	await host.evaluate(element => element.style.width = '180px');
	await expect(editor).toHaveCSS('height', '314px');
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.press('Backspace');
	await expect(editor).toHaveCSS('height', '100px');
	await expect(input).toBeFocused();
});

test('Chat input explicitly opens slash suggestions from the keyboard', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/history argument');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Home');
	for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Control+Space');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/history', { exact: true })).toBeVisible();
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/config', { exact: true })).toBeVisible();
	await expect(input).toBeFocused();
});

test('Chat input returns to the empty message state when a slash command is deleted', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/x');
	await expect(editor.locator('.stanza-editor-completion.visible')).toHaveCount(0);
	await page.keyboard.press('Backspace');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/');
	await page.keyboard.press('Backspace');
	await expect(editor.locator('.stanza-editor-completion.visible')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-placeholder-text')).toBeVisible();
	await expect(input).toBeFocused();
});

test('Chat input suggests and completes a command with a missing character', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/');
	await expect(editor.locator('.stanza-editor-completion-label').getByText('/config', { exact: true })).toBeVisible();
	await page.keyboard.type('cofig');

	await expect(editor.locator('.stanza-editor-completion-label')).toHaveText(['/config']);
	await expect(editor.locator('.stanza-editor-completion-option.focused')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-completion-option')).toHaveAttribute('aria-selected', 'false');
	await expect(editor.locator('.stanza-editor-completion-label strong')).toHaveText(['c', 'o', 'f', 'i', 'g']);
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/cofig');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(editor.locator('.stanza-editor-line-text')).toHaveText('/config');
});

test('Chat input matches slash command descriptions without selecting a command', async ({ target, workbench }) => {
	test.skip(target.appServerMode !== 'disabled', 'Uses the disconnected Chat shell.');
	const page = workbench.page;
	if (!await page.locator('.ash-chat-view-pane').isVisible()) {
		await page.getByRole('button', { name: 'Show Secondary Side Bar', exact: true }).click();
	}
	const editor = page.locator('.ash-chat-input-editor');
	const input = editor.locator('.stanza-editor-input');
	await input.focus();
	await page.keyboard.insertText('/');
	await page.keyboard.type('settings');
	await expect(editor.locator('.stanza-editor-completion-label')).toHaveText(['/config']);
	await expect(editor.locator('.stanza-editor-completion-option.focused')).toHaveCount(0);
	await expect(editor.locator('.stanza-editor-completion-option')).toHaveAttribute('aria-selected', 'false');
	await expect(editor.locator('.stanza-editor-completion-detail strong')).toHaveText([...'settings']);
});
