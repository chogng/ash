import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { QuickAccess } from '../../../automation/quickaccess.js';

test('blank rich Docs synchronizes first input and IME and retains document state', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench, application, testWorkspace }, testInfo) => {
	let page = await workbench.openAgentsWindow(target.kind);
	await new QuickAccess(page).runCommand('workbench.action.document.new');
	const richInput = () => page.locator('.ash-docs-workspace:visible .stanza-arkdown-prose').first();
	let rich = richInput();
	await expect(rich).toBeEditable();
	await rich.click();
	await page.keyboard.type('Read books');
	await expect(rich).toHaveText('Read books');
	await page.keyboard.press('ArrowLeft');
	await page.keyboard.type('!');
	await expect(rich).toHaveText('Read book!s');
	await rich.fill('');
	await expect(rich).toBeEmpty();
	const cdp = await page.context().newCDPSession(page);
	try {
		await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
		await expect(rich).toHaveText('zhong');
		await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
		await cdp.send('Input.insertText', { text: '中文' });
		await expect(rich).toHaveText('中文');
	} finally { await cdp.detach(); }
	await page.keyboard.type(' retained');
	await expect(rich).toHaveText('中文 retained');
	if (target.appServerMode === 'required' && 'windows' in application) {
		const output = join(await realpath(testWorkspace.directory), 'retained-docs.md');
		await application.evaluate(({ dialog }, filePath) => {
			dialog.showSaveDialog = async () => ({ canceled: false, filePath });
		}, output);
		await page.locator('.ash-docs-workspace:visible').getByRole('button', { name: 'Save document', exact: true }).click();
		await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('中文 retained');
		page = await workbench.reopenAgentsWindow(application, page);
		await expect(richInput()).toHaveText('中文 retained');
	}
	await page.screenshot({ path: testInfo.outputPath('blank-rich-docs-retained.png') });
});
