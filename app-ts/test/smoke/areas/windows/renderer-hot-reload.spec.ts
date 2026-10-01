/// <reference types="@webgpu/types" />
/// <reference path="../../../../src/typings/editContext.d.ts" />

import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import type * as Stanza from '../../../../src/ash/editor/editor.main.js';

declare global {
	var stanza: typeof Stanza;
	var hotReloadUpdateCount: number;
	var hotReloadEvidence: {
		readonly editor: ReturnType<typeof Stanza.editor.getEditors>[number];
		readonly model: ReturnType<typeof Stanza.editor.getModels>[number];
		readonly root: HTMLElement | null;
		readonly document: Document;
		previous: Element | null;
	};
}

test('development Renderer replaces contribution initialization twice while retaining its editor and model', async ({ playwright }, testInfo) => {
	test.skip(!['browser-ui', 'electron-ui'].includes(testInfo.project.name), 'Development hot reload runs in the browser and Electron UI projects.');
	test.setTimeout(120_000);
	const desktopDirectory = resolve(import.meta.dirname, '../../../..');
	const sourceFile = resolve(desktopDirectory, 'src/ash/editor/contrib/placeholderText/browser/placeholderTextContribution.ts');
	const original = await readFile(sourceFile, 'utf8');
	let written = original;
	const server = spawn(process.execPath, [resolve(desktopDirectory, 'node_modules/vite/bin/vite.js'), '--config', '../build/app_ts/vite/editor.vite.config.ts', '--port', '5198', '--strictPort'], { cwd: desktopDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let serverOutput = '';
	server.stdout.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
	server.stderr.on('data', (chunk: Buffer) => { serverOutput += chunk.toString(); });
	const profile = await mkdtemp(join(tmpdir(), 'ash-hmr-'));
	let electron: ElectronApplication | undefined;
	let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
	try {
		await test.step('start the development server', async () => {
			await expect.poll(() => {
				if (server.exitCode !== null) throw new Error(serverOutput);
				return serverOutput.includes('5198');
			}, { timeout: 30_000 }).toBe(true);
		});
		let page: Page;
		if (testInfo.project.name.startsWith('electron')) {
			const configuration = resolveElectronConfiguration({ desktopDirectory, appServerMode: 'disabled', userDataDirectory: profile });
			electron = await test.step('launch the Ash Electron host', () => _electron.launch({ args: [...configuration.args], cwd: configuration.cwd, env: configuration.env, executablePath: configuration.executablePath, timeout: 30_000 }));
			page = await test.step('wait for the first window', () => electron!.firstWindow({ timeout: 30_000 }));
			await test.step('wait for the Electron host navigation to finish', () => page.waitForLoadState('load', { timeout: 30_000 }));
		} else {
			browser = await playwright.chromium.launch();
			page = await browser.newPage();
		}
		const errors: string[] = [];
		const consoleMessages: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		page.on('console', message => consoleMessages.push(message.text()));
		await test.step('open the editor through Vite', async () => {
			try {
				await page.goto('http://127.0.0.1:5198/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
			} catch (error) {
				throw new Error(`Vite navigation failed: ${serverOutput}\n${errors.join('\n')}`, { cause: error });
			}
		});
		await test.step('wait for the placeholder contribution', async () => {
			try {
				await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
			} catch (error) {
				throw new Error(`Editor startup failed: ${errors.join('\n')}\n${await page.locator('body').innerText()}`, { cause: error });
			}
		});
		await page.evaluate(async () => {
			const clientUrl = '/@vite/client';
			const client = await import(clientUrl);
			globalThis.hotReloadUpdateCount = 0;
			client.createHotContext('/ash-hmr-evidence').on('vite:afterUpdate', () => globalThis.hotReloadUpdateCount++);
			const editor = globalThis.stanza.editor.getEditors()[0]!;
			const model = editor.getModel()!;
			model.setValue('kept through reload');
			editor.setPosition({ lineNumber: 1, column: 5 });
			editor.focus();
			globalThis.hotReloadEvidence = { editor, model, root: editor.getDomNode(), document, previous: document.querySelector('.stanza-editor-placeholder-text') };
		});
		for (const version of ['first', 'second']) {
			const updates = await page.evaluate(() => globalThis.hotReloadUpdateCount);
			written = original.replace('this.element = element;', `this.element = element;\n\t\telement.dataset.hotReloadVersion = '${version}';`);
			expect(written).not.toBe(original);
			// Match an editor's atomic save rather than exposing a truncated module to the watcher.
			const temporary = `${sourceFile}.ash-hot-reload`;
			await writeFile(temporary, written);
			await rename(temporary, sourceFile);
			try {
				await expect(page.locator('.stanza-editor-placeholder-text')).toHaveAttribute('data-hot-reload-version', version);
			} catch (error) {
				throw new Error(`Hot update failed (${version}, completed: ${await page.evaluate(() => globalThis.hotReloadUpdateCount)}):\n${serverOutput}\n${consoleMessages.join('\n')}\n${errors.join('\n')}`, { cause: error });
			}
			await expect.poll(() => page.evaluate(() => globalThis.hotReloadUpdateCount)).toBe(updates + 1);
			const retained = await page.evaluate(() => {
				const evidence = globalThis.hotReloadEvidence;
				const editor = globalThis.stanza.editor.getEditors()[0]!;
				const previousRemoved = !evidence.previous!.isConnected;
				evidence.previous = document.querySelector('.stanza-editor-placeholder-text');
				return { document: document === evidence.document, editor: editor === evidence.editor, model: editor.getModel() === evidence.model, root: editor.getDomNode() === evidence.root, text: evidence.model.getValue(), position: editor.getPosition(), focus: editor.hasTextFocus(), previousRemoved };
			});
			expect(retained).toEqual({ document: true, editor: true, model: true, root: true, text: 'kept through reload', position: { lineNumber: 1, column: 5 }, focus: true, previousRemoved: true });
			await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(1);
		}
		await page.evaluate(() => globalThis.hotReloadEvidence.model.setValue(''));
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveText('Start typing…');
		await expect(page.locator('.stanza-editor-placeholder-text')).toBeVisible();
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveAttribute('aria-hidden', 'true');
		await page.evaluate(() => globalThis.hotReloadEvidence.editor.dispose());
		await expect(page.locator('.stanza-editor-placeholder-text')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		// Do not overwrite an edit made by someone else while this scenario was running.
		const current = await readFile(sourceFile, 'utf8');
		if (current === written) {
			await writeFile(sourceFile, original);
		}
		if (electron) {
			await electron.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			await electron.close();
		}
		await browser?.close();
		if (server.exitCode === null) {
			const stopped = once(server, 'exit');
			server.kill();
			await stopped;
		}
		await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		if (current !== written && current !== original) {
			throw new Error(`Concurrent edit detected; preserve ${sourceFile}`);
		}
	}
});
