import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../../../automation/test.js';

interface DelayedClipboardRead {
	readonly calls: number;
	settle(outcome: 'resolve' | 'reject'): void;
	restore(): void;
}

for (const outcome of ['resolve', 'reject'] as const) {
	test(`cancelled browser paste ignores a late clipboard ${outcome} after a new paste`, { tag: ['@browser-ui', '@browser-app-server'] }, async ({ workbench }) => {
		const page = workbench.page;
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor('anchor');
		await page.evaluate(() => {
			const original = navigator.clipboard.readText;
			let resolve!: (text: string) => void;
			let reject!: (reason: Error) => void;
			const pending = new Promise<string>((accept, fail) => { resolve = accept; reject = fail; });
			let calls = 0;
			navigator.clipboard.readText = () => {
				calls++;
				return calls === 1 ? pending : Promise.resolve(calls === 2 ? 'fresh' : 'stale');
			};
			const fixture: DelayedClipboardRead = {
				get calls() { return calls; },
				settle(outcome) {
					if (outcome === 'reject') reject(new Error('Delayed clipboard read failed'));
					else resolve('stale');
				},
				restore() {
					resolve('');
					navigator.clipboard.readText = original;
				},
			};
			(window as unknown as { delayedClipboardRead: DelayedClipboardRead; }).delayedClipboardRead = fixture;
		});
		try {
			await editor.input.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
			await expect.poll(() => page.evaluate(() => (window as unknown as { delayedClipboardRead: DelayedClipboardRead; }).delayedClipboardRead.calls)).toBe(1);
			await editor.input.press('Home');
			await editor.input.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
			await editor.waitForEditorContents(text => text === 'freshanchor');
			await page.evaluate(outcome => (window as unknown as { delayedClipboardRead: DelayedClipboardRead; }).delayedClipboardRead.settle(outcome), outcome);
			if (outcome === 'reject') {
				// The clipboard owner still handles the failed read. Retrying it must
				// never revive the editor command whose selection was cancelled.
				const prompt = page.locator('.ash-notification').filter({ hasText: 'Unable to read the clipboard.' });
				await expect(prompt).toBeVisible();
				await prompt.getByRole('button', { name: 'Retry', exact: true }).click();
				await expect(prompt).toHaveCount(0);
				await expect.poll(() => page.evaluate(() => (window as unknown as { delayedClipboardRead: DelayedClipboardRead; }).delayedClipboardRead.calls)).toBe(3);
			}
			await editor.waitForEditorFocus();
			await editor.input.press('End');
			await editor.waitForTypeInEditor('!');
			await editor.waitForEditorContents(text => text === 'freshanchor!');
		} finally {
			await page.evaluate(() => {
				const state = window as unknown as { delayedClipboardRead?: DelayedClipboardRead; };
				state.delayedClipboardRead?.restore();
				delete state.delayedClipboardRead;
			});
		}
	});
}

test('editor paste reads text through the current Workbench clipboard service', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, target, application }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	if (target.kind === 'browser') {
		await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	}
	const read = (): Promise<string> => target.kind === 'electron'
		? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: page.evaluate(() => navigator.clipboard.readText());
	const write = async (text: string): Promise<void> => {
		if (target.kind === 'electron') {
			await (application as ElectronApplication).evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
		} else {
			await page.evaluate(value => navigator.clipboard.writeText(value), text);
		}
	};
	const previous = await read();
	try {
		await write('Workbench clipboard text');
		if (target.kind === 'electron') {
			await (application as ElectronApplication).evaluate(async ({ clipboard, ClipboardItem }) => {
				await clipboard.write([new ClipboardItem({ 'text/plain': 'Workbench clipboard text', 'text/html': '<b>Workbench clipboard text</b>' })]);
			});
			await page.evaluate(() => {
				const events: { text: string; html: string; trusted: boolean; }[] = [];
				(globalThis as unknown as { clipboardPasteEvents: typeof events; }).clipboardPasteEvents = events;
				document.addEventListener('paste', event => events.push({ text: event.clipboardData?.getData('text/plain') ?? '', html: event.clipboardData?.getData('text/html') ?? '', trusted: event.isTrusted }), { capture: true });
			});
		}
		await workbench.quickaccess.runCommand('editor.action.clipboardPasteAction');
		await editor.waitForEditorContents(text => text === 'Workbench clipboard text');
		if (target.kind === 'electron') {
			const events = await page.evaluate(() => (globalThis as unknown as { clipboardPasteEvents: { text: string; html: string; trusted: boolean; }[]; }).clipboardPasteEvents);
			expect(events).toHaveLength(1);
			expect(events[0].text).toBe('Workbench clipboard text');
			expect(events[0].html).toContain('<b>Workbench clipboard text</b>');
			expect(events[0].trusted).toBe(true);
		}
	} finally {
		await write(previous);
	}
});

test('command Paste As preserves rich clipboard choices and undo in the owning Workbench', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, target, application }) => {
	const page = workbench.page;
	if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	const previous = target.kind === 'electron'
		? await (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: await page.evaluate(() => navigator.clipboard.readText());
	try {
		if (target.kind === 'electron') {
			await (application as ElectronApplication).evaluate(async ({ clipboard, ClipboardItem }) => {
				await clipboard.write([new ClipboardItem({ 'text/plain': 'plain choice', 'text/html': '<b>rich choice</b>' })]);
			});
			const representations = await page.evaluate(async () => {
				const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<{ type: string; data: Uint8Array; }[]>; }; }; }).ash.ipcRenderer;
				return (await ipc.invoke('ash:host:readClipboardData')).filter(item => item.type.startsWith('text/')).map(item => ({ type: item.type, text: new TextDecoder().decode(item.data) }));
			});
			expect(representations).toEqual(expect.arrayContaining([
				{ type: 'text/plain', text: 'plain choice' },
				expect.objectContaining({ type: 'text/html', text: expect.stringContaining('<b>rich choice</b>') }),
			]));
		} else {
			await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
				'text/plain': new Blob(['plain choice'], { type: 'text/plain' }),
				'text/html': new Blob(['<b>rich choice</b>'], { type: 'text/html' }),
			})]));
		}
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('editor.action.pasteAs');
		const picker = page.getByRole('dialog', { name: 'Paste As...' });
		await expect(picker).toBeVisible();
		await expect(picker).toContainText('Insert Plain Text');
		await expect(picker).toContainText('Insert HTML');
		await editor.waitForEditorContents(text => text === '');
		await picker.getByRole('combobox').fill('HTML');
		await picker.getByRole('combobox').press('Enter');
		await editor.waitForEditorContents(text => text.includes('<b>rich choice</b>'));
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Z');
		await editor.waitForEditorContents(text => text === '');
		await workbench.quickaccess.runCommand('editor.action.pasteAsText');
		await editor.waitForEditorContents(text => text === 'plain choice');
		await expect(picker).toHaveCount(0);
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Z');
		await editor.waitForEditorContents(text => text === '');
	} finally {
		if (target.kind === 'electron') await (application as ElectronApplication).evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
		else await page.evaluate(text => navigator.clipboard.writeText(text), previous);
	}
});

test('browser clipboard permission recovery preserves cancelled pastes and permits a new paste', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ workbench, target }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorFocus();
	await page.evaluate(() => {
		const original = navigator.clipboard.readText.bind(navigator.clipboard);
		let calls = 0;
		navigator.clipboard.readText = async () => {
			if (++calls === 1) { throw new DOMException('Clipboard access denied', 'NotAllowedError'); }
			return 'recovered clipboard text';
		};
		(window as unknown as { restoreClipboardRead: () => void; }).restoreClipboardRead = () => { navigator.clipboard.readText = original; };
	});
	try {
		await editor.input.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
		const prompt = page.locator('.ash-notification').filter({ hasText: 'Unable to read the clipboard.' });
		await expect(prompt).toHaveAttribute('role', 'alert');
		const retry = prompt.getByRole('button', { name: 'Retry', exact: true });
		await retry.focus();
		await retry.press('Enter');
		await expect(prompt).toHaveCount(0);
		await editor.waitForEditorContents(text => text === '');
		await editor.input.focus();
		await editor.input.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
		await editor.waitForEditorContents(text => text === 'recovered clipboard text');
	} finally {
		await page.evaluate(() => (window as unknown as { restoreClipboardRead: () => void; }).restoreClipboardRead());
	}
});

test('global Find clipboard seeds a new editor and preserves copied text', { tag: process.platform === 'darwin' ? ['@browser-app-server', '@electron-app-server'] : ['@browser-app-server'] }, async ({ workbench, target, application }) => {
	const page = workbench.page;
	if (target.kind === 'browser') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	const readText = (): Promise<string> => target.kind === 'electron'
		? (application as ElectronApplication).evaluate(({ clipboard }) => clipboard.readText())
		: page.evaluate(() => navigator.clipboard.readText());
	const writeText = async (value: string): Promise<void> => {
		if (target.kind === 'electron') await (application as ElectronApplication).evaluate(({ clipboard }, text) => clipboard.writeText(text), value);
		else await page.evaluate(text => navigator.clipboard.writeText(text), value);
	};
	const previousText = await readText();
	const previousFind = target.kind === 'electron' ? await (application as ElectronApplication).evaluate(async ({ clipboard }) => {
		for (const item of await clipboard.read()) {
			if (item.types.includes('electron application/findtext')) return (await item.getType('electron application/findtext') as Blob).text();
		}
		return '';
	}) : '';
	try {
		await writeText('ordinary copied text');
		await page.keyboard.press('ControlOrMeta+N');
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('actions.find');
		const oldFind = page.locator('.stanza-editor-find-widget:visible').getByRole('textbox', { name: 'Find', exact: true });
		await oldFind.fill('previous local query');
		await oldFind.press('Escape');
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.getByRole('searchbox').fill('editor.find.globalFindClipboard');
		const sharing = settings.locator('[data-configuration-key="editor.find.globalFindClipboard"]');
		await sharing.focus();
		await sharing.press('Space');
		await expect(sharing).toBeChecked();
		await expect(sharing).toBeEnabled();
		await settings.locator('.ash-modal-editor-close').click();
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('actions.find');
		const find = page.locator('.stanza-editor-find-widget:visible').getByRole('textbox', { name: 'Find', exact: true });
		await expect(find).toBeFocused();
		await find.fill('shared query');
		if (target.kind === 'electron') {
			await expect.poll(() => (application as ElectronApplication).evaluate(async ({ clipboard }) => {
				for (const item of await clipboard.read()) {
					if (item.types.includes('electron application/findtext')) return (await item.getType('electron application/findtext') as Blob).text();
				}
				return '';
			})).toBe('shared query');
		}
		await find.press('Escape');
		const editor = workbench.editors.groupAt(0).editor;
		const previousLabel = await editor.input.getAttribute('aria-label');
		await page.keyboard.press('ControlOrMeta+N');
		await expect(editor.input).not.toHaveAttribute('aria-label', previousLabel!);
		await editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('actions.find');
		await expect(find).toHaveValue('shared query');
		await expect(find).toBeFocused();
		await find.fill('latest shared query');
		await find.press('Escape');
		await page.keyboard.press('ControlOrMeta+W');
		await editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('actions.find');
		await expect(find).toHaveValue('latest shared query');
		await expect.poll(readText).toBe('ordinary copied text');
	} finally {
		if (target.kind === 'electron') {
			await (application as ElectronApplication).evaluate(async ({ clipboard, ClipboardItem }, term) => {
				await clipboard.write([new ClipboardItem({ 'electron application/findtext': term })]);
			}, previousFind);
		}
		await writeText(previousText);
	}
});


test('desktop clipboard shortcuts preserve editor operations and native Find textbox input', { tag: ['@electron-app-server'] }, async ({ workbench, application }, testInfo) => {
	const desktop = application as ElectronApplication;
	const previous = await desktop.evaluate(({ clipboard }) => clipboard.readText());
	try {
		await workbench.page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor('clipboard editor text');
		await editor.input.press('ControlOrMeta+A');
		await editor.input.press('ControlOrMeta+C');
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('clipboard editor text');
		await editor.input.press('ControlOrMeta+X');
		await editor.waitForEditorContents(text => text === '');
		await editor.input.press('ControlOrMeta+V');
		await editor.waitForEditorContents(text => text === 'clipboard editor text');
		await workbench.quickaccess.runCommand('actions.find');
		const find = workbench.page.locator('.stanza-editor-find-widget:visible').getByRole('textbox', { name: 'Find', exact: true });
		await expect(find).toBeFocused();
		await find.fill('native textbox clipboard');
		await find.press('ControlOrMeta+A');
		await find.press('ControlOrMeta+C');
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('native textbox clipboard');
		await find.fill('');
		await find.press('ControlOrMeta+V');
		await expect(find).toHaveValue('native textbox clipboard');
		await editor.waitForEditorContents(text => text === 'clipboard editor text');
		await workbench.page.screenshot({ path: testInfo.outputPath('native-clipboard-shortcuts.png') });
	} finally {
		await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
	}
});

test('desktop Paste command inserts clipboard text into a focused Find textbox', { tag: ['@electron-app-server'] }, async ({ workbench, target, application }) => {
	const desktop = application as ElectronApplication;
	const previous = await desktop.evaluate(({ clipboard }) => clipboard.readText());
	try {
		await desktop.evaluate(({ clipboard }) => clipboard.writeText('textbox clipboard text'));
		await workbench.page.keyboard.press('ControlOrMeta+N');
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('actions.find');
		const find = workbench.page.locator('.stanza-editor-find-widget:visible').getByRole('textbox', { name: 'Find', exact: true });
		await expect(find).toBeFocused();
		await workbench.quickaccess.runCommand('editor.action.clipboardPasteAction');
		await expect(find).toHaveValue('textbox clipboard text');
	} finally {
		await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
	}
});

test('desktop clipboard routes reject unknown types and renderer-selected paste targets', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ workbench, target }) => {
	const errors = await workbench.page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown>; }; }; }).ash.ipcRenderer;
		const requests: [string, unknown][] = [
			['ash:host:readClipboard', 'private-type'],
			['ash:host:writeClipboard', { text: 'invalid', type: 'private-type' }],
			['ash:host:writeClipboard', { text: 'invalid', extra: true }],
			['ash:host:triggerPaste', 123],
			['ash:host:triggerPaste', { windowName: 'ash-auxiliary-00000000-0000-0000-0000-000000000000' }],
		];
		return Promise.all(requests.map(async ([channel, params]) => {
			try { await ipc.invoke(channel, params); return ''; }
			catch (error) { return String(error); }
		}));
	});
	expect(errors[0]).toContain('Invalid clipboard type');
	expect(errors[1]).toContain('Invalid clipboard type');
	expect(errors[2]).toContain('Invalid clipboard text write');
	expect(errors[3]).toContain('Invalid paste target');
	expect(errors[4]).toContain('The paste target window is unavailable');
});

test('Linux selection clipboard follows editor selections and supports command and middle-click paste', { tag: ['@electron-ui', '@electron-app-server', '@linux'] }, async ({ workbench, target, application }) => {
	const desktop = application as ElectronApplication;
	const previous = await desktop.evaluate(async ({ clipboard }) => ({ text: await clipboard.readText(), selection: await clipboard.selection.readText() }));
	try {
		await desktop.evaluate(({ clipboard }) => clipboard.writeText('ordinary clipboard'));
		await workbench.page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await editor.input.pressSequentially('selected text');
		await editor.input.press('Home');
		await editor.input.press('Shift+End');
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.selection.readText())).toBe('selected text');
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe('ordinary clipboard');
		await editor.input.press('End');
		await workbench.quickaccess.runCommand('editor.action.selectionClipboardPaste');
		await editor.waitForEditorContents(text => text === 'selected textselected text');
		await editor.input.click({ button: 'middle' });
		await editor.waitForEditorContents(text => text === 'selected textselected textselected text');
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.getByRole('searchbox').fill('editor.selectionClipboard');
		const enabled = settings.locator('[data-configuration-key="editor.selectionClipboard"]');
		await enabled.focus();
		await enabled.press('Space');
		await expect(enabled).not.toBeChecked();
		await expect(enabled).toBeEnabled();
		await settings.locator('.ash-modal-editor-close').click();
		await editor.waitForEditorFocus();
		await editor.input.press('Home');
		await editor.input.press('Shift+End');
		await editor.input.press('End');
		await workbench.page.evaluate(() => {
			document.addEventListener('mouseup', event => {
				if (event.button === 1) (globalThis as unknown as { middlePastePrevented: boolean; }).middlePastePrevented = event.defaultPrevented;
			});
		});
		await editor.input.click({ button: 'middle' });
		await expect.poll(() => workbench.page.evaluate(() => (globalThis as unknown as { middlePastePrevented: boolean; }).middlePastePrevented)).toBe(true);
		await editor.waitForEditorContents(text => text === 'selected textselected textselected text');
		await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.selection.readText())).toBe('selected text');
	} finally {
		await desktop.evaluate(async ({ clipboard }, saved) => {
			await clipboard.writeText(saved.text);
			await clipboard.selection.writeText(saved.selection);
		}, previous);
	}
});

test('desktop Paste As consumes the trusted rich paste event and returns focus after choosing HTML', { tag: ['@electron-app-server'] }, async ({ workbench, target, application }) => {
	const desktop = application as ElectronApplication;
	const previous = await desktop.evaluate(({ clipboard }) => clipboard.readText());
	try {
		await desktop.evaluate(async ({ clipboard, ClipboardItem }) => {
			await clipboard.write([new ClipboardItem({ 'text/plain': 'plain', 'text/html': '<b>rich paste</b>' })]);
		});
		await workbench.page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await workbench.quickaccess.runCommand('editor.action.pasteAs');
		const picker = workbench.page.locator('.ash-quick-pick');
		await expect(picker).toBeVisible();
		const input = picker.getByRole('combobox');
		await input.fill('HTML');
		await input.press('Enter');
		await editor.waitForEditorContents(text => text.includes('<b>rich paste</b>'));
		await editor.waitForEditorFocus();
	} finally {
		await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
	}
});

test('browser paste shortcut delivers trusted HTML and preserves undo and focus', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ workbench, target }) => {
	const page = workbench.page;
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	const previous = await page.evaluate(() => navigator.clipboard.readText());
	try {
		await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['plain'], { type: 'text/plain' }), 'text/html': new Blob(['<b>rich shortcut</b>'], { type: 'text/html' }) })]));
		await page.keyboard.press('ControlOrMeta+N');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorFocus();
		await page.evaluate(() => {
			const events: { trusted: boolean; html: string; }[] = [];
			(globalThis as unknown as { richPasteEvents: typeof events; }).richPasteEvents = events;
			document.addEventListener('paste', event => events.push({ trusted: event.isTrusted, html: event.clipboardData?.getData('text/html') ?? '' }), { capture: true });
		});
		await editor.input.press('ControlOrMeta+V');
		await editor.waitForEditorContents(text => text === 'plain');
		const events = await page.evaluate(() => (globalThis as unknown as { richPasteEvents: { trusted: boolean; html: string; }[]; }).richPasteEvents);
		expect(events).toHaveLength(1);
		expect(events[0].trusted).toBe(true);
		expect(events[0].html).toContain('<b>rich shortcut</b>');
		await editor.waitForEditorFocus();
		await editor.input.press('ControlOrMeta+Z');
		await editor.waitForEditorContents(text => text === '');
	} finally {
		await page.evaluate(text => navigator.clipboard.writeText(text), previous);
	}
});

test('desktop editor Paste reaches its registered auxiliary window and releases the target when closed', { tag: ['@electron-app-server'] }, async ({ workbench, target, application }) => {
	const desktop = application as ElectronApplication;
	const page = workbench.page;
	const previous = await desktop.evaluate(({ clipboard }) => clipboard.readText());
	let auxiliary: import('@playwright/test').Page | undefined;
	try {
		await desktop.evaluate(({ clipboard }) => clipboard.writeText('auxiliary clipboard text'));
		await page.keyboard.press('ControlOrMeta+N');
		await workbench.editors.groupAt(0).editor.waitForEditorFocus();
		const opened = page.context().waitForEvent('page');
		await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
		auxiliary = await opened;
		const input = auxiliary.locator('.ash-auxiliary-window-container .stanza-editor-input');
		await expect(input).toBeVisible();
		await input.focus();
		const windowName = await auxiliary.evaluate(() => window.name);
		await auxiliary.evaluate(() => {
			const events: boolean[] = [];
			(globalThis as unknown as { auxiliaryPasteEvents: boolean[]; }).auxiliaryPasteEvents = events;
			document.addEventListener('paste', event => events.push(event.isTrusted), { capture: true });
		});
		await auxiliary.bringToFront();
		await input.focus();
		await expect(input).toBeFocused();
		await workbench.quickaccess.runCommand('editor.action.clipboardPasteAction');
		await expect(auxiliary.locator('.stanza-editor')).toContainText('auxiliary clipboard text');
		expect(await auxiliary.evaluate(() => (globalThis as unknown as { auxiliaryPasteEvents: boolean[]; }).auxiliaryPasteEvents)).toEqual([true]);
		await auxiliary.close();
		auxiliary = undefined;
		const error = await page.evaluate(async name => {
			try {
				await (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<void>; }; }; }).ash.ipcRenderer.invoke('ash:host:triggerPaste', { windowName: name });
				return '';
			} catch (error) { return String(error); }
		}, windowName);
		expect(error).toContain('The paste target window is unavailable');
	} finally {
		await auxiliary?.close();
		await desktop.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
	}
});
