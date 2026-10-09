import { release } from 'node:os';
import type { BrowserWindow } from 'electron';
import type { MessageBoxOptions } from '../../../../../../base/parts/sandbox/common/electronTypes.js';
import { DialogMainService } from '../../../../../../platform/dialogs/electron-main/dialogMainService.js';
import { validateNativeDialogOperation, type INativeHostApi } from '../../../../../../platform/native/common/nativeHost.js';
import { NativeDialogHandler } from '../../../../../electron-browser/parts/dialogs/dialogHandler.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import "../../dialog.web.contribution.js";
import {
	type DialogRequest,
	DialogResult,
	DialogSeverity,
	type IDialogHandler,
	type IDialogOutcome,
} from "../../../../../../platform/dialogs/common/dialogs.js";
import { InstantiationService } from "../../../../../../platform/instantiation/common/instantiationService.js";
import {
	IDialogsModel,
	IWorkbenchDialogHandler,
} from "../../../../../../workbench/common/dialogs.js";
import { DialogHandlerContribution } from '../../dialog.web.contribution.js';
import {
	WorkbenchContributionsRegistry,
	WorkbenchPhase,
} from "../../../../../../workbench/common/contributions.js";
import {
	DialogService,
} from "../../../../../../workbench/services/dialogs/common/dialogService.js";

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

test("dialog handler contribution starts at BlockStartup", async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	const services = new InstantiationService();
	services.registerInstance(IDialogsModel, service.model);
	services.registerInstance(IWorkbenchDialogHandler, handler);
	using host = WorkbenchContributionsRegistry.createHost(services);

	host.advance(WorkbenchPhase.BlockStartup);
	const confirmation = service.confirm({ message: "Ready?" });

	assert.equal(handler.calls.length, 1);
	handler.calls[0]?.resolve(DialogResult.Primary);
	assert.equal((await confirmation).confirmed, true);
});

test("dialog handler contribution presents the model queue serially", async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: "Continue?" });
	const message = service.showMessage({
		severity: DialogSeverity.Info,
		message: "Finished",
	});

	assert.equal(service.model.dialogs.length, 2);
	assert.equal(handler.calls.length, 1);
	assert.equal(handler.calls[0]?.request.kind, "confirmation");

	handler.calls[0]?.resolve(DialogResult.Primary);
	assert.equal((await confirmation).confirmed, true);
	assert.equal(handler.calls.length, 2);
	assert.equal(handler.calls[1]?.request.kind, "message");

	handler.calls[1]?.resolve(DialogResult.Primary);
	await message;
	assert.equal(service.model.dialogs.length, 0);
});

test("dialog handler contribution picks up existing model items", async () => {
	using service = new DialogService();
	const confirmation = service.confirm({ message: "Pending" });
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);

	assert.equal(handler.calls.length, 1);
	assert.equal(handler.calls[0]?.request.message, "Pending");
	handler.calls[0]?.resolve(DialogResult.Cancel);
	assert.equal((await confirmation).confirmed, false);
});

test("closing the active model item aborts its handler", async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: "Cancel?" });
	const item = service.model.dialogs[0];
	const call = handler.calls[0];

	item?.cancel();

	assert.equal((await confirmation).confirmed, false);
	assert.equal(call?.signal.aborted, true);
	call?.resolve(DialogResult.Cancel);
});

test("dialog handler contribution continues after a handler failure", async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	using contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const failed = service.showMessage({
		severity: DialogSeverity.Error,
		message: "Failure",
	});
	const next = service.confirm({ message: "Retry?" });

	handler.calls[0]?.reject(new Error("render failed"));
	await assert.rejects(failed, /render failed/);
	assert.equal(handler.calls.length, 2);

	handler.calls[1]?.resolve(DialogResult.Primary);
	assert.equal((await next).confirmed, true);
});

test("disposing the contribution cancels its active model item", async () => {
	using service = new DialogService();
	const handler = new TestDialogHandler();
	const contribution = new DialogHandlerContribution(
		service.model,
		handler,
	);
	const confirmation = service.confirm({ message: "Active" });
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
