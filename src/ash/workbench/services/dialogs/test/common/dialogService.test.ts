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

test('dialog service emits lifecycle events for completion and failure', async () => {
	using service = new DialogService();
	const events: string[] = [];
	using willShow = service.onWillShowDialog(() => events.push('will'));
	using didShow = service.onDidShowDialog(() => events.push('did'));
	const first = service.confirm({ message: 'Continue?' });
	assert.deepEqual(events, ['will']);
	service.model.dialogs[0]?.close({ button: DialogResult.Primary });
	await first;
	const second = service.confirm({ message: 'Continue?' });
	service.model.dialogs[0]?.fail(new Error('failed'));
	await assert.rejects(second, /failed/);
	assert.deepEqual(events, ['will', 'did', 'will', 'did']);
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

test('action prompt maps a secondary choice to its callback', async () => {
	using service = new DialogService();
	const prompt = service.prompt({
		message: "Save changes?",
		buttons: [
			{ label: 'Save', run: () => 'save' },
			{ label: "Don't Save", run: () => 'discard' },
		],
	});
	const item = service.model.dialogs[0];

	assert.equal(item?.request.kind, 'choice');
	item?.close({ button: DialogResult.Primary, buttonIndex: 1 });

	assert.deepEqual(await prompt, { result: 'discard', checkboxChecked: undefined });
});

test('action prompt executes only the chosen button with its checkbox result', async () => {
	using service = new DialogService();
	const calls: string[] = [];
	const prompt = service.prompt({
		message: 'Choose action',
		checkbox: { label: 'Remember choice' },
		buttons: [
			{ label: 'First', run: () => { calls.push('first'); return 'first'; } },
			{ label: 'Second', run: ({ checkboxChecked }) => { calls.push(`second:${checkboxChecked}`); return 'second'; } },
		],
	});
	assert.deepEqual(service.model.dialogs[0]?.request, {
		kind: 'choice', message: 'Choose action', title: 'Confirm', detail: undefined,
		severity: undefined,
		checkbox: { label: 'Remember choice' }, buttons: ['First', 'Second'], cancelButton: 'Cancel',
	});
	service.model.dialogs[0]?.close({ button: DialogResult.Primary, buttonIndex: 1, checkboxChecked: true });
	assert.deepEqual(await prompt, { result: 'second', checkboxChecked: true });
	assert.deepEqual(calls, ['second:true']);
});

test('action prompt runs a custom cancel callback and leaves a plain cancel empty', async () => {
	using service = new DialogService();
	const custom = service.prompt({
		message: 'Choose action', buttons: [{ label: 'Apply', run: () => 'apply' }],
		cancelButton: { label: 'Skip', run: () => 'skip' },
	});
	service.model.dialogs[0]?.cancel();
	assert.deepEqual(await custom, { result: 'skip', checkboxChecked: undefined });
	const plain = service.prompt({ message: 'Choose action', buttons: [{ label: 'Apply', run: () => 'apply' }] });
	service.model.dialogs[0]?.cancel();
	assert.deepEqual(await plain, { result: undefined, checkboxChecked: undefined });
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

test("info, warn, and error use the dialog queue with their severity", async () => {
	using service = new DialogService();
	const results = [
		service.info("Information", "First detail"),
		service.warn("Warning", "Second detail"),
		service.error("Failure", "Third detail"),
	];
	assert.deepEqual(service.model.dialogs.map(item => item.request), [
		{ kind: "message", severity: DialogSeverity.Info, message: "Information", detail: "First detail", title: "Information", primaryButton: "OK" },
		{ kind: "message", severity: DialogSeverity.Warning, message: "Warning", detail: "Second detail", title: "Warning", primaryButton: "OK" },
		{ kind: "message", severity: DialogSeverity.Error, message: "Failure", detail: "Third detail", title: "Error", primaryButton: "OK" },
	]);
	for (const item of service.model.dialogs) item.close({ button: DialogResult.Primary });
	await Promise.all(results);
});
