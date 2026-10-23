import { expectIconFontLoaded } from '../../automation/iconFonts.js';
import { expect, test, type Page } from '@playwright/test';
import { Editor } from '../../automation/editor.js';
import { ShowLightbulbIconMode } from '../../../src/ash/editor/common/config/editorOptions.js';

for (const backend of ['native', 'textarea'] as const) {
	test(`cursor navigation separates typing undo groups with ${backend} input`, async ({ page }) => {
		if (backend === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		await page.goto('/standalone.html');
		try {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('base', [[1, 5, 1, 5]]));
			await page.locator('#caller .stanza-editor-input').focus();
			await page.keyboard.type('abc');
			await page.keyboard.press('Home');
			await page.keyboard.type('X');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('Xbaseabc');
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toMatchObject({ value: 'baseabc', selection: '[1,1 -> 1,1]', focused: true });
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('base');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('Xbaseabc');
		} finally { await page.evaluate(() => window.ashStandaloneIntegration.dispose()); }
	});
}

for (const inputKind of ['EditContext', 'textarea'] as const) {
	test(`${inputKind} browser paste shortcut preserves trusted HTML and undo`, async ({ page, context }) => {
		if (inputKind === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/standalone.html');
		const previous = await page.evaluate(() => navigator.clipboard.readText());
		try {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('', [[1, 1, 1, 1]]));
			await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['plain'], { type: 'text/plain' }), 'text/html': new Blob(['<b>rich shortcut</b>'], { type: 'text/html' }) })]));
			const events: { trusted: boolean; html: string; }[] = [];
			await page.exposeFunction('recordRichPaste', (event: typeof events[number]) => events.push(event));
			await page.evaluate(() => document.addEventListener('paste', event => {
				void (window as unknown as { recordRichPaste(event: { trusted: boolean; html: string; }): Promise<void>; }).recordRichPaste({ trusted: event.isTrusted, html: event.clipboardData?.getData('text/html') ?? '' });
			}, { capture: true }));
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await input.press('ControlOrMeta+V');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('plain');
			expect(events).toHaveLength(1);
			expect(events[0].trusted).toBe(true);
			expect(events[0].html).toContain('<b>rich shortcut</b>');
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+Z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('');
		} finally {
			await page.evaluate(text => navigator.clipboard.writeText(text), previous);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		}
	});

	for (const eolName of ['lf', 'crlf'] as const) {
		test(`${inputKind} ${eolName} models retain EOL through input, paste, undo and existing text`, async ({ page }) => {
			if (inputKind === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			await page.goto(`/standalone.html?eol=${eolName}`);
			const eol = eolName === 'lf' ? '\n' : '\r\n';
			const oppositeEol = eolName === 'lf' ? '\r\n' : '\n';
			const input = page.locator('#caller .stanza-editor-input');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('alpha', [[1, 6, 1, 6]]));
			await input.focus();
			await page.keyboard.insertText('\nbeta');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(`alpha${eol}beta`);
			await input.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha');
			await input.press('ControlOrMeta+Shift+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(`alpha${eol}beta`);

			await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('alpha', [[1, 6, 1, 6]]));
			await input.evaluate((element, text) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', text);
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, `${oppositeEol}beta`);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(`alpha${eol}beta`);
			await input.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha');

			// A file's existing line endings take precedence over the default for empty models.
			await page.evaluate(text => window.ashStandaloneIntegration.prepareClipboard(text, [[2, 4, 2, 4]]), `one${oppositeEol}two`);
			await page.keyboard.insertText('\nthree');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(`one${oppositeEol}two${oppositeEol}three`);
			await expect(input).toBeFocused();
		});
	}
}

async function stickyDefinitionPoint(page: Page): Promise<{ x: number; y: number; column: number; }> {
	const text = page.locator('#caller .stanza-editor-sticky-scroll-text').last();
	await expect(text).toHaveText('  function inner() {');
	return text.evaluate(element => {
		const text = element.firstElementChild!.firstChild!;
		const offset = text.textContent!.indexOf('inner') + 2;
		const range = document.createRange();
		range.setStart(text, offset);
		range.setEnd(text, offset + 1);
		const bounds = range.getBoundingClientRect();
		return { x: bounds.left + bounds.width / 4, y: bounds.top + bounds.height / 2, column: offset + 1 };
	});
}

test.describe('contribution lifecycle', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	for (const inputKind of ['EditContext', 'textarea'] as const) {
		for (const trigger of ['.', '('] as const) {
			test(`${inputKind} completion requests once after typing trigger ${trigger}`, async ({ page }) => {
				if (inputKind === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				await page.goto('/standalone.html');
				await page.evaluate(trigger => window.ashStandaloneIntegration.prepareContributionRequests('completion', [trigger]), trigger);
				await page.keyboard.type(trigger);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'typescript', aborted: false }]);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(`alpha${trigger === '(' ? '()' : '.'} beta\n  gamma\nalpha`);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
				await expect(page.locator('#caller .stanza-editor-completion')).toContainText('completion: typescript');
				await page.keyboard.type('z');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
				await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
				await page.keyboard.press('Escape');
				await page.keyboard.type('q');
				await expect(page.locator('#caller .stanza-editor-completion')).toBeHidden();
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(2);
				await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			});
		}
	}
});


for (const inputKind of ['editContext', 'textarea'] as const) {
	for (const command of ['copy', 'cut', 'paste'] as const) {
		for (const target of ['outside', 'readonly', 'find'] as const) {
			test(`${inputKind} active clipboard ${command} respects ${target} target`, async ({ page }) => {
				if (inputKind === 'textarea') {
					await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				}
				await page.goto('/standalone.html');
				const handled = target === 'outside' || target === 'readonly' && command === 'copy';
				const edited = target === 'outside' && command !== 'copy';
				expect(await page.evaluate(({ command, target }) => window.ashStandaloneIntegration.runActiveClipboard(command, target), { command, target })).toEqual({
					values: [edited ? (command === 'cut' ? '' : 'omega') : 'alpha', 'bravo'],
					written: handled && command !== 'paste' ? 'alpha' : '',
					reads: handled && command === 'paste' ? 1 : 0,
					focused: handled,
					documentCommands: target === 'find' || handled ? [command] : [],
				});
				if (edited) {
					await page.keyboard.press('ControlOrMeta+z');
					expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
				}
			});
		}
	}

	for (const label of ['Find', 'Replace']) {
		for (const useAlias of [false, true]) {
			test(`${inputKind} ${useAlias ? 'aliased' : 'public'} history commands undo and redo ${label} input`, async ({ page }) => {
				if (inputKind === 'textarea') {
					await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				}
				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareInputHistory());
				const input = page.locator(`#caller input[aria-label="${label}"]`);
				await input.fill('');
				await input.pressSequentially('needle');
				await input.press('ControlOrMeta+z');
				const undoneValue = await input.inputValue();
				expect(undoneValue).not.toBe('needle');
				await input.press('ControlOrMeta+Shift+z');
				await expect(input).toHaveValue('needle');
				expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runInputHistoryCommand(useAlias ? 'default:undo' : 'undo'), useAlias)).toEqual(['alpha!', 'bravo']);
				await expect(input).toHaveValue(undoneValue);
				expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runInputHistoryCommand(useAlias ? 'default:redo' : 'redo'), useAlias)).toEqual(['alpha!', 'bravo']);
				await expect(input).toHaveValue('needle');
			});
		}
	}

	test(`${inputKind} public select all targets text, active editor, and find input`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runSelectAllCommand())).toEqual({
			selections: ['[1,1 -> 2,4]|[1,2 -> 1,2]', '[1,1 -> 2,4]|[1,2 -> 1,2]', '[1,2 -> 1,2]|[1,2 -> 1,2]'],
			inputSelection: 'needle',
		});
	});

	for (const useAlias of [false, true]) {
		test(`${inputKind} ${useAlias ? 'aliased' : 'public'} history commands respect focus and dynamic readonly state`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(useAlias => window.ashStandaloneIntegration.runHistoryCommands(useAlias), useAlias)).toEqual([
				'alpha|bravo', 'alpha|bravo', 'alpha!|bravo', 'alpha!|bravo', 'alpha!|bravo', 'alpha|bravo',
			]);
		});
	}

	test(`${inputKind} editor focus stays coherent across find, replace, and external commands`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.runFocusRouting());
		expect(result).toEqual({
			states: [
				{ stage: 'text', text: true, widget: true, observedText: true, observedWidget: true, contextText: true, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'find', text: false, widget: true, observedText: false, observedWidget: true, contextText: false, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'replace', text: false, widget: true, observedText: false, observedWidget: true, contextText: false, contextWidget: true, widgetEvents: 'focus' },
				{ stage: 'outside', text: false, widget: false, observedText: false, observedWidget: false, contextText: false, contextWidget: false, widgetEvents: 'focus,blur' },
			],
			events: ['focus', 'blur'],
			activeAfterBlur: true,
			values: ['alpha\nalpha', 'bravo'],
			activeAfterDispose: true,
		});
	});

	test(`${inputKind} find highlights the current match in normal and forced colors`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+f');
		const findWidget = page.locator('#caller .stanza-editor-find-widget');
		await expect(findWidget).toBeVisible();
		await findWidget.getByRole('textbox', { name: 'Find' }).fill('caller');
		const currentMatch = page.locator('#caller .cdr.currentFindMatch');
		await expect(currentMatch).toHaveCount(1);
		await expect(currentMatch).toHaveCSS('outline-style', 'solid');
		await page.emulateMedia({ forcedColors: 'active' });
		await expect(currentMatch).toHaveCSS('outline-style', 'solid');
		await expect(currentMatch).toHaveCSS('background-color', /rgba\(.*?,\s*0\)/);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`${inputKind} find sash resizes the overlay and grouped button hovers share their delay`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+f');
		const findWidget = page.locator('#caller .stanza-editor-find-widget');
		const sash = findWidget.getByRole('separator', { name: 'Resize find widget' });
		await expect(sash).toBeVisible();
		const findIcons = findWidget.locator('.ash-icon[data-ash-icon-id^="find-"]');
		await expect(findIcons).toHaveCount(5);
		await expectIconFontLoaded(findIcons.first());
		await expect.poll(() => findIcons.evaluateAll(icons => icons.every(icon => icon.tagName === 'SPAN' && icon.classList.contains('ash-icon-font') && icon.childElementCount === 0))).toBe(true);
		await sash.hover();
		const initial = await findWidget.boundingBox();
		const sashBox = await sash.boundingBox();
		expect(initial).not.toBeNull();
		expect(sashBox).not.toBeNull();
		await page.mouse.move(sashBox!.x + sashBox!.width / 2, sashBox!.y + sashBox!.height / 2);
		await page.mouse.down();
		await expect(sash).toHaveClass(/ash-sash-active/);
		await page.mouse.move(sashBox!.x + sashBox!.width / 2 - 16, sashBox!.y + sashBox!.height / 2);
		await page.mouse.up();
		await expect.poll(() => findWidget.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(Math.round(initial!.width) + 16);
		await expect(sash).toHaveAttribute('aria-valuenow', String(Math.round(initial!.width) + 16));
		const resized = await findWidget.boundingBox();
		expect(Math.round(resized!.x)).toBe(Math.round(initial!.x) - 16);

		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(420));
		await expect.poll(() => findWidget.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBeLessThan(480);
		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(640));
		await expect.poll(() => findWidget.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(Math.round(initial!.width) + 16);

		await sash.focus();
		await page.keyboard.press('ArrowRight');
		await expect.poll(() => findWidget.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(Math.round(initial!.width) + 6);
		await sash.dblclick();
		await expect.poll(() => findWidget.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(480);

		const matchCase = findWidget.getByRole('button', { name: 'Match case' });
		const wholeWord = findWidget.getByRole('button', { name: 'Match whole word' });
		await matchCase.hover();
		await expect(page.locator('.ash-hover')).toHaveText('Match case');
		await wholeWord.hover();
		await expect(page.locator('.ash-hover')).toHaveText('Match whole word', { timeout: 300 });
		await matchCase.focus();
		await expect(page.locator('.ash-hover')).toHaveText('Match case');
		await expect(matchCase).toHaveAttribute('aria-describedby', /ash-hover-/);
		await wholeWord.focus();
		await expect(page.locator('.ash-hover')).toHaveText('Match whole word');
		await page.emulateMedia({ forcedColors: 'active' });
		await sash.hover();
		await expect(sash).toHaveClass(/ash-sash-hover/);
		await expect.poll(() => sash.evaluate(node => getComputedStyle(node, '::after').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`${inputKind} closed find options share managed hover delay`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.toggleClosedFindOption());
		const options = page.locator('#caller .stanza-editor-find-options-widget');
		await expect(options).toBeVisible();
		const matchCase = options.getByRole('button', { name: 'Match case' });
		await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
		await expect(matchCase).toHaveClass(/checked/u);
		await matchCase.hover();
		await expect(page.locator('.ash-hover')).toContainText('Match case');
		expect(await matchCase.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
		await options.getByRole('button', { name: 'Match whole word' }).hover();
		await expect(page.locator('.ash-hover')).toContainText('Match whole word', { timeout: 300 });
		await matchCase.click();
		await expect(matchCase).toHaveAttribute('aria-pressed', 'false');
		await expect(matchCase).not.toHaveClass(/checked/u);
		await options.getByRole('button', { name: 'Match whole word' }).hover();
		await expect(matchCase).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`${inputKind} active editor follows use across creation, model switches, and removal`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runEditorActivity())).toEqual([true, true, true, true]);
	});

	for (const fail of [false, true]) {
		test(`${inputKind} ordinary copy stays plain during a rich copy that ${fail ? 'fails' : 'succeeds'}`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(fail => window.ashStandaloneIntegration.runDeferredRichCopy(fail), fail)).toEqual({
				pendingHtml: '', finishedHtml: '', rejected: fail, writtenText: 'const',
			});
		});
	}

	for (const fromOutside of [false, true]) {
		for (const command of ['cut', 'paste'] as const) {
			for (const change of ['none', 'selection', 'focus', 'readonly', 'composition', 'escape', 'model', 'dispose'] as const) {
				test(`${inputKind} ${fromOutside ? 'external' : 'focused'} delayed clipboard ${command} respects ${change}`, async ({ page }) => {
					if (inputKind === 'textarea') {
						await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
					}
					await page.goto('/standalone.html');
					const result = await page.evaluate(({ command, change, fromOutside }) => window.ashStandaloneIntegration.runDeferredClipboard(command, change, fromOutside), { command, change, fromOutside });
					expect(result).toEqual({
						value: change === 'none' ? (command === 'cut' ? '' : 'omega') : 'alpha',
						finishedBeforeTransfer: change !== 'none',
					});
					if (change === 'none') {
						await page.keyboard.press('ControlOrMeta+z');
						expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
					}
				});
			}
		}
	}

	test(`${inputKind} file paste inserts its name without reading content`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runFilePaste())).toEqual({
			value: 'alphasnippet.txt',
			handled: true,
			fileReads: 0,
		});
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
	});
}

for (const inputKind of ['native', 'textarea'] as const) {
	for (const enabled of [true, false]) {
		test(`${inputKind} URI paste respects pasteAs.enabled=${enabled}`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(enabled => window.ashStandaloneIntegration.runUriPaste(enabled), enabled)).toEqual({
				value: enabled ? 'alphahttps://example.test/snippet' : 'alpha',
				handled: true,
			});
		});
	}
}

for (const inputKind of ['editContext', 'textarea']) {
	test(`${inputKind} command Paste As reads system HTML without a paste event and keeps text choice undoable`, async ({ page, context }) => {
		if (inputKind === 'textarea') await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/standalone.html');
		const previous = await page.evaluate(() => navigator.clipboard.readText());
		try {
			await page.evaluate(async () => {
				await navigator.clipboard.write([new ClipboardItem({
					'text/plain': new Blob(['plain choice'], { type: 'text/plain' }),
					'text/html': new Blob(['<b>rich choice</b>'], { type: 'text/html' }),
				})]);
				window.ashStandaloneIntegration.prepareClipboard('old', [[1, 1, 1, 4]]);
				void window.ashStandaloneIntegration.runLineAction('editor.action.pasteAs');
			});
			const picker = page.getByRole('dialog', { name: 'Paste As...' });
			await expect(picker).toBeVisible();
			await expect(picker).toContainText('Insert Plain Text');
			await expect(picker).toContainText('Insert HTML');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('old');
			await picker.getByRole('combobox').fill('HTML');
			await picker.getByRole('combobox').press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('<b>rich choice</b>');
			const input = page.locator('#caller .stanza-editor-input');
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+Z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('old');
			await page.evaluate(async () => {
				window.ashStandaloneIntegration.prepareClipboard('old', [[1, 1, 1, 4]]);
				await window.ashStandaloneIntegration.runLineAction('editor.action.pasteAsText');
			});
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('plain choice');
			await expect(picker).toHaveCount(0);
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+Z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('old');
		} finally {
			await page.evaluate(text => navigator.clipboard.writeText(text), previous);
		}
	});
}

for (const mime of ['application/pdf', 'application/x-test-binary']) {
	test(`command Paste As preserves system ${mime} bytes as a file`, async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/standalone.html');
		const previous = await page.evaluate(() => navigator.clipboard.readText());
		try {
			const bytes = [255, 128, 0, 80, 68, 70];
			await page.evaluate(async ({ mime, bytes }) => {
				await navigator.clipboard.write([new ClipboardItem({
					[`web ${mime}`]: new Blob([Uint8Array.from(bytes)], { type: mime }),
				})]);
			}, { mime, bytes });
			const name = mime === 'application/pdf' ? 'clipboard.pdf' : 'clipboard.bin';
			expect(await page.evaluate(mime => window.ashStandaloneIntegration.pasteClipboardFile(mime), mime)).toEqual({ name, bytes, value: name });
			const input = page.locator('#caller .stanza-editor-input');
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+Z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('old');
		} finally {
			await page.evaluate(text => navigator.clipboard.writeText(text), previous);
		}
	});
}

test('Paste As chooses an edit before changing the document', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.startPasteAsPicker());
	const picker = page.getByRole('dialog', { name: 'Paste As...' });
	await expect(picker).toBeVisible().catch(error => { throw new Error(`Paste picker page errors: ${JSON.stringify(errors)}`, { cause: error }); });
	await expect(picker).toContainText('Insert Plain Text');
	await expect(picker).toContainText('Insert HTML');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
	await picker.getByRole('combobox').fill('HTML');
	await picker.getByRole('combobox').press('Enter');
	await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('<b>markup</b>');
	await expect(picker).toBeHidden();
	expect(errors).toEqual([]);
});

for (const plainText of [true, false]) {
	test(`explicit paste ${plainText ? 'as text' : 'preferences'} inserts the requested kind without opening a picker`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(plainText => window.ashStandaloneIntegration.startPasteAsPicker(plainText ? undefined : { preferences: ['unavailable', 'html', 'text'] }, plainText), plainText);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe(plainText ? 'plain' : '<b>markup</b>');
		await expect(page.getByRole('dialog', { name: 'Paste As...' })).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('alpha');
		expect(errors).toEqual([]);
	});
}

test('paste providers show a keyboard accessible selector and switch the applied edit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runPasteProviderSelector())).toEqual({
		value: 'CUSTOM',
		handled: true,
	});
	const selector = page.locator('.stanza-editor-post-edit-selector');
	await expect(selector).toBeVisible();
	const trigger = selector.getByRole('button', { name: 'Paste options' });
	await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
	const surface = await trigger.evaluate(element => {
		const bounds = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		return { width: bounds.width, border: style.borderStyle, background: style.backgroundColor };
	});
	expect(surface.width).toBeGreaterThan(0);
	expect(surface.border).toBe('solid');
	expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
	await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-high-contrast-dark'));
	await expect(trigger).toHaveCSS('border-style', 'solid');
	await page.locator('#caller .stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+.');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem')).toHaveCount(2);
	await page.getByRole('menuitem', { name: 'Insert Plain Text', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('plain');
	await expect(selector).toBeVisible();
	await trigger.focus();
	await page.keyboard.press('Escape');
	await expect(selector).toHaveCount(0);
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('alpha');
	expect(errors).toEqual([]);
});

test('a pasted snippet keeps tabstop navigation after an additional resource edit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runPasteSnippetWithAdditionalEdit())).toEqual({
		value: 'name(value)', otherValue: 'EXTRA', handled: true,
	});
	await page.locator('#caller .stanza-editor-input').focus();
	await page.keyboard.type('fn');
	await page.keyboard.press('Tab');
	await page.keyboard.type('arg');
	await page.keyboard.press('Tab');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('fn(arg)');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getOwnedValue())).toBe('EXTRA');
	expect(errors).toEqual([]);
});

test('switching a snippet paste choice restores the additional resource edit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.runPasteSnippetWithAdditionalEdit());
	await page.getByRole('button', { name: 'Paste options', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Insert Plain Text', exact: true }).click();
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('plain');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getOwnedValue())).toBe('trail');
	expect(errors).toEqual([]);
});

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`${inputKind} editor actions keep their context across read-only and model changes`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runScopedActions())).toEqual({
			supported: [false, true], values: ['alpha\nbeta\ngamma', 'beta\ngamma', 'gamma'],
			otherValue: 'owned', sameContext: true, focusRetained: true,
		});
	});
}

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`bracket themes override token foreground and preserve ${inputKind} text and focus`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareBrackets('({[({[x]})]})', [1]);
			window.ashStandaloneIntegration.prepareBracketToken();
		});
		const brackets = page.locator('#caller .view-line [class*="stanza-editor-bracket-level-"]');
		const readColors = (): Promise<string[]> => brackets.evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
		const palettes = {
			Dark: ['rgb(229, 192, 123)', 'rgb(198, 120, 221)', 'rgb(86, 182, 194)', 'rgb(152, 195, 121)', 'rgb(224, 108, 117)', 'rgb(97, 175, 239)'],
			Light: ['rgb(121, 94, 0)', 'rgb(136, 65, 160)', 'rgb(0, 118, 129)', 'rgb(56, 125, 34)', 'rgb(161, 44, 64)', 'rgb(0, 95, 184)'],
			HighContrastDark: ['rgb(255, 255, 0)', 'rgb(255, 112, 232)', 'rgb(0, 255, 255)', 'rgb(140, 255, 102)', 'rgb(255, 157, 157)', 'rgb(154, 200, 255)'],
			HighContrastLight: ['rgb(121, 94, 0)', 'rgb(136, 65, 160)', 'rgb(0, 118, 129)', 'rgb(56, 125, 34)', 'rgb(161, 44, 64)', 'rgb(0, 95, 184)'],
		};
		for (const scheme of Object.keys(palettes) as (keyof typeof palettes)[]) {
			await page.evaluate(scheme => window.ashStandaloneIntegration.setBracketTheme(scheme), scheme);
			const expected = [...palettes[scheme], ...[...palettes[scheme]].reverse()];
			await expect.poll(readColors).toEqual(expected);
			await expect(page.locator('#caller .stanza-editor-line-text')).toHaveText('({[({[x]})]})');
			await expect(page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: /^x$/ })).toHaveCSS('color', 'rgb(18, 52, 86)');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		}
		await page.evaluate(() => window.ashStandaloneIntegration.setBracketTheme('Light', ['#aabb01', '#aabb02', '#aabb03', '#aabb04', '#aabb05', '#aabb06']));
		const custom = [1, 2, 3, 4, 5, 6].map(value => `rgb(170, 187, ${value})`);
		await expect.poll(readColors).toEqual([...custom, ...[...custom].reverse()]);
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(false, false));
		await expect(brackets).toHaveCount(0);
		await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCSS('color', 'rgb(18, 52, 86)');
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
		await expect.poll(readColors).toEqual([custom[0], custom[0], custom[0], custom[1], custom[1], custom[1], custom[1], custom[1], custom[1], custom[0], custom[0], custom[0]]);
		await expect(brackets.first()).toHaveCSS('font-weight', '700');
	});
}

test.describe('parameter hints requests', () => {
	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	const signatures = [
		{ label: 'call(value)', parameters: [{ label: 'value' }], activeParameter: 0 },
		{ label: 'call(other)', parameters: [{ label: 'other' }], activeParameter: 0 },
		{ label: 'call(last)', parameters: [{ label: 'last' }], activeParameter: 0 },
	];

	test('parameter hints respect runtime disabling and enabling', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(false));
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.changeParameterHintsState('on'));
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.changeParameterHintsState('off'));
		await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
	});
});

for (const scenario of [
	{ name: 'replacement before the caret', original: 'hello world', before: [1, 6, 1, 6], range: [0, 5], text: 'hi', after: [2, 2], expected: 'hi world', selection: '[1,3 -> 1,3]' },
	{ name: 'deletion away from the caret', original: 'hello world', before: [1, 12, 1, 12], range: [0, 6], text: '', after: [0, 0], expected: 'world', selection: '[1,1 -> 1,1]' },
	{ name: 'cross-line replacement with a final selection', original: 'first\nsecond\nlast', before: [1, 6, 1, 6], range: [3, 9], text: 'X\nY', after: [5, 6], expected: 'firX\nYond\nlast', selection: '[2,1 -> 2,2]' },
] as const) {
	test(`EditContext range update commits ${scenario.name} with undo and redo`, async ({ page }) => {
		await page.goto('/standalone.html');
		const initial = await page.evaluate(scenario => window.ashStandaloneIntegration.prepareClipboard(scenario.original, [[...scenario.before]]), scenario);
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await input.evaluate((element, scenario) => {
			const context = (element as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!context) throw new Error('Browser EditContext is unavailable');
			context.dispatchEvent(Object.assign(new Event('textupdate'), {
				text: scenario.text, updateRangeStart: scenario.range[0], updateRangeEnd: scenario.range[1],
				selectionStart: scenario.after[0], selectionEnd: scenario.after[1],
			}));
		}, scenario);
		const inserted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(inserted).toEqual({ value: scenario.expected, selection: scenario.selection, version: initial.version + 1, focused: true });
		await input.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: undone.value, selection: undone.selection }).toEqual({ value: initial.value, selection: initial.selection });
		await input.press('ControlOrMeta+Shift+z');
		const redone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: redone.value, selection: redone.selection }).toEqual({ value: inserted.value, selection: inserted.selection });
		await expect(page.locator('#caller .stanza-editor-line-text')).toHaveText(scenario.expected.split('\n'));
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('EditContext range update replaces text at every cursor in one transaction', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('hello\nhello', [[1, 6, 1, 6], [2, 6, 2, 6]]));
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	await input.evaluate(element => {
		const context = (element as HTMLElement & { editContext?: EventTarget; }).editContext;
		if (!context) throw new Error('Browser EditContext is unavailable');
		context.dispatchEvent(Object.assign(new Event('textupdate'), {
			text: 'hi', updateRangeStart: 0, updateRangeEnd: 5, selectionStart: 2, selectionEnd: 2,
		}));
	});
	const inserted = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect({ value: inserted.value, selections: inserted.selections, version: inserted.version }).toEqual({
		value: 'hi\nhi', selections: ['[1,3 -> 1,3]', '[2,3 -> 2,3]'], version: initial.version + 1,
	});
	await input.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect({ value: undone.value, selections: undone.selections }).toEqual({ value: initial.value, selections: initial.selections });
	await input.press('ControlOrMeta+Shift+z');
	const redone = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect({ value: redone.value, selections: redone.selections }).toEqual({ value: inserted.value, selections: inserted.selections });
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const inputKind of ['EditContext', 'textarea'] as const) {
	test(`${inputKind} multiline input inserts the full text at every cursor`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('x\ny', [[1, 1, 1, 1], [2, 1, 2, 1]]));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText('A\nB');
		const inserted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(inserted.value).toBe('A\nBx\nA\nBy');
		await input.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await input.press('ControlOrMeta+Shift+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(inserted.value);
		await input.press('ControlOrMeta+z');
		await input.evaluate(element => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', 'A\nB');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('Ax\nBy');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const original of ['', 'prefix\nlast']) {
		for (const text of ['one\ntwo\nthree', '    one\n  two\nthree\n']) {
			test(`${inputKind} multiline input replaces ${original ? 'existing text' : 'empty text'} with one undo step${text.endsWith('\n') ? ' including a final newline' : ''}`, async ({ page }) => {
				if (inputKind === 'textarea') {
					await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
				}
				await page.goto('/standalone.html');
				const initial = await page.evaluate(original => window.ashStandaloneIntegration.prepareClipboard(original), original);
				const input = page.locator('#caller .stanza-editor-input');
				await input.focus();
				await input.press('ControlOrMeta+A');
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				await page.keyboard.insertText(text);
				const inserted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				expect({ value: inserted.value, version: inserted.version }).toEqual({ value: text, version: initial.version + 1 });
				await page.keyboard.insertText('!');
				await input.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(text);
				await input.press('ControlOrMeta+z');
				const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				expect({ value: undone.value, selection: undone.selection }).toEqual({ value: original, selection: before.selection });
				await input.press('ControlOrMeta+Shift+z');
				const redone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				expect({ value: redone.value, selection: redone.selection, focused: redone.focused }).toEqual({ value: text, selection: inserted.selection, focused: true });
				await expect(page.locator('#caller .stanza-editor-line-text')).toHaveText(text.split('\n'));
				await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			});
		}
	}

	for (const scenario of [
		{ mode: 'none', value: '  {\n}', selection: '[2,1 -> 2,1]' },
		{ mode: 'keep', value: '  {\n  }', selection: '[2,3 -> 2,3]' },
		{ mode: 'brackets', value: '  {\n      \n  }', selection: '[2,7 -> 2,7]' },
		{ mode: 'advanced', value: '  {\n      \n  }', selection: '[2,7 -> 2,7]' },
		{ mode: 'full', value: '  {\n      \n  }', selection: '[2,7 -> 2,7]' },
	] as const) {
		test(`${inputKind} Enter honors ${scenario.mode} auto indentation and undo restores the caret`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			const initial = await page.evaluate(mode => {
				window.ashStandaloneIntegration.prepareBrackets('  {}', [4]);
				window.ashStandaloneIntegration.updateContributionOptions({ autoIndent: mode });
				return window.ashStandaloneIntegration.readKeyboardEditing();
			}, scenario.mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.press('Enter');
			const entered = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			expect({ value: entered.value, selection: entered.selection, version: entered.version, focused: entered.focused }).toEqual({
				value: scenario.value, selection: scenario.selection, version: initial.version + 1, focused: true,
			});
			await input.press('ControlOrMeta+z');
			const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			expect({ value: undone.value, selection: undone.selection, focused: undone.focused }).toEqual({ value: initial.value, selection: initial.selection, focused: true });
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	for (const mode of ['none', 'keep', 'brackets', 'advanced', 'full'] as const) {
		test(`${inputKind} ${mode} typing controls closing-bracket indentation and undo`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			const initial = await page.evaluate(mode => {
				window.ashStandaloneIntegration.prepareLineComment({ languageId: 'typescript' });
				window.ashStandaloneIntegration.prepareClipboard('if (ok) {\n    ', [[2, 5, 2, 5]]);
				window.ashStandaloneIntegration.updateContributionOptions({ autoIndent: mode });
				return window.ashStandaloneIntegration.readKeyboardEditing();
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.press('}');
			const state = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			expect({ value: state.value, selection: state.selection, version: state.version, focused: state.focused }).toEqual({
				value: mode === 'full' ? 'if (ok) {\n}' : 'if (ok) {\n    }',
				selection: mode === 'full' ? '[2,2 -> 2,2]' : '[2,6 -> 2,6]',
				version: initial.version + 1,
				focused: true,
			});
			await input.press('ControlOrMeta+z');
			const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			expect({ value: undone.value, selection: undone.selection, focused: undone.focused }).toEqual({ value: initial.value, selection: initial.selection, focused: true });
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	for (const mode of ['advanced', 'full'] as const) {
		test(`${inputKind} ${mode} Enter controls inherited indentation on blank lines`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				window.ashStandaloneIntegration.prepareLineComment({ languageId: 'typescript' });
				window.ashStandaloneIntegration.prepareClipboard('if (ok) {\n', [[2, 1, 2, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ autoIndent: mode });
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.press('Enter');
			const state = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			expect({ value: state.value, selection: state.selection, focused: state.focused }).toEqual(mode === 'full'
				? { value: 'if (ok) {\n\n    ', selection: '[3,5 -> 3,5]', focused: true }
				: { value: 'if (ok) {\n\n', selection: '[3,1 -> 3,1]', focused: true });
			await input.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe('if (ok) {\n');
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test(`${inputKind} commits one Enter edit and restores its selection on undo`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const input = page.locator('#caller .stanza-editor-input');
		expect(await input.evaluate(element => element.tagName)).toBe(inputKind === 'textarea' ? 'TEXTAREA' : 'DIV');
		await input.focus();
		await page.keyboard.press('Enter');
		const entered = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: entered.value, version: entered.version, selection: entered.selection, focused: entered.focused }).toEqual({
			value: 'fi\nrst\nsecond',
			version: initial.version + 1,
			selection: '[2,1 -> 2,1]',
			focused: true,
		});
		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: undone.value, version: undone.version, selection: undone.selection }).toEqual({
			value: initial.value,
			version: entered.version + 1,
			selection: '[1,3 -> 1,3]',
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} ignores input delivered after focus leaves the editor`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await page.keyboard.type('X');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('Xcaller');
		await owned.focus();
		await expect(owned).toBeFocused();
		const before = await page.evaluate(() => ({
			value: window.ashStandaloneIntegration.state('caller').value,
			version: window.ashStandaloneIntegration.getCallerVersion(),
		}));
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			if (kind === 'textarea') {
				input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'X' }));
				return;
			}
			const context = (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!context) throw new Error('Browser EditContext is unavailable');
			context.dispatchEvent(Object.assign(new Event('textupdate'), {
				text: 'X', updateRangeStart: 0, updateRangeEnd: 0, selectionStart: 1, selectionEnd: 1,
			}));
		}, inputKind);
		await caller.evaluate(input => {
			input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'z', ctrlKey: true }));
		});
		expect(await page.evaluate(() => ({
			value: window.ashStandaloneIntegration.state('caller').value,
			version: window.ashStandaloneIntegration.getCallerVersion(),
		}))).toEqual(before);
		await expect(owned).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} commits revised IME text as one undo step`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				const start = textArea.selectionStart;
				let end = textArea.selectionEnd;
				for (const text of ['你', '你好']) {
					// Chromium announces the candidate before changing the native buffer.
					target.dispatchEvent(new CompositionEvent('compositionupdate', { data: text }));
					textArea.setRangeText(text, start, end, 'end');
					end = start + text.length;
					target.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertCompositionText', isComposing: true }));
				}
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你好',
					updateRangeStart: 2,
					updateRangeEnd: 3,
					selectionStart: 4,
					selectionEnd: 4,
				}));
			}
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
		}, inputKind);
		const committed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(committed).toEqual({
			value: 'fi你好rst\nsecond',
			version: initial.version + 2,
			selection: '[1,5 -> 1,5]',
			focused: true,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual({
			...initial,
			version: committed.version + 1,
			focused: true,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} cancels IME text with Escape without leaving an undo step`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
				textArea.setRangeText('你', textArea.selectionStart, textArea.selectionEnd, 'end');
				target.dispatchEvent(new InputEvent('input', { data: '你', inputType: 'insertCompositionText', isComposing: true }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
			input.dispatchEvent(new KeyboardEvent('keydown', {
				bubbles: true,
				cancelable: true,
				isComposing: true,
				key: 'Escape',
			}));
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
		}, inputKind);
		const canceled = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(canceled).toEqual({
			value: initial.value,
			version: initial.version + 2,
			selection: initial.selection,
			focused: true,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.keyboard.type('X');
		const typed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect(typed.value).toBe('fiXrst\nsecond');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} cancels provisional IME text on blur and rejects late composition`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
				textArea.setRangeText('你', textArea.selectionStart, textArea.selectionEnd, 'end');
				target.dispatchEvent(new InputEvent('input', { data: '你', inputType: 'insertCompositionText', isComposing: true }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '你',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
		}, inputKind);
		const provisional = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: provisional.value, version: provisional.version, selection: provisional.selection }).toEqual({
			value: 'fi你rst\nsecond',
			version: initial.version + 1,
			selection: '[1,4 -> 1,4]',
		});
		await expect(page.locator('#caller .stanza-editor')).toHaveClass(/\bcomposing\b/u);

		await owned.focus();
		await expect(owned).toBeFocused();
		const canceled = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: canceled.value, version: canceled.version, selection: canceled.selection, focused: canceled.focused }).toEqual({
			value: initial.value,
			version: provisional.version + 1,
			selection: initial.selection,
			focused: false,
		});
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		const lateStart = await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }));
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			return document.querySelector('#caller .stanza-editor')?.classList.contains('composing');
		}, inputKind);
		expect(lateStart).toBe(false);
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '迟' }));
				textArea.setRangeText('迟', textArea.selectionStart, textArea.selectionEnd, 'end');
				target.dispatchEvent(new InputEvent('input', { data: '迟', inputType: 'insertCompositionText', isComposing: true }));
			} else {
				target.dispatchEvent(Object.assign(new Event('textupdate'), {
					text: '迟',
					updateRangeStart: 2,
					updateRangeEnd: 2,
					selectionStart: 3,
					selectionEnd: 3,
				}));
			}
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '迟' }));
		}, inputKind);
		await expect(owned).toBeFocused();
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(canceled);
		await expect(page.locator('#caller .stanza-editor')).not.toHaveClass(/\bcomposing\b/u);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	for (const mode of ['full', 'partial', 'line', 'multi', 'disabled', 'missingColors'] as const) {
		test(`${inputKind} rich clipboard copy preserves ${mode} content and token styles`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				const ranges: Record<typeof mode, [number, number, number, number][]> = {
					full: [[1, 1, 2, 9]], partial: [[1, 3, 1, 5]], line: [[1, 3, 1, 3]],
					multi: [[1, 3, 1, 5], [2, 2, 2, 5]], disabled: [[1, 1, 2, 9]], missingColors: [[1, 1, 2, 9]],
				};
				window.ashStandaloneIntegration.prepareClipboard('const <x>&\n\t"value"', ranges[mode]);
				window.ashStandaloneIntegration.configureClipboardTokens(mode !== 'disabled', mode !== 'missingColors');
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			const copied = await input.evaluate(input => {
				const clipboardData = new DataTransfer();
				input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }));
				const html = clipboardData.getData('text/html');
				const content = new DOMParser().parseFromString(html, 'text/html');
				return {
					text: clipboardData.getData('text/plain'), html, richText: content.querySelector('code')?.textContent,
					injected: content.querySelector('x, script') !== null,
					styles: [...content.querySelectorAll('span')].map(span => ({ text: span.textContent, color: span.style.color, weight: span.style.fontWeight, italic: span.style.fontStyle, decoration: span.style.textDecoration })),
				};
			});
			const expected = { full: 'const <x>&\n\t"value"', partial: 'ns', line: 'const <x>&\n', multi: 'ns\n"va', disabled: 'const <x>&\n\t"value"', missingColors: 'const <x>&\n\t"value"' }[mode];
			// Windows clipboard text uses CRLF; parsing HTML independently normalizes it to LF.
			expect(copied.text).toBe(process.platform === 'win32' ? expected.replace(/\n/g, '\r\n') : expected);
			if (mode === 'disabled') {
				expect(copied.html).toBe('');
			} else {
				expect(copied.richText).toBe(expected);
				expect(copied.injected).toBe(false);
				expect(copied.styles[0]).toMatchObject({ color: mode === 'missingColors' ? '' : 'rgb(18, 52, 86)', weight: 'bold', italic: 'italic' });
				if (mode === 'full' || mode === 'multi' || mode === 'missingColors') {
					expect(copied.styles.at(-1)).toMatchObject({ color: mode === 'missingColors' ? '' : 'rgb(101, 67, 33)', decoration: 'underline' });
				}
			}
		});
	}

	test(`${inputKind} explicit rich copy writes HTML even when default highlighting is disabled`, async ({ page, context }) => {
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareClipboard('const <x>&\n\t"value"', [[1, 1, 1, 6]]);
			window.ashStandaloneIntegration.configureClipboardTokens(false);
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.clipboardCopyWithSyntaxHighlightingAction'));
		const copied = await page.evaluate(async () => {
			const items = await navigator.clipboard.read();
			const item = items.find(item => item.types.includes('text/html'));
			if (!item) return null;
			const html = await (await item.getType('text/html')).text();
			const content = new DOMParser().parseFromString(html, 'text/html');
			const token = content.querySelector('span');
			return { text: content.querySelector('code')?.textContent, color: token?.style.color, weight: token?.style.fontWeight };
		});
		expect(copied).toEqual({ text: 'const', color: 'rgb(18, 52, 86)', weight: 'bold' });
		await page.keyboard.press('ControlOrMeta+c');
		expect(await page.evaluate(async () => {
			const items = await navigator.clipboard.read();
			return { text: await navigator.clipboard.readText(), hasHtml: items.some(item => item.types.includes('text/html')) };
		})).toEqual({ text: 'const', hasHtml: false });
	});

	for (const scenario of [
		{ name: 'consecutive breaks', html: '<div>one<br><br><br>two</div>', text: 'one\n\n\ntwo' },
		{ name: 'boundary breaks', html: '<br>one<br>', text: '\none\n' },
		{ name: 'code whitespace', html: '<pre><code>\n  one\n\n\n\ttwo\n</code></pre>', text: '\n  one\n\n\n\ttwo\n' },
		{ name: 'adjacent code blocks', html: '<pre>one</pre><pre>two</pre>', text: 'one\ntwo' },
		{ name: 'nested blocks', html: '<div><div>one</div><div>two</div></div>', text: 'one\ntwo' },
	]) {
		test(`${inputKind} default paste requires plain text for ${scenario.name}`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('alpha', [6]));
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await input.evaluate((input, html) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/html', html);
				input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, scenario.html);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			await input.evaluate((input, scenario) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/html', scenario.html);
				clipboardData.setData('text/plain', scenario.text);
				input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, scenario);
			await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha' + scenario.text);
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		});
	}

	for (const mode of ['html', 'plain', 'readonly'] as const) {
		test(`${inputKind} HTML clipboard paste respects ${mode} and remains undoable`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => window.ashStandaloneIntegration.prepareBrackets('alpha', [6], mode === 'readonly'), mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await input.evaluate((input, mode) => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/html', '<div>&lt;x&gt; &amp; one</div><div>two<br>three</div><script>window.clipboardScriptRan = true</script>');
				if (mode === 'plain') clipboardData.setData('text/plain', ' plain');
				input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			}, mode);
			const expected = { html: 'alpha', plain: 'alpha plain', readonly: 'alpha' }[mode];
			await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(expected);
			expect(await page.evaluate(() => Reflect.get(window, 'clipboardScriptRan'))).toBeUndefined();
			if (mode !== 'readonly') {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			}
		});
	}

	for (const mode of ['selections', 'externalLines', 'line', 'emptyDisabled'] as const) {
		test(`${inputKind} clipboard preserves ${mode} behavior through the production input`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				if (mode === 'selections') {
					window.ashStandaloneIntegration.prepareClipboard('a b', [[1, 1, 1, 2], [1, 3, 1, 4]]);
				} else if (mode === 'externalLines') {
					window.ashStandaloneIntegration.prepareClipboard('a b', [[1, 1, 1, 1], [1, 3, 1, 3]]);
				} else {
					window.ashStandaloneIntegration.prepareClipboard('alpha\nbeta', [[1, 3, 1, 3]], mode === 'line');
				}
			}, mode);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			const result = await input.evaluate((input, mode) => {
				const data = new DataTransfer();
				if (mode === 'externalLines') {
					data.setData('text/plain', 'X\r\nY');
					data.setData('vscode-editor-data', '{invalid metadata');
				} else {
					input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }));
				}
				const text = data.getData('text/plain');
				const metadata = data.getData('vscode-editor-data');
				if (mode === 'emptyDisabled') {
					input.dispatchEvent(new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
				} else {
					if (mode === 'selections') {
						window.ashStandaloneIntegration.prepareClipboard('x y', [[1, 1, 1, 2], [1, 3, 1, 4]]);
					}
					input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
				}
				return { text, metadata };
			}, mode);
			if (mode === 'selections') {
				expect(result.text).toBe(process.platform === 'win32' ? 'a\r\nb' : 'a\nb');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: false, multicursorText: ['a', 'b'] });
				await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('a b');
			} else if (mode === 'externalLines') {
				await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('Xa Yb');
			} else if (mode === 'line') {
				expect(result.text).toBe(process.platform === 'win32' ? 'alpha\r\n' : 'alpha\n');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: true });
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'alpha\nalpha\nbeta', selections: ['[2,3 -> 2,3]'] });
			} else {
				expect(result.text).toBe('');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'alpha\nbeta', selections: ['[1,3 -> 1,3]'] });
			}
			if (mode !== 'emptyDisabled') {
				await page.keyboard.press('ControlOrMeta+z');
				const expected = { selections: 'x y', externalLines: 'a b', line: 'alpha\nbeta' }[mode];
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(expected);
			}
		});
	}

	test(`${inputKind} copies, cuts, pastes and undoes through its clipboard events`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		const copied = await caller.evaluate(input => {
			const clipboardData = new DataTransfer();
			const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData });
			input.dispatchEvent(event);
			return {
				prevented: event.defaultPrevented,
				text: clipboardData.getData('text/plain'),
				metadata: clipboardData.getData('vscode-editor-data'),
			};
		});
		expect({ prevented: copied.prevented, text: copied.text }).toEqual({ prevented: true, text: 'alpha' });
		expect(JSON.parse(copied.metadata)).toMatchObject({ version: 1, isFromEmptySelection: false });
		const cutPrevented = await caller.evaluate(input => {
			const event = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(cutPrevented).toBe(true);
		const cut = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: cut.value, version: cut.version, selection: cut.selection }).toEqual({
			value: ' beta',
			version: initial.version + 1,
			selection: '[1,1 -> 1,1]',
		});
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.keyboard.press('ArrowRight');
		const pastePrevented = await caller.evaluate((input, data) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', data.text);
			clipboardData.setData('vscode-editor-data', data.metadata);
			const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData });
			input.dispatchEvent(event);
			return event.defaultPrevented;
		}, copied);
		expect(pastePrevented).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishPaste());
		const pasted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: pasted.value, version: pasted.version, selection: pasted.selection }).toEqual({
			value: 'alphaalpha beta',
			version: cut.version + 2,
			selection: '[1,11 -> 1,11]',
		});
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} ignores clipboard events delivered after focus leaves the editor`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		const owned = page.locator('#owned .stanza-editor-input');
		await caller.focus();
		await owned.focus();
		const late = await caller.evaluate(input => {
			const copyData = new DataTransfer();
			input.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: copyData }));
			const cut = new ClipboardEvent('cut', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
			input.dispatchEvent(cut);
			const pasteData = new DataTransfer();
			pasteData.setData('text/plain', 'X');
			const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: pasteData });
			input.dispatchEvent(paste);
			return { copiedText: copyData.getData('text/plain'), cutPrevented: cut.defaultPrevented, pastePrevented: paste.defaultPrevented };
		});
		expect(late).toEqual({ copiedText: '', cutPrevented: true, pastePrevented: true });
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(initial);
		await expect(owned).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test(`${inputKind} uses the browser clipboard for keyboard copy, cut and paste`, async ({ page, context }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard());
		const caller = page.locator('#caller .stanza-editor-input');
		await caller.focus();
		await page.keyboard.press('ControlOrMeta+c');
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('alpha');
		await page.keyboard.press('ControlOrMeta+x');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(' beta');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe(initial.value);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ControlOrMeta+v');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alphaalpha beta');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

for (const inputKind of ['editContext', 'textarea'] as const) {
	test(`${inputKind} inline completion debounces typing, learns latency and keeps explicit requests immediate`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('abc');
		await page.clock.runFor(49);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).toEqual({ requests: [], delay: 50, shared: true });
		await page.clock.runFor(1);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: false }]);
		await page.clock.runFor(240);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).delay).toBe(240);
		await page.keyboard.type('d');
		await page.clock.runFor(200);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(1);
		await page.keyboard.press('Control+Alt+Space');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[1]).toEqual({ kind: 'explicit', text: 'abcd', languageId: 'plaintext', aborted: false });
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
		await page.clock.runFor(500);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(2);
		await page.keyboard.press('Alt+Enter');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('abcd suggestion');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`${inputKind} inline completion waits for composition to finish`, async ({ page }) => {
		if (inputKind === 'textarea') {
			await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
		}
		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('abc');
		await page.evaluate(() => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input')!;
			const target = (input as HTMLElement & { editContext?: EventTarget; }).editContext ?? input;
			target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
		});
		await page.clock.runFor(500);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([]);
		await page.evaluate(() => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input')!;
			const target = (input as HTMLElement & { editContext?: EventTarget; }).editContext ?? input;
			target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
		});
		await page.clock.runFor(50);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: false }]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test.describe('folding command routing', () => {
	const text = 'first\n  inner\n    body\n  sibling\nsecond\n  inner\n    body\n  sibling\nlast';

	test.afterEach(async ({ page }) => {
		await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
	});

	test('default and custom chords share timeout, escape and focus cancellation', async ({ page }) => {
		await page.goto('/standalone.html');
		await page.clock.install();
		await page.evaluate(text => {
			window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
			window.ashStandaloneIntegration.prepareFoldingKeybinding();
		}, text);
		await page.locator('#caller .stanza-editor-input').focus();
		const lines = page.locator('#caller .view-line');
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+0');
		await expect(lines).toHaveCount(3);
		await page.keyboard.press('ControlOrMeta+k');
		await page.keyboard.press('ControlOrMeta+j');
		await expect(lines).toHaveCount(9);
		await page.keyboard.press('F9');
		await page.keyboard.press('F10');
		await expect(lines).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
		await expect(lines).toHaveCount(9);
		for (const reason of ['timeout', 'escape', 'blur'] as const) {
			await page.keyboard.press('ControlOrMeta+k');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).inChordMode).toBe(true);
			if (reason === 'timeout') await page.clock.runFor(5001);
			if (reason === 'escape') await page.keyboard.press('Escape');
			if (reason === 'blur') {
				await page.locator('#owned .stanza-editor-input').focus();
				await page.locator('#caller .stanza-editor-input').focus();
			}
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).inChordMode).toBe(false);
			await page.keyboard.press('ControlOrMeta+0');
			await expect(lines).toHaveCount(9);
		}
	});
});

for (const kind of ['definition', 'call', 'type', 'symbols'] as const) {
	const shortcut = { definition: 'F12', call: 'Alt+Shift+h', type: 'Alt+Shift+t', symbols: 'ControlOrMeta+Shift+o' }[kind];
}

test('Chinese paste options open a shared action menu and Escape restores its trigger', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => {
		window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN');
	});
	await page.evaluate(() => window.ashStandaloneIntegration.runPasteProviderSelector());
	const trigger = page.getByRole('button', { name: '粘贴选项', exact: true });
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	await trigger.focus();
	await page.keyboard.press('ArrowDown');
	await expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByRole('menuitem')).toHaveCount(2);
	await page.keyboard.press('Escape');
	await expect(trigger).toBeFocused();
	await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	for (const key of ['Enter', 'Space', 'ArrowUp']) {
		await trigger.press(key);
		await expect(trigger).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByRole('menuitem')).toHaveCount(2);
		await page.keyboard.press('Escape');
		await expect(trigger).toBeFocused();
		await expect(trigger).toHaveAttribute('aria-expanded', 'false');
	}
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('CUSTOM');
	await page.keyboard.press('Escape');
	await expect(trigger).toHaveCount(0);
	await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
});

test('changing the document closes the paste menu with its selector', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.runPasteProviderSelector());
	const trigger = page.getByRole('button', { name: 'Paste options', exact: true });
	await trigger.click();
	await expect(page.getByRole('menuitem')).toHaveCount(2);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
	await expect(trigger).toHaveCount(0);
	await expect(page.locator('.ash-action-widget')).toHaveCount(0);
});
