import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { DisposableStore } from "../../../../../base/common/lifecycle.js";
import { StorageScope, StorageTarget, WillSaveStateReason } from "../../../../../platform/storage/common/storage.js";
import { Memento } from "../../../../../workbench/common/memento.js";
import { BrowserStorageService } from "../../../../../workbench/services/storage/browser/storageService.js";

test("Browser storage persists scoped values and target metadata", () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const first = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	assert.equal(first.isNew(StorageScope.APPLICATION), true);
	assert.equal(first.isNew(StorageScope.PROFILE), true);
	assert.equal(first.isNew(StorageScope.WORKSPACE), true);
	first.store("shared", "application", StorageScope.APPLICATION, StorageTarget.USER);
	first.store("shared", 42, StorageScope.PROFILE, StorageTarget.MACHINE);
	first.store("shared", true, StorageScope.WORKSPACE, StorageTarget.MACHINE);

	assert.equal(first.get("shared", StorageScope.APPLICATION), "application");
	assert.equal(first.getNumber("shared", StorageScope.PROFILE), 42);
	assert.equal(first.getBoolean("shared", StorageScope.WORKSPACE), true);
	assert.deepEqual(first.keys(StorageScope.APPLICATION, StorageTarget.USER), ["shared"]);
	assert.deepEqual(first.keys(StorageScope.PROFILE, StorageTarget.MACHINE), ["shared"]);
	assert.equal(first.isNew(StorageScope.WORKSPACE), true);
	first.dispose();

	const restored = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	assert.equal(restored.get("shared", StorageScope.APPLICATION), "application");
	assert.equal(restored.getNumber("shared", StorageScope.PROFILE), 42);
	assert.equal(restored.getBoolean("shared", StorageScope.WORKSPACE), true);
	assert.equal(restored.isNew(StorageScope.APPLICATION), false);
	assert.equal(restored.isNew(StorageScope.PROFILE), false);
	assert.equal(restored.isNew(StorageScope.WORKSPACE), false);
	restored.dispose();
	dom.window.close();
});

test("Browser storage isolates workspaces while retaining profile state", () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const first = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	first.store("size", 260, StorageScope.PROFILE, StorageTarget.MACHINE);
	first.store("visible", false, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	first.switchWorkspace("workspace-b");
	assert.equal(first.isNew(StorageScope.WORKSPACE), true);
	assert.equal(first.getNumber("size", StorageScope.PROFILE), 260);
	assert.equal(first.getBoolean("visible", StorageScope.WORKSPACE), undefined);
	first.store("visible", true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	first.switchWorkspace("workspace-a");
	assert.equal(first.isNew(StorageScope.WORKSPACE), true);
	assert.equal(first.getBoolean("visible", StorageScope.WORKSPACE), false);
	first.switchWorkspace("workspace-b");
	assert.equal(first.getBoolean("visible", StorageScope.WORKSPACE), true);
	first.dispose();

	const second = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-b",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	assert.equal(second.getNumber("size", StorageScope.PROFILE), 260);
	assert.equal(second.getBoolean("visible", StorageScope.WORKSPACE), true);
	assert.equal(second.isNew(StorageScope.WORKSPACE), false);
	second.dispose();
	dom.window.close();
});

test("Browser storage saves and reloads Mementos across workspace changes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const seed = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-b",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	seed.store("memento/test.workspace", JSON.stringify({ value: "workspace-b" }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	seed.dispose();

	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	});
	const memento = new Memento(storage, {
		id: "test.workspace",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
		defaultValue: () => ({ value: "default" }),
		parse: parseWorkspaceTestState,
		serialize: (state) => ({ value: state.value }),
	});
	memento.update({ value: "workspace-a" });

	await storage.flush(WillSaveStateReason.WORKSPACE_CHANGE);
	storage.switchWorkspace("workspace-b");
	assert.equal(memento.state.value, "workspace-b");

	storage.switchWorkspace("workspace-a");
	assert.equal(memento.state.value, "workspace-a");

	memento.dispose();
	storage.dispose();
	dom.window.close();
});

test("Browser storage emits changes and will-save lifecycle events", async () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const disposables = new DisposableStore();
	const storage = disposables.add(new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	}));
	const changes: string[] = [];
	const saves: WillSaveStateReason[] = [];
	disposables.add(storage.onDidChangeValue(({ key }) => changes.push(key)));
	disposables.add(storage.onWillSaveState(({ reason }) => saves.push(reason)));

	storage.store("one", 1, StorageScope.PROFILE, StorageTarget.MACHINE);
	storage.store("one", 1, StorageScope.PROFILE, StorageTarget.MACHINE);
	storage.remove("one", StorageScope.PROFILE);
	await storage.flush(WillSaveStateReason.SHUTDOWN);

	assert.deepEqual(changes, ["one", "one"]);
	assert.deepEqual(saves, [WillSaveStateReason.SHUTDOWN]);
	dom.window.dispatchEvent(new dom.window.Event("pagehide"));
	assert.deepEqual(saves, [WillSaveStateReason.SHUTDOWN]);

	disposables.dispose();
	dom.window.close();
});

test("Browser storage projects external document changes", () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	const disposables = new DisposableStore();
	const storage = disposables.add(new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
	}));
	storage.store("size", 260, StorageScope.PROFILE, StorageTarget.MACHINE);
	const externalChanges: string[] = [];
	disposables.add(storage.onDidChangeValue((event) => {
		if (event.external) externalChanges.push(event.key);
	}));
	const storageKey = [...Array(dom.window.localStorage.length).keys()]
		.map((index) => dom.window.localStorage.key(index))
		.find((key) => key?.includes(".profile."));
	assert.ok(storageKey);
	const document = JSON.parse(dom.window.localStorage.getItem(storageKey)!) as {
		entries: Record<string, { value: string; target: string }>;
	};
	document.entries.size!.value = "310";
	const newValue = JSON.stringify(document);
	dom.window.localStorage.setItem(storageKey, newValue);
	dom.window.dispatchEvent(new dom.window.StorageEvent("storage", {
		key: storageKey,
		newValue,
		storageArea: dom.window.localStorage,
	}));

	assert.equal(storage.getNumber("size", StorageScope.PROFILE), 310);
	assert.deepEqual(externalChanges, ["size"]);

	disposables.dispose();
	dom.window.close();
});

test("Browser storage reports malformed persisted documents and falls back", () => {
	const dom = new JSDOM("<!doctype html><body></body>", {
		url: "https://ash.test",
	});
	dom.window.localStorage.setItem(
		"ash.code.storage.profile.default",
		JSON.stringify({ version: 99 }),
	);
	const errors: unknown[] = [];
	const storage = new BrowserStorageService({
		ownerWindow: dom.window as unknown as Window,
		applicationId: "code",
		workspaceId: "workspace-a",
		backend: dom.window.localStorage,
		flushInterval: 0,
		onError: (error) => errors.push(error),
	});

	assert.equal(storage.get("missing", StorageScope.PROFILE), undefined);
	assert.equal(storage.isNew(StorageScope.PROFILE), false);
	assert.equal(errors.length, 1);

	storage.dispose();
	dom.window.close();
});

function parseWorkspaceTestState(value: unknown): { readonly value: string } {
	if (typeof value !== "object" || value === null || !("value" in value) || typeof value.value !== "string") {
		throw new TypeError("Workspace test state is invalid");
	}
	return { value: value.value };
}
