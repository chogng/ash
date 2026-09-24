import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserStorageService } from "../../../storage/browser/storageService.js";
import { OutputService } from "../../browser/outputService.js";

test("OutputService registers, updates, reveals, and removes independent channels", () => {
	using output = new OutputService();
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
	using output = new OutputService();
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
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: "output-test", workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using output = new OutputService({ storageService: storage });
		using first = output.createChannel({ id: "first", label: "First" });
		using second = output.createChannel({ id: "second", label: "Second" });
		output.selectChannel(second.id);
	}
	{
		using output = new OutputService({ storageService: storage });
		using first = output.createChannel({ id: "first", label: "First" });
		assert.equal(output.activeChannel, first);
		using second = output.createChannel({ id: "second", label: "Second" });
		assert.equal(output.activeChannel, second);
	}
	browser.window.close();
});
