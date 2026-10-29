import { getViolations, injectAxe } from 'axe-playwright';
import { expect, test } from './test.ts';

test('production page loads its JavaScript and styles from the standalone build', async ({ stanzaPage: page }) => {
	const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name));
	expect(resources.some(url => /\/assets\/[^/]+\.js$/u.test(url))).toBe(true);
	expect(resources.some(url => /\/assets\/[^/]+\.css$/u.test(url))).toBe(true);
	expect(resources.filter(url => /\/@vite\/|\/@fs\/|\/src\/|\.ts(?:\?|$)/u.test(url))).toEqual([]);
	expect(resources.filter(url => new URL(url).origin !== new URL(page.url()).origin)).toEqual([]);
	await expect(page.locator('#editor-root .view-line').first()).toContainText('interface GeometrySample');
	const bounds = await page.locator('#editor-root .stanza-editor').boundingBox();
	expect(bounds?.width).toBeGreaterThan(500);
	expect(bounds?.height).toBeGreaterThan(300);
});

test('keyboard typing, undo and redo use the standalone editor registrations', async ({ stanzaPage: page }) => {
	await page.evaluate(() => {
		const editor = stanza.editor.getEditors()[0];
		editor.getModel()!.setValue('alpha');
		editor.setPosition({ lineNumber: 1, column: 6 });
		editor.focus();
	});
	await expect(page.locator('.stanza-editor-input')).toBeFocused();
	await page.keyboard.type(' beta');
	await expect.poll(() => page.evaluate(() => stanza.editor.getModels()[0].getValue())).toBe('alpha beta');
	await page.keyboard.press('ControlOrMeta+z');
	await expect.poll(() => page.evaluate(() => stanza.editor.getModels()[0].getValue())).toBe('alpha');
	await page.keyboard.press('ControlOrMeta+Shift+z');
	await expect.poll(() => page.evaluate(() => stanza.editor.getModels()[0].getValue())).toBe('alpha beta');
	await expect(page.locator('.view-line')).toContainText('alpha beta');
});

test('keyboard edits and undo preserve multiple cursors', async ({ stanzaPage: page }) => {
	await page.evaluate(() => {
		const editor = stanza.editor.getEditors()[0];
		editor.getModel()!.setValue('alpha\nbeta');
		editor.setSelections([new stanza.Selection(1, 6, 1, 6), new stanza.Selection(2, 5, 2, 5)]);
		editor.focus();
	});
	await page.keyboard.type('!');
	await expect.poll(() => page.evaluate(() => stanza.editor.getModels()[0].getValue())).toBe('alpha!\nbeta!');
	await page.keyboard.press('ControlOrMeta+z');
	await expect
		.poll(() =>
			page.evaluate(() => ({
				value: stanza.editor.getModels()[0].getValue(),
				cursors: stanza.editor
					.getEditors()[0]
					.getSelections()
					?.map(selection => [selection.positionLineNumber, selection.positionColumn]),
			})),
		)
		.toEqual({
			value: 'alpha\nbeta',
			cursors: [
				[1, 6],
				[2, 5],
			],
		});
	await expect(page.locator('.view-line')).toContainText(['alpha', 'beta']);
});

test('public editor creation and disposal retain the caller-owned model', async ({ stanzaPage: page }) => {
	const result = await page.evaluate(() => {
		const existing = stanza.editor.getEditors()[0];
		const model = existing.getModel()!;
		existing.dispose();
		const editor = stanza.editor.create(document.getElementById('editor-root')!, { model });
		try {
			return {
				registered: stanza.editor.getEditors()[0] === editor,
				sameModel: editor.getModel() === model,
				text: model.getLineContent(1),
			};
		} finally {
			editor.dispose();
		}
	});
	expect(result).toEqual({ registered: true, sameModel: true, text: 'interface GeometrySample {' });
	expect(
		await page.evaluate(() => ({
			editors: stanza.editor.getEditors().length,
			models: stanza.editor.getModels().length,
		})),
	).toEqual({ editors: 0, models: 1 });
	await expect(page.locator('#editor-root .stanza-editor')).toHaveCount(0);
});

test('editor exposes a named multiline textbox and accepts keyboard focus', async ({ stanzaPage: page }) => {
	const input = page.getByRole('textbox', { name: /standalone\.ts/u });
	await expect(input).toHaveAttribute('aria-multiline', 'true');
	await page.getByText('Stanza', { exact: true }).click();
	await page.keyboard.press('Tab');
	await expect(page.getByRole('scrollbar', { name: 'Vertical scrollbar' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(input).toBeFocused();
});

test('standalone editor passes WCAG accessibility checks', async ({ stanzaPage: page }, testInfo) => {
	await injectAxe(page);
	const violations = await getViolations(page, '#editor-root', {
		runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
	});
	await testInfo.attach('accessibility.json', {
		body: JSON.stringify(violations, null, 2),
		contentType: 'application/json',
	});
	expect(violations).toEqual([]);
});
