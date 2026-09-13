import { expect, test } from '@playwright/test';

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
