import { _electron, type Page, type TestInfo } from '@playwright/test';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '../../../automation/test.js';
import { resolveElectronConfiguration } from '../../../automation/electron.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { readDevelopmentAppServerGeneration } from '../../../../src/ash/platform/app-server-daemon/electron-main/developmentAppServerReloader.js';
import { developmentAppServerGenerationPath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAppServerDaemonLauncher } from '../../../../src/ash/platform/app-server-daemon/electron-main/appServerDaemonLauncher.js';
import { Editor } from '../../../automation/editor.js';

const desktopDirectory = resolve(import.meta.dirname, '../../../..');
const execFileAsync = promisify(execFile);

async function attachRuntimeLogs(testInfo: TestInfo, userDataDirectory: string): Promise<void> {
	for (const session of await readdir(join(userDataDirectory, 'logs')).catch(() => [])) {
		for (const file of await readdir(join(userDataDirectory, 'logs', session))) {
			if (!file.endsWith('.log')) continue;
			const path = testInfo.outputPath(`${session}-${file}`);
			await writeFile(path, await readFile(join(userDataDirectory, 'logs', session, file)));
			await testInfo.attach(`${session}-${file}`, { path, contentType: 'text/plain' });
		}
	}
}

async function publish(source: string, directory: string, identity: string): Promise<string> {
	const marker = join(directory, 'test-generation');
	await writeFile(marker, identity);
	const script =
		'import json,sys; from pathlib import Path; from build.lib.development_store import publish_generation; changed,generation=publish_generation(Path(sys.argv[1]), {"test-generation":Path(sys.argv[2])}, Path(sys.argv[3])); print(json.dumps({"generation":generation}))';
	const result = await execFileAsync(
		process.execPath,
		[resolve(desktopDirectory, 'build/python.ts'), '-B', '-c', script, source, marker, directory],
		{ cwd: desktopDirectory, windowsHide: true },
	);
	return (JSON.parse(result.stdout) as { generation: string }).generation;
}

async function connection(page: Page): Promise<{ generation: number }> {
	return page.evaluate(async () => {
		const ipc = (
			globalThis as unknown as {
				ash: { ipcRenderer: { invoke(channel: string): Promise<{ generation: number }> } };
			}
		).ash.ipcRenderer;
		return ipc.invoke('ash:remote:connection');
	});
}

type CatalogProbeGlobal = typeof globalThis & { catalogSubscriptions: number };

function countCatalogSubscriptions(): void {
	(globalThis as CatalogProbeGlobal).catalogSubscriptions = 0;
	const post = MessagePort.prototype.postMessage;
	// Observe outgoing product requests without replacing the connection or backend replies.
	MessagePort.prototype.postMessage = function (
		message: { data?: Uint8Array },
		options?: Transferable[] | StructuredSerializeOptions,
	): void {
		// The Desktop carrier writes complete JSONL frames as bytes.
		if (message.data instanceof Uint8Array) {
			for (const frame of new TextDecoder().decode(message.data).split('\n')) {
				try {
					if (frame && JSON.parse(frame).method === 'session/catalog/subscribe') {
						(globalThis as CatalogProbeGlobal).catalogSubscriptions++;
					}
				} catch {
					/* Other MessagePorts can carry binary messages. */
				}
			}
		}
		post.call(this, message, Array.isArray(options) ? { transfer: options } : options);
	};
}

test(
	'Rust publication reconnects Workbench and Agents once while keeping both windows open',
	{ tag: ['@electron-app-server'] },
	async ({ target, testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		const source = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
		if (!source) throw new Error('Prepare the development backend before this scenario');
		const directory = await mkdtemp(resolve(desktopDirectory, '.build/desktop/dev/test-runtime-'));
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const generationFile = join(directory, 'current.json');
		const environment = {
			...process.env,
			ASH_DEV_APP_SERVER_RELOAD: '1',
			ASH_DEV_APP_SERVER_GENERATION: generationFile,
			ASH_HOME: join(userDataDirectory, 'profile'),
		};
		let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
		let processOutput = '';
		const output = (chunk: Buffer): void => {
			processOutput += chunk.toString();
		};
		try {
			const first = await publish(source, directory, 'first');
			await writeFile(join(testWorkspace.directory, 'rebuild-ready.txt'), 'rust_rebuild_workspace_before\n');
			desktop = await launchElectron({
				appServerMode: 'required',
				environment,
				userDataDirectory,
				workspaceDirectory: testWorkspace.directory,
				workspacePermissions: 'development',
			});
			desktop.application.process().stdout?.on('data', output);
			desktop.application.process().stderr?.on('data', output);
			expect(
				await desktop.application.evaluate(() => ({
					reload: process.env.ASH_DEV_APP_SERVER_RELOAD,
					generation: process.env.ASH_DEV_APP_SERVER_GENERATION,
				})),
			).toEqual({ reload: '1', generation: generationFile });
			const workbench = desktop.driver.workbench.page;
			await desktop.driver.workbench.search.open();
			await desktop.driver.workbench.search.search('rust_rebuild_workspace_before');
			await expect(desktop.driver.workbench.search.status).toHaveText('1 results');
			await workbench.evaluate(countCatalogSubscriptions);
			await desktop.application.context().addInitScript(countCatalogSubscriptions);
			const opened = desktop.application.waitForEvent('window');
			await workbench
				.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button")
				.click();
			const agents = await opened;
			await expect(agents.locator('.ash-sessions-window')).toBeVisible();
			await expect
				.poll(() => agents.evaluate(() => (globalThis as CatalogProbeGlobal).catalogSubscriptions))
				.toBe(1);
			const editor = new Editor(agents.locator('.ash-sessions-chat-slot.active:visible'));
			await editor.waitForEditorFocus();
			await agents.keyboard.insertText('Keep the Agents draft across backend replacement');
			await editor.waitForEditorContents(text => text === 'Keep the Agents draft across backend replacement');
			const beforeWorkbench = await connection(workbench);
			const beforeAgents = await connection(agents);
			const daemon = join(source, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`);
			const beforePid = JSON.parse(
				(await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout,
			).pid;

			await writeFile(join(testWorkspace.directory, 'rebuild-ready.txt'), 'rust_rebuild_workspace_after\n');
			const second = await publish(source, directory, 'second');
			await expect
				.poll(async () => (await connection(workbench)).generation)
				.toBe(beforeWorkbench.generation + 1);
			await expect.poll(async () => (await connection(agents)).generation).toBe(beforeAgents.generation + 1);
			await expect.poll(() => processOutput.includes(`Restarted development runtime ${second}`)).toBe(true);
			await expect
				.poll(() => workbench.evaluate(() => (globalThis as CatalogProbeGlobal).catalogSubscriptions))
				.toBe(1);
			await expect
				.poll(() => agents.evaluate(() => (globalThis as CatalogProbeGlobal).catalogSubscriptions))
				.toBe(2);
			await editor.waitForEditorContents(text => text === 'Keep the Agents draft across backend replacement');
			const afterPid = JSON.parse(
				(await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout,
			).pid;
			expect(afterPid).not.toBe(beforePid);
			expect(desktop.application.windows()).toHaveLength(2);
			await expect(desktop.driver.workbench.element).toBeVisible();
			await expect(agents.locator('.ash-sessions-window')).toBeVisible();
			await expect(agents.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
			// A protocol handshake alone does not restore the new connection's directory grants.
			await expect(desktop.driver.workbench.search.element).toBeVisible();
			await expect
				.poll(
					async () => {
						await desktop!.driver.workbench.search.search('rust_rebuild_workspace_after');
						return desktop!.driver.workbench.search.status.textContent();
					},
					{ timeout: 30_000 },
				)
				.toBe('1 results');
			await expect(desktop.driver.workbench.search.element.locator('.ash-search-preview mark')).toHaveText(
				'rust_rebuild_workspace_after',
			);

			await expect
				.poll(async () => {
					await publish(source, directory, 'second');
					try {
						await access(join(directory, 'generations', first));
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
			expect((await connection(workbench)).generation).toBe(beforeWorkbench.generation + 1);
			expect(
				JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout)
					.pid,
			).toBe(afterPid);
			await agents.close();
			await expect.poll(() => desktop!.application.windows().length).toBe(1);
			expect(await publish(source, directory, 'first')).toBe(first);
			await expect
				.poll(async () => (await connection(workbench)).generation)
				.toBe(beforeWorkbench.generation + 2);
			await expect.poll(() => processOutput.includes(`Restarted development runtime ${first}`)).toBe(true);
			await expect
				.poll(() => workbench.evaluate(() => (globalThis as CatalogProbeGlobal).catalogSubscriptions))
				.toBe(2);
		} finally {
			try {
				try {
					// Capture before fixture teardown removes the profile, including when publication never reconnects.
					const path = testInfo.outputPath('runtime-publication-output.log');
					await writeFile(path, processOutput);
					await testInfo.attach('runtime-publication-output', { path, contentType: 'text/plain' });
					await attachRuntimeLogs(testInfo, userDataDirectory);
				} finally {
					desktop?.application.process().stdout?.off('data', output);
					desktop?.application.process().stderr?.off('data', output);
					await desktop?.close();
				}
			} finally {
				await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
				await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	},
);

test(
	'Rust publication overlapping a Workbench reload preserves its unsaved file and completes the new connection',
	{ tag: ['@electron-app-server'] },
	async ({ testWorkspace }, testInfo) => {
		test.setTimeout(120_000);
		const source = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
		if (!source) throw new Error('Prepare the development backend before this scenario');
		const directory = await mkdtemp(resolve(desktopDirectory, '.build/desktop/dev/test-runtime-overlap-'));
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const environment = {
			...process.env,
			ASH_DEV_APP_SERVER_RELOAD: '1',
			ASH_DEV_APP_SERVER_GENERATION: join(directory, 'current.json'),
			ASH_HOME: join(userDataDirectory, 'profile'),
		};
		let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
		let release: (() => Promise<void>) | undefined;
		try {
			await publish(source, directory, 'first');
			desktop = await launchElectron({
				appServerMode: 'required',
				environment,
				userDataDirectory,
				workspaceDirectory: testWorkspace.directory,
				workspacePermissions: 'development',
			});
			const page = desktop.driver.workbench.page;
			const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
			if (await showSidebar.isVisible()) await showSidebar.click();
			await page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' }).dblclick();
			const input = desktop.driver.workbench.editors.groupAt(0).content.locator('.stanza-editor-input');
			await input.focus();
			await input.press('ControlOrMeta+A');
			await input.pressSequentially('unsaved content across Rust publication and reload');
			await expect(page.locator('.stanza-editor-line-text').first()).toContainText(
				'unsaved content across Rust publication and reload',
			);
			const daemon = join(source, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`);
			const before = JSON.parse(
				(await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout,
			) as { pid: number };
			const modulePath = resolve(
				desktopDirectory,
				'.build/desktop/main/src/ash/platform/agentHost/electron-main/appServerConnectionRelay.js',
			);
			// Hold only completion of the real carrier stop. Publication, daemon restart,
			// renderer shutdown, backups and the new handshake still use their production owners.
			const fixture = await desktop.application.evaluateHandle(({ BrowserWindow, dialog }, path) => {
				const require = process.getBuiltinModule('module').createRequire(path);
				const { AppServerConnectionRelay } = require(path);
				const prototype = AppServerConnectionRelay.prototype;
				const stop = prototype.stop;
				const window = BrowserWindow.getAllWindows()[0]!;
				const send = window.webContents.send;
				const showMessageBox = dialog.showMessageBox;
				let allowStop!: () => void;
				const barrier = new Promise<void>(resolve => {
					allowStop = resolve;
				});
				const state = { stopping: false, armed: true, requests: [] as number[], prompts: [] as string[] };
				let relay:
					| {
							readonly state: string;
							readonly options: {
								readonly processLauncher: { readonly environment: Readonly<Record<string, string>> };
							};
					  }
					| undefined;
				prototype.stop = function (): Promise<void> {
					const completion = stop.call(this) as Promise<void>;
					if (!state.armed || this.renderer?.id !== window.webContents.id) return completion;
					state.armed = false;
					relay = this;
					return completion.then(() => {
						state.stopping = true;
						return barrier;
					});
				};
				window.webContents.send = function (channel, ...args): void {
					if (channel === 'ash:window:prepare-reload') state.requests.push(args[0] as number);
					send.call(this, channel, ...args);
				};
				Object.defineProperty(dialog, 'showMessageBox', {
					configurable: true,
					value: (...args: unknown[]) => {
						const options = args.at(-1) as Electron.MessageBoxOptions;
						state.prompts.push(options.message);
						return Promise.resolve({ response: options.cancelId ?? 0, checkboxChecked: false });
					},
				});
				return {
					state,
					release: allowStop,
					connectionState: () => relay?.state,
					selectedRuntime: () => relay?.options.processLauncher.environment.ASH_DEV_RUNTIME_ROOT,
					restore(): void {
						allowStop();
						prototype.stop = stop;
						dialog.showMessageBox = showMessageBox;
						if (!window.isDestroyed()) window.webContents.send = send;
					},
				};
			}, modulePath);
			release = () => fixture.evaluate(value => value.restore());
			try {
				const second = await publish(source, directory, 'second');
				await expect.poll(() => fixture.evaluate(value => value.state.stopping)).toBe(true);
				const reload = page.reload();
				// Observe the real shutdown token while the daemon replacement is still gated.
				await expect.poll(() => fixture.evaluate(value => value.state.requests.length)).toBe(1);
				await fixture.evaluate(value => value.release());
				await reload;
				await desktop.driver.workbench.waitForReady();
				await expect(page.locator('.stanza-editor-line-text').first()).toContainText(
					'unsaved content across Rust publication and reload',
				);
				await expect.poll(() => fixture.evaluate(value => value.connectionState())).toBe('ready');
				const after = JSON.parse(
					(await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout,
				) as { pid: number };
				expect(after.pid).not.toBe(before.pid);
				expect(await readDevelopmentAppServerGeneration(environment.ASH_DEV_APP_SERVER_GENERATION)).toBe(
					join(directory, 'generations', second),
				);
				expect(await fixture.evaluate(value => value.selectedRuntime())).toBe(
					join(directory, 'generations', second),
				);
				expect(await fixture.evaluate(value => value.state.prompts)).toEqual([]);
				const screenshot = testInfo.outputPath('publication-reloaded-editor.png');
				await page.screenshot({ path: screenshot });
				await testInfo.attach('publication-reloaded-editor', { path: screenshot, contentType: 'image/png' });
			} finally {
				try {
					await testInfo.attach('publication-overlap', {
						body: JSON.stringify(await fixture.evaluate(value => value.state)),
						contentType: 'application/json',
					});
					await testInfo.attach('publication-renderer-errors', {
						body: JSON.stringify(desktop.diagnostics.errors),
						contentType: 'application/json',
					});
					await testInfo.attach('publication-renderer-console-errors', {
						body: JSON.stringify(desktop.diagnostics.consoleErrors),
						contentType: 'application/json',
					});
				} finally {
					await release();
					release = undefined;
					await fixture.dispose();
				}
			}
		} finally {
			try {
				try {
					await attachRuntimeLogs(testInfo, userDataDirectory);
					await release?.();
				} finally {
					await desktop?.close();
				}
			} finally {
				await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
				await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	},
);

test(
	'publication between runtime selection and Windows process startup preserves the selected build',
	{ tag: ['@electron-app-server'] },
	async ({ target }) => {
		test.setTimeout(120_000);
		const source = await readDevelopmentAppServerGeneration(developmentAppServerGenerationPath(desktopDirectory));
		if (!source) throw new Error('Prepare the development backend before this scenario');
		const directory = await mkdtemp(resolve(desktopDirectory, '.build/desktop/dev/test-startup-'));
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory });
		const generationFile = join(directory, 'current.json');
		let launcher: ReturnType<typeof createAppServerDaemonLauncher>['launcher'] | undefined;
		try {
			await publish(source, directory, 'first');
			launcher = createAppServerDaemonLauncher({
				packageLocation: {
					appPath: desktopDirectory,
					isPackaged: false,
					platform: process.platform,
					resourcesPath: '',
				},
				sourceEnvironment: {
					...configuration.env,
					ASH_DEV_APP_SERVER_RELOAD: '1',
					ASH_DEV_APP_SERVER_GENERATION: generationFile,
				},
				profileRoot: configuration.env.ASH_HOME!,
				electronExecutable: configuration.executablePath,
				role: 'agents',
			}).launcher;
			// The pointer changes after Electron creates the launcher but before Rust leases it.
			const second = await publish(source, directory, 'second');
			await launcher.validate();
			expect(launcher.environment.ASH_DEV_RUNTIME_ROOT).toBe(join(directory, 'generations', second));
			// Another real publication must retain the leased runtime before any daemon starts.
			await publish(source, directory, 'third');
			await launcher.validate();
			await access(launcher.executable);
			const result = await execFileAsync(launcher.executable, ['start'], {
				env: { ...launcher.environment },
				windowsHide: true,
			});
			expect((JSON.parse(result.stdout) as { pid: number }).pid).toBeGreaterThan(0);
			await execFileAsync(launcher.executable, ['stop'], { env: { ...launcher.environment }, windowsHide: true });
			launcher.dispose();
			await expect
				.poll(async () => {
					await publish(source, directory, 'third');
					try {
						await access(join(directory, 'generations', second));
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
		} finally {
			if (launcher && !launcher.isDisposed) {
				try {
					await execFileAsync(launcher.executable, ['stop'], {
						env: { ...launcher.environment },
						windowsHide: true,
					});
				} finally {
					launcher.dispose();
				}
			}
			await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	},
);

test(
	'the Agents development entry opens one connected Agents window directly',
	{ tag: ['@electron-app-server'] },
	async ({ target }) => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-'));
		const configuration = resolveElectronConfiguration({ appServerMode: 'required', userDataDirectory: directory });
		const application = await _electron.launch({
			args: [...configuration.args],
			cwd: configuration.cwd,
			executablePath: configuration.executablePath,
			env: { ...configuration.env, ASH_DEV_APP_SERVER_RELOAD: '1', ASH_DEV_AGENTS_WINDOW: '1' },
		});
		try {
			const page = await application.firstWindow();
			await expect(page.locator('.ash-sessions-window')).toBeVisible();
			expect(application.windows()).toHaveLength(1);
			await expect(page.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
		} finally {
			await application.evaluate(({ BrowserWindow }) => {
				for (const window of BrowserWindow.getAllWindows()) window.destroy();
			});
			const runtime = await readDevelopmentAppServerGeneration(
				developmentAppServerGenerationPath(desktopDirectory),
			);
			if (runtime)
				await execFileAsync(
					join(runtime, `bin/ash-app-server-daemon${process.platform === 'win32' ? '.exe' : ''}`),
					['stop'],
					{ env: { ...configuration.env }, windowsHide: true },
				);
			await application.close();
			await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	},
);
