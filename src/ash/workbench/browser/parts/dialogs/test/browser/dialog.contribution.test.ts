import { expect } from '@playwright/test';
import { useBrowserTests } from '../../../../../../../../test/unit/browser/context.js';
import { release } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { MessageBoxOptions } from '../../../../../../base/parts/sandbox/common/electronTypes.js';
import { DialogMainService } from '../../../../../../platform/dialogs/electron-main/dialogMainService.js';
import { validateNativeDialogOperation, type INativeHostApi } from '../../../../../../platform/native/common/nativeHost.js';
import { NativeDialogHandler } from '../../../../../electron-browser/parts/dialogs/dialogHandler.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import '../../dialog.web.contribution.js';
import {
	type DialogRequest,
	DialogResult,
	DialogSeverity,
	type IDialogHandler,
	type IDialogOutcome,
} from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import {
	IDialogsModel,
	IWorkbenchDialogHandler,
} from '../../../../../../workbench/common/dialogs.js';
import { DialogHandlerContribution } from '../../dialog.web.contribution.js';
import {
	WorkbenchContributionsRegistry,
	WorkbenchPhase,
} from '../../../../../../workbench/common/contributions.js';
import {
	DialogService,
} from '../../../../../../workbench/services/dialogs/common/dialogService.js';

class TestDialogHandler implements IDialogHandler {
	readonly calls: Array<{
		readonly request: DialogRequest;
		readonly signal: AbortSignal;
		readonly resolve: (result: DialogResult) => void;
		readonly reject: (error: unknown) => void;
	}> = [];

	showDialog(
		request: DialogRequest,
		signal: AbortSignal,
	): Promise<IDialogOutcome> {
		return new Promise((resolve, reject) => {
			this.calls.push({ request, signal, resolve: result => resolve({ button: result }), reject });
		});
	}
}

test('dialog handler contribution starts at BlockStartup', async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	const services = new InstantiationService();
	services.registerInstance(IDialogsModel, service.model);
	services.registerInstance(IWorkbenchDialogHandler, handler);
	using host = WorkbenchContributionsRegistry.createHost(services);

	host.advance(WorkbenchPhase.BlockStartup);
	const confirmation = service.confirm({ message: 'Ready?' });

	assert.equal(handler.calls.length, 1);
	handler.calls[0]?.resolve(DialogResult.Primary);
	assert.equal((await confirmation).confirmed, true);
});

test('dialog handler contribution presents the model queue serially', async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: 'Continue?' });
	const message = service.showMessage({
		severity: DialogSeverity.Info,
		message: 'Finished',
	});

	assert.equal(service.model.dialogs.length, 2);
	assert.equal(handler.calls.length, 1);
	assert.equal(handler.calls[0]?.request.kind, 'confirmation');

	handler.calls[0]?.resolve(DialogResult.Primary);
	assert.equal((await confirmation).confirmed, true);
	assert.equal(handler.calls.length, 2);
	assert.equal(handler.calls[1]?.request.kind, 'message');

	handler.calls[1]?.resolve(DialogResult.Primary);
	await message;
	assert.equal(service.model.dialogs.length, 0);
});

test('dialog handler contribution picks up existing model items', async () => {
	using service = new DialogService();
	const confirmation = service.confirm({ message: 'Pending' });
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);

	assert.equal(handler.calls.length, 1);
	assert.equal(handler.calls[0]?.request.message, 'Pending');
	handler.calls[0]?.resolve(DialogResult.Cancel);
	assert.equal((await confirmation).confirmed, false);
});

test('closing the active model item aborts its handler', async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: 'Cancel?' });
	const item = service.model.dialogs[0];
	const call = handler.calls[0];

	item?.cancel();

	assert.equal((await confirmation).confirmed, false);
	assert.equal(call?.signal.aborted, true);
	call?.resolve(DialogResult.Cancel);
});

test('dialog handler contribution continues after a handler failure', async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const failed = service.showMessage({
		severity: DialogSeverity.Error,
		message: 'Failure',
	});
	const next = service.confirm({ message: 'Retry?' });

	handler.calls[0]?.reject(new Error('render failed'));
	await assert.rejects(failed, /render failed/);
	assert.equal(handler.calls.length, 2);

	handler.calls[1]?.resolve(DialogResult.Primary);
	assert.equal((await next).confirmed, true);
});

test('disposing the contribution cancels its active model item', async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	const contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: 'Active' });
	const call = handler.calls[0];

	contribution.dispose();

	assert.equal(call?.signal.aborted, true);
	assert.equal((await confirmation).confirmed, false);
	call?.resolve(DialogResult.Cancel);
});

function desktopHandler(dialogs: DialogMainService, id: number): NativeDialogHandler {
	let sequence = 0;
	return new NativeDialogHandler({
		async showMessageBox({ signal, ...options }) {
			const operation = validateNativeDialogOperation(structuredClone({ kind: 'show', id: ++sequence, options }));
			const result = await dialogs.perform({ id } as BrowserWindow, operation);
			assert.ok(result);
			return result;
		},
	} as INativeHostApi, {} as HTMLElement);
}

test('desktop dialog handler maps message, confirmation, and prompt results', async () => {
	const options: MessageBoxOptions[] = [];
	const selections = ['OK', 'Cancel', 'Discard', 'Cancel'];
	using dialogs = new DialogMainService({
		showMessageBox: async value => {
			options.push(value);
			const response = value.buttons!.indexOf(selections.shift()!);
			assert.notEqual(response, -1);
			return { response, checkboxChecked: true };
		},
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
	});
	const handler = desktopHandler(dialogs, 1);
	const message = await handler.showDialog({ kind: 'message', severity: DialogSeverity.Info, message: 'Notice' }, new AbortController().signal);
	const confirmation = await handler.showDialog({ kind: 'confirmation', message: 'Continue?' }, new AbortController().signal);
	const prompt = await handler.showDialog({ kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' }, new AbortController().signal);
	const cancelledPrompt = await handler.showDialog({ kind: 'prompt', message: 'Save?', primaryButton: 'Save', secondaryButton: 'Discard' }, new AbortController().signal);
	let expectedButtons = [['OK'], ['Confirm', 'Cancel'], ['Save', 'Discard', 'Cancel'], ['Save', 'Discard', 'Cancel']];
	if (process.platform === 'linux') {
		expectedButtons = [['OK'], ['Cancel', 'Confirm'], ['Discard', 'Cancel', 'Save'], ['Discard', 'Cancel', 'Save']];
	} else if (process.platform === 'darwin' && Number.parseInt(release(), 10) < 24) {
		expectedButtons = [['OK'], ['Confirm', 'Cancel'], ['Save', 'Cancel', 'Discard'], ['Save', 'Cancel', 'Discard']];
	}
	assert.deepEqual({ message, confirmation, prompt, cancelledPrompt, buttons: options.map(value => value.buttons) }, {
		message: { button: DialogResult.Primary, checkboxChecked: true },
		confirmation: { button: DialogResult.Cancel, checkboxChecked: true },
		prompt: { button: DialogResult.Secondary, checkboxChecked: true },
		cancelledPrompt: { button: DialogResult.Cancel, checkboxChecked: true },
		buttons: expectedButtons,
	});
});

test('desktop dialog handler returns the selected action index and checkbox state', async () => {
	let shown: MessageBoxOptions | undefined;
	using dialogs = new DialogMainService({
		showMessageBox: async options => {
			shown = options;
			const response = options.buttons!.indexOf('Third');
			assert.notEqual(response, -1);
			return { response, checkboxChecked: true };
		},
		showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
		showSaveDialog: async () => ({ canceled: true, filePath: '' }),
	});
	const request = { kind: 'choice' as const, severity: DialogSeverity.Warning, message: 'Choose action', buttons: ['First', 'Second', 'Third'], cancelButton: 'Cancel' };
	const result = await desktopHandler(dialogs, 11).showDialog(request, new AbortController().signal);
	let expectedButtons = ['First', 'Second', 'Third', 'Cancel'];
	if (process.platform === 'linux') {
		expectedButtons = ['Third', 'Second', 'Cancel', 'First'];
	} else if (process.platform === 'darwin' && Number.parseInt(release(), 10) < 24) {
		expectedButtons = ['First', 'Cancel', 'Second', 'Third'];
	}
	assert.deepEqual(shown?.buttons, expectedButtons);
	assert.equal(shown?.type, 'warning');
	assert.deepEqual(result, { button: DialogResult.Primary, buttonIndex: 2, checkboxChecked: true });
});

suite('dialog browser component', () => {
	const browserTests = useBrowserTests();
	test('base Dialog returns logical button indices, typed values and checkbox state', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('standard'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		await expect(dialog).toHaveClass(/base-dialog-contract/);
		await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeFocused();
		const gap = await dialog.evaluate(element => element.querySelector('.ash-checkbox')!.getBoundingClientRect().top - element.querySelector('.ash-dialog-inputs')!.getBoundingClientRect().bottom);
		expect(gap).toBe(8);
		await dialog.getByRole('textbox', { name: 'Name' }).fill('Ada');
		await dialog.getByPlaceholder('Secret').fill('token');
		await dialog.getByRole('checkbox', { name: 'Remember values' }).check();
		await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult)).toEqual({ button: 2, checkboxChecked: true, values: ['Ada', 'token'] });
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.visibility)).toEqual([true, false]);
	});

	test('base Dialog updates its accessible message and uses cancelId for Escape and close', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		for (const close of ['Escape', 'button', 'keyboard']) {
			await page.evaluate(() => window.ashDialogIntegration.showCore('standard'));
			await page.evaluate(() => window.ashDialogIntegration.updateCoreMessage('Updated message'));
			const dialog = page.getByRole('dialog', { name: 'Updated message' });
			await expect(dialog.locator('.ash-dialog-title')).toHaveText('Updated message');
			const toolbar = dialog.getByRole('toolbar', { name: 'Close Dialog' });
			await expect(toolbar).toHaveClass(/ash-action-bar/);
			await expect(toolbar.locator('[data-action-id="dialog.close"]')).toHaveCount(1);
			const closeButton = toolbar.getByRole('button', { name: 'Close Dialog' });
			await expect(closeButton).toHaveText('');
			const geometry = await closeButton.evaluate(button => {
				const bounds = button.getBoundingClientRect();
				const icon = button.querySelector('.ash-icon')!.getBoundingClientRect();
				return {
					width: bounds.width, height: bounds.height, iconWidth: icon.width,
					centerX: bounds.x + bounds.width / 2 - icon.x - icon.width / 2,
					centerY: bounds.y + bounds.height / 2 - icon.y - icon.height / 2,
				};
			});
			expect(geometry).toEqual({ width: 28, height: 28, iconWidth: 16, centerX: 0, centerY: 0 });
			if (close === 'Escape') await page.keyboard.press('Escape');
			else if (close === 'button') await closeButton.click();
			else {
				await closeButton.focus();
				await closeButton.press('ArrowLeft');
				await expect(closeButton).toBeFocused();
				await expect(closeButton).not.toHaveCSS('outline-style', 'none');
				await closeButton.press('Enter');
			}
			await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult?.button)).toBe(1);
			await expect(dialog).toHaveCount(0);
		}
	});

	test('base Dialog dismisses on the first Escape from a populated native search field', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('search'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		const search = dialog.getByRole('searchbox', { name: 'Search' });
		await expect(search).toBeFocused();
		await search.fill('A query');
		await search.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult?.button)).toBe(1);
	});

	test('base Dialog navigates buttons in visual order while preserving logical result indices', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('custom'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		const keep = dialog.getByRole('button', { name: 'Keep', exact: true });
		const discard = dialog.getByRole('button', { name: 'Discard', exact: true });
		await keep.focus();
		await page.keyboard.press('ArrowRight');
		await expect(discard).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(keep).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(discard).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult?.button)).toBe(2);
	});

	test('base Dialog stacks vertical actions without changing their result indices', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('vertical'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		const keep = dialog.getByRole('button', { name: 'Keep', exact: true });
		const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
		const discard = dialog.getByRole('button', { name: 'Discard', exact: true });
		const bounds = await Promise.all([keep, cancel, discard].map(button => button.boundingBox()));
		expect(bounds[0]!.y + bounds[0]!.height).toBeLessThan(bounds[1]!.y);
		expect(bounds[1]!.y + bounds[1]!.height).toBeLessThan(bounds[2]!.y);
		await discard.click();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult?.button)).toBe(2);
	});

	test('base Dialog excludes disabled actions from keyboard navigation', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('buttons'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		await expect(dialog.getByRole('button', { name: 'Keep', exact: true })).toBeDisabled();
		await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
	});

	test('base Dialog leaves multiline editing and horizontal cursor keys to custom controls', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('custom'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		const textarea = dialog.getByRole('textbox', { name: 'Custom text' });
		await textarea.fill('Line');
		await textarea.press('Enter');
		await expect(textarea).toHaveValue('Line\n');
		for (const control of [textarea, dialog.locator('[contenteditable]')]) {
			const result = await control.evaluate(element => {
				(element as HTMLElement).focus();
				const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
				element.dispatchEvent(event);
				return { focused: element.ownerDocument.activeElement === element, prevented: event.defaultPrevented };
			});
			expect(result).toEqual({ focused: true, prevented: false });
		}
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
	});

	test('base Dialog honors disabled dismissal and prefers pre-rendered detail', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('blocked'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		await page.keyboard.press('Escape');
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Close Dialog' })).toHaveCount(0);
		await dialog.getByRole('textbox', { name: 'Custom text' }).press('Enter');
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Complete', exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await page.evaluate(() => window.ashDialogIntegration.showCore('detail'));
		await expect(dialog.locator('.ash-dialog-detail')).toHaveText('Details link');
		await expect(dialog.locator('a')).toHaveAttribute('tabindex', '0');
		await expect(dialog.locator('a')).toHaveCSS('color', 'rgb(4, 5, 6)');
		await page.keyboard.press('Escape');
	});

	test('base Dialog supplies the standard OK action when buttons are omitted', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('default'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		await expect(dialog.getByRole('button', { name: 'OK', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastCoreResult)).toEqual({ button: 0 });
	});

	test('base Dialog focuses a footer-only action without applying link styles to its button', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCore('footer'));
		const dialog = page.getByRole('dialog', { name: 'Core dialog' });
		const done = dialog.getByRole('button', { name: 'Done' });
		await expect(done).toBeFocused();
		await expect(done).toHaveCSS('color', 'rgb(1, 2, 3)');
		await expect(done).toHaveCSS('text-decoration-line', 'none');
		await expect(dialog.locator('a')).toHaveCSS('color', 'rgb(4, 5, 6)');
		await done.click();
		await expect(dialog).toHaveCount(0);
	});

	test('a short dialog detail stays keyboard-accessible while it scrolls', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 800, height: 300 });
		await page.goto('/dialog.html');
		const text = Array.from({ length: 26 }, (_, index) => `Line ${index + 1}`).join('\n');
		expect(text.length).toBeLessThan(1_025);
		await page.evaluate(detail => window.ashDialogIntegration.show(detail), text);

		const detail = page.locator('.ash-dialog-detail');
		await expect(detail).toBeVisible();
		await expect(detail).toHaveAttribute('tabindex', '0');
		expect(await detail.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
		const confirm = page.getByRole('button', { name: 'Confirm' });
		await expect(confirm).toBeFocused();
		await confirm.focus();
		await page.keyboard.press('Shift+Tab');
		await expect(detail).toBeFocused();
		expect(await detail.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
		await page.keyboard.press('PageDown');
		await expect.poll(() => detail.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

		await page.setViewportSize({ width: 800, height: 1_200 });
		await expect.poll(() => detail.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
		await expect(detail).not.toHaveAttribute('tabindex');
		await confirm.focus();
		await page.keyboard.press('Shift+Tab');
		await expect(detail).not.toBeFocused();
		await page.getByRole('button', { name: 'Cancel' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
	});

	test('dialog buttons and Escape return their result and restore focus', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => {
			const trigger = document.createElement('button');
			trigger.id = 'dialog-trigger';
			trigger.textContent = 'Open dialog';
			document.body.append(trigger);
			trigger.focus();
			window.ashDialogIntegration.showPrompt();
		});

		const dialog = page.getByRole('dialog', { name: 'Save changes' });
		await expect(dialog).toBeVisible();
		// The fixture imports components only: their owners must bring their own styles.
		await expect(dialog).toHaveCSS('width', '440px');
		await expect(dialog).toHaveCSS('padding', '0px');
		await expect(dialog.locator('.ash-dialog-actions')).toHaveCSS('display', 'flex');
		await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCSS('display', 'flex');
		await expect(dialog.getByRole('button', { name: 'Save' }).locator('.ash-icon-label')).toHaveCSS('display', 'flex');
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button', { name: 'Close Dialog' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
		await dialog.getByRole('button', { name: 'Discard' }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#dialog-trigger')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('secondary');

		await page.evaluate(() => window.ashDialogIntegration.showPrompt());
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#dialog-trigger')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('cancel');
	});

	test('action prompt returns the selected button index and checkbox state', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showChoice());
		const dialog = page.getByRole('dialog', { name: 'Choose action' });
		await expect(dialog).toHaveAttribute('data-dialog-severity', 'warning');
		await dialog.getByRole('checkbox', { name: 'Remember choice' }).check();
		await dialog.getByRole('button', { name: 'Third' }).click();
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
			button: 'primary', buttonIndex: 2, checkboxChecked: true, values: undefined,
		});
	});

	test('aborting a dialog settles it as cancelled and removes its modal', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.show('Details'));
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.evaluate(() => window.ashDialogIntegration.abort());
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('cancel');
	});

	test('retiring a workspace connection removes its permission modal and allows the next prompt', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => {
			const trigger = document.createElement('button');
			trigger.id = 'directory-trigger';
			trigger.textContent = 'Connect host';
			document.body.append(trigger);
			trigger.focus();
			return window.ashDialogIntegration.showDirectoryPermission();
		});
		const dialog = page.getByRole('dialog', { name: 'Directory permissions' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Read only', exact: true })).toBeFocused();
		await page.evaluate(() => window.ashDialogIntegration.cancelDirectoryPermission());
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#directory-trigger')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastDirectoryResult)).toBe('cancelled');
		expect(await page.evaluate(() => window.ashDialogIntegration.directoryWrites)).toBe(0);
		await page.evaluate(() => window.ashDialogIntegration.showDirectoryPermission());
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: 'Read only', exact: true }).press('Enter');
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#directory-trigger')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastDirectoryResult)).toBe('ready');
		expect(await page.evaluate(() => window.ashDialogIntegration.directoryWrites)).toBe(2);
	});

	test('permission setup cancelled before prompt metadata arrives does not replace a newer modal', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(async () => {
			window.ashDialogIntegration.holdDirectoryPrompt();
			await window.ashDialogIntegration.showDirectoryPermission();
			window.ashDialogIntegration.cancelDirectoryPermission();
		});
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastDirectoryResult)).toBe('cancelled');
		await page.evaluate(() => window.ashDialogIntegration.showDirectoryPermission());
		const dialog = page.getByRole('dialog', { name: 'Directory permissions' });
		await expect(dialog).toBeVisible();
		await page.evaluate(() => window.ashDialogIntegration.releaseDirectoryPrompt());
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await dialog.getByRole('button', { name: 'Read only', exact: true }).press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastDirectoryResult)).toBe('ready');
		expect(await page.evaluate(() => window.ashDialogIntegration.directoryWrites)).toBe(2);
	});

	test('disposing a dialog without buttons resolves it and restores focus', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => {
			const trigger = document.createElement('button');
			trigger.id = 'dialog-trigger';
			document.body.append(trigger);
			trigger.focus();
			window.ashDialogIntegration.showBare();
		});
		const dialog = page.getByRole('dialog', { name: 'Plain dialog' });
		await expect(dialog).toBeFocused();
		await page.evaluate(() => window.ashDialogIntegration.disposeBare());
		await expect(dialog).toHaveCount(0);
		await expect(page.locator('#dialog-trigger')).toBeFocused();
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastResult)).toBe('0');
	});

	test('input dialog returns typed values and checkbox state', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showInput());
		const dialog = page.getByRole('dialog', { name: 'Connect' });
		const input = dialog.getByRole('textbox', { name: 'Server address' });
		await expect(input).toBeFocused();
		expect(await input.evaluate(element => {
			const input = element as HTMLInputElement;
			return [input.selectionStart, input.selectionEnd];
		})).toEqual([0, 'https://'.length]);
		await input.pressSequentially('https://example.test');
		await dialog.getByRole('checkbox', { name: 'Remember server' }).check();
		await input.press('Enter');
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
			button: 'primary',
			checkboxChecked: true,
			values: ['https://example.test'],
		});
	});

	test('confirmation returns the checkbox state after the primary action', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCheckboxConfirmation());
		const dialog = page.getByRole('dialog', { name: 'Remove server' });
		await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeFocused();
		await dialog.getByRole('checkbox', { name: 'Also remove credentials' }).check();
		await dialog.getByRole('button', { name: 'Confirm' }).click();
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
			button: 'primary', checkboxChecked: true, values: undefined,
		});
	});

	test('modified Enter and IME composition do not accept an input dialog', async function () {
		const { page } = browserTests;
		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showInput());
		const dialog = page.getByRole('dialog', { name: 'Connect' });
		const input = dialog.getByRole('textbox', { name: 'Server address' });
		for (const key of ['Shift+Enter', 'Control+Enter', 'Meta+Enter', 'Alt+Enter']) {
			await input.press(key);
			await expect(dialog).toBeVisible();
		}
		const composing = await input.evaluate(element => {
			const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
			element.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(composing).toBe(false);
		await expect(dialog).toBeVisible();
		await input.press('Enter');
		await expect(dialog).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
			button: 'primary', checkboxChecked: false, values: ['https://'],
		});
	});

	for (const platform of [
		{ name: 'macOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', secondaryShortcut: true },
		{ name: 'Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', secondaryShortcut: false },
		{ name: 'Linux', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', secondaryShortcut: false },
	]) {
		suite(platform.name, () => {
			browserTests.use({ userAgent: platform.userAgent });

			test('Command+D chooses the secondary action only on macOS', async function () {
				const { page } = browserTests;
				await page.goto('/dialog.html');
				await page.evaluate(() => window.ashDialogIntegration.showChoice());
				const dialog = page.getByRole('dialog', { name: 'Choose action' });
				await dialog.getByRole('checkbox', { name: 'Remember choice' }).check();
				await page.keyboard.press('Meta+d');
				if (platform.secondaryShortcut) {
					await expect(dialog).toHaveCount(0);
					await expect.poll(() => page.evaluate(() => window.ashDialogIntegration.lastOutcome)).toEqual({
						button: 'primary', buttonIndex: 1, checkboxChecked: true, values: undefined,
					});
				} else {
					await expect(dialog).toBeVisible();
					await page.keyboard.press('Escape');
					await expect(dialog).toHaveCount(0);
				}
			});

			if (platform.secondaryShortcut) {
				test('Command+D respects disabled and cancel actions and extra modifiers', async function () {
					const { page } = browserTests;
					await page.goto('/dialog.html');
					await page.evaluate(() => window.ashDialogIntegration.showPrompt());
					const prompt = page.getByRole('dialog', { name: 'Save changes' });
					for (const key of ['Meta+Shift+d', 'Meta+Alt+d', 'Meta+Control+d']) {
						await page.keyboard.press(key);
						await expect(prompt).toBeVisible();
					}
					await prompt.getByRole('button', { name: 'Discard' }).evaluate(element => { (element as HTMLButtonElement).disabled = true; });
					await page.keyboard.press('Meta+d');
					await expect(prompt).toBeVisible();
					await page.keyboard.press('Escape');
					await expect(prompt).toHaveCount(0);

					await page.evaluate(() => window.ashDialogIntegration.showCore('custom'));
					const core = page.getByRole('dialog', { name: 'Core dialog' });
					await expect(core.getByRole('textbox', { name: 'Custom text' })).toBeFocused();
					await page.keyboard.press('Meta+d');
					await expect(core).toBeVisible();
					await page.keyboard.press('Escape');
					await expect(core).toHaveCount(0);
				});
			}
		});
	}

	test('a failed Command Palette action opens an error dialog', async function () {
		const { page } = browserTests;

		await page.goto('/dialog.html');
		await page.evaluate(() => window.ashDialogIntegration.showCommandFailure());
		const dialog = page.getByRole('dialog', { name: 'Error' });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('.ash-dialog-message')).toHaveText("Command 'Failing command' resulted in an error");
		await expect(dialog.locator('.ash-dialog-detail')).toHaveText('The command could not finish.');
		await expect(dialog.getByRole('button', { name: 'OK' })).toBeFocused();
		await dialog.getByRole('button', { name: 'OK' }).click();
		await expect(dialog).toHaveCount(0);
	});
});
