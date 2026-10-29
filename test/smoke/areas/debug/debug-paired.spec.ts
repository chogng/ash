import { _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { registerRunResource } from '../../../../build/processes.ts';

// Opt-in because the reference product is an external, independently installed
// application. Both hosts run this same synthetic peer through their real DAP transport.
const upstreamExecutable = process.env.ASH_DEBUG_UPSTREAM_EXECUTABLE;
const adapter = String.raw`
const fs = require('node:fs');
const [source, requests] = process.argv.slice(2);
let buffer = Buffer.alloc(0), sequence = 1, line = 2, answer = '42', child = '1';
function send(message) {
  const body = Buffer.from(JSON.stringify({seq: sequence++, ...message}));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function event(event, body) { send({type: 'event', event, body}); }
function accept(request) {
  fs.appendFileSync(requests, JSON.stringify(request) + '\n');
  const args = request.arguments || {};
  let body = {};
  if (request.command === 'initialize') body = {supportsConfigurationDoneRequest: true, supportsSetVariable: true, supportsLoadedSourcesRequest: true};
  if (request.command === 'launch') event('initialized', {});
  if (request.command === 'threads') body = {threads: [{id: 7, name: 'main'}]};
  if (request.command === 'stackTrace') body = {stackFrames: [{id: 11, name: 'main', source: {name: 'paired-source.js', path: source}, line, column: 1}], totalFrames: 1};
  if (request.command === 'scopes') body = {scopes: [{name: 'Locals', variablesReference: 10, expensive: false}]};
  if (request.command === 'variables') body = {variables: args.variablesReference === 10 ? [{name: 'answer', value: answer, variablesReference: 0}, {name: 'object', value: 'Object', variablesReference: 20}] : [{name: 'child', value: child, variablesReference: 0}]};
  if (request.command === 'evaluate') body = {result: answer, variablesReference: 0};
  if (request.command === 'loadedSources') body = {sources: [{name: 'paired-generated.js', sourceReference: 25}]};
  if (request.command === 'source') body = {content: 'const pairedGenerated = 25;', mimeType: 'text/javascript'};
  if (request.command === 'setVariable') {
    if (args.variablesReference === 10 && args.name === 'answer') answer = args.value;
    else if (args.variablesReference === 20 && args.name === 'child') child = args.value;
    else throw new Error('Unexpected assignment container');
    body = {value: args.value};
  }
  if (request.command === 'setBreakpoints') body = {breakpoints: args.breakpoints.map(point => ({line: point.line, verified: true}))};
  send({type: 'response', request_seq: request.seq, command: request.command, success: true, body});
  if (request.command === 'configurationDone') {
    event('output', {category: 'console', output: 'PAIRED_DEBUG_READY\n'});
    event('stopped', {reason: 'breakpoint', threadId: 7, allThreadsStopped: true});
  }
  if (request.command === 'next') {
    line++;
    answer = String(Number(answer) + 1);
    event('continued', {threadId: 7, allThreadsContinued: true});
    event('stopped', {reason: 'step', threadId: 7, allThreadsStopped: true});
  }
  if (request.command === 'disconnect') {
    event('terminated', {});
    process.stdout.end(() => process.exit(0));
  }
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    const end = headerEnd + 4 + size;
    if (buffer.length < end) return;
    const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
    buffer = buffer.subarray(end);
    accept(request);
  }
});
`;

test.use({ useDefaultLanguageServer: false });
test.beforeEach(async ({ testWorkspace }) => {
	test.skip(!upstreamExecutable, 'Set ASH_DEBUG_UPSTREAM_EXECUTABLE to run the paired product acceptance.');
	const directory = testWorkspace.directory;
	await mkdir(join(directory, '.vscode'));
	await writeFile(join(directory, 'paired-adapter.cjs'), adapter);
	await writeFile(
		join(directory, 'paired-source.js'),
		Array.from({ length: 200 }, (_, index) => (index === 0 ? 'const answer = 42;' : index === 1 ? 'console.log(answer);' : `// synthetic source line ${index + 1}`)).join('\n') + '\n',
	);
	await writeFile(
		join(directory, '.vscode', 'launch.json'),
		JSON.stringify({
			version: '0.2.0',
			configurations: [
				{
					name: 'Paired Debug',
					type: 'paired-debug',
					request: 'launch',
					debugAdapter: {
						program: process.execPath,
						args: [join(directory, 'paired-adapter.cjs'), join(directory, 'paired-source.js'), join(directory, 'ash-requests.jsonl')],
					},
				},
			],
		}),
	);
});

interface PairHost {
	readonly kind: 'ash' | 'vscode';
	readonly page: Page;
	readonly variables: Locator;
	readonly editor: Locator;
	readonly cursor: Locator;
	command(id: string, label: string): Promise<void>;
	size(width: number, height: number): Promise<void>;
}

async function focusedRow(row: Locator): Promise<boolean> {
	return row.evaluate(element => element.contains(document.activeElement) || document.activeElement?.getAttribute('aria-activedescendant') === element.id);
}

test(
	'paired upstream Debug preserves independent views, inspection, keyboard focus, source selection, scrolling and themes',
	{ tag: ['@electron-app-server'] },
	async ({ application, workbench, reloadWorkbench, testWorkspace }, testInfo) => {
		test.setTimeout(240_000);
		const directory = testWorkspace.directory;
		const reference = join(directory, 'reference');
		// The macOS reference host puts its instance socket below user-data-dir.
		// The smoke workspace's system temporary path exceeds that socket's limit.
		const profileRoot = resolve('.build/debug-pair');
		await mkdir(profileRoot, { recursive: true });
		const profile = await mkdtemp(join(profileRoot, 'profile-'));
		await mkdir(reference);
		await mkdir(join(profile, 'User'), { recursive: true });
		await writeFile(
			join(profile, 'User', 'settings.json'),
			JSON.stringify({
				'security.workspace.trust.enabled': false,
				'workbench.startupEditor': 'none',
				'workbench.tips.enabled': false,
				'window.menuStyle': 'custom',
				'update.mode': 'none',
				'extensions.autoUpdate': false,
				'git.openRepositoryInParentFolders': 'never',
			}),
		);
		await writeFile(
			join(reference, 'package.json'),
			JSON.stringify({
				name: 'paired-debug',
				publisher: 'ash-test',
				version: '1.0.0',
				engines: { vscode: '^1.100.0' },
				main: 'extension.cjs',
				activationEvents: ['onDebug'],
				contributes: {
					debuggers: [
						{
							type: 'paired-debug',
							label: 'Paired Debug',
							languages: ['javascript'],
							configurationAttributes: { launch: { properties: {} } },
						},
					],
				},
			}),
		);
		await writeFile(
			join(reference, 'extension.cjs'),
			`const vscode = require('vscode'); exports.activate = context => context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('paired-debug', { createDebugAdapterDescriptor: () => new vscode.DebugAdapterExecutable(${JSON.stringify(process.execPath)}, ${JSON.stringify([join(directory, 'paired-adapter.cjs'), join(directory, 'paired-source.js'), join(directory, 'vscode-requests.jsonl')])}) }));`,
		);
		const evidence: Record<string, unknown> = { upstreamExecutable, steps: [] };
		const snapshots = evidence.steps as unknown[];
		const capture = async (host: PairHost, step: string, result: unknown) => {
			console.log(`${host.kind}: ${step}`);
			snapshots.push({
				host: host.kind,
				step,
				result,
				focus: await host.page.evaluate(() => ({
					tag: document.activeElement?.tagName,
					role: document.activeElement?.getAttribute('role'),
					label: document.activeElement?.getAttribute('aria-label'),
				})),
			});
			await host.page.screenshot({
				path: testInfo.outputPath(`${host.kind}-${step}.png`),
			});
		};
		let upstream: ElectronApplication | undefined;
		const referenceResource = await registerRunResource();
		try {
			upstream = await _electron.launch({
				executablePath: upstreamExecutable!,
				args: [
					`--user-data-dir=${profile}`,
					`--extensions-dir=${join(directory, 'reference-extensions')}`,
					`--extensionDevelopmentPath=${reference}`,
					'--skip-welcome',
					'--skip-release-notes',
					'--disable-updates',
					directory,
				],
				timeout: 30_000,
			});
			await referenceResource.process(upstream.process());
			let upstreamLog = '';
			upstream.process().stderr?.on('data', data => {
				upstreamLog += data.toString();
			});
			upstream.process().stdout?.on('data', data => {
				upstreamLog += data.toString();
			});
			upstream.process().once('exit', (code, signal) => {
				evidence.upstreamExit = { code, signal, log: upstreamLog };
			});
			const referencePage = await upstream.firstWindow();
			await upstream.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
			referencePage.setDefaultTimeout(15_000);
			await expect(referencePage.locator('.monaco-workbench')).toBeVisible();
			const appRoot = process.platform === 'darwin' ? resolve(dirname(upstreamExecutable!), '../Resources/app') : join(dirname(upstreamExecutable!), 'resources', 'app');
			const product = JSON.parse(await readFile(join(appRoot, 'product.json'), 'utf8'));
			evidence.upstream = {
				version: JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')).version,
				commit: product.commit,
				date: product.date,
			};
			await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
			const openViews = () => workbench.page.locator('[data-part="sidebar"] .ash-pane-composite-title').getByRole('button', { name: 'More Actions', exact: true }).click();
			const items = await workbench.menus.inspect(application, openViews);
			await workbench.menus.select(application, openViews, items.some(item => item.label === 'Call Stack') ? ['Call Stack'] : ['Views', 'Call Stack']);
			({ application, workbench } = await reloadWorkbench());
			workbench.page.setDefaultTimeout(15_000);
			if (!(await workbench.page.locator('[data-view-container-id="ash.debug"]').isVisible())) await workbench.page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
			await expect(workbench.page.locator('[data-view-id="workbench.debug.callStackView"]')).toHaveCount(0);
			await referencePage.keyboard.press('ControlOrMeta+Shift+D');
			await referencePage.locator('.part.sidebar').getByRole('button', { name: 'Views and More Actions...', exact: true }).click();
			evidence.referenceViewMenu = await referencePage.locator('[role^="menuitem"]').evaluateAll(elements =>
				elements.map(element => ({
					role: element.getAttribute('role'),
					label: element.getAttribute('aria-label'),
					text: element.textContent,
				})),
			);
			await referencePage.getByText('Call Stack', { exact: true }).last().click();
			await expect(
				referencePage.getByRole('button', {
					name: 'Call Stack Section',
					exact: true,
				}),
			).toHaveCount(0);
			const referenceCommand = async (_id: string, label: string) => {
				await referencePage.keyboard.press('F1');
				const input = referencePage.locator('.quick-input-widget input');
				await input.fill(`>${label}`);
				await referencePage.locator('.quick-input-widget').getByText(label, { exact: true }).click();
			};
			const referenceReload = referencePage.waitForEvent('domcontentloaded');
			await referenceCommand('workbench.action.reloadWindow', 'Developer: Reload Window');
			await referenceReload;
			console.log('Reference views hidden; reloading');
			await expect(referencePage.locator('.monaco-workbench')).toBeVisible();
			await expect(
				referencePage.getByRole('button', {
					name: 'Call Stack Section',
					exact: true,
				}),
			).toHaveCount(0);
			const ash: PairHost = {
				kind: 'ash',
				page: workbench.page,
				variables: workbench.page.locator('.ash-debug-variables'),
				editor: workbench.editors.groupAt(0).editor.element,
				cursor: workbench.page.locator('[data-statusbar-item-id="ash.status.editor.cursor"]'),
				command: id => workbench.quickaccess.runCommand(id),
				size: async (width, height) => {
					await (application as ElectronApplication).evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { width, height });
				},
			};
			const vscode: PairHost = {
				kind: 'vscode',
				page: referencePage,
				variables: referencePage.getByRole('tree', {
					name: 'Debug Variables',
					exact: true,
				}),
				editor: referencePage.locator('.editor-instance .monaco-editor:visible'),
				cursor: referencePage.locator('[id="status.editor.selection"]'),
				command: referenceCommand,
				size: async (width, height) => {
					await upstream!.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), { width, height });
				},
			};
			for (const host of [ash, vscode]) {
				const { page } = host;
				await host.size(1440, 900);
				const requests = async (): Promise<{ command: string; arguments?: Record<string, unknown> }[]> =>
					(await readFile(join(directory, `${host.kind}-requests.jsonl`), 'utf8'))
						.trim()
						.split('\n')
						.filter(Boolean)
						.map(line => JSON.parse(line));
				await page
					.getByRole('button', {
						name: host.kind === 'ash' ? 'Start Debugging' : /^Start Debugging/,
						exact: host.kind === 'ash',
					})
					.first()
					.click();
				await expect(host.variables).toContainText('answer');
				await expect(host.cursor).toContainText('Ln 2, Col 1');
				const hiddenStack =
					host.kind === 'ash'
						? page.locator('[data-view-id="workbench.debug.callStackView"]')
						: page.getByRole('button', {
								name: 'Call Stack Section',
								exact: true,
							});
				await expect(hiddenStack).toHaveCount(0);
				await capture(host, 'hidden-stack-source', {
					sourceLine: 2,
					callStackAbsent: true,
				});
				const variable = (name: string) =>
					host.kind === 'ash'
						? host.variables.locator('.ash-debug-variable').filter({ hasText: `${name} =` })
						: host.variables.getByRole('treeitem', {
								name: new RegExp(`^${name}, value `),
							});
				const answer = variable('answer');
				await answer.dblclick();
				const edit = host.variables.locator('input:visible');
				await expect(edit).toBeFocused();
				await edit.fill('100');
				await edit.press('Escape');
				await expect(edit).toBeHidden();
				if (host.kind === 'ash') await expect.poll(() => focusedRow(answer)).toBe(true);
				await capture(host, 'variable-cancel-focus', {
					rowFocused: await focusedRow(answer),
					editorClosed: true,
				});
				await expect(answer).toContainText('42');
				expect((await requests()).filter(request => request.command === 'setVariable')).toHaveLength(0);
				await answer.dblclick();
				await edit.fill('43');
				await edit.press('Enter');
				await expect(answer).toContainText('43');
				if (host.kind === 'ash') await expect.poll(() => focusedRow(answer)).toBe(true);
				if (host.kind === 'ash') await variable('object').click();
				else await variable('object').locator('.monaco-tl-twistie').click();
				const child = variable('child');
				await child.dblclick();
				await edit.fill('2');
				await edit.press('Enter');
				await expect(child).toContainText('2');
				if (host.kind === 'ash') await expect.poll(() => focusedRow(child)).toBe(true);
				expect((await requests()).filter(request => request.command === 'setVariable').map(request => request.arguments)).toEqual([
					{ variablesReference: 10, name: 'answer', value: '43' },
					{ variablesReference: 20, name: 'child', value: '2' },
				]);
				await capture(host, 'variable-edit', {
					cancelledValue: 100,
					answer: 43,
					child: 2,
					parentReferences: [10, 20],
				});
				const watchHeader = page.getByRole('button', {
					name: host.kind === 'ash' ? 'Watch' : 'Watch Section',
					exact: true,
				});
				await watchHeader.hover();
				await page.getByRole('button', { name: /^Add (?:watch )?Expression$/i }).click();
				const watchInput = host.kind === 'ash' ? page.getByRole('textbox', { name: 'Add watch expression' }) : page.locator('.debug-watch input');
				await watchInput.fill('answer');
				await watchInput.press('Enter');
				const watch = page.locator(host.kind === 'ash' ? '.ash-debug-watch-value' : '.debug-watch .expression');
				await expect(watch).toContainText('43');
				await host.command('workbench.action.debug.stepOver', 'Debug: Step Over');
				await expect(host.cursor).toContainText('Ln 3, Col 1');
				await expect(hiddenStack).toHaveCount(0);
				await expect(watch).toContainText('44');
				await expect(variable('object')).toHaveAttribute('aria-expanded', 'true');
				await expect(variable('child')).toContainText('2');
				await capture(host, 'step-watch', {
					sourceLine: 3,
					watch: 44,
					objectExpanded: true,
					child: 2,
					callStackAbsent: true,
				});
				const input = host.editor.locator(host.kind === 'ash' ? '.stanza-editor-input' : '[role="textbox"]');
				await input.focus();
				await input.press('Shift+ArrowRight');
				await input.press('Shift+ArrowRight');
				await input.press('Shift+ArrowRight');
				await expect(host.cursor).toContainText('3 selected');
				await capture(host, 'source-selection', { selectedCharacters: 3 });
				await input.press(host.kind === 'vscode' && process.platform === 'darwin' ? 'Meta+ArrowDown' : 'ControlOrMeta+End');
				await expect(host.editor).toContainText('synthetic\u00a0source\u00a0line\u00a0200');
				await input.press(host.kind === 'vscode' && process.platform === 'darwin' ? 'Meta+ArrowUp' : 'ControlOrMeta+Home');
				await expect(host.cursor).toContainText('Ln 1, Col 1');
				await expect(host.editor).toContainText('const\u00a0answer');
				await capture(host, 'source-scroll', {
					bottomLine: 200,
					restoredLine: 1,
					editorFocused: await input.evaluate(element => element === document.activeElement),
				});
				await host.command('workbench.debug.action.focusRepl', 'Debug Console: Focus on Debug Console View');
				const consoleInput = page.locator(host.kind === 'ash' ? '.ash-debug-console-form .stanza-editor-input' : '.repl-input-wrapper [role="textbox"]');
				await consoleInput.focus();
				await expect(consoleInput).toBeFocused();
				await page.keyboard.insertText('answer');
				await consoleInput.press('Enter');
				await expect
					.poll(async () => (await requests()).filter(request => request.command === 'evaluate' && request.arguments?.context === 'repl').map(request => request.arguments?.expression))
					.toEqual(['answer']);
				const consoleOutput = page.locator(host.kind === 'ash' ? '.ash-debug-console-output' : '.repl');
				await expect(consoleOutput).toContainText('PAIRED_DEBUG_READY');
				await expect(consoleOutput).toContainText('44');
				await expect(consoleInput).toBeFocused();
				await capture(host, 'console-input', {
					expression: 'answer',
					result: 44,
					context: 'repl',
					focusRetained: true,
				});
				for (const [name, ashTheme, referenceTheme] of [
					['dark', 'Ash Dark', 'Dark Modern'],
					['light', 'Ash Light', 'Light Modern'],
					['hcDark', 'Ash High Contrast Dark', 'Dark High Contrast'],
					['hcLight', 'Ash High Contrast Light', 'Light High Contrast'],
				] as const) {
					await host.command('workbench.action.selectTheme', 'Preferences: Color Theme');
					const themeInput = page.locator(host.kind === 'ash' ? '.ash-quick-pick input' : '.quick-input-widget input');
					await expect(themeInput).not.toHaveValue(/^>/);
					const selectedTheme = host.kind === 'ash' ? ashTheme : referenceTheme;
					await themeInput.fill(selectedTheme);
					await page
						.locator(host.kind === 'ash' ? '.ash-quick-pick' : '.quick-input-widget')
						.getByText(selectedTheme, { exact: true })
						.click();
					await expect(themeInput).toBeHidden();
					if (host.kind === 'ash') {
						await expect(workbench.element).toHaveAttribute(
							'data-color-theme',
							{
								dark: 'ash-dark',
								light: 'ash-light',
								hcDark: 'ash-high-contrast-dark',
								hcLight: 'ash-high-contrast-light',
							}[name]!,
						);
					} else {
						await expect(page.locator('.monaco-workbench')).toHaveClass(new RegExp(`(?:^|\\s)${{ dark: 'vs-dark', light: 'vs', hcDark: 'hc-black', hcLight: 'hc-light' }[name]}(?:\\s|$)`));
					}
					await host.size(1000, 700);
					await answer.click();
					const geometry = await host.variables.evaluate(element => {
						const rect = element.getBoundingClientRect();
						const style = getComputedStyle(element);
						return {
							x: rect.x,
							y: rect.y,
							width: rect.width,
							height: rect.height,
							viewportWidth: innerWidth,
							viewportHeight: innerHeight,
							color: style.color,
							background: style.backgroundColor,
						};
					});
					expect(geometry.width).toBeGreaterThan(80);
					expect(geometry.height).toBeGreaterThan(20);
					expect(geometry.x).toBeGreaterThanOrEqual(0);
					expect(geometry.y + geometry.height).toBeLessThanOrEqual(geometry.viewportHeight);
					await expect(answer).toBeVisible();
					const statusbar = page.locator(host.kind === 'ash' ? '[data-part="statusbar"]' : '.part.statusbar');
					const colors = await statusbar.evaluate(element => ({
						background: getComputedStyle(element).backgroundColor,
						foreground: getComputedStyle(element).color,
					}));
					expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
					await expect.poll(() => focusedRow(answer)).toBe(true);
					await capture(host, `theme-${name}`, {
						...geometry,
						colors,
						theme: name,
						variableFocused: true,
					});
					await host.size(1440, 900);
				}
				await host.command('workbench.action.debug.showLoadedScripts', 'Debug: Open Loaded Script');
				const sourcePicker = page.locator(host.kind === 'ash' ? '.ash-quick-pick' : '.quick-input-widget');
				await sourcePicker.locator('input').fill('paired-generated');
				await expect(sourcePicker).toContainText('paired-generated.js');
				await sourcePicker.locator('input').press('Enter');
				await expect(host.editor).toContainText('pairedGenerated');
				await expect.poll(async () => (await requests()).filter(request => request.command === 'source').map(request => request.arguments?.sourceReference)).toContain(25);
				await capture(host, 'loaded-source', {
					sourceReference: 25,
					content: 'const pairedGenerated = 25;',
				});
				await host.command('workbench.action.debug.stop', 'Debug: Stop');
				await expect.poll(async () => (await requests()).filter(request => request.command === 'disconnect').length).toBe(1);
				await expect(host.variables).not.toContainText('answer');
				await capture(host, 'stop', {
					disconnected: true,
					variablesRetired: true,
				});
			}
			for (const step of ['hidden-stack-source', 'variable-edit', 'step-watch', 'source-selection', 'source-scroll', 'console-input', 'loaded-source', 'stop']) {
				const results = (snapshots as { step: string; result: unknown }[]).filter(snapshot => snapshot.step === step).map(snapshot => snapshot.result);
				expect(results, step).toHaveLength(2);
				expect(results[0], step).toEqual(results[1]);
			}
			evidence.assertions = 'passed';
		} finally {
			try {
				if (upstream) {
					for (const page of upstream.windows()) {
						if (!page.isClosed()) {
							await page.screenshot({ path: testInfo.outputPath('reference-final.png') }).catch(() => undefined);
							evidence.referenceFinalText = await page
								.locator('body')
								.innerText()
								.catch(() => 'Closed');
						}
					}
					await upstream
						.context()
						.tracing.stop({ path: testInfo.outputPath('reference-trace.zip') })
						.catch(() => undefined);
				}
				for (const host of ['ash', 'vscode']) {
					const log = await readFile(join(directory, `${host}-requests.jsonl`), 'utf8').catch(() => '');
					await writeFile(testInfo.outputPath(`${host}-requests.jsonl`), log);
				}
				await writeFile(testInfo.outputPath('paired-debug.json'), JSON.stringify(evidence, null, 2));
				await testInfo.attach('paired-debug', {
					path: testInfo.outputPath('paired-debug.json'),
					contentType: 'application/json',
				});
			} finally {
				await upstream?.close();
				await referenceResource.dispose();
				await rm(profile, { recursive: true, force: true });
			}
		}
	},
);
