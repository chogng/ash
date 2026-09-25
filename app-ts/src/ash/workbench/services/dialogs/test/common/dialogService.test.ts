import assert from "node:assert/strict";
import { test } from "mocha";
import {
	DialogResult,
	DialogSeverity,
} from "../../../../../platform/dialogs/common/dialogs.js";
import {
	DialogService,
} from "../../../../../workbench/services/dialogs/common/dialogService.js";

test("dialog service publishes requests through its owned model", async () => {
	using service = new DialogService();
	const confirmation = service.confirm({
		message: "Continue?",
	});
	const item = service.model.dialogs[0];

	assert.equal(service.model.dialogs.length, 1);
	assert.equal(item?.request.kind, "confirmation");
	item?.close({ button: DialogResult.Primary });

	assert.deepEqual(await confirmation, { confirmed: true, checkboxChecked: undefined });
	assert.equal(service.model.dialogs.length, 0);
});

test("dialog service maps cancellation to a false confirmation", async () => {
	using service = new DialogService();
	const confirmation = service.confirm({
		message: "Delete item?",
		primaryButton: "Delete",
	});

	service.model.dialogs[0]?.cancel();

	assert.deepEqual(await confirmation, { confirmed: false, checkboxChecked: undefined });
});

test('confirmation keeps its checkbox selection', async () => {
	using service = new DialogService();
	const confirmation = service.confirm({ message: 'Remove credentials?', checkbox: { label: 'Remove stored data' } });
	service.model.dialogs[0]?.close({ button: DialogResult.Primary, checkboxChecked: true });
	assert.deepEqual(await confirmation, { confirmed: true, checkboxChecked: true });
});

test("dialog service preserves all three prompt outcomes", async () => {
	using service = new DialogService();
	const prompt = service.prompt({
		message: "Save changes?",
		primaryButton: "Save",
		secondaryButton: "Don't Save",
	});
	const item = service.model.dialogs[0];

	assert.equal(item?.request.kind, "prompt");
	item?.close({ button: DialogResult.Secondary });

	assert.equal(await prompt, DialogResult.Secondary);
});

test("input dialog returns values and checkbox state from the selected action", async () => {
	using service = new DialogService();
	const input = service.input({
		message: "Server address",
		inputs: [{ value: "https://" }],
		checkbox: { label: "Remember server" },
	});
	const item = service.model.dialogs[0];
	assert.equal(item?.request.kind, "input");
	item?.close({ button: DialogResult.Primary, values: ["https://example.test"], checkboxChecked: true });
	assert.deepEqual(await input, {
		confirmed: true,
		values: ["https://example.test"],
		checkboxChecked: true,
	});
});

test("disposing dialog service cancels every queued model request", async () => {
	const service = new DialogService();
	const confirmation = service.confirm({ message: "Active" });
	const message = service.showMessage({
		severity: DialogSeverity.Warning,
		message: "Queued",
	});

	assert.equal(service.model.dialogs.length, 2);
	service.dispose();

	assert.deepEqual(await confirmation, { confirmed: false, checkboxChecked: undefined });
	await message;
	assert.equal(service.model.dialogs.length, 0);
});

test("dialog service propagates model presentation failures", async () => {
	using service = new DialogService();
	const result = service.showMessage({
		severity: DialogSeverity.Error,
		message: "Failure",
	});

	service.model.dialogs[0]?.fail(new Error("render failed"));

	await assert.rejects(result, /render failed/);
	assert.equal(service.model.dialogs.length, 0);
});
