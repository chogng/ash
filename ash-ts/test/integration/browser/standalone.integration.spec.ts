import { expect, test } from '@playwright/test';

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
					documentCommands: target === 'find' || handled && command !== 'paste' ? [command] : [],
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

	for (const change of ['none', 'writableAgain', 'selection', 'composition', 'escape'] as const) {
		test(`${inputKind} deferred file paste respects ${change} state before committing`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			expect(await page.evaluate(change => window.ashStandaloneIntegration.runDeferredPaste(change), change)).toEqual({
				value: change === 'none' ? 'alpha file' : 'alpha',
				handled: true,
				finishedBeforeDecode: change !== 'none',
			});
			if (change === 'none') {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			}
		});
	}
}

for (const change of ['none', 'readonly', 'writableAgain'] as const) {
	test(`deferred file drop respects ${change} state before committing`, async ({ page }) => {
		await page.goto('/standalone.html');
		expect(await page.evaluate(change => window.ashStandaloneIntegration.runDeferredDrop(change), change)).toEqual({
			value: change === 'none' ? 'alpha file' : 'alpha',
			selectionUnchanged: change !== 'none',
			handled: true,
		});
		if (change === 'none') {
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		}
	});
}

test('occurrence shortcuts and actions share the same selections and edit transaction', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo echo', [2]));
	await page.keyboard.press('ControlOrMeta+d');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]']);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.addSelectionToNextFindMatch'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
	await page.keyboard.press('ControlOrMeta+Shift+l');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(3);
	await page.keyboard.type('X');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('X X X');
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('echo echo echo');
});

test('cursor actions share line-end and adjacent cursor operations', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAtEndOfEachLineSelected'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('alpha\nbeta\ngamma', [2]));
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorBelow'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(2);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAbove'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo', [2]));
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.selectHighlights'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
});

test('multicursor registration handles line-end cursors and one undoable edit', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
	await page.keyboard.press('Alt+Shift+i');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
	await page.keyboard.type('X');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alphaX\nbetaX');
	await page.keyboard.press('ControlOrMeta+z');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta');
});

test('bracket navigation shares the controller with its action for multiple cursors', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
	await page.keyboard.press('ControlOrMeta+Shift+Backslash');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]', '[1,11 -> 1,11]']);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,1]', '[1,7 -> 1,7]']);
});

for (const entry of ['shortcut', 'action'] as const) {
	test(`bracket removal via ${entry} is one undo step`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
		if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
		else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('one two');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(one) [two]', selections: ['[1,1 -> 1,1]', '[1,7 -> 1,7]'] });
	});
}

for (const entry of ['shortcut', 'action'] as const) {
	test(`bracket removal via ${entry} preserves unrelated selected text`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(value) keep', [1, [13, 9]]));
		if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
		else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'value keep', selections: ['[1,1 -> 1,1]', '[1,11 -> 1,7]'] });
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(value) keep', selections: ['[1,1 -> 1,1]', '[1,13 -> 1,9]'] });
	});
}

test('bracket removal respects read-only state while navigation remains available', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one)', [1], true));
	await page.keyboard.press('ControlOrMeta+Alt+Backspace');
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('(one)');
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]']);
});

test('document formatting uses a range-only provider and remains undoable', async ({ page }) => {
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runFormatting('range'))).toBe('ALPHA');
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe('alpha');
});

test('line comment shortcuts share actions and preserve the primary selection below a secondary caret', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
	await page.keyboard.press('ControlOrMeta+/');
	const commented = { value: '// alpha\nbeta\n// gamma', selections: ['[3,7 -> 3,5]', '[1,5 -> 1,5]'] };
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.commentLine'));
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

for (const kind of ['line', 'block'] as const) {
	test(`${kind} comment shortcuts honor spacing and toggle through the action`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ insertSpace: false, value: 'alpha' }));
		await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
		await page.evaluate(kind => window.ashStandaloneIntegration.runLineAction(kind === 'line' ? 'editor.action.commentLine' : 'editor.action.blockComment'), kind);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
	});

	for (const mode of ['readonly', 'unsupported'] as const) {
		test(`${kind} comment shortcuts leave ${mode} text unchanged`, async ({ page }) => {
			await page.goto('/standalone.html');
			await page.evaluate(mode => window.ashStandaloneIntegration.prepareLineComment({ readOnly: mode === 'readonly', languageId: mode === 'unsupported' ? 'plaintext' : 'typescript' }), mode);
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		});
	}
}

test('line comment shortcuts use the configured empty-line policy', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ value: 'alpha\n\nbeta' }));
	await page.keyboard.press('ControlOrMeta+/');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('// alpha\n\n// beta');
});

test('transpose letters keeps a selected primary range while editing a secondary caret', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
	await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.transposeLetters'));
	const after = { value: 'lapha\nbeta\ngamma', selections: ['[3,4 -> 3,2]', '[1,3 -> 1,3]'] };
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
	await page.keyboard.press('ControlOrMeta+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	await page.keyboard.press('ControlOrMeta+Shift+z');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const direction of ['Up', 'Down']) {
	test(`copy final lines ${direction} includes the empty last line and restores selections on undo`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy(true));
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
		const delta = direction === 'Down' ? 1 : 0;
		const copied = { value: 'head\ntail\ntail\n\n', selections: [`[${4 + delta},1 -> ${4 + delta},1]`, `[${2 + delta},3 -> ${2 + delta},1]`] };
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test(`copy lines ${direction} retains multiple cursors and separates undo from typing`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
		await page.keyboard.type('X');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
		const copied = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		const delta = direction === 'Down' ? 1 : 0;
		expect(copied).toEqual({ value: 'aXlpha\naXlpha\nbeta\ngXma\ngXma', selections: [`[${4 + delta},3 -> ${4 + delta},3]`, `[${1 + delta},3 -> ${1 + delta},3]`] });
		await page.keyboard.type('!');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

for (const id of ['editor.action.duplicateSelection', 'editor.action.moveLinesDownAction', 'editor.action.sortLinesDescending']) {
	test(`${id} has its own undo step between typing operations`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.type('Z');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), id);
		const edited = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		expect(edited.value).not.toBe(before.value);
		await page.keyboard.type('!');
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(edited);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

test('public range selection replaces the selected text through keyboard input and undo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.selectRange());
	expect(selected).toEqual({ value: 'first\nsecond', version: before.version, selection: '[1,2 -> 2,4]', focused: true });
	await expect(page.locator('#caller .stanza-editor-selection')).toHaveCount(2);
	await expect(input).toBeFocused();
	await page.keyboard.type('X');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('fXond');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('first\nsecond');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().selection)).toBe('[1,2 -> 2,4]');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone editors type and release their models, contributions, registry entries, and DOM', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await expect(page.locator('#caller .stanza-editor')).toBeVisible();
	await expect(page.locator('#owned .stanza-editor')).toBeVisible();
	const initial = await page.evaluate(() => ({
		events: window.ashStandaloneIntegration.events,
		caller: window.ashStandaloneIntegration.state('caller'),
		owned: window.ashStandaloneIntegration.state('owned'),
	}));
	expect(initial).toEqual({
		events: [
			{ model: 'inmemory://stanza/caller.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
			{ model: 'inmemory://stanza/owned.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
		],
		caller: {
			value: 'caller', disposed: false, registered: true, modelRegistered: true,
			mounted: true, placeholder: true, theme: 'ash-light',
		},
		owned: {
			value: 'owned', disposed: false, registered: true, modelRegistered: true,
			mounted: true, placeholder: true, theme: 'ash-light',
		},
	});

	for (const kind of ['caller', 'owned'] as const) {
		const input = page.locator(`#${kind} .stanza-editor-input`);
		await expect(input).toHaveAttribute('aria-label', /.+/u);
		await input.focus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type('!');
		await expect.poll(() => page.evaluate(name => window.ashStandaloneIntegration.state(name).value, kind)).toBe(`${kind}!`);
	}

	await page.evaluate(() => window.ashStandaloneIntegration.releaseCaller());
	await expect(page.locator('#caller .stanza-editor')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).toEqual({
		value: 'changed after editor disposal', disposed: false, registered: false, modelRegistered: true,
		mounted: false, placeholder: false, theme: null,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
	await expect(page.locator('#owned .stanza-editor')).toHaveCount(0);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('owned'))).toEqual({
		value: null, disposed: true, registered: false, modelRegistered: false,
		mounted: false, placeholder: false, theme: null,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('standalone editor switches a live model in place and keeps caller ownership', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.locator('#owned .stanza-editor-input').focus();
	const switched = await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller());
	expect(switched).toEqual({
		ownedModelDisposed: true,
		ownedModelRegistered: false,
		rootRetained: true,
		editorCount: 2,
		currentModelIsCaller: true,
	});
	await expect(page.locator('#owned .stanza-editor')).toHaveCount(1);
	await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.getOwnedValue())).toBe('caller!');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!');

	expect(await page.evaluate(() => window.ashStandaloneIntegration.detachOwned())).toEqual({
		modelIsNull: true,
		value: '',
		rootMounted: true,
		inputCount: 0,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.reattachOwned());
	await expect(page.locator('#owned .stanza-editor-input')).toHaveCount(1);
	await page.locator('#owned .stanza-editor-input').focus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('?');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!?');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.events.length)).toBe(2);
	await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
	expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').disposed)).toBe(false);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('public editor edits preserve complete UTF-16 characters and reject overlapping batches', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.tryOverlappingSurrogateEdits())).toEqual({
		rejected: true,
		value: 'a📚b',
		versionUnchanged: true,
	});
	await expect(page.locator('#caller .view-line')).toContainText('a📚b');
	await expect(page.locator('#owned .view-line')).toContainText('a📚b');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.applySurrogateEdit())).toBe('ab');
	await expect(page.locator('#caller .view-line')).toContainText('ab');
	await expect(page.locator('#owned .view-line')).toContainText('ab');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('same-value reset advances the shared model version and preserves existing snapshots', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const result = await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
	expect(result).toEqual({
		beforeVersion: result.beforeVersion,
		afterVersion: result.beforeVersion + 1,
		alternativeVersion: result.beforeVersion + 1,
		snapshotValue: 'stable',
		events: [{ version: result.beforeVersion + 1, reason: 'reset', changes: 0 }],
	});
	await expect(page.locator('#caller .view-line')).toContainText('stable');
	await expect(page.locator('#owned .view-line')).toContainText('stable');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('keyboard undo and redo restore multi-cursor selections in a shared model', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const input = page.locator('#caller .stanza-editor-input');
	const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareSelectionUndo());
	expect(before.ownedSelections).toEqual(['[2,3 -> 2,3]']);
	await input.focus();
	await expect(input).toBeFocused();
	const focused = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({
		caller: focused.callerFocused,
		owned: focused.ownedFocused,
		activeInput: focused.activeInput,
	}).toEqual({ caller: true, owned: false, activeInput: 'caller' });
	const edited = await page.evaluate(() => window.ashStandaloneIntegration.applySelectionEdit());
	expect(edited.value).toBe('A\nB');
	expect(edited.callerSelections).toEqual(['[1,2 -> 1,2]', '[2,2 -> 2,2]']);
	expect(edited.ownedSelections).toHaveLength(1);
	expect({
		caller: edited.callerFocused,
		owned: edited.ownedFocused,
		activeInput: edited.activeInput,
	}).toEqual({ caller: true, owned: false, activeInput: 'caller' });

	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({ value: undone.value, version: undone.version, selections: undone.callerSelections }).toEqual({
		value: 'alpha\nbeta',
		version: edited.version + 1,
		selections: ['[1,6 -> 1,1]', '[2,1 -> 2,5]'],
	});
	expect(undone.ownedSelections).toHaveLength(1);
	await expect(page.locator('#caller .view-line')).toContainText(['alpha', 'beta']);
	await expect(page.locator('#owned .view-line')).toContainText(['alpha', 'beta']);

	await page.keyboard.press('ControlOrMeta+Shift+z');
	const redone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
	expect({ value: redone.value, version: redone.version, selections: redone.callerSelections }).toEqual({
		value: 'A\nB',
		version: undone.version + 1,
		selections: edited.callerSelections,
	});
	expect(redone.ownedSelections).toHaveLength(1);
	await expect(page.locator('#caller .view-line')).toContainText(['A', 'B']);
	await expect(page.locator('#owned .view-line')).toContainText(['A', 'B']);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('model word lookup handles empty regular-expression matches before an emoji', async ({ page }) => {
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.runEmptyWordPattern())).toEqual({ word: 'foo', startColumn: 4, endColumn: 7 });
});

for (const kind of ['codeAction', 'rename', 'parameterHints', 'queuedParameterHints'] as const) {
	test(`disposing the editor cancels ${kind} work`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		expect(await page.evaluate(kind => window.ashStandaloneIntegration.runDisposedLanguageRequest(kind), kind)).toEqual(
			kind === 'queuedParameterHints' ? { calls: 0, aborted: false } : { calls: 1, aborted: true },
		);
		expect(errors).toEqual([]);
	});
}

test('code action dismissal restores focus only when its menu owns focus', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions());
	const input = page.locator('#caller .stanza-editor-input');
	const menu = page.locator('#caller .stanza-editor-code-action');
	const action = menu.getByRole('menuitem', { name: 'Example code action' });
	await input.focus();
	await page.keyboard.press('ControlOrMeta+.');
	await expect(action).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(input).toBeFocused();

	await page.keyboard.press('ControlOrMeta+.');
	await expect(action).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
	await expect(menu).toBeHidden();
	await expect(input).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('shared editors retain line identities through split, undo, and redo', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareLineIdentity());
	expect({
		value: initial.value,
		lineCount: initial.ids.length,
		longLineIndex: initial.longLineIndex,
		longLineEnd: initial.longLineEnd,
	}).toEqual({
		value: 'a\nlonger',
		lineCount: 2,
		longLineIndex: 1,
		longLineEnd: [2, 7],
	});
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	const split = await page.evaluate(() => window.ashStandaloneIntegration.splitLineIdentity());
	expect(split).toEqual({
		value: 'a\n\nlonger',
		version: initial.version + 1,
		ids: [initial.ids[0], split.ids[1], initial.ids[1]],
		longLineIndex: 2,
		longLineEnd: [3, 7],
	});
	expect(split.ids[1]).not.toBe(initial.ids[0]);
	expect(split.ids[1]).not.toBe(initial.ids[1]);
	await expect(page.locator('#caller .view-line')).toHaveCount(3);
	await expect(page.locator('#owned .view-line')).toHaveCount(3);

	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
	expect(undone).toEqual({ ...initial, version: split.version + 1 });
	await expect(page.locator('#caller .view-line')).toHaveCount(2);
	await expect(page.locator('#owned .view-line')).toHaveCount(2);

	await page.keyboard.press('ControlOrMeta+Shift+z');
	const redone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
	expect(redone).toEqual({ ...split, version: undone.version + 1 });
	await expect(page.locator('#caller .view-line')).toHaveCount(3);
	await expect(page.locator('#owned .view-line')).toHaveCount(3);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('large standalone models keep both editors readable within the tokenization budget', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const state = await page.evaluate(() => window.ashStandaloneIntegration.openLargeModel());
	expect(state).toEqual({
		textUnits: 20_500 * 1_024 + 20_499,
		lineCount: 20_500,
		tooLargeForTokenization: true,
		tooLargeForSynchronization: false,
		attachedEditors: 2,
		firstChunkPrefix: 'x'.repeat(32),
	});
	await expect(page.locator('#caller .view-line').first()).toContainText('x'.repeat(32));
	await expect(page.locator('#owned .view-line').first()).toContainText('x'.repeat(32));
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('completion snippets navigate and undo through the mounted editor', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation('${1:name}(${2:value})$0'));
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Control+Space');
	await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
	await page.keyboard.press('Enter');
	await expect(page.locator('#caller .view-line').first()).toContainText('conname(value)');
	await page.keyboard.type('fn');
	await page.keyboard.press('Tab');
	await page.keyboard.type('arg');
	await page.keyboard.press('Tab');
	await page.keyboard.type(';');
	await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg);');
	await page.keyboard.press('Escape');
	await page.keyboard.press('ControlOrMeta+z');
	await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg)');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const { placement, snippet, initial, expanded } of [
	{ placement: 'interleaved', snippet: '${1|a,long|} => ${1/(.*)/${1:/upcase}/} $1$0', initial: 'cona => A a', expanded: 'conlong => LONG long' },
	{ placement: 'forward', snippet: '${1/(.*)/${1:/upcase}/} ${1|a,long|}-$1$0', initial: 'conA a-a', expanded: 'conLONG long-long' },
	{ placement: 'nested forward mirror', snippet: '${2:$1-${1|a,long|}} => ${1/(.*)/${1:/upcase}/}$0', initial: 'cona-a => A', expanded: 'conlong-long => LONG' },
]) {
	test(`snippet choices keep ${placement} transforms and mirrors together through undo and redo`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(snippet => window.ashStandaloneIntegration.enableCompletionNavigation(snippet), snippet);
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await page.keyboard.press('Enter');
		const line = page.locator('#caller .view-line').first();
		await expect(line).toContainText(initial);
		const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
		await page.keyboard.press('Alt+ArrowDown');
		await expect(line).toContainText(expanded);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version + 1);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(line).toContainText(initial);
		await page.keyboard.press('Alt+ArrowDown');
		await expect(line).toContainText(expanded);
		await page.keyboard.press('ControlOrMeta+z');
		await expect(line).toContainText(initial);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect(line).toContainText(expanded);
		await page.keyboard.press('Alt+ArrowUp');
		await expect(line).toContainText(initial);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('completion arrow keys select a suggestion before editor navigation', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Control+Space');
	const options = page.locator('#caller .stanza-editor-completion-option');
	await expect(options).toHaveCount(2);
	await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });

	await page.keyboard.press('ArrowDown');
	await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
	const optionId = await options.nth(1).getAttribute('id');
	expect(optionId).toBeTruthy();
	await expect(input).toHaveAttribute('aria-activedescendant', optionId!);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });
	await page.keyboard.press('Enter');
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('conconsole');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('keyboard selection, deletion, undo, and typing share one edit path', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
	const input = page.locator('#caller .stanza-editor-input');
	await input.focus();
	await page.keyboard.press('Shift+ArrowDown');
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: selected.value, version: selected.version, selection: selected.selection }).toEqual({
		value: 'first\nsecond',
		version: initial.version,
		selection: '[1,3 -> 2,3]',
	});

	await page.keyboard.press('Backspace');
	const deleted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: deleted.value, version: deleted.version, selection: deleted.selection }).toEqual({
		value: 'ficond',
		version: initial.version + 1,
		selection: '[1,3 -> 1,3]',
	});
	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: undone.value, version: undone.version, selection: undone.selection }).toEqual({
		value: 'first\nsecond',
		version: deleted.version + 1,
		selection: '[1,3 -> 2,3]',
	});

	await page.keyboard.press('ArrowLeft');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.type('X');
	const typed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
	expect({ value: typed.value, version: typed.version, selection: typed.selection, focused: typed.focused }).toEqual({
		value: 'firXst\nsecond',
		version: undone.version + 1,
		selection: '[1,5 -> 1,5]',
		focused: true,
	});
	await expect(page.locator('#caller .view-line').first()).toContainText('firXst');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('double-clicking editor text selects the whole word', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	const character = await page.evaluate(() => {
		const spans = [...document.querySelectorAll('#caller .view-line > span > span')];
		const box = spans[0]?.getBoundingClientRect();
		return { text: spans.map(span => span.textContent).join(''), box: box && { x: box.x, y: box.y, width: box.width, height: box.height } };
	});
	expect(character.text.startsWith('alpha beta')).toBe(true);
	expect(character.box).toBeTruthy();
	await page.mouse.dblclick(character.box!.x + character.box!.width / 4, character.box!.y + character.box!.height / 2);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection())).toEqual({
		value: 'alpha beta\nsecond line',
		version: before.version,
		selection: '[1,1 -> 1,6]',
		ownedSelection: before.ownedSelection,
		focused: true,
		mouseUpEvents: 2,
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('pointer drag extends one editor selection and stops on release', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
	const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map(span => {
		const box = span.getBoundingClientRect();
		return { text: span.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
	}));
	expect(lines.map(line => line.text)).toEqual(['alpha beta', 'second line']);
	await page.mouse.move(lines[0]!.x + lines[0]!.width * 0.3, lines[0]!.y + lines[0]!.height / 2);
	await page.mouse.down();
	await page.mouse.move(lines[1]!.x + lines[1]!.width * 0.7, lines[1]!.y + lines[1]!.height / 2, { steps: 5 });
	await page.mouse.up();
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	expect(selected.selection).toMatch(/^\[1,\d+ -> 2,\d+\]$/u);
	expect({ value: selected.value, version: selected.version, ownedSelection: selected.ownedSelection, focused: selected.focused, mouseUpEvents: selected.mouseUpEvents }).toEqual({
		value: before.value,
		version: before.version,
		ownedSelection: before.ownedSelection,
		focused: true,
		mouseUpEvents: 1,
	});
	await page.mouse.move(lines[0]!.x + lines[0]!.width * 0.8, lines[0]!.y + lines[0]!.height / 2);
	const released = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
	expect({ selection: released.selection, mouseUpEvents: released.mouseUpEvents }).toEqual({ selection: selected.selection, mouseUpEvents: 1 });
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('Alt-click toggles editor-local cursors and one typing transaction edits both lines', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.prepareMultiCursor());
	const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map(span => {
		const box = span.getBoundingClientRect();
		return { text: span.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
	}));
	expect(lines.map(line => line.text)).toEqual(['abcd', 'efgh']);
	const first = { x: lines[0]!.x + lines[0]!.width * 0.4, y: lines[0]!.y + lines[0]!.height / 2 };
	const second = { x: lines[1]!.x + lines[1]!.width * 0.4, y: lines[1]!.y + lines[1]!.height / 2 };
	await page.mouse.click(first.x, first.y);
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	const added = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(added.selections).toHaveLength(2);
	expect(added.selections.map(selection => Number(selection.match(/^\[(\d+),/u)?.[1])).sort()).toEqual([1, 2]);
	expect({ value: added.value, version: added.version, ownedSelections: added.ownedSelections }).toEqual({
		value: initial.value,
		version: initial.version,
		ownedSelections: initial.ownedSelections,
	});

	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	const removed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(removed.selections).toHaveLength(1);
	expect(removed.selections[0]).toMatch(/^\[1,/u);
	await page.keyboard.down('Alt');
	await page.mouse.click(second.x, second.y);
	await page.keyboard.up('Alt');
	await page.keyboard.type('X');
	const typed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(typed.value.split('\n').map(line => (line.match(/X/gu) ?? []).length)).toEqual([1, 1]);
	expect(typed.version).toBe(initial.version + 1);
	expect(typed.ownedSelections).toHaveLength(1);
	await page.keyboard.press('ControlOrMeta+z');
	const undone = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
	expect(undone.value).toBe('abcd\nefgh');
	expect(undone.version).toBe(typed.version + 1);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const inputKind of ['EditContext', 'textarea'] as const) {
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
			const context = (input as HTMLElement & { editContext?: EventTarget }).editContext;
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
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
				textArea.value = '你好';
				textArea.setSelectionRange(2, 2);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你好' }));
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
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
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
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '你';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你' }));
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
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			target.dispatchEvent(new CompositionEvent('compositionend', { data: '你' }));
			target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
			return document.querySelector('#caller .stanza-editor')?.classList.contains('composing');
		}, inputKind);
		expect(lateStart).toBe(false);
		await page.evaluate(kind => {
			const input = document.querySelector<HTMLElement>('#caller .stanza-editor-input');
			if (!input) throw new Error('Caller input is unavailable');
			const target = kind === 'textarea' ? input : (input as HTMLElement & { editContext?: EventTarget }).editContext;
			if (!target) throw new Error('Composition target is unavailable');
			if (kind === 'textarea') {
				const textArea = input as HTMLTextAreaElement;
				textArea.value = '迟';
				textArea.setSelectionRange(1, 1);
				target.dispatchEvent(new CompositionEvent('compositionupdate', { data: '迟' }));
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

	for (const mode of ['full', 'partial', 'line', 'multi', 'disabled'] as const) {
		test(`${inputKind} rich clipboard copy preserves ${mode} content and token styles`, async ({ page }) => {
			if (inputKind === 'textarea') {
				await page.addInitScript(() => { Reflect.deleteProperty(window, 'EditContext'); });
			}
			await page.goto('/standalone.html');
			await page.evaluate(mode => {
				const ranges: Record<typeof mode, [number, number, number, number][]> = {
					full: [[1, 1, 2, 9]], partial: [[1, 3, 1, 5]], line: [[1, 3, 1, 3]],
					multi: [[1, 3, 1, 5], [2, 2, 2, 5]], disabled: [[1, 1, 2, 9]],
				};
				window.ashStandaloneIntegration.prepareClipboard('const <x>&\n\t"value"', ranges[mode]);
				window.ashStandaloneIntegration.configureClipboardTokens(mode !== 'disabled');
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
			const expected = { full: 'const <x>&\n\t"value"', partial: 'ns', line: 'const <x>&\n', multi: 'ns\n"va', disabled: 'const <x>&\n\t"value"' }[mode];
			expect(copied.text).toBe(expected);
			if (mode === 'disabled') {
				expect(copied.html).toBe('');
			} else {
				expect(copied.richText).toBe(expected);
				expect(copied.injected).toBe(false);
				expect(copied.styles[0]).toMatchObject({ color: 'rgb(18, 52, 86)', weight: 'bold', italic: 'italic' });
				if (mode === 'full' || mode === 'multi') {
					expect(copied.styles.at(-1)).toMatchObject({ color: 'rgb(101, 67, 33)', decoration: 'underline' });
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
		test(`${inputKind} HTML clipboard preserves ${scenario.name}`, async ({ page }) => {
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
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha' + scenario.text);
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
			const expected = { html: 'alpha<x> & one\ntwo\nthree', plain: 'alpha plain', readonly: 'alpha' }[mode];
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(expected);
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
				return { text, metadata, state: window.ashStandaloneIntegration.readLineCopy() };
			}, mode);
			if (mode === 'selections') {
				expect(result.text).toBe('a\nb');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: false, multicursorText: ['a', 'b'] });
				expect(result.state.value).toBe('a b');
			} else if (mode === 'externalLines') {
				expect(result.state.value).toBe('Xa Yb');
			} else if (mode === 'line') {
				expect(result.text).toBe('alpha\n');
				expect(JSON.parse(result.metadata)).toMatchObject({ isFromEmptySelection: true });
				expect(result.state).toEqual({ value: 'alpha\nalpha\nbeta', selections: ['[2,3 -> 2,3]'] });
			} else {
				expect(result.text).toBe('');
				expect(result.state).toEqual({ value: 'alpha\nbeta', selections: ['[1,3 -> 1,3]'] });
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

test('soft wrapping keeps layout, model coordinates and pointer selection in sync after resize and edit', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareWrappedLayout());
	expect(initial.modelLineCount).toBe(1);
	expect(initial.contentHeight).toBeGreaterThan(80);
	const rows = page.locator('#caller .view-line');
	const initialRows = await rows.count();
	expect(initialRows).toBeGreaterThan(1);
	const firstText = (await rows.first().textContent()) ?? '';
	const second = await rows.nth(1).boundingBox();
	expect(second).not.toBeNull();
	await page.mouse.click(second!.x + 8, second!.y + second!.height / 2);
	const selected = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
	expect(selected?.lineNumber).toBe(1);
	expect(selected?.column).toBeGreaterThan(firstText.length);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.readWrappedLayout())).toEqual(initial);

	const wider = await page.evaluate(() => window.ashStandaloneIntegration.resizeWrappedLayout(320));
	expect({ value: wider.value, version: wider.version, modelLineCount: wider.modelLineCount }).toEqual({
		value: initial.value,
		version: initial.version,
		modelLineCount: 1,
	});
	expect(wider.contentHeight).toBeLessThan(initial.contentHeight);
	await expect.poll(() => rows.count()).toBeLessThan(initialRows);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(selected);

	const short = await page.evaluate(() => window.ashStandaloneIntegration.editWrappedText('short'));
	expect(short).toEqual({ value: 'short', version: initial.version + 1, modelLineCount: 1, contentHeight: 80 });
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('short');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('proportional-font soft wrapping keeps a word together at the available width', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const state = await page.evaluate(() => window.ashStandaloneIntegration.prepareProportionalWrap());
	expect({ value: state.value, modelLineCount: state.modelLineCount }).toEqual({ value: 'abc defgh', modelLineCount: 1 });
	const rows = page.locator('#caller .view-line');
	await expect(rows).toHaveCount(2);
	expect(await rows.allTextContents()).toEqual(['abc ', 'defgh']);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('scrolling keeps overlapping visible rows attached and releases rows that leave the viewport', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareVisibleRows());
	expect(initial.lineCount).toBe(80);
	const result = await page.evaluate(async () => {
		const layers = [...document.querySelectorAll<HTMLElement>('#caller .view-lines, #caller .stanza-editor-row-layer.view-overlays')];
		const tracked = layers.map(layer => {
			const before = new Map<number, HTMLElement>();
			for (const child of layer.children) {
				const row = child as HTMLElement;
				before.set(Number(row.dataset.lineIndex), row);
			}
			const removed = new Set<Node>();
			const observer = new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.removedNodes) {
						removed.add(node);
					}
				}
			});
			observer.observe(layer, { childList: true });
			return { layer, before, removed, observer };
		});
		let scrollTop = 0;
		try {
			scrollTop = window.ashStandaloneIntegration.scrollVisibleRows(60);
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
		} finally {
			for (const entry of tracked) {
				entry.observer.disconnect();
			}
		}
		const snapshots = tracked.map(({ layer, before, removed }) => {
			const after = new Map<number, HTMLElement>();
			for (const child of layer.children) {
				const row = child as HTMLElement;
				after.set(Number(row.dataset.lineIndex), row);
			}
			const overlap = [...before.keys()].filter(index => after.has(index));
			return {
				kind: layer.classList.contains('view-lines') ? 'text' : 'overlay',
				beforeCount: before.size,
				afterCount: after.size,
				firstBefore: Math.min(...before.keys()),
				firstAfter: Math.min(...after.keys()),
				firstText: after.values().next().value?.textContent ?? '',
				overlap: overlap.length,
				stable: overlap.every(index => before.get(index) === after.get(index)),
				removedOverlap: overlap.filter(index => removed.has(before.get(index)!)).length,
				staleDetached: [...before].filter(([index]) => !after.has(index)).every(([, row]) => !row.isConnected),
			};
		});
		return { scrollTop, snapshots };
	});
	expect(result.scrollTop).toBe(60);
	expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
	for (const layer of result.snapshots) {
		expect(layer.beforeCount).toBeGreaterThan(0);
		expect(layer.afterCount).toBeLessThan(20);
		expect(layer.firstAfter).toBeGreaterThan(layer.firstBefore);
		expect(layer.overlap).toBeGreaterThan(0);
		expect(layer.stable).toBe(true);
		expect(layer.removedOverlap).toBe(0);
		expect(layer.staleDetached).toBe(true);
	}
	const textLayer = result.snapshots.find(layer => layer.kind === 'text');
	if (!textLayer) throw new Error('Visible text layer is unavailable');
	expect(textLayer.firstText).toContain(`line-${String(textLayer.firstAfter).padStart(2, '0')}`);
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);
	const updated = await page.evaluate(async lineIndex => {
		const selector = `#caller .view-line[data-line-index="${lineIndex}"]`;
		const row = document.querySelector<HTMLElement>(selector);
		const layer = document.querySelector<HTMLElement>('#caller .view-lines');
		if (!row || !layer) throw new Error('Visible text row is unavailable');
		let removed = false;
		const observer = new MutationObserver(records => {
			for (const record of records) {
				for (const node of record.removedNodes) {
					if (node === row) removed = true;
				}
			}
		});
		observer.observe(layer, { childList: true });
		try {
			const value = window.ashStandaloneIntegration.editVisibleRow(lineIndex);
			await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			return { value, sameNode: document.querySelector(selector) === row, connected: row.isConnected, removed, text: row.textContent };
		} finally {
			observer.disconnect();
		}
	}, textLayer.firstAfter);
	expect(updated).toEqual({
		value: `changed-${textLayer.firstAfter}`,
		sameNode: true,
		connected: true,
		removed: false,
		text: `changed-${textLayer.firstAfter}`,
	});
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version + 1);
	const released = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('#caller .view-line')];
		window.ashStandaloneIntegration.dispose();
		return { detached: rows.every(row => !row.isConnected), roots: document.querySelectorAll('#caller .view-lines').length };
	});
	expect(released).toEqual({ detached: true, roots: 0 });
	expect(errors).toEqual([]);
});

test('wrapped cursor and gutter markers stay on their model lines through navigation and editing', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.stack ?? error.message));
	await page.goto('/standalone.html');
	const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareCursorGutter());
	expect(initial.modelLineCount).toBe(2);
	await page.locator('#caller .stanza-editor-input').focus();
	const readGeometry = async () => page.evaluate(() => {
		const firstRows = [...document.querySelectorAll<HTMLElement>('#caller .view-line[data-logical-line-index="0"]')];
		const secondRow = document.querySelector<HTMLElement>('#caller .view-line[data-logical-line-index="1"]');
		const caret = document.querySelector<HTMLElement>('#caller .stanza-editor-caret.primary');
		const glyphs = [...document.querySelectorAll<HTMLElement>('#caller .ash-gutter-probe')];
		const numberRows = [...document.querySelectorAll<HTMLElement>('#caller .margin-view-overlays .view-overlay-line')];
		if (!firstRows.length || !secondRow || !caret) {
			throw new Error(`Cursor and gutter rows are unavailable: first=${firstRows.length}, second=${Boolean(secondRow)}, caret=${Boolean(caret)}`);
		}
		return {
			wrappedRows: firstRows.length,
			firstTop: firstRows[0]!.getBoundingClientRect().top,
			lastTop: firstRows.at(-1)!.getBoundingClientRect().top,
			secondTop: secondRow.getBoundingClientRect().top,
			caretTop: caret.getBoundingClientRect().top,
			glyphTops: glyphs.map(glyph => glyph.getBoundingClientRect().top),
			numbers: numberRows.map(row => row.querySelector('.line-numbers')?.textContent ?? ''),
		};
	});
	const wrapped = await readGeometry();
	expect(wrapped.wrappedRows).toBeGreaterThan(1);
	expect(wrapped.numbers[0]).toBe('1');
	expect(wrapped.numbers.slice(1, wrapped.wrappedRows)).toEqual(Array(wrapped.wrappedRows - 1).fill(''));
	expect(wrapped.numbers[wrapped.wrappedRows]).toBe('1');
	expect(wrapped.glyphTops).toEqual([wrapped.firstTop]);
	expect(wrapped.caretTop).toBe(wrapped.lastTop);

	await page.evaluate(() => window.ashStandaloneIntegration.moveGutterCaret(2, 1));
	const moved = await readGeometry();
	expect(moved.caretTop).toBe(moved.secondTop);
	expect(moved.glyphTops).toEqual([moved.firstTop]);
	expect(moved.numbers[0]).toBe('1');
	expect(moved.numbers[moved.wrappedRows]).toBe('2');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);

	const editedVersion = await page.evaluate(() => window.ashStandaloneIntegration.shortenGutterLine());
	expect(editedVersion).toBe(initial.version + 1);
	const shortened = await readGeometry();
	expect(shortened.secondTop).toBeLessThan(moved.secondTop);
	expect(shortened.caretTop).toBe(shortened.secondTop);
	expect(shortened.glyphTops).toEqual([shortened.firstTop]);
	expect(shortened.numbers[0]).toBe('1');
	expect(shortened.numbers[shortened.wrappedRows]).toBe('2');
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	await expect(page.locator('#caller .ash-gutter-probe')).toHaveCount(0);
	expect(errors).toEqual([]);
});

for (const unit of ['pixels', 'lines'] as const) {
	test(`standalone view zones collapse and expand in ${unit} without changing text or decoration anchors`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(value => window.ashStandaloneIntegration.prepareViewZone(value), unit);
		expect(initial.computedHeights).toEqual([0]);
		const zone = page.locator('#caller .ash-zone-probe');
		const margin = page.locator('#caller .ash-zone-margin-probe');
		const block = page.locator('#caller .ash-zone-block-probe');
		const caret = page.locator('#caller .stanza-editor-caret.primary');
		await page.locator('#caller .stanza-editor-input').focus();
		await expect(zone).toHaveCount(1);
		await expect(zone).toHaveAttribute('data-computed-height', '0');
		await expect(zone).toBeHidden();
		await expect(margin).toBeHidden();
		const originalBlock = await block.boundingBox();
		expect(originalBlock).not.toBeNull();
		const originalCaret = await caret.boundingBox();
		expect(originalCaret).not.toBeNull();
		const node = await zone.elementHandle();
		const height = unit === 'pixels' ? 40 : 2;
		const expanded = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
		expect(expanded).toEqual({
			version: initial.version,
			lineTop: initial.lineTop + 40,
			contentHeight: initial.contentHeight + 40,
			computedHeights: [0, 40],
		});
		await expect(zone).toBeVisible();
		await expect(zone).toHaveCSS('height', '40px');
		await expect(zone).toHaveAttribute('data-computed-height', '40');
		await expect(zone).toHaveAttribute('data-top', '20');
		await expect(margin).toHaveCSS('height', '40px');
		await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height + 40);
		await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y + 40);
		expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-zone-probe'))).toBe(true);

		const moved = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 2), height);
		expect(moved.lineTop).toBe(initial.lineTop);
		await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y);
		await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
		const collapsed = await page.evaluate(() => window.ashStandaloneIntegration.resizeViewZone(0, 1));
		expect(collapsed).toEqual({ ...initial, computedHeights: [0, 40, 40, 0] });
		await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height);
		await expect(zone).toBeHidden();
		await expect(margin).toBeHidden();
		await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
		await expect(zone).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.removeViewZone());
		await expect(zone).toHaveCount(0);
		await expect(margin).toHaveCount(0);
		await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
		expect(await node!.evaluate(element => element.isConnected)).toBe(false);
		await node!.dispose();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});
}

test('public editor contracts honor initial wrapping, animated scrolling, content events, and detachment', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.checkContracts())).toEqual({
		wrapping: 'on', wrapped: true, animated: true, settled: true, top: 600, interrupted: true, detached: true, eventTexts: ['X'],
	});
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});


test('standalone marker decorations appear and clear through the shared marker service', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(true));
	await expect(page.locator('#caller .squiggly-error')).toHaveCount(1);
	await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(false));
	await expect(page.locator('#caller .squiggly-error')).toHaveCount(0);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('reference Peek embeds a read-only editor that follows parent configuration and releases on Escape', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.prepareReferencePreview());
	const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
	await input.focus();
	await page.keyboard.press('Shift+F12');
	const preview = page.locator('.stanza-editor-language-preview .stanza-editor');
	await expect(preview).toBeVisible();
	await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
	await page.evaluate(() => window.ashStandaloneIntegration.setParentFontSize());
	await expect(preview.locator('.stanza-editor-line-text').first()).toHaveCSS('font-size', '18px');
	await preview.locator('.stanza-editor-input').focus();
	await page.keyboard.type('X');
	await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
	await page.keyboard.press('Escape');
	await expect(preview).toHaveCount(0);
	await expect(input).toBeFocused();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

test('minimap repaints token colors when the registry palette changes', async ({ page }) => {
	await page.goto('/standalone.html');
	await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#ff0000'));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel().slice(0, 3))).toEqual([255, 0, 0]);
	await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#0000ff'));
	await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel().slice(0, 3))).toEqual([0, 0, 255]);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
});

test('standalone view zones stay after the wrapped fold header while folded and scrolled', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(true));
	const zone = page.locator('#caller .ash-folded-zone-probe');
	const margin = page.locator('#caller .ash-folded-zone-margin-probe');
	await expect(zone).toHaveCSS('top', '80px');
	const node = await zone.elementHandle();
	await page.locator('#caller .ash-icon-folding-expanded').first().click();
	await expect(page.locator('#caller .ash-icon-folding-collapsed').first()).toBeVisible();
	await expect(zone).toHaveCSS('top', '60px');
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '60');
	await expect(margin).toHaveCSS('top', '60px');
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
	await expect(zone).toBeVisible();
	await expect(zone).toHaveAttribute('data-top', '20');
	await expect.poll(async () => {
		const bounds = await zone.boundingBox();
		const root = await page.locator('#caller .stanza-editor').boundingBox();
		return bounds && root ? Math.round(bounds.y - root.y) : null;
	}).toBe(20);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
	await page.locator('#caller .ash-icon-folding-collapsed').first().click();
	await expect(zone).toHaveCSS('top', '80px');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
	expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(await node!.evaluate(element => element.isConnected)).toBe(false);
	await node!.dispose();
	expect(errors).toEqual([]);
});


test('folding hides view zones and restores their layout callbacks after scrolling and unfolding', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(false));
	const zone = page.locator('#caller .ash-folded-zone-probe');
	const margin = page.locator('#caller .ash-folded-zone-margin-probe');
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '80');
	const node = await zone.elementHandle();
	await page.locator('#caller .ash-icon-folding-expanded').first().click();
	await expect(zone).toBeHidden();
	await expect(margin).toBeHidden();
	await expect(zone).toHaveAttribute('data-computed-height', '0');
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
	await expect(zone).toBeHidden();
	await expect.poll(() => zone.getAttribute('data-top').then(Number)).toBeLessThan(0);
	await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
	await page.locator('#caller .ash-icon-folding-collapsed').first().click();
	await expect(zone).toBeVisible();
	await expect(margin).toBeVisible();
	await expect(zone).toHaveAttribute('data-computed-height', '40');
	await expect(zone).toHaveAttribute('data-top', '80');
	expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
	expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(await node!.evaluate(element => element.isConnected)).toBe(false);
	await node!.dispose();
	expect(errors).toEqual([]);
});


test('editor rendering follows updated configuration without replacing the view', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto('/standalone.html');
	const root = page.locator('#caller .stanza-editor');
	const minimap = page.locator('#caller .minimap');
	const node = await root.elementHandle();
	const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
	for (const enabled of [false, true, false]) {
		expect(await page.evaluate(value => window.ashStandaloneIntegration.updateRenderingOptions(value), enabled)).toBe(version);
		await expect(minimap).toBeVisible({ visible: enabled });
		await expect(root).toHaveCSS('font-size', enabled ? '18px' : '14px');
		await expect(root).toHaveClass(enabled ? /stanza-editor-mouse-copy/ : /stanza-editor-mouse-default/);
		if (enabled) {
			await expect(root).toHaveClass(/word-wrapped/);
			await expect(minimap).toHaveCSS('left', '0px');
		} else {
			await expect(root).not.toHaveClass(/word-wrapped/);
		}
	}
	expect(await node!.evaluate(element => element === document.querySelector('#caller .stanza-editor'))).toBe(true);
	await node!.dispose();
	await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	expect(errors).toEqual([]);
});

for (const [original, formatted] of [['😀 hello', '😀 Hello'], ['a😀z', 'a😁z'], ['a😀z', 'a🨀z'], ['first\n😀 hello', 'first\n😀 Hello']]) {
	test(`formatting preserves UTF-16 characters: ${JSON.stringify(original)} to ${JSON.stringify(formatted)}`, async ({ page }) => {
		await page.goto('/standalone.html');
		expect(await page.evaluate(([before, after]) => window.ashStandaloneIntegration.runUnicodeFormatting(before!, after!), [original, formatted])).toBe(formatted);
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(original);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(formatted);
	});
}

for (const change of ['none', 'position', 'model', 'readonly', 'eol', 'returnPosition'] as const) {
	test(`formatting validates ${change} state before applying delayed edits`, async ({ page }) => {
		await page.goto('/standalone.html');
		const value = await page.evaluate(change => window.ashStandaloneIntegration.runFormatting(change), change);
		expect(value).toBe(change === 'eol' ? '\r\n' : change === 'none' ? 'ALPHA' : change === 'model' ? 'owned' : 'alpha');
		if (change === 'eol') {
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\r\n');
		}
		if (change === 'none') {
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('ALPHA');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

for (const cancel of ['escape', 'supersede'] as const) {
	test(`format action cancels pending provider on ${cancel}`, async ({ page }) => {
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareDeferredFormatting());
		await page.keyboard.press('ControlOrMeta+Shift+i');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: [false], value: 'alpha' });
		if (cancel === 'escape') {
			await page.keyboard.press('Escape');
		} else {
			await page.evaluate(() => { void window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument'); });
		}
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: cancel === 'escape' ? [true] : [true, false], value: 'alpha' });
		await page.evaluate(() => window.ashStandaloneIntegration.finishDeferredFormatting());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe(cancel === 'escape' ? 'alpha' : 'ALPHA');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});
}

for (const mode of ['ranges', 'single', 'empty', 'cancel', 'readonly'] as const) {
	test(`selection formatting handles ${mode} through the registered action`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(mode => window.ashStandaloneIntegration.runSelectionFormatting(mode), mode);
		const original = 'alpha\nbeta\ngamma';
		if (mode === 'cancel' || mode === 'readonly') {
			expect(result.value).toBe(original);
			if (mode === 'cancel') expect(result.cancelled).toBe(true);
			if (mode === 'readonly') expect(result.ranges).toEqual([]);
		} else {
			expect(result.value).toBe(mode === 'empty' ? 'alpha\nBETA\ngamma' : 'ALPHA\nbeta\nGAMMA');
			expect(result.ranges).toEqual(mode === 'empty' ? ['[2,1 -> 2,5]'] : ['[1,1 -> 1,6]', '[3,1 -> 3,6]']);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe(original);
		}
	});
}

for (const cancel of [false, true]) {
	test(`overlapping formatting re-queries the combined range${cancel ? ' and cancels' : ' before one undoable edit'}`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(cancel => window.ashStandaloneIntegration.runOverlappingFormatting(cancel), cancel);
		expect(result).toEqual({
			value: cancel ? 'alpha\nbeta\ngamma' : 'ALPHA\nBETA\nGAMMA',
			ranges: ['[1,1 -> 1,6]', '[3,1 -> 3,6]', '[1,1 -> 3,6]'],
			cancelled: cancel,
		});
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
		if (!cancel) {
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('alpha\nbeta\ngamma');
		}
	});
}

for (const outcome of ['second', 'empty', 'decline', 'error', 'cancel', 'silent', 'languageChoice', 'languageResult'] as const) {
	test(`formatter selection honors ${outcome} without running another provider`, async ({ page }) => {
		await page.goto('/standalone.html');
		const result = await page.evaluate(outcome => window.ashStandaloneIntegration.runFormatterChoice(outcome), outcome);
		expect(result).toEqual({
			value: outcome === 'second' || outcome === 'silent' ? 'SELECTED' : 'alpha',
			calls: outcome === 'decline' || outcome === 'cancel' || outcome === 'languageChoice' ? [] : ['selected'],
			modes: [outcome === 'silent' ? 2 : 1],
			errors: outcome === 'error' ? ['formatter failed'] : [],
		});
	});
}
