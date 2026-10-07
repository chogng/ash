import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserStorageService } from "../../../../services/storage/browser/storageService.js";

test("OutputService registers, updates, reveals, and removes independent channels", () => {
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using first = output.createChannel({ id: "tasks", label: "Tasks" });
	using second = output.createChannel({ id: "rust-analyzer", label: "rust-analyzer" });
	const selections: Array<string | undefined> = [];
	using selectionListener = output.onDidChangeActiveChannel(channel => selections.push(channel?.id));

	assert.equal(output.activeChannel, first);
	const reveals: Array<[string, string]> = [];
	using revealListener = output.onDidRequestShowChannel(request => reveals.push([request.channel.id, request.focus]));
	first.appendLine({ severity: "log", text: "task started" });
	second.append({ severity: "warning", text: "check failed" });
	assert.deepEqual(first.entries.map(entry => [entry.sequence, entry.severity, entry.text]), [[1, "log", "task started\n"]]);
	assert.deepEqual(second.entries.map(entry => [entry.sequence, entry.severity, entry.text]), [[1, "warning", "check failed"]]);

	output.selectChannel(second.id);
	assert.equal(output.activeChannel, second);
	assert.deepEqual(selections, [second.id]);
	first.show({ focus: "preserve" });
	assert.equal(output.activeChannel, first);
	assert.deepEqual(reveals, [[first.id, "preserve"]]);
	first.replace([{ severity: "information", category: "lifecycle", timestamp: 1, text: "ready" }]);
	assert.equal(first.getText(), "ready");
	assert.deepEqual(first.entries.map(entry => [entry.timestamp, entry.severity, entry.category, entry.text]), [[1, "information", "lifecycle", "ready"]]);
	output.selectChannel(second.id);
	second.clear();
	assert.deepEqual(second.entries, []);
	second.dispose();
	assert.equal(output.activeChannel, first);
	assert.deepEqual(output.channels.map(channel => channel.id), [first.id]);
	assert.deepEqual(selections, ["rust-analyzer", "tasks", "rust-analyzer", "tasks"]);
});

test("OutputService rejects ambiguous channel ownership and invalid entries", () => {
	using outputResources = new DisposableStore();
	const output = workbenchInstantiationService(outputResources).get(IOutputService);
	using channel = output.createChannel({ id: "server", label: "Server" });
	assert.throws(() => output.createChannel({ id: "server", label: "Duplicate" }), /already registered/);
	assert.throws(() => output.createChannel({ id: "invalid id", label: "Invalid" }), /cannot contain whitespace/);
	assert.throws(() => output.selectChannel("missing"), /Unknown Output channel/);
	assert.throws(() => channel.append({ severity: "fatal" as never, text: "unsupported" }), /Unsupported Output entry severity/);
	channel.append({ severity: "log", text: "  " });
	assert.equal(channel.getText(), "  ");
});

test("OutputService restores the workspace active channel when its producer returns", () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using outputResources = new DisposableStore();
		const output = workbenchInstantiationService(outputResources, storage).get(IOutputService);
		using first = output.createChannel({ id: "first", label: "First" });
		using second = output.createChannel({ id: "second", label: "Second" });
		output.selectChannel(second.id);
	}
	{
		using outputResources = new DisposableStore();
		const output = workbenchInstantiationService(outputResources, storage).get(IOutputService);
		using first = output.createChannel({ id: "first", label: "First" });
		assert.equal(output.activeChannel, first);
		using second = output.createChannel({ id: "second", label: "Second" });
		assert.equal(output.activeChannel, second);
	}
	browser.window.close();
});

const entry = { sequence: 1, timestamp: 1, severity: "warning", category: "lifecycle", text: "Server restart scheduled" } as const;

test('Output keeps panel and editor references live, and recreates a released model from retained content', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const resolver = services.get(ITextModelService);
	using channel = output.createChannel({ id: 'live', label: 'Live' });
	channel.appendLine({ text: 'first', category: 'build', severity: 'warning' });
	const panel = await resolver.createModelReference(channel.uri);
	const editor = await resolver.createModelReference(channel.uri);
	const model = panel.object.textEditorModel;
	assert.equal(model, editor.object.textEditorModel);
	channel.appendLine({ text: 'second' });
	assert.equal(editor.object.textEditorModel.getValue(), 'first\nsecond\n');
	panel.dispose();
	assert.equal(model.isDisposed(), false);
	channel.replace({ text: 'replacement' });
	assert.equal(model.getValue(), 'replacement');
	editor.dispose();
	assert.equal(model.isDisposed(), true);
	channel.appendLine({ text: ' after close' });
	using reopened = await resolver.createModelReference(channel.uri);
	assert.notEqual(reopened.object.textEditorModel, model);
	assert.equal(reopened.object.textEditorModel.getValue(), 'replacement after close\n');
	channel.clear();
	assert.equal(reopened.object.textEditorModel.getValue(), '');
});

test('Output retention also removes expired text from an open model', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	using channel = services.get(IOutputService).createChannel({ id: 'bounded', label: 'Bounded' });
	using reference = await services.get(ITextModelService).createModelReference(channel.uri);
	channel.appendLine({ text: 'expired' });
	channel.append({ text: 'x'.repeat(2 * 1024 * 1024 - 20) });
	assert.equal(reference.object.textEditorModel.getValue(), channel.getText());
	assert.equal(channel.entries.length, 1);
	channel.append({ text: 'y'.repeat(4 * 1024 * 1024) });
	assert.equal(reference.object.textEditorModel.getValue(), '');
});

test('Output normalizes CRLF once when producers split it between writes', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	using channel = services.get(IOutputService).createChannel({ id: 'crlf', label: 'CRLF' });
	using reference = await services.get(ITextModelService).createModelReference(channel.uri);
	channel.append({ text: 'first\r' });
	channel.append({ text: '\nsecond\r' });
	channel.append({ text: '\n' });
	assert.equal(channel.getText(), 'first\r\nsecond\r\n');
	assert.equal(reference.object.textEditorModel.getValue().replaceAll('\r\n', '\n'), 'first\nsecond\n');
});

test("OutputFilterState combines include, exclude, severity, and category filters", () => {
	using filterResources = new DisposableStore();
	const filters = workbenchInstantiationService(filterResources).get(IOutputService).filters;
	filters.setText('"server restart" !failed');
	assert.equal(filters.matches(entry), true);
	filters.setText("server !scheduled");
	assert.equal(filters.matches(entry), false);
	filters.setText("");
	filters.setSeverityVisible("warning", false);
	assert.equal(filters.matches(entry), false);
	filters.setSeverityVisible("warning", true);
	filters.setCategoryVisible("lifecycle", false);
	assert.equal(filters.matches(entry), false);
	filters.reset();
	assert.equal(filters.matches(entry), true);
	filters.setMinimumSeverity("error");
	assert.equal(filters.matches(entry), false);
	assert.equal(filters.matches({ ...entry, severity: "error" }), true);
});

test("OutputFilterState restores workspace-local filter choices", () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using filterResources = new DisposableStore();
		const filters = workbenchInstantiationService(filterResources, storage).get(IOutputService).filters;
		filters.setText("server");
		filters.setSeverityVisible("trace", false);
	}
	{
		using filterResources = new DisposableStore();
		const filters = workbenchInstantiationService(filterResources, storage).get(IOutputService).filters;
		assert.equal(filters.text, "server");
		assert.equal(filters.isSeverityVisible("trace"), false);
	}
	browser.window.close();
});
