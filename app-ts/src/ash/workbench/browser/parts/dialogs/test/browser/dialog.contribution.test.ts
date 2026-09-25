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
import {
	ServiceContainer,
} from "../../../../../../platform/instantiation/common/instantiation.js";
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
	const services = new ServiceContainer();
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
