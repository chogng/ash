import { ITerminalQuickFixService, type ITerminalQuickFixProvider } from '../../browser/quickFix.js';
import { TerminalQuickFixService } from '../../browser/terminalQuickFixService.js';
import { IExtensionService } from '../../../../../services/extensions/common/extensionService.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TerminalCapability, type ICommandDetectionCapability, type ITerminalCommand } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { TerminalCommand } from '../../../../../../platform/terminal/common/capabilities/commandDetection/terminalCommand.js';
import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import type { ITerminalCommandScreen } from '../../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import '../../browser/terminal.quickFix.contribution.js';

const typoOutput = "git: 'sttatus' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus";
const upstreamOutput = 'fatal: The current branch topic has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin topic';

function completedCommand(text: string, output: string, exitCode = 1): ITerminalCommand {
	const lines = [...output.split('\n'), ''];
	const buffer = {
		cursorX: 0,
		length: lines.length,
		getLine: (line: number) => ({
			isWrapped: false,
			translateToString: (_trim: boolean, start: number, end: number) => lines[line]!.slice(start, end),
		}),
	};
	const marker = (line: number) => {
		let disposed = false;
		return {
			id: line,
			line,
			get isDisposed() {
				return disposed;
			},
			onDispose: Event.None,
			dispose() {
				disposed = true;
			},
		};
	};
	return new TerminalCommand({ cols: 4096, buffer: { normal: buffer, active: buffer } } as unknown as ITerminalCommandScreen, {
		command: text,
		commandLineConfidence: 'high',
		isTrusted: false,
		timestamp: 1,
		duration: 1,
		id: 'failed',
		cwd: '/workspace',
		exitCode,
		commandStartLineContent: text,
		markProperties: undefined,
		startX: 0,
		executedX: 0,
		marker: marker(0),
		executedMarker: marker(0),
		endMarker: marker(lines.length - 1),
	});
}

function fixture(command = completedCommand('git sttatus', typoOutput), initialInput = '') {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const quickFixes = lifetime.add(new TerminalQuickFixService());
	services.registerInstance(ITerminalQuickFixService, quickFixes);
	services.registerInstance(IExtensionService, {
		activateByEvent: async () => undefined,
	} as unknown as IExtensionService);
	const opened: string[] = [];
	services.registerInstance(IOpenerService, {
		open: async resource => {
			opened.push(resource.toString());
			return true;
		},
	} as IOpenerService);
	const capabilities = lifetime.add(new TerminalCapabilityStore());
	const changedInput = lifetime.add(new Emitter<void>());
	const started = lifetime.add(new Emitter<ITerminalCommand>());
	const finished = lifetime.add(new Emitter<ITerminalCommand>());
	const invalidated = lifetime.add(new Emitter<ITerminalCommand[]>());
	const activeChanged = lifetime.add(new Emitter<ITerminalInstance | undefined>());
	const stateChanged = lifetime.add(new Emitter<ITerminalInstance['state']>());
	const exited = lifetime.add(new Emitter<number | undefined>());
	const disposed = lifetime.add(new Emitter<ITerminalInstance>());
	const workspaceChanged = lifetime.add(new Emitter<void>());
	const rawInput = lifetime.add(new Emitter<string>());
	let input = initialInput;
	let processId = 1;
	const commands = [command];
	const detection = {
		type: TerminalCapability.CommandDetection,
		commands,
		promptInputModel: {
			state: PromptInputState.Input,
			get value() {
				return input;
			},
			get cursorIndex() {
				return input.length;
			},
			ghostTextIndex: -1,
			onDidChangeInput: changedInput.event,
			onDidInterrupt: Event.None,
		},
		onCommandStarted: started.event,
		onCommandExecuted: Event.None,
		onCommandFinished: finished.event,
		onCommandInvalidated: invalidated.event,
		onCurrentCommandInvalidated: Event.None,
	} as unknown as ICommandDetectionCapability;
	capabilities.add(TerminalCapability.CommandDetection, detection);
	const sent: Array<{ text: string; execute: boolean; paste: boolean | undefined }> = [];
	let focusCount = 0;
	const instance = {
		capabilities,
		state: 'running',
		get processId() {
			return processId;
		},
		onDidChangeState: stateChanged.event,
		onDidExit: exited.event,
		xterm: {
			isDisposed: false,
			raw: { buffer: { active: { type: 'normal' } }, onData: rawInput.event },
			focus: () => focusCount++,
		},
		sendText: async (text: string, execute: boolean, paste?: boolean) => {
			sent.push({ text, execute, paste });
		},
	} as unknown as ITerminalInstance;
	let activeInstance: ITerminalInstance | undefined = instance;
	services.registerInstance(ITerminalService, {
		get activeInstance() {
			return activeInstance;
		},
		instances: [instance],
		onDidChangeActiveInstance: activeChanged.event,
		onDidDisposeInstance: disposed.event,
	} as unknown as ITerminalService);
	services.registerInstance(IWorkspaceContextService, {
		onDidChangeWorkspace: workspaceChanged.event,
		onDidChangeWorkspaceFolders: Event.None,
	} as unknown as IWorkspaceContextService);
	const accepted = lifetime.add(new Emitter<{ inBackground: boolean }>());
	const hidden = lifetime.add(new Emitter<void>());
	const shown = new DeferredPromise<void>();
	const itemChanges = lifetime.add(new Emitter<readonly IQuickPickItem[]>());
	let items: readonly IQuickPickItem[] = [];
	const picker = {
		get items() {
			return items;
		},
		set items(value: readonly IQuickPickItem[]) {
			items = value;
			itemChanges.fire(value);
		},
		selectedItems: [] as IQuickPickItem[],
		placeholder: '',
		onDidAccept: accepted.event,
		onDidHide: hidden.event,
		show: () => {
			void shown.complete();
		},
		hide: () => hidden.fire(),
		dispose() {},
		[Symbol.dispose]() {},
	} as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		instance,
		picker,
		sent,
		shown: shown.p,
		commands,
		quickFixes,
		opened,
		waitForItems: (predicate: (items: readonly IQuickPickItem[]) => boolean): Promise<void> =>
			new Promise(resolve => {
				if (predicate(items)) {
					resolve();
					return;
				}
				const listener = lifetime.add(
					itemChanges.event(value => {
						if (predicate(value)) {
							listener.dispose();
							resolve();
						}
					}),
				);
			}),
		run: () => services.invokeFunction(CommandsRegistry.getCommand('workbench.action.terminal.showQuickFixes')!),
		accept: (index = 0) => {
			picker.selectedItems = [picker.items[index]! as IQuickPickItem];
			accepted.fire({ inBackground: false });
		},
		cancel: () => picker.hide(),
		focusCount: () => focusCount,
		input: (value: string) => {
			input = value;
			changedInput.fire();
		},
		switch: () => {
			activeInstance = undefined;
			activeChanged.fire(undefined);
			activeInstance = instance;
			activeChanged.fire(instance);
		},
		reconnect: () => {
			stateChanged.fire('reconnecting');
			stateChanged.fire('running');
		},
		replace: () => {
			processId++;
		},
		exit: () => exited.fire(0),
		disposeInstance: () => disposed.fire(instance),
		startCommand: () => started.fire(command),
		finishCommand: () => {
			commands.push(completedCommand('echo newer', 'newer', 0));
			finished.fire(commands.at(-1)!);
		},
		invalidate: () => {
			commands.length = 0;
			invalidated.fire([command]);
		},
		removeCapability: () => capabilities.remove(TerminalCapability.CommandDetection),
		workspaceChange: () => workspaceChanged.fire(),
		rawInput: () => rawInput.fire('typed before echo'),
	};
}

for (const [text, output, expected] of [
	['git sttatus', typoOutput, ['git status']],
	['git pu --verbose', "git: 'pu' is not a git command. See 'git --help'.\nThe most similar commands are\n\tpull\n\tpush", ['git pull --verbose', 'git push --verbose']],
	['git push', upstreamOutput, ['git push --set-upstream origin topic']],
	['git push origin 分支', upstreamOutput.replaceAll('topic', '分支'), ['git push --set-upstream origin 分支']],
] as const) {
	test(`Terminal Quick Fixes inserts an accepted output-backed suggestion for ${text} without executing`, async () => {
		using state = fixture(completedCommand(text, output));
		const operation = state.run();
		await state.shown;
		assert.deepEqual(
			state.picker.items.map(item => item.label),
			expected,
		);
		assert.deepEqual(state.sent, []);
		state.accept();
		await operation;
		assert.deepEqual(state.sent, [{ text: expected[0], execute: false, paste: true }]);
		assert.equal(state.focusCount(), 1);
	});
}

test('Terminal Quick Fixes cancellation and existing prompt input never write to the shell', async () => {
	for (const input of ['', 'pending command']) {
		using state = fixture(undefined, input);
		const operation = state.run();
		await state.shown;
		if (input) {
			assert.deepEqual(state.picker.items, []);
			assert.match(state.picker.placeholder ?? '', /current input is preserved/u);
		}
		state.cancel();
		await operation;
		assert.deepEqual(state.sent, []);
	}
});

for (const transition of ['switch', 'reconnect', 'replace', 'exit', 'disposeInstance', 'startCommand', 'finishCommand', 'invalidate', 'removeCapability', 'workspaceChange', 'rawInput'] as const) {
	test(`Terminal Quick Fixes rejects a stale choice after ${transition}`, async () => {
		using state = fixture();
		const operation = state.run();
		await state.shown;
		state[transition]();
		state.accept();
		await operation;
		assert.deepEqual(state.sent, []);
		assert.equal(state.focusCount(), 0);
	});
}

test('Terminal Quick Fixes cancels if shell input changes while the picker is open', async () => {
	using state = fixture();
	const operation = state.run();
	await state.shown;
	state.input('preserve this');
	state.accept();
	await operation;
	assert.deepEqual(state.sent, []);
});

test('Terminal Quick Fixes rejects a chosen suggestion after its retained output is trimmed', async () => {
	const command = completedCommand('git sttatus', typoOutput);
	using state = fixture(command);
	const operation = state.run();
	await state.shown;
	command.endMarker!.dispose();
	state.accept();
	await operation;
	assert.deepEqual(state.sent, []);
});

for (const [text, output, code] of [
	['git sttatus', typoOutput, 0],
	['git status', typoOutput, 1],
	['echo git push', upstreamOutput, 1],
	['git sttatus\necho injected', typoOutput, 1],
	['git sttatus \x1b[31m', typoOutput, 1],
	['git sttatus ; echo injected', typoOutput, 1],
	['git sttatus', typoOutput.replace('\tstatus', '\tstatus; echo injected'), 1],
	['git sttatus', typoOutput.replace('\tstatus', '\tstatus\x03'), 1],
	['git push', upstreamOutput.replace('origin topic', 'origin topic; echo injected'), 1],
	['git push', upstreamOutput.replace('origin topic', 'origin $(echo injected)'), 1],
	['git push', upstreamOutput.replace('origin topic', 'origin unrelated-branch'), 1],
] as const) {
	test(`Terminal Quick Fixes rejects inapplicable or unsafe output (${JSON.stringify(text)}, ${JSON.stringify(output.slice(-35))})`, async () => {
		using state = fixture(completedCommand(text, output, code));
		const operation = state.run();
		await state.shown;
		assert.deepEqual(state.picker.items, []);
		state.cancel();
		await operation;
		assert.deepEqual(state.sent, []);
	});
}

test('Terminal Quick Fixes consumes extension actions through the registered provider and cancels stale requests', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	let receivedSignal: AbortSignal | undefined;
	using registration = state.quickFixes.registerQuickFixProvider('extension/fix', {
		provideTerminalQuickFixes: async (instance, command, signal) => {
			assert.equal(instance, state.instance);
			assert.equal(command.command, 'tool bad');
			receivedSignal = signal;
			return [{ label: 'tool good', terminalCommand: 'tool good', shouldExecute: true }];
		},
	});
	const operation = state.run();
	await state.waitForItems(items => items.some(item => item.label === 'tool good'));
	state.accept();
	await operation;
	assert.deepEqual(state.sent, [{ text: 'tool good', execute: true, paste: true }]);
	assert.equal(receivedSignal?.aborted, true);
});

test('Terminal Quick Fixes rejects a provider result delivered after the prompt changes', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	const pending = new DeferredPromise<readonly import('../../browser/quickFix.js').ITerminalQuickFix[]>();
	const started = new DeferredPromise<AbortSignal>();
	using registration = state.quickFixes.registerQuickFixProvider('extension/fix', {
		provideTerminalQuickFixes: (_instance, _command, signal) => {
			void started.complete(signal);
			return pending.p;
		},
	});
	const operation = state.run();
	const signal = await started.p;
	state.input('preserve');
	assert.equal(signal.aborted, true);
	await pending.complete([{ label: 'late', terminalCommand: 'late' }]);
	await operation;
	assert.deepEqual(state.sent, []);
	assert.deepEqual(state.picker.items, []);
});

test('Terminal Quick Fixes cannot execute an already visible action after its provider is revoked', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	using registration = state.quickFixes.registerQuickFixProvider('extension/fix', {
		provideTerminalQuickFixes: async () => [{ label: 'tool good', terminalCommand: 'tool good', shouldExecute: true }],
	});
	const operation = state.run();
	await state.waitForItems(items => items.some(item => item.label === 'tool good'));
	registration.dispose();
	state.accept();
	await operation;
	assert.deepEqual(state.sent, []);
});

test('Terminal Quick Fixes isolates synchronous and asynchronous provider failures', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	using broken = state.quickFixes.registerQuickFixProvider('extension/broken', {
		provideTerminalQuickFixes: () => {
			throw new Error('Provider failed');
		},
	});
	using rejected = state.quickFixes.registerQuickFixProvider('extension/rejected', {
		provideTerminalQuickFixes: async () => {
			throw new Error('Provider rejected');
		},
	});
	using healthy = state.quickFixes.registerQuickFixProvider('extension/healthy', {
		provideTerminalQuickFixes: async () => [{ label: 'tool good', terminalCommand: 'tool good' }],
	});
	const operation = state.run();
	await state.waitForItems(items => items.some(item => item.label === 'tool good'));
	state.accept();
	await operation;
	assert.deepEqual(state.sent, [{ text: 'tool good', execute: false, paste: true }]);
});

test('Terminal Quick Fixes does not revive a visible action when its provider is registered again', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	const provider: ITerminalQuickFixProvider = {
		provideTerminalQuickFixes: async () => [{ label: 'tool good', terminalCommand: 'tool good', shouldExecute: true }],
	};
	using original = state.quickFixes.registerQuickFixProvider('extension/fix', provider);
	const operation = state.run();
	await state.waitForItems(items => items.some(item => item.label === 'tool good'));
	original.dispose();
	using replacement = state.quickFixes.registerQuickFixProvider('extension/fix', provider);
	state.accept();
	await operation;
	assert.deepEqual(state.sent, []);
});

test('Terminal Quick Fixes discards a pending result from a replaced registration', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	const pending = new DeferredPromise<readonly import('../../browser/quickFix.js').ITerminalQuickFix[]>();
	const provider: ITerminalQuickFixProvider = { provideTerminalQuickFixes: () => pending.p };
	using original = state.quickFixes.registerQuickFixProvider('extension/fix', provider);
	const operation = state.quickFixes.provideTerminalQuickFixes(state.instance, state.commands[0]!, new AbortController().signal);
	original.dispose();
	using replacement = state.quickFixes.registerQuickFixProvider('extension/fix', provider);
	await pending.complete([{ label: 'stale', terminalCommand: 'stale', shouldExecute: true }]);
	assert.deepEqual(await operation, []);
});

test('Terminal Quick Fixes invalidates only the revoked registration of a shared provider', async () => {
	using state = fixture(completedCommand('tool bad', 'failed'));
	const provider: ITerminalQuickFixProvider = {
		provideTerminalQuickFixes: async () => [{ label: 'tool good', terminalCommand: 'tool good' }],
	};
	using first = state.quickFixes.registerQuickFixProvider('extension/first', provider);
	using second = state.quickFixes.registerQuickFixProvider('extension/second', provider);
	const results = await state.quickFixes.provideTerminalQuickFixes(state.instance, state.commands[0]!, new AbortController().signal);
	assert.equal(results.length, 2);
	first.dispose();
	assert.deepEqual(
		results.map(result => result.isValid?.()),
		[false, true],
	);
});

test('Terminal Quick Fixes does not dispatch a cancelled request', async () => {
	using quickFixes = new TerminalQuickFixService();
	let calls = 0;
	using registration = quickFixes.registerQuickFixProvider('extension/fix', {
		provideTerminalQuickFixes: async () => {
			calls++;
			return [];
		},
	});
	const request = new AbortController();
	request.abort();
	assert.deepEqual(await quickFixes.provideTerminalQuickFixes({} as ITerminalInstance, completedCommand('tool bad', 'failed'), request.signal), []);
	assert.equal(calls, 0);
});

for (const transition of ['cancel', 'unregister', 'dispose'] as const) {
	test(`Terminal Quick Fixes settles after ${transition} even when a provider ignores cancellation`, async () => {
		using state = fixture(completedCommand('tool bad', 'failed'));
		const pending = new DeferredPromise<readonly import('../../browser/quickFix.js').ITerminalQuickFix[]>();
		let providerSignal: AbortSignal | undefined;
		using registration = state.quickFixes.registerQuickFixProvider('extension/pending', {
			provideTerminalQuickFixes: (_instance, _command, signal) => {
				providerSignal = signal;
				return pending.p;
			},
		});
		using healthy = state.quickFixes.registerQuickFixProvider('extension/healthy', {
			provideTerminalQuickFixes: async () => [{ label: 'healthy', terminalCommand: 'healthy' }],
		});
		const request = new AbortController();
		const operation = state.quickFixes.provideTerminalQuickFixes(state.instance, state.commands[0]!, request.signal);
		if (transition === 'cancel') request.abort();
		else if (transition === 'unregister') registration.dispose();
		else state.quickFixes.dispose();
		const result = await operation;
		assert.equal(providerSignal?.aborted, true);
		assert.deepEqual(
			result.map(item => item.label),
			transition === 'unregister' ? ['healthy'] : [],
		);
		await pending.error(new Error('Late provider failure'));
	});
}

test('Terminal Quick Fixes rejects registration after the window service is disposed', () => {
	using service = new TerminalQuickFixService();
	service.dispose();
	assert.throws(() => service.registerQuickFixProvider('extension/late', { provideTerminalQuickFixes: async () => [] }), isCancellationError);
});
