import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	TerminalCapability,
	type ICommandDetectionCapability,
	type ITerminalCommand,
} from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCommand } from '../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import { CwdDetectionCapability } from '../../../../../platform/terminal/common/capabilities/cwdDetectionCapability.js';
import {
	TerminalCapabilityStore,
	TerminalCapabilityStoreMultiplexer,
} from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import type { IOutputChannel, IOutputService } from '../../../../services/output/common/output.js';
import type { ITerminalInstance, ITerminalService } from '../../browser/terminal.js';
import { createInstanceCapabilityEventMultiplexer } from '../../browser/terminalEvents.js';
import { AgentHostOutputChannel } from '../../browser/agentHostOutputChannel.js';

function screenCommand(id: string): ITerminalCommand {
	return new TerminalCommand(
		{ buffer: { normal: { cursorX: 0 } } } as ConstructorParameters<typeof TerminalCommand>[0],
		{
			id,
			command: 'screen command',
			commandLineConfidence: 'high',
			isTrusted: true,
			timestamp: 123,
			duration: 10,
			marker: undefined,
			cwd: '/workspace',
			exitCode: 0,
			commandStartLineContent: undefined,
			markProperties: undefined,
			executedX: undefined,
			startX: undefined,
		},
	);
}

function source(owner: DisposableStore, id: number) {
	const changes = owner.add(new Emitter<void>());
	const statuses = owner.add(new Emitter<import('../../browser/terminal.js').ITerminalCommandStatusEvent>());
	const finished = owner.add(new Emitter<ITerminalCommand>());
	let enabled = false;
	let storageDisabled = false;
	const commands: ITerminalCommand[] = [];
	const capabilities = owner.add(new TerminalCapabilityStore());
	const cwd = owner.add(new CwdDetectionCapability());
	cwd.updateCwd('/committed/cwd');
	const command = {
		type: TerminalCapability.CommandDetection as const,
		get commands() {
			return commands;
		},
		hasRichCommandDetection: true,
		get commandStorageDisabled() {
			return storageDisabled;
		},
		onCommandFinished: finished.event,
	} as unknown as ICommandDetectionCapability;
	owner.add(
		changes.event(() => {
			if (enabled) {
				capabilities.add(TerminalCapability.CwdDetection, cwd);
				capabilities.add(TerminalCapability.CommandDetection, command);
			} else {
				capabilities.remove(TerminalCapability.CwdDetection);
				capabilities.remove(TerminalCapability.CommandDetection);
			}
		}),
	);
	const instance = {
		id: `instance-${id}`,
		instanceId: id,
		capabilities,
		onDidChangeCommandStatus: statuses.event,
		get shellIntegration() {
			return { commandStorageDisabled: storageDisabled };
		},
	} as unknown as ITerminalInstance;
	return {
		instance,
		statuses,
		finished,
		commands,
		enable: (value: boolean) => {
			enabled = value;
			changes.fire();
		},
		disableStorage: () => {
			storageDisabled = true;
			changes.fire();
		},
	};
}

class RecordingChannel extends Disposable {
	readonly lines: string[] = [];
	appendLine(entry: { readonly text: string }): void {
		this.lines.push(entry.text);
	}
}

suite('Terminal capability event lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('screen and process registry leases select one owner and restore a live fallback', () => {
		using owner = new DisposableStore();
		const first = owner.add(new TerminalCapabilityStore());
		const fallback = owner.add(new TerminalCapabilityStore());
		const primaryCwd = owner.add(new CwdDetectionCapability());
		const fallbackCwd = owner.add(new CwdDetectionCapability());
		first.add(TerminalCapability.CwdDetection, primaryCwd);
		fallback.add(TerminalCapability.CwdDetection, fallbackCwd);
		const merged = owner.add(new TerminalCapabilityStoreMultiplexer());
		const events: unknown[] = [];
		owner.add(merged.onDidAddCwdDetectionCapability(capability => events.push(capability)));
		owner.add(merged.onDidRemoveCwdDetectionCapability(() => events.push('removed')));
		const primaryLease = owner.add(merged.add(first));
		const fallbackLease = owner.add(merged.add(fallback));
		assert.equal(merged.get(TerminalCapability.CwdDetection), primaryCwd);
		primaryLease.dispose();
		assert.equal(merged.get(TerminalCapability.CwdDetection), fallbackCwd);
		fallbackLease.dispose();
		assert.deepEqual([...merged.items], []);
		assert.deepEqual(events, [primaryCwd, 'removed', fallbackCwd, 'removed']);
		assert.equal(primaryCwd.isDisposed, false);
		assert.equal(fallbackCwd.isDisposed, false);
	});

	test('directory capability keeps committed history and updates trust without a false directory change', () => {
		using capability = new CwdDetectionCapability();
		const observed: string[] = [];
		using listener = capability.onDidChangeCwd(cwd => observed.push(cwd));
		capability.updateCwd('/one', true);
		capability.updateCwd('/one', false);
		assert.equal(capability.isTrusted, false);
		capability.updateCwd('/two', true);
		capability.updateCwd('/one', true);
		assert.equal(capability.getCwd(), '/one');
		assert.deepEqual(capability.cwds, ['/one', '/two']);
		assert.deepEqual(observed, ['/one', '/two', '/one']);
		capability.cwds.push('/outside');
		assert.deepEqual(capability.cwds, ['/one', '/two']);
	});

	test('capability events carry their implementation and registry disposal releases references without disposing the model', () => {
		using owner = new DisposableStore();
		const registry = owner.add(new TerminalCapabilityStore());
		const cwd = owner.add(new CwdDetectionCapability());
		const added: unknown[] = [];
		const removed: unknown[] = [];
		owner.add(registry.onDidAddCapability(event => added.push(event)));
		owner.add(registry.onDidRemoveCapability(event => removed.push(event)));
		registry.add(TerminalCapability.CwdDetection, cwd);
		assert.deepEqual([...registry.items], [TerminalCapability.CwdDetection]);
		assert.equal(registry.get(TerminalCapability.CwdDetection), cwd);
		registry.remove(TerminalCapability.CwdDetection);
		registry.remove(TerminalCapability.CwdDetection);
		assert.deepEqual(added, [{ id: TerminalCapability.CwdDetection, capability: cwd }]);
		assert.deepEqual(removed, added);
		registry.add(TerminalCapability.CwdDetection, cwd);
		registry.dispose();
		assert.deepEqual([...registry.items], []);
		cwd.updateCwd('/still-owned');
		assert.equal(cwd.getCwd(), '/still-owned');
	});

	test('binds current and newly created capabilities, withdraws them and releases closed-instance listeners', () => {
		using owner = new DisposableStore();
		const added = owner.add(new Emitter<ITerminalInstance>());
		const removed = owner.add(new Emitter<ITerminalInstance>());
		const first = source(owner, 1);
		const mux = owner.add(
			createInstanceCapabilityEventMultiplexer(
				[first.instance],
				added.event,
				removed.event,
				TerminalCapability.CommandDetection,
				capability => capability.onCommandFinished,
			),
		);
		const observed: string[] = [];
		owner.add(mux.event(event => observed.push(event.instance.id)));
		const event = screenCommand('command');
		first.finished.fire(event);
		assert.deepEqual(observed, []);
		first.enable(true);
		first.finished.fire(event);
		first.enable(false);
		assert.equal(first.finished.hasListeners(), false);
		first.finished.fire(event);
		first.enable(true);
		first.finished.fire(event);
		const second = source(owner, 2);
		second.enable(true);
		added.fire(second.instance);
		second.finished.fire(event);
		removed.fire(first.instance);
		first.finished.fire(event);
		assert.equal(first.finished.hasListeners(), false);
		assert.deepEqual(observed, ['instance-1', 'instance-1', 'instance-2']);
		mux.dispose();
		assert.equal(second.finished.hasListeners(), false);
	});

	test('capability getters read the source snapshot without a second command list', () => {
		using owner = new DisposableStore();
		const item = source(owner, 1);
		item.enable(true);
		const detection = item.instance.capabilities!.get(TerminalCapability.CommandDetection)!;
		assert.equal(detection.commands, item.commands);
		item.commands.push(screenCommand('one'));
		assert.equal(detection.commands.length, 1);
		assert.equal(item.instance.capabilities!.get(TerminalCapability.CwdDetection)?.getCwd(), '/committed/cwd');
	});

	test('host diagnostics are lazy, omit untrusted or disabled command text, and release their source', () => {
		using owner = new DisposableStore();
		const item = source(owner, 1);
		item.enable(true);
		const channel = new RecordingChannel();
		let creations = 0;
		const output = {
			createChannel: () => {
				creations++;
				return channel as unknown as IOutputChannel;
			},
		} as unknown as IOutputService;
		const terminals = {
			instances: [item.instance],
			onDidCreateInstance: owner.add(new Emitter<ITerminalInstance>()).event,
			onDidDisposeInstance: owner.add(new Emitter<ITerminalInstance>()).event,
		} as unknown as ITerminalService;
		const diagnostics = owner.add(new AgentHostOutputChannel(terminals, output));
		assert.equal(creations, 0);
		item.statuses.fire({ commandId: 'one', status: 'succeeded', exitCode: 0, isTrusted: true, command: 'allowed' });
		item.statuses.fire({ commandId: 'two', status: 'failed', exitCode: 1, isTrusted: false, command: 'untrusted' });
		item.disableStorage();
		item.statuses.fire({
			commandId: 'three',
			status: 'succeeded',
			exitCode: 0,
			isTrusted: true,
			command: 'disabled',
		});
		assert.equal(creations, 1);
		assert.equal(JSON.parse(channel.lines[0]!).command, 'allowed');
		assert.equal(JSON.parse(channel.lines[1]!).command, undefined);
		assert.equal(JSON.parse(channel.lines[2]!).command, undefined);
		diagnostics.dispose();
		assert.equal(channel.isDisposed, true);
		assert.equal(item.statuses.hasListeners(), false);
	});
});
