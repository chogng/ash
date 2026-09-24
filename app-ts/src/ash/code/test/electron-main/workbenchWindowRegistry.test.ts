import { strict as assert } from "node:assert";
import { test } from "mocha";
import type { IWorkbenchWindowRecord } from "../../electron-main/workbenchWindowRegistry.js";
import { WorkbenchWindowRegistry } from "../../electron-main/workbenchWindowRegistry.js";

interface TestWindowRecord extends IWorkbenchWindowRecord {
	destroyed: boolean;
	focusCount: number;
}

test("Workbench window registry tracks activation and deterministic focus fallback", () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	const first = record(1, "workspace-one");
	const second = record(2, "workspace-two");
	registry.add(first);
	registry.add(second);

	assert.equal(registry.active(), second);
	registry.activate(first.id);
	assert.equal(registry.active(), first);
	assert.equal(registry.focusActive(), true);
	assert.equal(first.focusCount, 1);

	registry.remove(first.id);
	assert.equal(registry.active(), second);
	assert.equal(registry.size, 1);
});

test("Workbench window registry updates Workspace identity and ignores destroyed records", () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	const first = record(1, "workspace-one");
	const second = record(2, "workspace-two");
	registry.add(first);
	registry.add(second);

	registry.updateWorkspace(first.id, "workspace-three");
	assert.equal(registry.findWorkspace("workspace-one"), undefined);
	assert.equal(registry.findWorkspace("workspace-three"), first);

	first.destroyed = true;
	second.destroyed = true;
	assert.equal(registry.active(), undefined);
	assert.equal(registry.focusActive(), false);
	assert.equal(registry.size, 0);
});

test("Workbench window registry rejects duplicate or unknown record operations", () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	const first = record(1, "workspace-one");
	registry.add(first);

	assert.throws(() => registry.add(record(1, "workspace-two")), /already registered/);
	assert.throws(() => registry.activate(2), /not registered/);
	assert.throws(() => registry.updateWorkspace(2, "workspace-two"), /not registered/);
});

test("Workbench window registry coalesces concurrent opens and later focuses the live record", async () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	let createCalls = 0;
	let finishCreate!: (record: TestWindowRecord) => void;
	const creation = new Promise<TestWindowRecord>(resolve => finishCreate = resolve);
	const create = async (): Promise<TestWindowRecord> => {
		createCalls += 1;
		const created = await creation;
		registry.add(created);
		return created;
	};

	const first = registry.openWorkspace("workspace-one", create);
	const second = registry.openWorkspace("workspace-one", create);
	assert.equal(first, second);
	assert.equal(createCalls, 1);

	const created = record(1, "workspace-one");
	finishCreate(created);
	assert.equal(await first, created);
	assert.equal(await second, created);

	assert.equal(await registry.openWorkspace("workspace-one", async () => assert.fail("live Workspace must not be recreated")), created);
	assert.equal(created.focusCount, 1);
});

test("Workbench window registry releases a failed opening for an explicit retry", async () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	let createCalls = 0;
	await assert.rejects(() => registry.openWorkspace("workspace-one", async () => {
		createCalls += 1;
		throw new Error("startup failed");
	}), /startup failed/);

	const created = record(1, "workspace-one");
	assert.equal(await registry.openWorkspace("workspace-one", async () => {
		createCalls += 1;
		registry.add(created);
		return created;
	}), created);
	assert.equal(createCalls, 2);
});

test("Workbench window registry keeps coalescing after a window registers but before startup settles", async () => {
	const registry = new WorkbenchWindowRegistry<TestWindowRecord>();
	const created = record(1, "workspace-one");
	let finishStartup!: () => void;
	const startup = new Promise<void>(resolve => finishStartup = resolve);
	const first = registry.openWorkspace("workspace-one", async () => {
		registry.add(created);
		await startup;
		return created;
	});

	const second = registry.openWorkspace("workspace-one", async () => assert.fail("pending Workspace must not be recreated"));
	assert.equal(second, first);
	assert.equal(created.focusCount, 0);

	finishStartup();
	assert.equal(await first, created);
	assert.equal(await second, created);
});

function record(id: number, workspaceId: string): TestWindowRecord {
	const value: TestWindowRecord = {
		id,
		workspaceId,
		destroyed: false,
		focusCount: 0,
		isDestroyed: () => value.destroyed,
		focus: () => { value.focusCount += 1; },
	};
	return value;
}
