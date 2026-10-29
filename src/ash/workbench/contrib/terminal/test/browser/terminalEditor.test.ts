import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalEditorService } from '../../browser/terminalEditorService.js';
import {
	ITerminalService,
	type ITerminalInstance,
	type ICreateTerminalOptions,
	type TerminalInstanceState,
} from '../../browser/terminal.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import {
	IEditorGroupsService,
	GroupDirection,
	type IEditorGroup,
} from '../../../../services/editor/common/editorGroupsService.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { TerminalEditorInput } from '../../browser/terminalEditorInput.js';
import { TerminalInputSerializer } from '../../browser/terminalEditorSerializer.js';
import { getTerminalUri, parseTerminalUri, getInstanceFromResource } from '../../browser/terminalUri.js';
import { EditorInputSerializerRegistry } from '../../../../services/editor/common/editorInputSerializer.js';

ensureNoDisposablesAreLeakedInTestSuite();

suite('Terminal editor resource boundary', () => {
	test('working sets persist only identity, not executable configuration', () => {
		const registry = new EditorInputSerializerRegistry();
		using registration = registry.register(new TerminalInputSerializer());
		const resource = getTerminalUri('session-one', 3, 'Shell');
		const saved = registry.serialize(new TerminalEditorInput(resource));
		assert.deepEqual(saved.value, { resource: resource.toString() });
		const restored = registry.deserialize(saved);
		assert.ok(restored instanceof TerminalEditorInput);
		assert.equal(restored.label, 'Shell');
		assert.equal(restored.terminalInstance, undefined);
	});

	test('incarnations with a reused instance number cannot bind an old resource', () => {
		const instance = { resource: getTerminalUri('current-session', 1, 'New') };
		assert.equal(getInstanceFromResource([instance], getTerminalUri('old-session', 1)), undefined);
		assert.equal(
			getInstanceFromResource([instance], instance.resource.with({ fragment: 'Old label', query: 'command' })),
			instance,
		);
	});

	test('rejects forged resource schemes, authorities, IDs and persistence values', () => {
		for (const value of [
			'file:/session/1',
			'vscode-terminal://host/session/1',
			'vscode-terminal:/session/0',
			'vscode-terminal:/session/1x',
			'vscode-terminal:/session/9007199254740992',
			'vscode-terminal:/session/1/extra',
		]) {
			assert.throws(() => parseTerminalUri(URI.parse(value)), TypeError);
		}
		const serializer = new TerminalInputSerializer();
		for (const value of [null, [], {}, { resource: 3 }, { resource: 'file:/session/1' }])
			assert.throws(() => serializer.deserialize(value), TypeError);
	});
});

suite('Terminal editor destination', () => {
	test('a background open keeps the original input target through editor selection notifications', async () => {
		using changed = new Emitter<void>();
		const original = {
			resource: getTerminalUri('session', 1),
			target: TerminalLocation.Panel,
		} as ITerminalInstance;
		const background = {
			resource: getTerminalUri('session', 2),
			target: TerminalLocation.Panel,
		} as ITerminalInstance;
		let active = original;
		let selected: TerminalEditorInput | undefined;
		const terminals = {
			instances: [original, background],
			onDidDisposeInstance: Event.None,
			onDidChangeInstances: Event.None,
			setActiveInstance: (instance: ITerminalInstance) => {
				active = instance;
			},
		} as unknown as ITerminalService;
		const editors = {
			onDidActiveEditorChange: changed.event,
			get activeEditor() {
				return selected;
			},
			openEditor: async (input: TerminalEditorInput) => {
				selected = input;
				changed.fire();
			},
		} as unknown as IEditorService;
		const groups = { groups: [], onDidChangeGroups: Event.None } as unknown as IEditorGroupsService;
		using service = new TerminalEditorService(terminals, editors, groups);
		await service.openEditor(background, { preserveFocus: true });
		assert.equal(active, original);
		await service.openEditor(background);
		assert.equal(active, background);
	});

	test('the captured auxiliary group receives the same instance even when another group is active', async () => {
		const instance = {
			resource: getTerminalUri('session', 1),
			target: TerminalLocation.Panel,
		} as ITerminalInstance;
		const requests: unknown[] = [];
		const terminals = {
			instances: [instance],
			onDidDisposeInstance: Event.None,
			onDidChangeInstances: Event.None,
			setActiveInstance: (active: ITerminalInstance) => {
				assert.equal(active, instance);
			},
		} as unknown as ITerminalService;
		const editors = {
			onDidActiveEditorChange: Event.None,
			openEditor: async (input, options, target) => {
				requests.push([input, options, target]);
			},
		} as IEditorService;
		const groups = { groups: [], onDidChangeGroups: Event.None } as unknown as IEditorGroupsService;
		using service = new TerminalEditorService(terminals, editors, groups);
		await service.openEditor(instance, { viewColumn: 12 });
		assert.equal(instance.target, TerminalLocation.Editor);
		const [input, options, target] = requests[0] as [TerminalEditorInput, unknown, unknown];
		assert.equal(input.terminalInstance, instance);
		assert.deepEqual(options, { pinned: true, ignoreError: true, preserveFocus: undefined });
		assert.deepEqual(target, { groupId: 12 });
	});
});

function splitFixture() {
	const lifetime = new DisposableStore();
	const state = lifetime.add(new Emitter<TerminalInstanceState>());
	const source = {
		resource: getTerminalUri('split', 1),
		target: TerminalLocation.Editor,
		state: 'running',
		onDidChangeState: state.event,
		shellLaunchConfig: { executable: '/bin/bash', env: { TEST: 'retained' } },
	} as unknown as ITerminalInstance;
	const created = { resource: getTerminalUri('split', 2), target: TerminalLocation.Editor } as ITerminalInstance;
	const input = new TerminalEditorInput(source.resource!, source);
	const origin = { id: 7, inputs: [input], onDidChangeEditors: Event.None } as unknown as IEditorGroup;
	const destination = { id: 8, inputs: [], onDidChangeEditors: Event.None } as unknown as IEditorGroup;
	const allGroups = [origin];
	const instances = [source];
	const closed: ITerminalInstance[] = [];
	const removed: IEditorGroup[] = [];
	const requests: ICreateTerminalOptions[] = [];
	let create = async (options: ICreateTerminalOptions): Promise<ITerminalInstance> => {
		requests.push(options);
		instances.push(created);
		return created;
	};
	const terminals = {
		instances,
		onDidDisposeInstance: Event.None,
		onDidChangeInstances: Event.None,
		createTerminal: (options: ICreateTerminalOptions) => create(options),
		closeTerminal: async (instance: ITerminalInstance) => {
			closed.push(instance);
			instances.splice(instances.indexOf(instance), 1);
		},
	} as unknown as ITerminalService;
	const groups = {
		groups: allGroups,
		onDidChangeGroups: Event.None,
		getGroup: (id: number) => allGroups.find(group => group.id === id),
		addGroup: (reference: IEditorGroup, direction: GroupDirection) => {
			assert.equal(reference, origin);
			assert.equal(direction, GroupDirection.RIGHT);
			allGroups.push(destination);
			return destination;
		},
		removeGroup: async (group: IEditorGroup) => {
			removed.push(group);
			allGroups.splice(allGroups.indexOf(group), 1);
			return true;
		},
	} as unknown as IEditorGroupsService;
	const service = lifetime.add(
		new TerminalEditorService(terminals, { onDidActiveEditorChange: Event.None } as IEditorService, groups),
	);
	return {
		lifetime,
		source,
		created,
		destination,
		instances,
		state,
		closed,
		removed,
		requests,
		service,
		setCreate: (value: typeof create) => (create = value),
	};
}

test('editor terminal split captures the original group and reuses parent launch resolution', async () => {
	const f = splitFixture();
	using lifetime = f.lifetime;
	assert.equal(await f.service.splitInstance(f.source), f.created);
	assert.deepEqual(f.requests, [
		{ config: f.source.shellLaunchConfig, location: { parentTerminal: f.source, viewColumn: 8 } },
	]);
	assert.deepEqual(f.closed, []);
	assert.deepEqual(f.removed, []);
});

test('editor terminal split removes only its empty destination after creation fails', async () => {
	const f = splitFixture();
	using lifetime = f.lifetime;
	f.setCreate(async () => {
		throw new Error('Shell launch failed');
	});
	await assert.rejects(f.service.splitInstance(f.source), /Shell launch failed/);
	assert.deepEqual(f.instances, [f.source]);
	assert.deepEqual(f.closed, []);
	assert.deepEqual(f.removed, [f.destination]);
});

test('editor terminal split closes a late new process after the parent changes generation', async () => {
	const f = splitFixture();
	using lifetime = f.lifetime;
	const pending = new DeferredPromise<ITerminalInstance>();
	f.setCreate(() => pending.p);
	const splitting = f.service.splitInstance(f.source);
	const rejected = assert.rejects(splitting, isCancellationError);
	f.state.fire('disconnected');
	f.instances.push(f.created);
	await pending.complete(f.created);
	await rejected;
	assert.deepEqual(f.instances, [f.source]);
	assert.deepEqual(f.closed, [f.created]);
	assert.deepEqual(f.removed, [f.destination]);
});
