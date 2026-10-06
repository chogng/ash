import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from '../../../platform/storage/common/storage.js';
import { Memento } from '../../../workbench/common/memento.js';

interface TestMementoState {
	expanded: boolean;
	selected: string;
}

test('Memento saves scoped state only when its owner requests a save', async () => {
	using storage = new TestStorageService();
	const memento = new Memento<TestMementoState>('test.view', storage);
	const state = memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
	Object.assign(state, { expanded: true, selected: 'changes' });
	await storage.flush();
	assert.equal(storage.get('memento/test.view', StorageScope.WORKSPACE), undefined);

	memento.saveMemento();
	const restored = new Memento<TestMementoState>('test.view', storage);
	assert.deepEqual(restored.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), { expanded: true, selected: 'changes' });
	assert.equal(memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), state);
});

test('Memento separates scopes and records the selected storage targets', () => {
	using storage = new TestStorageService();
	const memento = new Memento<TestMementoState>('test.view', storage);
	memento.getMemento(StorageScope.APPLICATION, StorageTarget.USER).selected = 'application';
	memento.getMemento(StorageScope.PROFILE, StorageTarget.USER).selected = 'profile';
	memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).selected = 'workspace';
	const changes: Array<{ scope: StorageScope; target: StorageTarget | undefined; }> = [];
	using listeners = new DisposableStore();
	listeners.add(storage.onDidChangeValue(({ scope, target }) => changes.push({ scope, target })));
	memento.saveMemento();

	assert.deepEqual(changes, [
		{ scope: StorageScope.APPLICATION, target: StorageTarget.USER },
		{ scope: StorageScope.PROFILE, target: StorageTarget.USER },
		{ scope: StorageScope.WORKSPACE, target: StorageTarget.MACHINE },
	]);
	assert.deepEqual([StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE].map(scope => JSON.parse(storage.get('memento/test.view', scope)!)), [
		{ selected: 'application' }, { selected: 'profile' }, { selected: 'workspace' },
	]);
});

test('Memento reload retains the state object and removes stale properties', () => {
	using storage = new TestStorageService();
	const memento = new Memento<TestMementoState>('test.view', storage);
	const state = memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);
	Object.assign(state, { expanded: true, selected: 'local' });
	storage.storeExternal('memento/test.view', '{"selected":"external"}', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.equal(state.selected, 'local');

	memento.reloadMemento(StorageScope.WORKSPACE);
	assert.equal(memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), state);
	assert.deepEqual(state, { selected: 'external' });
	delete memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).selected;
	memento.saveMemento();
	assert.equal(storage.get('memento/test.view', StorageScope.WORKSPACE), undefined);
});

test('Memento changes are limited to its key and scope and stop when the listener owner is disposed', () => {
	using storage = new TestStorageService();
	const memento = new Memento<TestMementoState>('test.view', storage);
	using listeners = new DisposableStore();
	const values: string[] = [];
	memento.onDidChangeValue(StorageScope.WORKSPACE, listeners)(event => values.push(event.key));
	storage.storeExternal('memento/other.view', '{}', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	storage.storeExternal('memento/test.view', '{}', StorageScope.PROFILE, StorageTarget.MACHINE);
	storage.storeExternal('memento/test.view', '{}', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	listeners.dispose();
	storage.storeExternal('memento/test.view', '{}', StorageScope.WORKSPACE, StorageTarget.MACHINE);
	assert.deepEqual(values, ['memento/test.view']);
});

test('Memento rejects invalid identifiers and malformed persisted objects', () => {
	using storage = new TestStorageService();
	assert.throws(() => new Memento('', storage), /Invalid Workbench Memento ID/);
	for (const source of ['{broken', '[]', 'null', '{"constructor":{}}']) {
		storage.store('memento/test.view', source, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const memento = new Memento<TestMementoState>('test.view', storage);
		assert.throws(() => memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE));
	}
});

test('Memento rejects non-JSON component state before storing it', () => {
	using storage = new TestStorageService();
	const memento = new Memento<{ size: number }>('test.view', storage);
	memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).size = Number.NaN;
	assert.throws(() => memento.saveMemento(), /finite number/);
	assert.equal(storage.get('memento/test.view', StorageScope.WORKSPACE), undefined);
});

test('Memento preserves state for extension editor identifiers', () => {
	using storage = new TestStorageService();
	const id = 'publisher.custom_editor:preview';
	const memento = new Memento<TestMementoState>(id, storage);
	memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE).selected = 'preview';
	memento.saveMemento();
	const restored = new Memento<TestMementoState>(id, storage);
	assert.deepEqual(restored.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE), { selected: 'preview' });
});

class TestStorageService extends Disposable implements IStorageService {
	private readonly _onDidChangeValue = this._register(new Emitter<IStorageValueChangeEvent>());
	private readonly _onWillSaveState = this._register(new Emitter<IWillSaveStateEvent>());
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
