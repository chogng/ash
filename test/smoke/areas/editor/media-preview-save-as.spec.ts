import { expect, test } from '../../../automation/test.js';
import { createMediaPreviewFixture } from './mediaPreviewFixture.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Image split, tab movement and Save As preserve zoom and scroll in Ash', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const page = workbench.page;
	await createMediaPreviewFixture(page, target, testWorkspace.directory, workbench);
	try {
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'product.png', exact: true }).dblclick();
		const source = workbench.editors.groupAt(0);
		const viewport = source.content.getByLabel('Image viewport', { exact: true });
		await viewport.focus();
		await viewport.press('1');
		await viewport.press('+');
		await viewport.press('+');
		await expect(viewport.locator('img')).toHaveCSS('width', '1600px');
		await viewport.evaluate(element => { element.scrollLeft = 200; element.scrollTop = 120; });
		await expect.poll(() => viewport.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([200, 120]);
		await workbench.quickaccess.runCommand('workbench.action.splitEditorHorizontal');
		const destination = workbench.editors.groupAt(1);
		const secondViewport = destination.content.getByLabel('Image viewport', { exact: true });
		await expect(secondViewport.locator('img')).toHaveCSS('width', '1600px');
		await expect.poll(() => secondViewport.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([200, 120]);
		await viewport.evaluate(element => { element.scrollLeft = 50; element.scrollTop = 60; });
		await expect.poll(() => secondViewport.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([200, 120]);
		// Keep another resource in the target group while retiring its first image copy.
		await secondViewport.focus();
		await page.locator('.ash-explorer').getByRole('treeitem', { name: 'retry.png', exact: true }).dblclick();
		await destination.tabs.filter({ hasText: 'product.png' }).click();
		await workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
		await source.tabs.filter({ hasText: 'product.png' }).dragTo(destination.tabs.filter({ hasText: 'retry.png' }), { targetPosition: { x: 8, y: 12 } });
		const movedGroup = workbench.editors.groups.filter({ has: page.getByRole('tab', { name: 'retry.png', exact: true }) });
		const moved = movedGroup.locator('.ash-image-preview:visible').getByLabel('Image viewport', { exact: true });
		await expect(moved.locator('img')).toHaveCSS('width', '1600px');
		await expect.poll(() => moved.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([50, 60]);
		await workbench.quickaccess.runCommand('workbench.action.files.saveAs');
		const dialog = page.getByRole('dialog', { name: 'Save File', exact: true });
		await dialog.getByRole('textbox').fill('view-state-copy.png');
		await dialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(movedGroup.getByRole('tab', { name: 'view-state-copy.png', exact: true })).toHaveAttribute('aria-selected', 'true');
		await expect(moved.locator('img')).toHaveCSS('width', '1600px');
		await expect.poll(() => moved.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([50, 60]);
		await page.reload();
		await expect(page.getByRole('tab', { name: 'view-state-copy.png', exact: true })).toHaveAttribute('aria-selected', 'true');
		const restored = page.locator('.ash-image-preview:visible').getByLabel('Image viewport', { exact: true });
		await expect(restored.locator('img')).toHaveCSS('width', '1600px');
		await expect.poll(() => restored.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([50, 60]);
	} finally {
		if (!page.isClosed()) { await page.evaluate(() => window.mediaRetryProbe?.restore()); }
	}
});

test('Media Save As preserves bytes through the command, cancellation and replacement confirmation', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const page = workbench.page;
	const fixture = await createMediaPreviewFixture(page, target, testWorkspace.directory, workbench);
	try {
		const group = workbench.editors.groupAt(0);
		// Disconnected Web has the static image pane; the server catalog supplies audio and video.
		const names = target.appServerMode === 'disabled' ? ['product.png'] : ['product.png', 'retry.wav', 'retry.webm'];
		for (const name of names) {
			await page.locator('.ash-explorer').getByRole('treeitem', { name, exact: true }).dblclick();
			const selector = { 'product.png': '.ash-image-viewer img', 'retry.wav': 'audio', 'retry.webm': 'video' }[name]!;
			await expect(group.content.locator(selector)).toHaveAttribute('src', /^blob:/);
			const copy = `copy-${name}`;
			await workbench.quickaccess.runCommand('workbench.action.files.saveAs');
			const dialog = page.getByRole('dialog', { name: 'Save File', exact: true });
			await expect(dialog).toBeVisible();
			await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(group.tabs.filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
			await workbench.quickaccess.runCommand('workbench.action.files.saveAs');
			await dialog.getByRole('textbox').fill(copy);
			await dialog.getByRole('button', { name: 'OK', exact: true }).click();
			await expect(group.tabs.filter({ hasText: copy })).toHaveAttribute('aria-selected', 'true');
			const equal = target.appServerMode === 'disabled' ? await page.evaluate(async ({ name, copy }) => {
				const bytes = async (path: string): Promise<string> => {
					const file = await (await window.mediaRetryFolder.getFileHandle(path)).getFile();
					return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).join(',');
				};
				return await bytes(name) === await bytes(copy);
			}, { name, copy }) : (await readFile(join(testWorkspace.directory, name))).equals(await readFile(join(testWorkspace.directory, copy)));
			expect(equal).toBe(true);
		}
		await workbench.quickaccess.runCommand('workbench.action.files.saveAs');
		const save = page.getByRole('dialog', { name: 'Save File', exact: true });
		await save.getByRole('textbox').fill('product.png');
		await save.getByRole('button', { name: 'OK', exact: true }).click();
		const confirmation = page.getByRole('dialog', { name: 'Confirm', exact: true });
		await expect(confirmation).toContainText('Replace the existing file product.png?');
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(workbench.editors.groupAt(0).tabs.filter({ hasText: `copy-${names.at(-1)}` })).toHaveAttribute('aria-selected', 'true');
	} finally {
		await fixture.dispose();
	}
});

test('Damaged images can be opened as text from the keyboard in Ash', { tag: ['@browser-ui', '@browser-app-server', '@electron-app-server'] }, async ({ target, testWorkspace, workbench }) => {
	const fixture = await createMediaPreviewFixture(workbench.page, target, testWorkspace.directory, workbench);
	try {
		await workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'broken.png', exact: true }).dblclick();
		const group = workbench.editors.groupAt(0);
		const recovery = group.content.getByRole('button', { name: 'Open as read-only text', exact: true });
		await expect(recovery).toBeVisible();
		await recovery.focus();
		await recovery.press('Enter');
		await group.editor.waitForEditorContents(text => text.includes('PNG'));
		const before = await group.editor.lines.allTextContents();
		await group.editor.waitForEditorFocus();
		await workbench.page.keyboard.insertText('forbidden');
		await expect(group.editor.lines).toHaveText(before);
	} finally {
		await fixture.dispose();
	}
});
