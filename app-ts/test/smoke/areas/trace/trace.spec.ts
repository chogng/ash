import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { developmentAshPackagePath } from '../../../../../build/runtime/store.ts';
import { expect, test } from '../../../automation/test.js';

test('developer trace viewer validates connection settings and restores focus after keyboard help', async ({ workbench }) => {
	const page = workbench.page;
	await page.keyboard.press('ControlOrMeta+Shift+P');
	await page.getByPlaceholder('Type the name of a command to run').fill('Developer: Open trace viewer');
	await page.keyboard.press('Enter');
	const viewer = page.locator('.ash-trace');
	await expect(viewer).toBeVisible();
	await viewer.getByLabel('Trace token', { exact: true }).fill('invalid');
	await viewer.getByRole('button', { name: 'Connect', exact: true }).click();
	await expect(viewer.getByRole('status')).toContainText('64-digit hexadecimal token');
	await expect(viewer.getByRole('button', { name: 'Export filtered OTLP' })).toBeDisabled();
	const filter = viewer.getByLabel('Filter by name, outcome or trace ID', { exact: true });
	await filter.focus();
	await page.keyboard.press('Alt+F1');
	await expect(page.getByRole('dialog', { name: 'Trace viewer help' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(filter).toBeFocused();
	await page.getByRole('button', { name: 'Close Trace viewer', exact: true }).click();
	await expect(viewer).toHaveCount(0);
});

test('developer trace viewer connects to App Server, filters, exports and releases its connection', async ({ target, application, workbench }) => {
	test.skip(target.appServerMode !== 'required', 'Live capture requires the built product package.');
	const profile = await mkdtemp(join(tmpdir(), 'ash-trace-'));
	const token = randomBytes(32).toString('hex');
	const root = resolve(import.meta.dirname, '../../../../..');
	const packageRoot = developmentAshPackagePath(root, target.kind === 'browser' ? 'packaged-node' : 'host-provided-node');
	const environment: NodeJS.ProcessEnv = { ...process.env, ASH_HOME: profile, ASH_TRACE_WEBSOCKET_ADDR: '127.0.0.1:0', ASH_TRACE_WEBSOCKET_TOKEN: token };
	delete environment.ASH_WORKSPACE_ROOT;
	const child = spawn(join(packageRoot, 'bin', process.platform === 'win32' ? 'ash-app-server.exe' : 'ash-app-server'), ['--listen', 'stdio://'], {
		cwd: root, windowsHide: true,
		env: environment,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const errors = createInterface({ input: child.stderr });
	let stderr = '';
	errors.on('line', line => { stderr = (stderr + line + '\n').slice(-8192); });
	const responses = createInterface({ input: child.stdout });
	let requestId = 0;
	const call = (method: string, params: unknown): Promise<unknown> => new Promise((resolveResponse, reject) => {
		const id = ++requestId;
		const timer = setTimeout(() => { responses.off('line', onLine); reject(new Error('Trace fixture RPC timed out')); }, 10_000);
		const onLine = (line: string): void => {
			const value = JSON.parse(line);
			if (value.id === id) { clearTimeout(timer); responses.off('line', onLine); resolveResponse(value); }
		};
		responses.on('line', onLine);
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	});
	try {
		const address = await new Promise<string>((resolveAddress, reject) => {
			const timer = setTimeout(() => { errors.off('line', onLine); reject(new Error('Trace listener did not start')); }, 15_000);
			const onLine = (line: string): void => {
				const match = /^Ash trace WebSocket: (ws:\/\/[^ ]+)$/.exec(line);
				if (match) { clearTimeout(timer); errors.off('line', onLine); resolveAddress(match[1]!); }
			};
			errors.on('line', onLine);
			child.once('error', error => { clearTimeout(timer); reject(error); });
			child.once('exit', code => { clearTimeout(timer); reject(new Error('Trace server exited: ' + code + '\n' + stderr)); });
		});
		await call('initialize', { clientInfo: { name: 'trace-playwright', version: '1' }, capabilities: {} });
		const page = workbench.page;
		await page.keyboard.press('ControlOrMeta+Shift+P');
		await page.getByPlaceholder('Type the name of a command to run').fill('Developer: Open trace viewer');
		await page.keyboard.press('Enter');
		const viewer = page.locator('.ash-trace');
		await expect(viewer).toBeVisible();
		await viewer.getByLabel('Trace address', { exact: true }).fill(address);
		await viewer.getByLabel('Trace token', { exact: true }).fill('0'.repeat(64));
		await viewer.getByRole('button', { name: 'Connect', exact: true }).click();
		await expect(viewer.getByRole('status')).toContainText('Connection failed');
		await viewer.getByLabel('Trace token', { exact: true }).fill(token);
		await viewer.getByRole('button', { name: 'Connect', exact: true }).click();
		await expect(viewer.getByRole('status')).toContainText('Connected');
		await call('diagnostics/read', {});
		await call('trace/nonexistent', { prompt: 'private-content', authorization: 'private-key' });
		await expect(viewer.getByRole('option')).toHaveCount(2);
		const timeline = viewer.getByRole('listbox', { name: 'Trace timeline' });
		await timeline.focus();
		await page.keyboard.press('End');
		await expect(viewer.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
		await expect(viewer.getByRole('region', { name: 'Span details' })).toContainText('failed');
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Trace viewer help' });
		await expect(help).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(timeline).toBeFocused();
		await viewer.getByLabel('Filter by name, outcome or trace ID', { exact: true }).fill('failed');
		await expect(viewer.getByRole('option')).toHaveCount(1);
		let exportedPath: string;
		if ('windows' in application) {
			exportedPath = join(profile, 'exported-traces.json');
			await application.evaluate(({ BrowserWindow }, path) => {
				const state = globalThis as typeof globalThis & { traceDownloadState?: string };
				state.traceDownloadState = 'pending';
				BrowserWindow.getAllWindows()[0]!.webContents.session.once('will-download', (_event, item) => {
					item.setSavePath(path);
					item.once('done', (_event, result) => { state.traceDownloadState = result; });
				});
			}, exportedPath);
			await viewer.getByRole('button', { name: 'Export filtered OTLP' }).click();
			await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { traceDownloadState?: string }).traceDownloadState)).toBe('completed');
		} else {
			const downloadPromise = page.waitForEvent('download');
			await viewer.getByRole('button', { name: 'Export filtered OTLP' }).click();
			exportedPath = (await (await downloadPromise).path())!;
		}
		const text = await readFile(exportedPath, 'utf8');
		const exported = JSON.parse(text);
		expect(exported.resourceSpans).toHaveLength(1);
		expect(exported.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('rpc');
		expect(exported.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
		for (const secret of [token, 'private-content', 'private-key']) { expect(text).not.toContain(secret); }
		await viewer.getByRole('button', { name: 'Disconnect', exact: true }).click();
		await expect(viewer.getByRole('status')).toHaveText('Disconnected');
		await expect(viewer.getByRole('option')).toHaveCount(1);
		await viewer.getByRole('button', { name: 'Clear', exact: true }).click();
		await expect(viewer.getByRole('option')).toHaveCount(0);
		await expect(viewer.getByRole('button', { name: 'Export filtered OTLP' })).toBeDisabled();
		await viewer.getByLabel('Filter by name, outcome or trace ID', { exact: true }).fill('');
		const socketEvent = page.waitForEvent('websocket', socket => socket.url() === address);
		await viewer.getByRole('button', { name: 'Connect', exact: true }).click();
		const socket = await socketEvent;
		await expect(viewer.getByRole('status')).toContainText('Connected');
		const closed = socket.waitForEvent('close');
		await timeline.focus();
		await page.keyboard.press('ControlOrMeta+w');
		await expect(viewer).toHaveCount(0);
		await closed;
	} finally {
		errors.close();
		responses.close();
		if (child.exitCode === null) {
			const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
			child.kill();
			await exited;
		}
		await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
