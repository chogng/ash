import type { ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Output channels open from the product command palette', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
	await workbench.quickaccess.select('Window');
	const output = workbench.page.locator('[data-view-id="ash.output"]');
	await expect(output).toBeVisible();
	await output.getByRole('searchbox', { name: 'Filter Output', exact: true }).fill('Workbench restored');
	const input = output.locator('.stanza-editor-input');
	await expect(output.locator('.view-lines')).toContainText('Workbench restored');
	await input.focus();
	await workbench.page.keyboard.press('Alt+F1');
	const help = workbench.page.getByRole('dialog', { name: 'Accessibility Help', exact: true });
	await expect(help.locator('.ash-accessible-view-content')).toHaveValue(/Output is a read-only editor/u);
	await workbench.page.keyboard.press('Escape');
	await expect(input).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.output.openInEditor');
	const editor = workbench.editors.groupAt(0).content;
	await expect(editor.locator('.view-lines')).toContainText('Workbench restored');
	await output.getByRole('searchbox', { name: 'Filter Output', exact: true }).fill('no_output_matches_this');
	await expect(output.locator('.view-lines')).toHaveCount(0);
	await expect(editor.locator('.view-lines')).toContainText('Workbench restored');
	await output.getByRole('searchbox', { name: 'Filter Output', exact: true }).fill('Workbench restored');
	await expect(output.locator('.view-lines')).toContainText('Workbench restored');
	await workbench.quickaccess.runCommand('workbench.action.output.clear');
	await expect(editor.locator('.view-lines')).not.toContainText('Workbench restored');
	await expect(output.locator('.view-lines')).not.toContainText('Workbench restored');
});

test('Output task file links open the editor at their line and column from the keyboard', async ({ target, testWorkspace, workbench }) => {
	test.skip(target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires workspace task execution.');
	const taskLabel = 'Check src/link-target.ts:12:7 now';
	await mkdir(join(testWorkspace.directory, 'src'), { recursive: true });
	await mkdir(join(testWorkspace.directory, '.vscode'), { recursive: true });
	await writeFile(join(testWorkspace.directory, 'src', 'link-target.ts'), Array.from({ length: 15 }, (_, index) => `// source line ${index + 1}`).join('\n'));
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
		{ label: taskLabel, type: 'shell', command: 'node -e "process.exit(0)"' },
	] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select(taskLabel);
	await workbench.page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	await expect(workbench.page.locator('.ash-task-run')).toContainText(`${taskLabel} — succeeded (0)`);
	await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
	await workbench.quickaccess.select('Tasks');
	const output = workbench.page.locator('[data-view-id="ash.output"]');
	const input = output.locator('.stanza-editor-input');
	await expect(output.locator('.view-lines')).toContainText('src/link-target.ts:12:7');
	await input.focus();
	await workbench.page.keyboard.press('ControlOrMeta+f');
	const find = output.getByRole('textbox', { name: 'Find', exact: true });
	await find.fill('src/link-target.ts:12:7');
	await find.press('Enter');
	await find.press('Escape');
	await workbench.quickaccess.runCommand('editor.action.openLink');
	const group = workbench.editors.groupAt(0);
	await expect(group.tabs.filter({ hasText: 'link-target.ts' })).toBeVisible();
	await expect(group.editor.input).toBeFocused();
	await expect(group.content.locator('.stanza-editor-accessibility-status')).toContainText('Line 12, column 7');
	await workbench.quickaccess.runCommand('workbench.action.output.clear');
	await expect(output.locator('.view-lines')).not.toContainText('src/link-target.ts:12:7');
});

interface ExternalOpening {
	readonly urls: string[];
	readonly windows: number[];
	readonly navigations: { readonly url: string; readonly prevented: boolean }[];
	restore(): void;
}

async function captureExternalOpening(electron: ElectronApplication): Promise<void> {
	await electron.evaluate(({ shell, BrowserWindow }) => {
		const original = shell.openExternal;
		const urls: string[] = [];
		(globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening = {
			urls,
			windows: BrowserWindow.getAllWindows().map(window => window.id),
			navigations: [],
			restore: () => { shell.openExternal = original; },
		};
		shell.openExternal = async url => { urls.push(url); };
	});
}

test('editor document links open from the keyboard and modifier click', async ({ application, target, workbench }) => {
	const page = workbench.page;
	const href = 'https://example.test/editor-link?source=text#browser';
	const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
	if (electron) {
		await captureExternalOpening(electron);
	} else {
		await page.context().route(href.split('#')[0]!, route => route.fulfill({ contentType: 'text/html', body: '<title>Editor destination</title>' }));
	}
	try {
		await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
		const editor = workbench.editors.groupAt(0).content.locator('.stanza-editor:visible');
		const input = editor.locator('.stanza-editor-input');
		await input.focus();
		await page.keyboard.insertText(href);
		const link = editor.locator('.view-line > span > span').filter({ hasText: href }).first();
		await expect(link).toBeVisible();
		await page.keyboard.press('ControlOrMeta+Home');
		for (const [index, method] of ['keyboard', 'pointer'].entries()) {
			const popupOpened = electron ? undefined : page.context().waitForEvent('page');
			if (method === 'keyboard') {
				await workbench.quickaccess.runCommand('editor.action.openLink');
			} else {
				const bounds = await link.boundingBox();
				expect(bounds).not.toBeNull();
				const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
				await page.mouse.move(point.x, point.y);
				await page.mouse.click(point.x, point.y);
				await page.keyboard.down('ControlOrMeta');
				try {
					await expect(page.locator('.stanza-editor-link-target')).toHaveCount(1);
					await page.mouse.click(point.x, point.y);
				} finally {
					await page.keyboard.up('ControlOrMeta');
				}
			}
			if (electron) {
				await expect.poll(() => electron.evaluate(({ BrowserWindow }) => {
					const state = (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening;
					return {
						urls: state.urls,
						unchangedWindows: BrowserWindow.getAllWindows().map(window => window.id).join(',') === state.windows.join(','),
					};
				})).toEqual({ urls: Array.from({ length: index + 1 }, () => href), unchangedWindows: true });
			} else {
				const popup = await popupOpened!;
				try {
					await expect(popup).toHaveURL(href);
					await expect(popup).toHaveTitle('Editor destination');
					expect(await popup.evaluate(() => ({ opener: window.opener, referrer: document.referrer }))).toEqual({ opener: null, referrer: '' });
				} finally {
					await popup.close();
				}
			}
		}
		await expect(link).toBeVisible();
	} finally {
		if (electron) {
			await electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.restore());
		}
	}
});

test('editor Open Link and Output help are localized after a display-language restart', async ({ target, workbench, restartWorkbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Requires the Code command palette.');
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	await workbench.editors.groupAt(0).content.locator('.stanza-editor-input').focus();
	await workbench.page.keyboard.press('F1');
	const picker = workbench.page.locator('.ash-quick-pick');
	await picker.getByRole('combobox').fill('打开链接');
	await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: /^打开链接$/u })).toBeVisible();
	await picker.getByRole('combobox').press('Escape');
	await workbench.quickaccess.runCommand('workbench.action.output.showChannels');
	await workbench.quickaccess.select('Window');
	const output = workbench.page.locator('[data-view-id="ash.output"]');
	await expect(output.getByRole('searchbox', { name: '筛选输出', exact: true })).toBeVisible();
	await output.locator('.stanza-editor-input').focus();
	await workbench.page.keyboard.press('Alt+F1');
	const help = workbench.page.locator('.ash-accessible-view-dialog');
	await expect(help.locator('.ash-accessible-view-content')).toHaveValue(/输出是只读编辑器/u);
	await workbench.page.keyboard.press('Escape');
	await expect(output.locator('.stanza-editor-input')).toBeFocused();
});

test.describe('SCM external opening', () => {
	test.use({ gitRepository: true });

	test('Git commit links reach the system browser without creating an application window', async ({ application, target, testWorkspace, workbench }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the desktop Git workspace.');
		const run = promisify(execFile);
		const cwd = testWorkspace.directory;
		await run('git', ['remote', 'add', 'origin', 'https://github.com/ash-test/history.git'], { cwd });
		const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
		const href = `https://github.com/ash-test/history/commit/${stdout.trim()}`;
		const electron = application as ElectronApplication;
		await captureExternalOpening(electron);
		try {
			const page = workbench.page;
			await page.getByRole('tab', { name: /^Git(?:,|$)/u }).click();
			const history = page.locator('[data-view-id="ash.gitGraph"]');
			await expect(history).toBeVisible();
			await history.locator('.ash-pane-view-header').click();
			await history.locator('[data-action-id="ash.git.graph.refresh"] > button').click();
			const commit = history.getByRole('treeitem', { name: /Initial/ });
			await expect(commit).toBeVisible();
			await commit.focus();
			await commit.press('Alt+ArrowDown');
			const hover = page.getByRole('tooltip').filter({ has: page.locator('.ash-scm-graph-hover') });
			const openLink = hover.getByRole('button', { name: 'Open on GitHub', exact: true });
			await openLink.focus();
			await openLink.press('Enter');
			await expect.poll(() => electron.evaluate(({ BrowserWindow }) => {
				const state = (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening;
				return {
					urls: state.urls,
					unchangedWindows: BrowserWindow.getAllWindows().map(window => window.id).join(',') === state.windows.join(','),
				};
			})).toEqual({ urls: [href], unchangedWindows: true });
		} finally {
			await electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.restore());
		}
	});
});

test('release notes external links use the product opener from the keyboard', async ({ application, target, workbench }) => {
	const page = workbench.page;
	const href = 'https://example.test/ash-docs?topic=links#opening';
	const electron = target.kind === 'electron' ? application as ElectronApplication : undefined;
	if (electron) {
		await captureExternalOpening(electron);
	} else {
		await page.context().route(href.split('#')[0]!, route => route.fulfill({ contentType: 'text/html', body: '<title>External documentation</title>' }));
	}
	try {
		await workbench.quickaccess.runCommand('workbench.action.showReleaseNotes');
		const notes = page.frameLocator('.ash-release-notes-editor iframe');
		await expect(notes.getByRole('heading', { name: 'Ash 0.1', exact: true })).toBeVisible();
		// Supply an external destination to the real document's delegated link handler.
		await notes.locator('body').evaluate((body, href) => {
			const link = body.ownerDocument.createElement('a');
			link.href = href;
			link.textContent = 'External documentation';
			body.append(link);
		}, href);
		const link = notes.getByRole('link', { name: 'External documentation', exact: true });
		await link.focus();
		if (electron) {
			await link.press('Enter');
			await expect.poll(() => electron.evaluate(({ BrowserWindow }) => {
				const state = (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening;
				return {
					urls: state.urls,
					unchangedWindows: BrowserWindow.getAllWindows().map(window => window.id).join(',') === state.windows.join(','),
				};
			})).toEqual({ urls: [href], unchangedWindows: true });
		} else {
			const opened = page.context().waitForEvent('page');
			await link.press('Enter');
			const popup = await opened;
			try {
				await expect(popup).toHaveURL(href);
				await expect(popup).toHaveTitle('External documentation');
			} finally {
				await popup.close();
			}
		}
		await expect(notes.getByRole('heading', { name: 'Ash 0.1', exact: true })).toBeVisible();
	} finally {
		if (electron) {
			await electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.restore());
		}
	}
});

test('desktop link window requests use the system and product pages cannot navigate away', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Desktop window interception is owned by Main.');
	const electron = application as ElectronApplication;
	await captureExternalOpening(electron);
	try {
		const agents = await workbench.openAgentsWindow(target.kind);
		const urls: string[] = [];
		for (const [index, page] of [workbench.page, agents].entries()) {
			const href = `https://example.test/window-${index}`;
			const originalUrl = page.url();
			const windows = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id));
			await page.evaluate(href => { window.open(href, '_blank', 'noopener,noreferrer'); }, href);
			urls.push(href);
			await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.urls)).toEqual(urls);
			expect(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id))).toEqual(windows);
			await electron.evaluate(({ BrowserWindow }, originalUrl) => {
				const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === originalUrl)!;
				window.webContents.once('will-navigate', (event, url) => {
					(globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.navigations.push({ url, prevented: event.defaultPrevented });
				});
			}, originalUrl);
			await page.evaluate(href => { location.href = href; }, href);
			await expect.poll(() => electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.navigations.at(-1))).toEqual({ url: href, prevented: true });
			expect(page.url()).toBe(originalUrl);
			await expect.poll(() => page.evaluate(selector => {
				const bounds = document.querySelector(selector)?.getBoundingClientRect();
				return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
			}, index === 0 ? '.ash-workbench' : '.ash-sessions-window')).toBe(true);
		}
	} finally {
		await electron.evaluate(() => (globalThis as typeof globalThis & { externalOpening: ExternalOpening }).externalOpening.restore());
	}
});
