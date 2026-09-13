import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../base/common/event.js";
import type { JsonValue } from "../../../base/common/jsonValue.js";
import { isRecord } from "../../../base/common/types.js";
import { type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from "../../../platform/storage/common/storage.js";
import { Memento } from "../../../workbench/common/memento.js";

interface TestMementoState {
	readonly version: 2;
	readonly expanded: boolean;
	readonly selected: string | null;
}

test("Memento saves validated private state on the Storage lifecycle", async () => {
	const storage = new TestStorageService();
	const memento = createTestMemento(storage);

	assert.deepEqual(memento.state, defaultTestState());
	memento.update({
		version: 2,
		expanded: true,
		selected: "changes",
	});
	assert.equal(
		storage.get("memento/test.view", StorageScope.WORKSPACE),
		undefined,
	);

	await storage.flush(WillSaveStateReason.SHUTDOWN);
	assert.equal(
		storage.get("memento/test.view", StorageScope.WORKSPACE),
		JSON.stringify({
			version: 2,
			expanded: true,
			selected: "changes",
		}),
	);

	memento.dispose();
	const restored = createTestMemento(storage);
	assert.deepEqual(restored.state, {
		version: 2,
		expanded: true,
		selected: "changes",
	});
	restored.dispose();
});

test("Memento migrates and normalizes a persisted state", async () => {
	const storage = new TestStorageService();
	storage.store(
		"memento/test.view",
		JSON.stringify({ version: 1, expanded: true }),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	const memento = createTestMemento(storage);

	assert.deepEqual(memento.state, {
		version: 2,
		expanded: true,
		selected: null,
	});
	await storage.flush();
	assert.equal(
		storage.get("memento/test.view", StorageScope.WORKSPACE),
		JSON.stringify({
			version: 2,
			expanded: true,
			selected: null,
		}),
	);

	memento.dispose();
});

test("Memento reports malformed state, falls back, and repairs storage", async () => {
	const storage = new TestStorageService();
	storage.store(
		"memento/test.view",
		"{broken",
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	const errors: unknown[] = [];
	const memento = createTestMemento(storage, (error) => errors.push(error));

	assert.deepEqual(memento.state, defaultTestState());
	assert.equal(errors.length, 1);
	await storage.flush();
	assert.equal(
		storage.get("memento/test.view", StorageScope.WORKSPACE),
		JSON.stringify(defaultTestState()),
	);

	memento.dispose();
});

test("Memento reloads external state without discarding pending local state", async () => {
	const storage = new TestStorageService();
	const memento = createTestMemento(storage);
	const changes: Array<{ readonly selected: string | null; readonly external: boolean }> = [];
	memento.onDidChange(({ state, external }) => {
		changes.push({ selected: state.selected, external });
	});

	storage.storeExternal(
		"memento/test.view",
		JSON.stringify({
			version: 2,
			expanded: true,
			selected: "external",
		}),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	assert.equal(memento.state.selected, "external");

	memento.update({
		version: 2,
		expanded: false,
		selected: "local",
	});
	storage.storeExternal(
		"memento/test.view",
		JSON.stringify({
			version: 2,
			expanded: true,
			selected: "newer-external",
		}),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	assert.equal(memento.state.selected, "local");
	await storage.flush();
	const stored = JSON.parse(
		storage.get("memento/test.view", StorageScope.WORKSPACE)!,
	) as { readonly selected: string };
	assert.equal(
		stored.selected,
		"local",
	);
	assert.deepEqual(changes, [
		{ selected: "external", external: true },
		{ selected: "local", external: false },
	]);

	memento.dispose();
});

test("Memento rejects unstable identifiers", () => {
	const storage = new TestStorageService();
	assert.throws(
		() => new Memento(storage, {
			id: "../view",
			scope: StorageScope.PROFILE,
			target: StorageTarget.MACHINE,
			defaultValue: defaultTestState,
			parse: parseTestState,
			serialize: serializeTestState,
		}),
		/Invalid Workbench Memento ID/,
	);
});

function createTestMemento(
	storage: IStorageService,
	onError?: (error: unknown) => void,
): Memento<TestMementoState> {
	return new Memento(storage, {
		id: "test.view",
		scope: StorageScope.WORKSPACE,
		target: StorageTarget.MACHINE,
		defaultValue: defaultTestState,
		parse: parseTestState,
		serialize: serializeTestState,
		onError,
	});
}

function defaultTestState(): TestMementoState {
	return {
		version: 2,
		expanded: false,
		selected: null,
	};
}

function parseTestState(value: unknown): TestMementoState {
	if (!isRecord(value) || typeof value.expanded !== "boolean") {
		throw new TypeError("Test Memento state is invalid");
	}
	if (value.version === 1) {
		return {
			version: 2,
			expanded: value.expanded,
			selected: null,
		};
	}
	if (
		value.version !== 2 ||
		(value.selected !== null && typeof value.selected !== "string")
	) {
		throw new TypeError("Test Memento state is invalid");
	}
	return {
		version: 2,
		expanded: value.expanded,
		selected: value.selected,
	};
}

function serializeTestState(state: TestMementoState): JsonValue {
	return {
		version: state.version,
		expanded: state.expanded,
		selected: state.selected,
	};
}

class TestStorageService implements IStorageService {
	private readonly _onDidChangeValue = new Emitter<IStorageValueChangeEvent>();
	private readonly _onWillSaveState = new Emitter<IWillSaveStateEvent>();
	private readonly values = new Map<string, string>();

	readonly onDidChangeValue = this._onDidChangeValue.event;
	readonly onWillSaveState = this._onWillSaveState.event;

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	get(
		key: string,
		scope: StorageScope,
		fallbackValue?: string,
	): string | undefined {
		return this.values.get(storageMapKey(key, scope)) ?? fallbackValue;
	}

	getBoolean(
		key: string,
		scope: StorageScope,
		fallbackValue: boolean,
	): boolean;
	getBoolean(
		key: string,
		scope: StorageScope,
	): boolean | undefined;
	getBoolean(
		key: string,
		scope: StorageScope,
		fallbackValue?: boolean,
	): boolean | undefined {
		const value = this.get(key, scope);
		if (value === "true") return true;
		if (value === "false") return false;
		return fallbackValue;
	}

	getNumber(
		key: string,
		scope: StorageScope,
		fallbackValue: number,
	): number;
	getNumber(
		key: string,
		scope: StorageScope,
	): number | undefined;
	getNumber(
		key: string,
		scope: StorageScope,
		fallbackValue?: number,
	): number | undefined {
		const value = this.get(key, scope);
		if (value === undefined) return fallbackValue;
		const number = Number(value);
		return Number.isFinite(number) ? number : fallbackValue;
	}

	store(
		key: string,
		value: StorageValue,
		scope: StorageScope,
		target: StorageTarget,
	): void {
		if (value === undefined || value === null) {
			this.remove(key, scope);
			return;
		}
		this.values.set(storageMapKey(key, scope), String(value));
		this._onDidChangeValue.fire({
			key,
			scope,
			target,
			external: false,
		});
	}

	remove(key: string, scope: StorageScope): void {
		this.values.delete(storageMapKey(key, scope));
		this._onDidChangeValue.fire({
			key,
			scope,
			target: undefined,
			external: false,
		});
	}

	keys(scope: StorageScope, _target: StorageTarget): readonly string[] {
		const prefix = `${scope}:`;
		return [...this.values.keys()]
			.filter((key) => key.startsWith(prefix))
			.map((key) => key.slice(prefix.length));
	}

	isNew(_scope: StorageScope): boolean { return false; }

	async flush(
		reason: WillSaveStateReason = WillSaveStateReason.PERIODIC,
	): Promise<void> {
		this._onWillSaveState.fire({ reason });
	}

	storeExternal(
		key: string,
		value: string,
		scope: StorageScope,
		target: StorageTarget,
	): void {
		this.values.set(storageMapKey(key, scope), value);
		this._onDidChangeValue.fire({
			key,
			scope,
			target,
			external: true,
		});
	}
}

function storageMapKey(key: string, scope: StorageScope): string {
	return `${scope}:${key}`;
}
