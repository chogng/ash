import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../../../automation/test.js';

test('Markdown preview loads an image relative to a workspace document', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Workspace files require the connected App Server.');
	const documents = join(testWorkspace.directory, 'preview-docs');
	const assets = join(testWorkspace.directory, 'preview-assets');
	await mkdir(documents);
	await mkdir(assets);
	await writeFile(join(assets, 'diagram space.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="green"/></svg>');
	const document = join(documents, 'preview.md');
	await writeFile(document, '# Workspace resources\n\n![Workspace diagram](../preview-assets/diagram%20space.svg)');
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
	await workbench.quickaccess.runCommand('markdown.reopenAsPreview');
	const content = source.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	await expect(content.getByRole('heading', { name: 'Workspace resources', exact: true })).toBeVisible();
	await expect.poll(() => content.getByRole('img', { name: 'Workspace diagram', exact: true }).evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }))).toEqual({ width: 24, height: 16 });
});

test('Markdown extension owns preview commands and shares unsaved text across editor views', async ({ workbench, application }) => {
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

test('Markdown tab menus reopen the clicked document while another tab is active', async ({ workbench, application }) => {
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
	await workbench.menus.select(application, () => group.tabs.filter({ hasText: 'second.md' }).click({ button: 'right' }), ['Reopen Editor With...']);
	await workbench.quickaccess.select('Markdown Preview');
	await expect(frame.getByRole('heading', { name: 'Second document', exact: true })).toBeVisible();
	await expect(group.tabs).toHaveCount(4);
	await workbench.menus.select(application, () => group.title.getByRole('button', { name: 'Select editor: Markdown Preview', exact: true }).click(), ['Text Editor']);
	await group.editor.waitForEditorContents(text => text.includes('# Second document'));
});

test('Markdown rich editor follows theme colors and shows keyboard focus in every theme', async ({ workbench }) => {
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
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	const editor = frame.getByLabel('Markdown rich text editor', { exact: true });
	const bold = frame.getByRole('button', { name: 'Bold', exact: true });
	await expect(editor).toBeVisible();
	for (const theme of ['Ash Light', 'Ash Dark', 'Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.search(theme);
		await workbench.quickaccess.input.press('Enter');
		await expect(workbench.quickaccess.element).toHaveCount(0);
		const palette = await workbench.element.evaluate(element => {
			const probe = document.createElement('span');
			element.appendChild(probe);
			try {
				return Object.fromEntries(['button-foreground', 'button-secondaryBackground', 'button-hoverBackground', 'focusBorder', 'border', 'widget-border', 'text-codeBlockBackground', 'accent-foreground', 'error-foreground', 'editorCursor-foreground', 'editor-lineHighlightBackground', 'description-foreground'].map(name => {
					probe.style.backgroundColor = `var(--ash-${name})`;
					return [name, getComputedStyle(probe).backgroundColor];
				}));
			} finally {
				probe.remove();
			}
		});
		const foreground = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-foreground').trim());
		await expect(frame.locator('html')).toHaveCSS('--ash-editor-foreground', foreground);
		await expect.poll(() => editor.evaluate(element => {
			const probe = document.createElement('span');
			element.appendChild(probe);
			try {
				return ['--md-cursor-background', '--md-block-active-background', '--md-html-comment-foreground'].map(property => {
					probe.style.backgroundColor = `var(${property})`;
					return getComputedStyle(probe).backgroundColor;
				});
			} finally {
				probe.remove();
			}
		})).toEqual([palette['editorCursor-foreground'], palette['editor-lineHighlightBackground'], palette['description-foreground']]);
		await page.mouse.move(0, 0);
		await expect(bold).toHaveCSS('color', palette['button-foreground']!);
		await expect(bold).toHaveCSS('background-color', palette['button-secondaryBackground']!);
		await expect(frame.getByRole('toolbar')).toHaveCSS('border-bottom-color', palette['border']!);
		await expect(editor.locator('.md-code-block')).toHaveCSS('background-color', palette['text-codeBlockBackground']!);
		await expect(editor.locator('.md-blockquote')).toHaveCSS('border-left-color', palette['widget-border']!);
		await expect(editor.getByRole('link')).toHaveCSS('color', palette['accent-foreground']!);
		await expect(editor.getByRole('cell', { name: 'Header', exact: true })).toHaveCSS('border-top-color', palette['widget-border']!);
		await expect(frame.getByRole('status')).toHaveCSS('color', palette['error-foreground']!);
		await editor.focus();
		await page.keyboard.press('Alt+F10');
		await expect(bold).toBeFocused();
		await expect(bold).toHaveCSS('outline-style', 'solid');
		await expect(bold).toHaveCSS('outline-width', '1px');
		await expect(bold).toHaveCSS('outline-color', palette['focusBorder']!);
		await bold.hover();
		await expect(bold).toHaveCSS('background-color', palette['button-hoverBackground']!);
	}
});

test('Markdown rich editor shares text and history with the source editor', async ({ workbench }) => {
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
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	const editor = frame.getByLabel('Markdown rich text editor', { exact: true });
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nAdded in rich editor');
	await expect(editor).toContainText('Added in rich editor');
	await frame.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(editor).not.toContainText('Added in rich editor');
	await frame.getByRole('button', { name: 'Redo', exact: true }).click();
	await expect(editor).toContainText('Added in rich editor');
	for (const theme of ['Ash High Contrast Dark', 'Ash High Contrast Light']) {
		await workbench.quickaccess.runCommand('workbench.action.selectTheme');
		await workbench.quickaccess.search(theme);
		await workbench.quickaccess.input.press('Enter');
		const foreground = await workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-foreground').trim());
		await expect(frame.locator('html')).toHaveCSS('--ash-editor-foreground', foreground);
		await expect(editor).toContainText('Added in rich editor');
	}
	await workbench.quickaccess.runCommand('markdown.reopenAsSource');
	await group.editor.waitForEditorContents(text => text.includes('Added in rich editor') && text.includes('[keep]: ./other.md'));
});

test('Markdown rich editor saves files and refreshes from an open source tab', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'File persistence requires the connected App Server.');
	const path = join(testWorkspace.directory, 'rich-saved.md');
	const original = '---\ntitle: Keep front matter\n---\n\n# Rich saved\n\n[keep]: ./other.md\n\n```js\nconst tag = "</script>";\n```\n\nBody';
	await writeFile(path, original);
	const page = workbench.page;
	await page.locator('.ash-explorer').getByRole('treeitem', { name: 'rich-saved.md', exact: true }).dblclick();
	const group = workbench.editors.groupAt(0);
	await group.editor.waitForEditorContents(text => text.includes('# Rich saved'));
	await workbench.quickaccess.runCommand('markdown.showRichEditor');
	await expect(group.tabs.filter({ hasText: 'rich-saved.md' })).toHaveCount(2);
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	const editor = frame.getByLabel('Markdown rich text editor', { exact: true });
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.insertText(' persisted');
	await page.keyboard.press('ControlOrMeta+s');
	await expect.poll(() => readFile(path, 'utf8')).toBe(original + ' persisted');
	await page.keyboard.press('Alt+F10');
	await expect(frame.getByRole('button', { name: 'Bold', exact: true })).toBeFocused();
	await page.keyboard.press('ArrowRight');
	await expect(frame.getByRole('button', { name: 'Italic', exact: true })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(editor).toBeFocused();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Markdown rich text editor[\s\S]*Alt\+F10/u);
	await page.keyboard.press('Escape');
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

test('Markdown rich editor respects readonly rules and rejects stale document edits', async ({ workbench }) => {
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
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	const editor = frame.getByLabel('Markdown rich text editor', { exact: true });
	await expect(editor).toBeVisible();
	for (const readonly of [true, false]) {
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await settings.getByRole('searchbox').fill('files.readonlyInclude');
		const control = settings.locator('[data-configuration-key="files.readonlyInclude"]');
		if (readonly) {
			await control.getByRole('button', { name: 'Add pattern', exact: true }).click();
			await control.locator('[data-pattern-part="key"]').fill('**/protected.md');
		}
		await control.locator('[data-pattern-part="value"]').fill(String(readonly));
		await control.locator('[data-pattern-part="value"]').press('Tab');
		await expect(control.locator('.ash-settings-indicators')).toBeHidden();
		await settings.locator('.ash-modal-editor-close').click();
		await expect(editor).toHaveAttribute('aria-readonly', String(readonly));
		await expect(frame.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ enabled: !readonly });
		await expect(frame.getByRole('checkbox', { name: 'Keep unchecked', exact: true })).toBeEnabled({ enabled: !readonly });
		await editor.click();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.insertText(readonly ? ' forbidden' : ' accepted');
		if (readonly) {
			await expect(editor).not.toContainText('forbidden');
		} else {
			await expect(editor).toContainText('accepted');
		}
	}
	const channel = await group.content.locator('iframe.ash-webview:visible').getAttribute('data-ash-webview-channel');
	// Send an obsolete version through the public webview protocol, as a delayed view would.
	await editor.evaluate((_element, channel) => {
		parent.postMessage({ channel, message: { type: 'edit', version: 0, text: 'stale content' } }, '*');
	}, channel);
	await expect(frame.getByRole('status')).toContainText('changed in another editor');
	await expect(editor).toContainText('accepted');
	await frame.getByRole('button', { name: 'Reload document', exact: true }).click();
	await expect(editor).toHaveAttribute('aria-readonly', 'false');
	await expect(editor).toContainText('accepted');
	await workbench.quickaccess.runCommand('markdown.reopenAsSource');
	await group.editor.waitForEditorContents(text => text === '# Protected document\n\n- [ ] Keep unchecked\n\nOriginal body accepted');
});

test('Markdown language providers navigate headings, rename links and show diagnostics', async ({ workbench }) => {
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
	await page.locator('[data-part="panel"]').getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(page.getByText(/No header found: 'missing'/u).first()).toBeVisible();
});

test('Markdown link rename moves the target file and updates its references together', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'File renaming requires the connected App Server.');
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

test('Markdown rich editor localizes its toolbar and accessibility help in Chinese', async ({ workbench, restartWorkbench }) => {
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
	const frame = group.content.frameLocator('iframe.ash-webview:visible').frameLocator('iframe');
	await expect(frame.getByRole('toolbar', { name: 'Markdown 格式', exact: true })).toBeVisible();
	const editor = frame.getByLabel('Markdown 富文本编辑器', { exact: true });
	await expect(editor).toContainText('中文文档');
	await expect(frame.getByRole('button', { name: '粗体', exact: true })).toBeVisible();
	await expect(frame.getByRole('button', { name: '保存', exact: true })).toBeVisible();
	await editor.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.locator('.ash-accessible-view-content')).toHaveValue(/Markdown 富文本编辑器[\s\S]*Alt\+F10/u);
	await page.keyboard.press('Escape');
	await expect(group.content.locator('iframe.ash-webview:visible')).toBeFocused();
});
