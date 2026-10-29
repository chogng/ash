import { expect, test } from '../../../automation/test.js';
import type { Page } from '@playwright/test';

interface ProgressRequest {
	readonly id: number;
	readonly method: string;
	readonly operationId?: string;
	readonly operation?: string;
	completed: boolean;
}

interface ProgressRequestGate {
	methods: string[];
	readonly requests: ProgressRequest[];
	release(): void;
	restore(): void;
}

declare global {
	var ashTestProgressRequests: ProgressRequestGate;
}

/** Delay real requests at the byte carrier without replacing domain services or their replies. */
async function installRequestGate(page: Page): Promise<void> {
	await page.evaluate(() => {
		const original = MessagePort.prototype.postMessage;
		const held: { port: MessagePort; args: [unknown, (StructuredSerializeOptions | Transferable[])?] }[] = [];
		const receivers: { port: MessagePort; receive: MessagePort['onmessage']; wrapper: MessagePort['onmessage'] }[] =
			[];
		const ports = new WeakMap<
			MessagePort,
			{ requests: Map<number, ProgressRequest>; reads: ProgressRequest[][]; decoder: TextDecoder; text: string }
		>();
		const gate: ProgressRequestGate = (globalThis.ashTestProgressRequests = {
			methods: ['extensions/listInstalled'],
			requests: [],
			release() {
				for (const item of held.splice(0)) {
					Reflect.apply(original, item.port, item.args);
				}
			},
			restore() {
				this.methods = [];
				this.release();
				MessagePort.prototype.postMessage = original;
				for (const item of receivers) {
					if (item.port.onmessage === item.wrapper) {
						item.port.onmessage = item.receive;
					}
				}
			},
		});
		MessagePort.prototype.postMessage = function (
			this: MessagePort,
			...args: [unknown, (StructuredSerializeOptions | Transferable[])?]
		): void {
			const message = args[0] as { data?: Uint8Array; ack?: boolean };
			let state = ports.get(this);
			if (message.ack && state) {
				for (const request of state.reads.shift() ?? []) {
					request.completed = true;
				}
			}
			let frame:
				| { id: number; method: string; params?: { operationId?: string; request?: { operation?: string } } }
				| undefined;
			if (message.data instanceof Uint8Array) {
				try {
					frame = JSON.parse(new TextDecoder().decode(message.data));
				} catch {
					/* Other ports are outside this fixture. */
				}
			}
			if (frame?.method) {
				if (!state) {
					state = { requests: new Map(), reads: [], decoder: new TextDecoder(), text: '' };
					ports.set(this, state);
					const receive = this.onmessage!;
					const connection = state;
					this.onmessage = function (event): void {
						if (event.data?.data instanceof Uint8Array) {
							connection.text += connection.decoder.decode(event.data.data, { stream: true });
							const lines = connection.text.split('\n');
							connection.text = lines.pop()!;
							const completed: ProgressRequest[] = [];
							for (const line of lines) {
								const reply = JSON.parse(line);
								const request = !reply.method && connection.requests.get(reply.id);
								if (request) {
									completed.push(request);
								}
							}
							connection.reads.push(completed);
						}
						receive.call(this, event);
					};
					receivers.push({ port: this, receive, wrapper: this.onmessage });
				}
				const request: ProgressRequest = {
					id: frame.id,
					method: frame.method,
					operationId: frame.params?.operationId,
					operation: frame.params?.request?.operation,
					completed: false,
				};
				gate.requests.push(request);
				state.requests.set(frame.id, request);
				if (gate.methods.includes(frame.method)) {
					held.push({ port: this, args });
					return;
				}
			}
			Reflect.apply(original, this, args);
		};
	});
}

const agentsTest = test.extend({ electronArgs: ['--agents-window'], useDefaultLanguageServer: false });

agentsTest(
	'Agents routes pending view reads and cancellable operations through their progress owners',
	{ tag: ['@electron-app-server'] },
	async ({ workbench, driver }) => {
		const page = workbench.page;
		await expect(page.locator('.ash-sessions-window')).toBeVisible();
		await installRequestGate(page);
		try {
			// This public action is in the Agents palette; its underlying command is not a palette entry.
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			const plugins = page.locator('[data-view-id="ash.extensions.plugins"]');
			await expect
				.poll(() =>
					page.evaluate(() =>
						globalThis.ashTestProgressRequests.requests.some(
							request => request.method === 'extensions/listInstalled',
						),
					),
				)
				.toBe(true);
			await expect(plugins.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
			await expect(plugins.locator('progress')).toBeVisible();
			await expect(page.locator('.ash-notification-message')).toHaveCount(0);

			const header = plugins.locator('.ash-pane-view-header-button');
			await header.press('ArrowLeft');
			await expect(plugins.locator('progress')).toBeHidden();
			await header.press('ArrowRight');
			await expect(plugins.locator('progress')).toBeVisible();
			await page
				.locator('.ash-sessions-activity-content')
				.getByRole('button', { name: 'Chat', exact: true })
				.click();
			await expect(plugins).toBeHidden();
			await expect(page.locator('.ash-view-pane progress:visible')).toHaveCount(0);
			await expect(page.locator('.ash-notification-message')).toHaveCount(0);
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await expect(plugins.locator('progress')).toBeVisible();
			await page.evaluate(() => {
				const gate = globalThis.ashTestProgressRequests;
				gate.methods = [];
				gate.release();
			});
			await expect(plugins.locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
			await expect(plugins.locator('progress')).toBeHidden();
			await workbench.quickaccess.runCommand('notifications.showList');
			await expect(page.locator('.ash-notification-message')).toHaveCount(0);
			await workbench.quickaccess.runCommand('notifications.hideList');

			await page.evaluate(() => {
				globalThis.ashTestProgressRequests.methods = ['session/runtime/invoke'];
			});
			await workbench.quickaccess.runCommand('sessions.newDevContainerSession');
			const notice = page.locator('.ash-notification').filter({ hasText: 'Starting Dev Container...' });
			await expect(notice.locator('progress')).toBeVisible();
			await expect(notice.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
			await expect(page.locator('.ash-view-pane progress:visible')).toHaveCount(0);
			const readRuntimeRequests = () =>
				page.evaluate(() =>
					globalThis.ashTestProgressRequests.requests.filter(request =>
						request.method.startsWith('session/runtime/'),
					),
				);
			await expect
				.poll(readRuntimeRequests)
				.toEqual([
					expect.objectContaining({ method: 'session/runtime/invoke', operation: 'probe', completed: false }),
				]);
			await notice.getByRole('button', { name: 'Cancel', exact: true }).click();
			await expect(notice).toHaveCount(0);
			await expect
				.poll(readRuntimeRequests)
				.toEqual([
					expect.objectContaining({ method: 'session/runtime/invoke', operation: 'probe', completed: false }),
					expect.objectContaining({ method: 'session/runtime/cancel' }),
				]);
			const [invoke, cancel] = await readRuntimeRequests();
			expect(cancel.operationId).toBe(invoke.operationId);
			// Only the read-only probe reaches the real backend, after cancellation. No container is prepared.
			await page.evaluate(() => {
				const gate = globalThis.ashTestProgressRequests;
				gate.methods = [];
				gate.release();
			});
			await expect.poll(async () => (await readRuntimeRequests()).every(request => request.completed)).toBe(true);
			expect(
				(await readRuntimeRequests())
					.filter(request => request.method === 'session/runtime/invoke')
					.map(request => request.operation),
			).toEqual(['probe']);
			await workbench.quickaccess.runCommand('notifications.showList');
			await expect(page.locator('.ash-notification-message')).toHaveCount(0);
			expect(driver.diagnostics.errors).toEqual([]);
		} finally {
			const cancel = page
				.locator('.ash-notification')
				.filter({ hasText: 'Starting Dev Container...' })
				.getByRole('button', { name: 'Cancel', exact: true });
			if (await cancel.isVisible()) {
				await cancel.click();
			}
			await page.evaluate(() => globalThis.ashTestProgressRequests.restore());
		}
	},
);
