import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { readUserSettings, writeUserSettings } from '../../../automation/settings.js';
import { expect, test } from '../../../automation/test.js';

const emptyWindowTest = test.extend({ openWorkspace: false });

async function jsonWorkerActive(page: Page): Promise<boolean> {
	const hosts = page.workers().filter(worker => worker.url().includes('extensionHostWorker'));
	const names = await Promise.all(hosts.map(worker => worker.evaluate(() => self.name)));
	return names.includes('Ash Web Extension Host: ash.json-language-features');
}

emptyWindowTest('an empty Desktop window leaves the bundled JSON Worker dormant', { tag: ['@electron-app-server'] }, async ({ workbench }) => {
	expect(await jsonWorkerActive(workbench.page)).toBe(false);
});

test('plain editing and Markdown preview leave the bundled JSON Worker dormant until a JSON file opens', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench }) => {
	const page = workbench.page;
	const plain = join(testWorkspace.directory, 'startup-plain.txt');
	await Promise.all([
		writeFile(plain, 'First file\n'),
		writeFile(join(testWorkspace.directory, 'startup-preview.md'), '# Preview on request\n'),
		writeFile(join(testWorkspace.directory, 'startup-language.json'), '{"enabled": }\n'),
	]);
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	expect(await jsonWorkerActive(page)).toBe(false);
	await workbench.openExplorer();
	const explorer = page.locator('.ash-explorer');
	const group = workbench.editors.groupAt(0);
	await explorer.getByRole('treeitem', { name: 'startup-plain.txt', exact: true }).dblclick();
	await group.editor.waitForEditorContents(text => text.includes('First file'));
	await group.editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+A');
	await page.keyboard.insertText('Saved before JSON');
	await page.keyboard.press('ControlOrMeta+S');
	await expect.poll(() => readFile(plain, 'utf8')).toBe('Saved before JSON');
	expect(await jsonWorkerActive(page)).toBe(false);
	await explorer.getByRole('treeitem', { name: 'startup-preview.md', exact: true }).dblclick();
	await group.editor.waitForEditorContents(text => text.includes('# Preview on request'));
	await workbench.quickaccess.runCommand('markdown.reopenAsPreview');
	await expect(group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe').getByRole('heading', { name: 'Preview on request', exact: true })).toBeVisible();
	expect(await jsonWorkerActive(page)).toBe(false);
	await explorer.getByRole('treeitem', { name: 'startup-language.json', exact: true }).dblclick();
	await group.editor.waitForEditorContents(text => text.includes('"enabled"'));
	await expect.poll(() => jsonWorkerActive(page)).toBe(true);
	await expect(group.editor.element.locator('.squiggly-error')).not.toHaveCount(0);
});

test('Markdown views load resources relative to a workspace document', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench, runningApplication }) => {
	const documents = join(testWorkspace.directory, 'preview-docs');
	const assets = join(testWorkspace.directory, 'preview-assets');
	await mkdir(documents);
	await mkdir(assets);
	await writeFile(join(assets, 'diagram space.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="green"/></svg>');
	const document = join(documents, 'preview.md');
	await writeFile(document, '# Workspace resources\n\n![Workspace diagram](../preview-assets/diagram%20space.svg)\n\n[Related document](./related.md)');
	await writeFile(join(documents, 'related.md'), '# Related Markdown source');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const source = workbench.editors.groupAt(0);
	await source.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(uri => {
		const value = new DataTransfer();
		value.setData('text/uri-list', uri);
		return value;
	}, pathToFileURL(document).href);
	try {
		await source.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	} finally {
		await transfer.dispose();
	}
	await source.editor.waitForEditorContents(text => text.includes('# Workspace resources'));
	await runningApplication.driver.diagnostics.waitFor(async () => {
		await workbench.quickaccess.runCommand('markdown.reopenAsPreview');
		const content = source.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
		await expect(content.getByRole('heading', { name: 'Workspace resources', exact: true })).toBeVisible();
		await expect.poll(() => content.getByRole('img', { name: 'Workspace diagram', exact: true }).evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 24, height: 16 });
	});
	await workbench.quickaccess.runCommand('markdown.reopenAsRichEditor');
	const native = source.content.getByRole('textbox', { name: 'Document body', exact: true });
	await expect.poll(() => native.getByRole('img', { name: 'Workspace diagram', exact: true }).evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 24, height: 16 });
	await native.getByRole('link', { name: 'Related document', exact: true }).click({ modifiers: ['ControlOrMeta'] });
	await source.editor.waitForEditorContents(text => text.includes('# Related Markdown source'));
});

test('pasting a Markdown image creates a sibling asset and dropped images share the same preview', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ testWorkspace, workbench, runningApplication }) => {
	const file = join(testWorkspace.directory, 'pasted-image.md');
	const existing = join(testWorkspace.directory, 'image.png');
	const pasted = join(testWorkspace.directory, 'image-1.png');
	const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
	await Promise.all([writeFile(file, '# Pasted image\n\n'), writeFile(existing, 'existing file')]);
	await workbench.openExplorer();
	await workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'pasted-image.md', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(text => text.includes('# Pasted image'));
	await group.editor.input.press('ControlOrMeta+End');
	await group.editor.input.evaluate((input, data) => {
		const clipboardData = new DataTransfer();
		const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
		clipboardData.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
		input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
	}, png);
	await group.editor.waitForEditorContents(text => text.includes('![alt text](image-1.png)'));
	await expect(async () => {
		expect(await readFile(pasted)).toEqual(Buffer.from(png, 'base64'));
	}).toPass();
	expect(await readFile(existing, 'utf8')).toBe('existing file');
	await group.editor.input.press('Escape');
	await group.editor.input.press('ControlOrMeta+End');
	await workbench.page.keyboard.insertText('\n\nDrop target: ');
	await group.editor.lines.filter({ hasText: 'Drop target:' }).evaluate((line, data) => {
		const dataTransfer = new DataTransfer();
		const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
		dataTransfer.items.add(new File([bytes], 'another image.png', { type: 'image/png' }));
		const bounds = line.getBoundingClientRect();
		line.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: bounds.right - 1, clientY: bounds.top + bounds.height / 2 }));
	}, png);
	await group.editor.waitForEditorContents(text => text.includes('![alt text](another%20image.png)'));
	await expect(async () => {
		expect(await readFile(join(testWorkspace.directory, 'another image.png'))).toEqual(Buffer.from(png, 'base64'));
	}).toPass();
	await group.editor.input.press('Escape');
	await group.editor.input.press('ControlOrMeta+s');
	await expect.poll(() => readFile(file, 'utf8')).toContain('![alt text](image-1.png)');
	await runningApplication.driver.diagnostics.waitFor(async () => {
		await workbench.quickaccess.runCommand('markdown.reopenAsPreview');
		const preview = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
		const images = preview.getByRole('img', { name: 'alt text' });
		await expect(images).toHaveCount(2);
		await expect.poll(() => images.evaluateAll(elements => elements.map(image => (image as HTMLImageElement).naturalWidth))).toEqual([1, 1]);
	});
});

test('Markdown extension owns preview commands and shares unsaved text across editor views', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, application }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const source = workbench.editors.groupAt(0);
	await source.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Shared draft\n\nOriginal body'], 'draft.md', { type: 'text/markdown' }));
		return transfer;
	});
	// Exercise the public file-drop path, including in the disconnected Electron UI.
	await source.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await source.editor.waitForEditorContents(text => text.includes('# Shared draft'));
	await source.editor.waitForEditorFocus();
	const breadcrumb = source.title.getByRole('button', { name: 'Select editor: Text Editor', exact: true });
	await expect(breadcrumb).toBeVisible();
	const previewSide = source.title.locator('[data-action-id="markdown.showPreviewToSide"] button');
	await expect(previewSide).toHaveAttribute('aria-label', 'Open Preview to the Side');
	const split = source.title.locator('[data-action-id="workbench.action.splitEditor"] button');
	await expect(split).toHaveAttribute('aria-label', 'Split Right');
	await expect(split.locator('[data-ash-icon-id="split-horizontal"]')).toBeVisible();
	await source.title.locator('[data-action-id="markdown.reopenAsPreview"] button').click();
	const frame = source.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	await expect(frame.getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
	await expect(source.tabs).toHaveCount(2);
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.search(theme);
		await workbench.quickaccess.input.press('Enter');
		await expect(workbench.quickaccess.element).toHaveCount(0);
		const palette = await workbench.element.evaluate(element => {
			const style = getComputedStyle(element);
			return { foreground: style.getPropertyValue('--ash-editor-foreground').trim(), background: style.getPropertyValue('--ash-editor-background').trim() };
		});
		await expect(frame.locator('html')).toHaveCSS('--ash-editor-foreground', palette.foreground);
		await expect(frame.locator('html')).toHaveCSS('--ash-editor-background', palette.background);
		await expect(frame.locator('html')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		await expect(frame.locator('html')).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
		const selector = source.title.getByRole('button', { name: 'Select editor: Markdown Preview', exact: true });
		await selector.focus();
		await expect(selector).toHaveCSS('outline-style', 'solid');
		await expect(selector).not.toHaveCSS('outline-width', '0px');
	}
	await source.content.locator('iframe.ash-webview:visible').focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/document preview[\s\S]*editor selector/u);
	await page.keyboard.press('Escape');
	await expect(source.content.locator('iframe.ash-webview:visible')).toBeFocused();
	await page.keyboard.press('Alt+F2');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue('# Shared draft\n\nOriginal body');
	await page.keyboard.press('Escape');
	const previewBreadcrumb = source.title.getByRole('button', { name: 'Select editor: Markdown Preview', exact: true });
	await previewBreadcrumb.focus();
	const editors = await workbench.menus.inspect(application, () => previewBreadcrumb.press('Enter'));
	expect(editors).toContainEqual(expect.objectContaining({ label: 'Markdown Preview', checked: true }));
	await workbench.menus.select(application, () => previewBreadcrumb.press('Enter'), ['Text Editor']);
	await source.editor.waitForEditorFocus();
	await source.editor.waitForEditorContents(text => text.includes('# Shared draft'));
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' changed');
	await workbench.quickaccess.runCommand('markdown.showPreview');
	await expect(source.tabs).toHaveCount(3);
	await expect(frame.getByText('Original body changed', { exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('markdown.showSource');
	await expect(source.tabs).toHaveCount(3);
	await source.editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' live');
	await source.tabs.nth(2).click();
	await expect(frame.getByText('Original body changed live', { exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('markdown.showSource');
	await previewSide.click();
	await expect(workbench.editors.groups).toHaveCount(2);
	const side = workbench.editors.groupAt(1);
	await expect(side.content.frameLocator('iframe.ash-webview').frameLocator('iframe').getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
	const boxes = await workbench.editors.groups.evaluateAll(groups => groups.map(group => {
		const box = group.getBoundingClientRect();
		return { x: box.x, y: box.y, width: box.width };
	}));
	expect(boxes[1]!.x).toBeGreaterThanOrEqual(boxes[0]!.x + boxes[0]!.width);
	expect(Math.abs(boxes[1]!.y - boxes[0]!.y)).toBeLessThan(2);
	await side.title.locator('[data-action-id="workbench.action.splitEditor"] button').click();
	await expect(workbench.editors.groups).toHaveCount(3);
	await expect(workbench.editors.groupAt(2).content.frameLocator('iframe.ash-webview').frameLocator('iframe').getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
	const third = workbench.editors.groupAt(2);
	await page.keyboard.down('Alt');
	const splitDown = third.title.locator('[data-action-id="workbench.action.splitEditor"] button');
	await expect(splitDown).toHaveAttribute('aria-label', 'Split Down');
	await expect(splitDown.locator('[data-ash-icon-id="split-vertical"]')).toBeVisible();
	await splitDown.click();
	await page.keyboard.up('Alt');
	await expect(workbench.editors.groups).toHaveCount(4);
	const lower = workbench.editors.groupAt(3);
	await expect(lower.content.frameLocator('iframe.ash-webview').frameLocator('iframe').getByRole('heading', { name: 'Shared draft', exact: true })).toBeVisible();
	const thirdBox = await third.element.boundingBox();
	const lowerBox = await lower.element.boundingBox();
	expect(lowerBox!.y).toBeGreaterThanOrEqual(thirdBox!.y + thirdBox!.height);
	expect(Math.abs(lowerBox!.x - thirdBox!.x)).toBeLessThan(2);
});

test('Markdown tab menus reopen the clicked document while another tab is active', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, application }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# First document'], 'first.md', { type: 'text/markdown' }));
		transfer.items.add(new File(['# Second document'], 'second.md', { type: 'text/markdown' }));
		return transfer;
	});
	await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await group.editor.waitForEditorContents(text => text.includes('# Second document'));
	await workbench.menus.select(application, () => group.tabs.filter({ hasText: 'first.md' }).click({ button: 'right' }), ['Open Preview']);
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	await expect(frame.getByRole('heading', { name: 'First document', exact: true })).toBeVisible();
	await expect(group.tabs).toHaveCount(4);
	await workbench.menus.select(application, () => group.tabs.filter({ hasText: 'second.md' }).click({ button: 'right' }), ['Reopen With...']);
	await workbench.quickaccess.select('Markdown Preview');
	await expect(frame.getByRole('heading', { name: 'Second document', exact: true })).toBeVisible();
	await expect(group.tabs).toHaveCount(4);
	await workbench.menus.select(application, () => group.title.getByRole('button', { name: 'Select editor: Markdown Preview', exact: true }).click(), ['Text Editor']);
	await group.editor.waitForEditorContents(text => text.includes('# Second document'));
});

test('Markdown rich editor follows theme colors and shows keyboard focus in every theme', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Theme colors\n\n[Link](https://example.com)\n\n> Quoted text\n\n```js\nconst value = 1;\n```\n\n| Header |\n| --- |\n| Cell |'], 'theme.md', { type: 'text/markdown' }));
		return transfer;
	});
	try {
		await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	} finally {
		await transfer.dispose();
	}
	await group.editor.waitForEditorContents(text => text.includes('# Theme colors'));
	await workbench.quickaccess.runCommand('markdown.reopenAsRichEditor');
	const editor = group.content.getByRole('textbox', { name: 'Document body', exact: true });
	await expect(group.content.locator('iframe.ash-webview:visible')).toHaveCount(0);
	await expect(editor).toBeVisible();
	for (const [theme, id] of [['Ash Light', 'ash-light'], ['Ash Dark', 'ash-dark'], ['Ash High Contrast Dark', 'ash-high-contrast-dark'], ['Ash High Contrast Light', 'ash-high-contrast-light']]) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.search(theme);
		await workbench.quickaccess.input.press('Enter');
		await expect(workbench.quickaccess.element).toHaveCount(0);
		await expect(workbench.element).toHaveAttribute('data-color-theme', id);
		const colors = await workbench.element.evaluate(element => {
			const probe = document.createElement('span');
			element.appendChild(probe);
			try {
				return Object.fromEntries(['text-codeBlockBackground', 'editorCursor-foreground'].map(name => {
					probe.style.color = `var(--ash-${name})`;
					return [name, getComputedStyle(probe).color];
				}));
			} finally { probe.remove(); }
		});
		await expect(editor.locator('pre')).toHaveCSS('background-color', colors['text-codeBlockBackground']!);
		await editor.focus();
		await expect(editor).toBeFocused();
		await expect(editor).toHaveCSS('caret-color', colors['editorCursor-foreground']!);
	}
});

test('Markdown rich editor shares text and history with the source editor', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Rich document\n\nOriginal body\n\n[keep]: ./other.md\n'], 'rich.md', { type: 'text/markdown' }));
		return transfer;
	});
	await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await group.editor.waitForEditorContents(text => text.includes('# Rich document'));
	await workbench.quickaccess.runCommand('markdown.reopenAsRichEditor');
	const editor = group.content.getByRole('textbox', { name: 'Document body', exact: true });
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.press('Enter');
	await page.keyboard.insertText('Added in rich editor');
	await page.keyboard.press('Escape');
	await expect(editor).toContainText('Added in rich editor');
	await editor.press('ControlOrMeta+z');
	await expect(editor).not.toContainText('Added in rich editor');
	await editor.press('ControlOrMeta+Shift+z');
	await expect(editor).toContainText('Added in rich editor');
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.search(theme);
		await workbench.quickaccess.input.press('Enter');
		const foreground = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-foreground').trim());
		await expect(editor).toHaveCSS('--ash-editor-foreground', foreground);
		await expect(editor).toContainText('Added in rich editor');
	}
	await workbench.quickaccess.runCommand('markdown.reopenAsSource');
	await group.editor.waitForEditorContents(text => text.includes('Added in rich editor') && text.includes('[keep]: ./other.md'));
});

test('Markdown rich editor saves files and refreshes from an open source tab', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const path = join(testWorkspace.directory, 'rich-saved.md');
	const original = '---\ntitle: Keep front matter\n---\n\n# Rich saved\n\n[keep]: ./other.md\n\n```js\nconst tag = "</script>";\n```\n\nBody';
	await writeFile(path, original);
	const page = workbench.page;
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'rich-saved.md', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(text => text.includes('# Rich saved'));
	await workbench.quickaccess.runCommand('markdown.showRichEditor');
	await expect(group.tabs.filter({ hasText: 'rich-saved.md' })).toHaveCount(2);
	const editor = group.content.getByRole('textbox', { name: 'Document body', exact: true });
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' persisted');
	await page.keyboard.press('ControlOrMeta+s');
	await expect.poll(() => readFile(path, 'utf8')).toBe(original + ' persisted');
	await editor.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Edit the formatted Markdown directly/u);
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
	await workbench.quickaccess.runCommand('markdown.showSource');
	await group.editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' from source');
	await group.tabs.filter({ hasText: 'rich-saved.md' }).last().click();
	await expect(editor).toContainText('persisted from source');
	await editor.focus();
	await page.keyboard.press('ControlOrMeta+s');
	await expect.poll(() => readFile(path, 'utf8')).toBe(original + ' persisted from source');
});

test('Markdown rich editor respects readonly rules', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Protected document\n\n- [ ] Keep unchecked\n\nOriginal body'], 'protected.md', { type: 'text/markdown' }));
		return transfer;
	});
	await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await group.editor.waitForEditorContents(text => text.includes('# Protected document'));
	await workbench.quickaccess.runCommand('markdown.reopenAsRichEditor');
	const editor = group.content.getByRole('textbox', { name: 'Document body', exact: true });
	await expect(editor).toBeVisible();
	for (const readonly of [true, false]) {
		const settings = await readUserSettings(page);
		const values = JSON.parse(settings.content);
		await writeUserSettings(page, JSON.stringify({
			...values,
			'files.readonlyInclude': { ...values['files.readonlyInclude'], '**/protected.md': readonly },
		}), settings.revision);
		await expect(editor).toHaveAttribute('aria-readonly', String(readonly));
		await expect(editor.getByRole('listitem').filter({ hasText: 'Keep unchecked' }).getByRole('checkbox', { name: 'Task: Keep unchecked', exact: true })).toBeEnabled({ enabled: !readonly });
		await editor.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(readonly ? ' forbidden' : ' accepted');
		await page.keyboard.press('Escape');
		if (readonly) {
			await expect(editor).not.toContainText('forbidden');
		} else {
			await expect(editor).toContainText('accepted');
		}
	}
	await workbench.quickaccess.runCommand('markdown.reopenAsSource');
	await group.editor.waitForEditorContents(text => text === '# Protected document\n\n- [ ] Keep unchecked\n\nOriginal body accepted');
});

test('Markdown language providers navigate headings, rename links and show diagnostics', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench }) => {
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# Heading\n\n[go](#heading)\n\n[broken](#missing)'], 'language.md', { type: 'text/markdown' }));
		return transfer;
	});
	await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await group.editor.waitForEditorContents(text => text.includes('# Heading'));
	await expect(page.getByRole('button', { name: 'Language Markdown', exact: true })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await page.locator('[data-part="panel"]').getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(page.getByText(/No header found: 'missing'/u).first()).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.closePanel');
	await group.editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+Home');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Home');
	for (let index = 0; index < 8; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('F12');
	await expect(page.getByRole('button', { name: /^Ln 1, Col /u })).toBeVisible();
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('F2');
	const rename = page.getByRole('textbox', { name: 'New symbol name', exact: true });
	await expect(rename).toBeVisible();
	await rename.fill('Renamed heading');
	await rename.press('Enter');
	await expect(rename).toBeHidden();
	await expect(page.locator('.ash-bulk-edit-replacements')).toContainText('renamed-heading');
	await page.locator('.ash-bulk-edit').getByRole('button', { name: 'Apply selected', exact: true }).click();
	await group.editor.waitForEditorContents(text => text.includes('# Renamed heading') && text.includes('[go](#renamed-heading)'));
	await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await page.locator('[data-part="panel"]').getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(page.getByText(/No header found: 'missing'/u).first()).toBeVisible();
});

test('Markdown link rename moves the target file and updates its references together', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const original = join(testWorkspace.directory, 'rename-target.md');
	const renamed = join(testWorkspace.directory, 'renamed-target.md');
	const referring = join(testWorkspace.directory, 'rename-link.md');
	await writeFile(original, '# Target\n\nKeep this body');
	await writeFile(referring, '[go](./rename-target.md)');
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'rename-link.md', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(text => text === '[go](./rename-target.md)');
	await group.editor.waitForEditorFocus();
	await page.keyboard.press('ControlOrMeta+Home');
	for (let index = 0; index < 10; index++) await page.keyboard.press('ArrowRight');
	await page.keyboard.press('F2');
	const name = page.getByRole('textbox', { name: 'New symbol name', exact: true });
	await expect(name).toBeVisible();
	await name.fill('./renamed-target.md');
	await name.press('Enter');
	await expect(page.locator('.ash-bulk-edit')).toContainText('rename-target.md → renamed-target.md');
	await page.locator('.ash-bulk-edit').getByRole('button', { name: 'Apply selected', exact: true }).click();
	await group.editor.waitForEditorContents(text => text === '[go](./renamed-target.md)');
	await expect.poll(() => readFile(renamed, 'utf8')).toBe('# Target\n\nKeep this body');
	await expect.poll(() => readFile(referring, 'utf8')).toBe('[go](./renamed-target.md)');
	await expect(readFile(original, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('Markdown rich editor localizes its body and accessibility help in Chinese', { tag: ['@browser-app-server', '@electron-app-server'] }, async ({ workbench, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const picker = workbench.page.getByRole('dialog', { name: 'Select Display Language', exact: true });
	await picker.getByRole('combobox').fill('简体中文');
	await picker.getByRole('combobox').press('Enter');
	({ workbench } = await restartWorkbench());
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+N');
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorFocus();
	const transfer = await page.evaluateHandle(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['# 中文文档\n\n正文'], 'chinese.md', { type: 'text/markdown' }));
		return transfer;
	});
	await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
	await transfer.dispose();
	await group.editor.waitForEditorContents(text => text.includes('中文文档'));
	await workbench.quickaccess.runCommand('markdown.reopenAsRichEditor');
	const editor = group.content.getByRole('textbox', { name: '文档正文', exact: true });
	await expect(editor).toContainText('中文文档');
	await editor.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/排版后的 Markdown/u);
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
});

for (const view of ['preview', 'visual editor'] as const) {
	test(`Markdown ${view} restores an unsaved custom tab after reload`, { tag: ['@electron-app-server'] }, async ({ workbench, testWorkspace, reloadWorkbench }) => {
		const file = join(testWorkspace.directory, 'restore.md');
		await writeFile(file, '# Persisted heading\n\nSaved text\n');
		await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
		await workbench.page.keyboard.press('ControlOrMeta+N');
		const group = workbench.editors.groupAt(0);
		const transfer = await workbench.page.evaluateHandle(uri => {
			const value = new DataTransfer();
			value.setData('text/uri-list', uri);
			return value;
		}, pathToFileURL(file).href);
		try {
			await group.title.locator('.ash-tab-list:visible [role="tablist"]').dispatchEvent('drop', { dataTransfer: transfer });
		} finally { await transfer.dispose(); }
		await group.editor.waitForEditorContents(text => text.includes('# Persisted heading'));
		await group.editor.input.focus();
		await workbench.page.keyboard.press('ControlOrMeta+a');
		await workbench.page.keyboard.insertText('# Unsaved restored heading\n\nRetained draft\n');
		await workbench.quickaccess.runCommand(view === 'preview' ? 'markdown.reopenAsPreview' : 'markdown.reopenAsRichEditor');
		const documentBody = () => {
			const content = workbench.editors.groupAt(0).content;
			return view === 'preview'
				? content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe').locator('body')
				: content.getByRole('textbox', { name: 'Document body', exact: true });
		};
		await expect(documentBody().getByRole('heading', { name: 'Unsaved restored heading', exact: true })).toBeVisible();
		({ workbench } = await reloadWorkbench());
		await expect(documentBody().getByRole('heading', { name: 'Unsaved restored heading', exact: true })).toBeVisible();
		await expect(documentBody()).toContainText('Retained draft');
		await workbench.quickaccess.runCommand('markdown.reopenAsSource');
		// Viewport empty lines contain layout placeholders; persisted bytes below verify the exact text.
		await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text.includes('Unsaved restored heading') && text.includes('Retained draft'));
		expect(await readFile(file, 'utf8')).toBe('# Persisted heading\n\nSaved text\n');
		await workbench.page.keyboard.press('ControlOrMeta+s');
		await expect.poll(() => readFile(file, 'utf8')).toBe('# Unsaved restored heading\n\nRetained draft\n');
	});
}
