import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from '../../../automation/test.js';
import { installMainChannelTestClient } from '../../../automation/mainProcessIpc.js';
import { Workbench } from '../../../automation/workbench.js';

test.use({ electronWindowMode: 'active', video: 'on' });

// Check the real timeout and native replacement with a prepared checkpoint. The
// fault stalls only the acknowledgement after the host has stored the capability;
// it never fabricates a checkpoint, lease, PTY, timeout or backend response.
for (const rejection of ['none', 'all', 'first'] as const) test(`emergency Reopen retains checkpointed PTYs after failed startup (${rejection} rejected attachments)`, { tag: ['@electron-app-server'] }, async ({ application, workbench, testWorkspace, driver }, testInfo) => {
	test.skip(process.platform === 'win32', 'The synthetic input and shell fixture currently covers POSIX hosts.');
	test.setTimeout(120_000);
	const rejectAttachments = rejection !== 'none';
	const rejectedCount = rejection === 'first' ? 1 : 2;
	if (!('windows' in application)) throw new Error('Emergency window recovery requires Electron');
	const electron = application;
	let mainErrors = '';
	const recordMainError = (data: Buffer): void => { mainErrors = (mainErrors + data.toString()).slice(-24000); };
	electron.process().stderr?.on('data', recordMainError);
	const page = workbench.page;
	await writeFile(join(testWorkspace.directory, 'emergency-child.cjs'), `const fs=require('fs');let count=0;console.log('CHECKPOINT_HISTORY_'+process.argv[2]);process.stdin.on('data',data=>console.log('RECEIVED:'+data.toString().trim()));setInterval(()=>fs.writeFileSync('emergency-'+process.argv[2]+'.json',JSON.stringify({pid:process.pid,shell:process.ppid,count:++count})),100);`);
	await workbench.terminal.show();
	await page.locator('.ash-terminal-title-toolbar').getByRole('button', { name: 'Split Terminal', exact: true }).click();
	const panes = page.locator('.ash-terminal-group-pane:visible');
	await expect(panes).toHaveCount(2);
	const state = async (index: number): Promise<{ pid: number; shell: number; count: number; }> => JSON.parse(await readFile(join(testWorkspace.directory, `emergency-${index}.json`), 'utf8'));
	for (const index of [0, 1]) {
		const input = panes.nth(index).locator('.xterm-helper-textarea');
		await input.focus();
		await input.pressSequentially(`node emergency-child.cjs ${index}`);
		await input.press('Enter');
		await expect(panes.nth(index).locator('.xterm-rows')).toContainText(`CHECKPOINT_HISTORY_${index}`);
		await expect.poll(() => state(index).then(value => value.count).catch(() => 0)).toBeGreaterThan(0);
	}
	const before = await Promise.all([0, 1].map(state));
	const window = await electron.browserWindow(page);
	const sourceId = await window.evaluate(window => window.id);
	const peerOpening = electron.waitForEvent('window');
	await page.evaluate(root => (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, value: unknown): Promise<void>; }; }; }).ash.ipcRenderer.invoke('ash:native-host:open-workspace', { root, forceNewWindow: true }), testWorkspace.directory);
	const peer = await peerOpening;
	await new Workbench(peer).waitForReady();
	await installMainChannelTestClient(peer);
	const root = process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve(import.meta.dirname, '../../../..');
	const fixture = await electron.evaluateHandle(({ BrowserWindow, dialog }, { modulePath, carrierPath, sourceId, rejection }) => {
		const require = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json');
		const { BaseSecretStorageService } = require(modulePath) as typeof import('../../../../src/ash/platform/secrets/common/secrets.js');
		const { ChildProcessJsonlTransport } = require(carrierPath) as typeof import('../../../../src/ash/platform/agentHost/node/childProcessJsonlTransport.js');
		const sendBytes = ChildProcessJsonlTransport.prototype.sendBytes;
		const onData = ChildProcessJsonlTransport.prototype.onData;
		const set = BaseSecretStorageService.prototype.set;
		const show = dialog.showMessageBox;
		const load = BrowserWindow.prototype.loadURL;
		let choose: ((response: number) => void) | undefined;
		const state = {
			rejectedTerminalId: undefined as string | undefined,
			rejectingAttachments: false, attachWrites: 0, rejectedAttachResponses: 0,
			checkpoint: false, prompts: [] as string[][], loadFailures: [] as string[], failNextLoad: false,
			choose(response: number): void { choose!(response); },
			releaseOpenFaults(): void { BaseSecretStorageService.prototype.set = set; BrowserWindow.prototype.loadURL = load; },
			restore(): void { this.releaseOpenFaults(); dialog.showMessageBox = show; ChildProcessJsonlTransport.prototype.sendBytes = sendBytes; ChildProcessJsonlTransport.prototype.onData = onData; },
		};
		// Corrupt only synthetic reconnect credentials in outbound attach requests.
		// The real backend must reject them; all actual response bytes pass unchanged.
		ChildProcessJsonlTransport.prototype.sendBytes = function (bytes): Promise<void> {
			if (!state.rejectingAttachments) return sendBytes.call(this, bytes);
			const text = Buffer.from(bytes).toString('utf8');
			if (!text.endsWith('\n')) throw new Error('Attach fault expected complete JSONL requests');
			let changed = false;
			const lines = text.trimEnd().split('\n').map(line => {
				const request = JSON.parse(line) as { method?: string; params?: { terminalId?: string; reconnectToken?: string; }; };
				if (request.method !== 'terminal/attach') return line;
				if (!request.params?.terminalId) throw new Error('Attach fault expected request parameters');
				state.rejectedTerminalId ??= request.params.terminalId;
				if (rejection === 'first' && request.params.terminalId !== state.rejectedTerminalId) return line;
				request.params.reconnectToken = '0'.repeat(64);
				state.attachWrites++;
				changed = true;
				return JSON.stringify(request);
			});
			return sendBytes.call(this, changed ? Buffer.from(lines.join('\n') + '\n') : bytes);
		};
		ChildProcessJsonlTransport.prototype.onData = function (listener) {
			const decoder = new TextDecoder();
			let pending = '';
			return onData.call(this, bytes => {
				pending += decoder.decode(bytes, { stream: true });
				const lines = pending.split('\n');
				pending = lines.pop()!;
				for (const line of lines) {
					const response = JSON.parse(line) as { error?: { data?: { kind?: string; }; }; };
					if (response.error?.data?.kind === 'TerminalAttachRejected') state.rejectedAttachResponses++;
				}
				listener(bytes);
			});
		};
		BaseSecretStorageService.prototype.set = async function (key, value): Promise<void> {
			await set.call(this, key, value);
			if (key === 'terminal.reload' && !state.checkpoint) { state.checkpoint = true; await new Promise<void>(() => { }); }
		};
		Object.defineProperty(dialog, 'showMessageBox', {
			configurable: true, value: (...args: unknown[]) => {
				const options = args.at(-1) as Electron.MessageBoxOptions;
				if (!options.buttons?.includes('Reopen')) return Reflect.apply(show, dialog, args);
				state.prompts.push([...options.buttons]);
				return new Promise<Electron.MessageBoxReturnValue>(resolve => { choose = response => resolve({ response, checkboxChecked: false }); });
			}
		});
		BrowserWindow.prototype.loadURL = function (...args): Promise<void> {
			if (this.id !== sourceId && state.failNextLoad) {
				state.failNextLoad = false;
				state.loadFailures.push('synthetic replacement load failure');
				return Promise.reject(new Error('synthetic replacement load failure'));
			}
			return load.apply(this, args);
		};
		return state;
	}, { modulePath: join(root, '.build/desktop/main/src/ash/platform/secrets/common/secrets.js'), carrierPath: join(root, '.build/desktop/main/src/ash/platform/agentHost/node/childProcessJsonlTransport.js'), sourceId, rejection });
	try {
		await window.evaluate(window => window.webContents.reload());
		await expect.poll(() => fixture.evaluate(fixture => fixture.checkpoint)).toBe(true);
		expect(await peer.evaluate(async () => (await ashTestMainProcess.call<string[]>('secretStorage', 'keys', [])).includes('terminal.reload'))).toBe(false);
		const peerWindow = await electron.browserWindow(peer);
		await peerWindow.evaluate(window => window.destroy());
		await peerWindow.dispose();
		// The other cases exercise the real timeout. This case isolates partial
		// attachment through the same native recovery action without another timer wait.
		if (rejection === 'first') await window.evaluate(window => window.emit('unresponsive'));
		await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.length), { timeout: 40_000 }).toBe(1);
		await fixture.evaluate(fixture => fixture.choose(2));
		expect(await window.evaluate(window => window.isDestroyed())).toBe(false);
		// The first replacement deliberately fails to load. Source credentials and
		// its lifetime must remain owned by the still usable source window.
		await window.evaluate(window => window.emit('unresponsive'));
		await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.length)).toBe(2);
		await fixture.evaluate(fixture => { fixture.failNextLoad = true; fixture.choose(0); });
		await expect.poll(() => fixture.evaluate(fixture => fixture.loadFailures)).toEqual(['synthetic replacement load failure']);
		await expect.poll(() => electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
		expect(await window.evaluate(window => window.isDestroyed())).toBe(false);
		for (const index of [0, 1]) await expect.poll(() => state(index).then(value => value.count)).toBeGreaterThan(before[index]!.count);
		await window.evaluate(window => window.emit('unresponsive'));
		await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.length)).toBe(3);
		const opening = electron.waitForEvent('window');
		await fixture.evaluate((fixture, reject) => { fixture.releaseOpenFaults(); fixture.rejectingAttachments = reject; fixture.choose(0); }, rejectAttachments);
		let replacement = await opening;
		await expect.poll(() => electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null, sourceId)).toBe(true);
		if (rejectAttachments) {
			await expect.poll(() => fixture.evaluate(fixture => fixture.rejectedAttachResponses)).toBe(rejectedCount);
			expect(await fixture.evaluate(fixture => fixture.attachWrites)).toBeGreaterThanOrEqual(rejectedCount);
			await new Workbench(replacement).waitForReady();
			await installMainChannelTestClient(replacement);
			expect(await replacement.evaluate(async () => (await ashTestMainProcess.call<string[]>('secretStorage', 'keys', [])).includes('terminal.reload'))).toBe(true);
			for (const index of [0, 1]) await expect.poll(() => state(index).then(value => value.count)).toBeGreaterThan(before[index]!.count);
			expect(driver.diagnostics.consoleErrors.some(message => message.includes('Terminal reload recovery failed'))).toBe(true);
			const expectedRuntimeError = '[runtime] Error: Could not restore terminal sessions after reload.';
			await expect.poll(() => driver.diagnostics.consoleErrors.filter(message => message.startsWith(expectedRuntimeError)).length).toBe(1);
			await testInfo.attach('expected-attach-rejection-error', { body: JSON.stringify(driver.diagnostics.consoleErrors.filter(message => message.startsWith(expectedRuntimeError))), contentType: 'application/json' });
			for (let index = driver.diagnostics.consoleErrors.length - 1; index >= 0; index--) {
				if (driver.diagnostics.consoleErrors[index]!.startsWith(expectedRuntimeError)) driver.diagnostics.consoleErrors.splice(index, 1);
			}
			// Consume only the exact deliberate restore error, if the host reports it
			// as a page exception. Unrelated errors remain visible to fixture teardown.
			for (let index = driver.diagnostics.pageErrors.length - 1; index >= 0; index--) {
				if (/^Error: Could not restore terminal sessions after reload\./u.test(driver.diagnostics.pageErrors[index]!)) driver.diagnostics.pageErrors.splice(index, 1);
			}
			const rejectedWindow = await electron.browserWindow(replacement);
			const rejectedId = await rejectedWindow.evaluate(window => window.id);
			await rejectedWindow.evaluate(window => window.emit('unresponsive'));
			await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.length)).toBe(4);
			const retrying = electron.waitForEvent('window');
			await fixture.evaluate(fixture => { fixture.rejectingAttachments = false; fixture.choose(0); });
			replacement = await retrying;
			await expect.poll(() => electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null, rejectedId)).toBe(true);
			await rejectedWindow.dispose();
		}
		const restored = replacement.locator('.ash-terminal-group-pane:visible');
		await expect(restored).toHaveCount(2, { timeout: 15_000 });
		for (const index of [0, 1]) {
			await expect(restored.nth(index).locator('.xterm-rows')).toContainText(`CHECKPOINT_HISTORY_${index}`);
			const current = await state(index);
			expect([current.pid, current.shell]).toEqual([before[index]!.pid, before[index]!.shell]);
			await expect.poll(() => state(index).then(value => value.count)).toBeGreaterThan(current.count);
			const input = restored.nth(index).locator('.xterm-helper-textarea');
			await input.focus();
			await input.pressSequentially(`CONTINUED_${index}`);
			await input.press('Enter');
			await expect(restored.nth(index).locator('.xterm-rows')).toContainText(`RECEIVED:CONTINUED_${index}`);
		}
		const phases = testInfo.outputPath('connection-phases.json');
		await writeFile(phases, JSON.stringify(await electron.evaluate(() => performance.getEntriesByType('mark').filter(entry => entry.name.startsWith('ash.appServer.main.')).map(entry => ({ name: entry.name, at: entry.startTime, detail: (entry as PerformanceMark).detail })))));
		await testInfo.attach('connection-phases', { path: phases, contentType: 'application/json' });
		await testInfo.attach('recovered-terminal-window', { body: await replacement.screenshot(), contentType: 'image/png' });
		const trace = testInfo.outputPath('recovery-trace.zip');
		await replacement.context().tracing.stop({ path: trace });
		await testInfo.attach('recovery-trace', { path: trace, contentType: 'application/zip' });
		const recoveredWindow = await electron.browserWindow(replacement);
		const recoveredId = await recoveredWindow.evaluate(window => window.id);
		await recoveredWindow.evaluate(window => window.emit('unresponsive'));
		await expect.poll(() => fixture.evaluate(fixture => fixture.prompts.length)).toBe(rejectAttachments ? 5 : 4);
		await fixture.evaluate(fixture => fixture.choose(1));
		await expect.poll(() => electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null, recoveredId)).toBe(true);
		for (const entry of before) {
			for (const pid of [entry.pid, entry.shell]) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
		}
		await recoveredWindow.dispose();
		const proof = testInfo.outputPath('process-proof.json');
		await writeFile(proof, JSON.stringify({ before, after: await Promise.all([0, 1].map(state)), sourceId, recoveredId, closeChoice: 'Close', stoppedAfterClose: true, rejectedAttachments: await fixture.evaluate(fixture => fixture.rejectedAttachResponses) }));
		await testInfo.attach('same-processes', { path: proof, contentType: 'application/json' });
	} catch (error) {
		await testInfo.attach('recovery-diagnostics', { body: JSON.stringify({ errors: driver.diagnostics.errors, console: driver.diagnostics.consoleErrors, main: mainErrors }), contentType: 'application/json' });
		throw error;
	} finally {
		electron.process().stderr?.off('data', recordMainError);
		await fixture.evaluate(fixture => fixture.restore()).catch(() => { });
		await fixture.dispose();
		await window.dispose();
	}
});
