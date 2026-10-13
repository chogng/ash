import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalCapability, type TerminalCommandSnapshot } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalCapabilityStore } from '../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import type { IOutputChannel, IOutputService } from '../../../../services/output/common/output.js';
import type { ITerminalInstance, ITerminalService } from '../../../../services/terminal/browser/terminal.js';
import { createInstanceCapabilityEventMultiplexer } from '../../browser/terminalEvents.js';
import { AgentHostOutputChannel } from '../../browser/agentHostOutputChannel.js';

function source(owner: DisposableStore, id: number) {
	const changes = owner.add(new Emitter<void>());
	const statuses = owner.add(new Emitter<TerminalCommandSnapshot>());
	let enabled = false;
	let storageDisabled = false;
	const commands: TerminalCommandSnapshot[] = [];
	const capabilities = owner.add(new TerminalCapabilityStore(() => enabled ? {
		commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: storageDisabled, commands,
	} : undefined, () => '/committed/cwd', changes.event, statuses.event));
	const instance = { id: `instance-${id}`, instanceId: id, capabilities } as unknown as ITerminalInstance;
	return { instance, statuses, commands, enable: (value: boolean) => { enabled = value; changes.fire(); }, disableStorage: () => { storageDisabled = true; changes.fire(); } };
}

class RecordingChannel extends Disposable {
	readonly lines: string[] = [];
	appendLine(entry: { readonly text: string; }): void { this.lines.push(entry.text); }
}

suite('Terminal capability event lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('binds current and newly created capabilities, withdraws them and releases closed-instance listeners', () => {
		using owner = new DisposableStore();
		const added = owner.add(new Emitter<ITerminalInstance>());
		const removed = owner.add(new Emitter<ITerminalInstance>());
		const first = source(owner, 1);
		const mux = owner.add(createInstanceCapabilityEventMultiplexer([first.instance], added.event, removed.event, TerminalCapability.CommandDetection, capability => capability.onCommandFinished));
		const observed: string[] = [];
		owner.add(mux.event(event => observed.push(event.instance.id)));
		const event: TerminalCommandSnapshot = { commandId: 'command', status: 'succeeded', exitCode: 0 };
		first.statuses.fire(event);
		assert.deepEqual(observed, []);
		first.enable(true);
		first.statuses.fire(event);
		first.enable(false);
		assert.equal(first.statuses.hasListeners(), false);
		first.statuses.fire(event);
		first.enable(true);
		first.statuses.fire(event);
		const second = source(owner, 2);
		second.enable(true);
		added.fire(second.instance);
		second.statuses.fire(event);
		removed.fire(first.instance);
		first.statuses.fire(event);
		assert.equal(first.statuses.hasListeners(), false);
		assert.deepEqual(observed, ['instance-1', 'instance-1', 'instance-2']);
		mux.dispose();
		assert.equal(second.statuses.hasListeners(), false);
	});

	test('capability getters read the source snapshot without a second command list', () => {
		using owner = new DisposableStore();
		const item = source(owner, 1);
		item.enable(true);
		const detection = item.instance.capabilities!.get(TerminalCapability.CommandDetection)!;
		assert.equal(detection.commands, item.commands);
		item.commands.push({ commandId: 'one', status: 'failed', exitCode: 1 });
		assert.equal(detection.commands.length, 1);
		assert.equal(item.instance.capabilities!.get(TerminalCapability.CwdDetection)?.getCwd(), '/committed/cwd');
	});

	test('host diagnostics are lazy, omit untrusted or disabled command text, and release their source', () => {
		using owner = new DisposableStore();
		const item = source(owner, 1);
		item.enable(true);
		const channel = new RecordingChannel();
		let creations = 0;
		const output = { createChannel: () => { creations++; return channel as unknown as IOutputChannel; } } as unknown as IOutputService;
		const terminals = { instances: [item.instance], onDidCreateInstance: owner.add(new Emitter<ITerminalInstance>()).event, onDidDisposeInstance: owner.add(new Emitter<ITerminalInstance>()).event } as unknown as ITerminalService;
		const diagnostics = owner.add(new AgentHostOutputChannel(terminals, output));
		assert.equal(creations, 0);
		item.statuses.fire({ commandId: 'one', status: 'succeeded', exitCode: 0, isTrusted: true, command: 'allowed' });
		item.statuses.fire({ commandId: 'two', status: 'failed', exitCode: 1, isTrusted: false, command: 'untrusted' });
		item.disableStorage();
		item.statuses.fire({ commandId: 'three', status: 'succeeded', exitCode: 0, isTrusted: true, command: 'disabled' });
		assert.equal(creations, 1);
		assert.equal(JSON.parse(channel.lines[0]!).command, 'allowed');
		assert.equal(JSON.parse(channel.lines[1]!).command, undefined);
		assert.equal(JSON.parse(channel.lines[2]!).command, undefined);
		diagnostics.dispose();
		assert.equal(channel.isDisposed, true);
		assert.equal(item.statuses.hasListeners(), false);
	});
});
