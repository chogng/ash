import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
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
		cursorX: 0, length: lines.length,
		getLine: (line: number) => ({ isWrapped: false, translateToString: (_trim: boolean, start: number, end: number) => lines[line]!.slice(start, end) }),
	};
	const marker = (line: number) => {
		let disposed = false;
		return { id: line, line, get isDisposed() { return disposed; }, onDispose: Event.None, dispose() { disposed = true; } };
	};
	return new TerminalCommand({ cols: 4096, buffer: { normal: buffer, active: buffer } } as unknown as ITerminalCommandScreen, {
		command: text, commandLineConfidence: 'high', isTrusted: false, timestamp: 1, duration: 1, id: 'failed', cwd: '/workspace', exitCode,
		commandStartLineContent: text, markProperties: undefined, startX: 0, executedX: 0,
		marker: marker(0), executedMarker: marker(0), endMarker: marker(lines.length - 1),
	});
}

function fixture(command = completedCommand('git sttatus', typoOutput), initialInput = '') {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
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
		type: TerminalCapability.CommandDetection, commands,
		promptInputModel: {
			state: PromptInputState.Input, get value() { return input; }, get cursorIndex() { return input.length; }, ghostTextIndex: -1,
			onDidChangeInput: changedInput.event, onDidInterrupt: Event.None,
		},
		onCommandStarted: started.event, onCommandExecuted: Event.None, onCommandFinished: finished.event,
		onCommandInvalidated: invalidated.event, onCurrentCommandInvalidated: Event.None,
	} as unknown as ICommandDetectionCapability;
	capabilities.add(TerminalCapability.CommandDetection, detection);
	const sent: Array<{ text: string; execute: boolean; paste: boolean | undefined; }> = [];
	let focusCount = 0;
	const instance = {
		capabilities, state: 'running', get processId() { return processId; },
		onDidChangeState: stateChanged.event, onDidExit: exited.event,
		xterm: { isDisposed: false, raw: { buffer: { active: { type: 'normal' } }, onData: rawInput.event }, focus: () => focusCount++ },
		sendText: async (text: string, execute: boolean, paste?: boolean) => { sent.push({ text, execute, paste }); },
	} as unknown as ITerminalInstance;
	let activeInstance: ITerminalInstance | undefined = instance;
	services.registerInstance(ITerminalService, {
		get activeInstance() { return activeInstance; }, instances: [instance], onDidChangeActiveInstance: activeChanged.event, onDidDisposeInstance: disposed.event,
	} as unknown as ITerminalService);
	services.registerInstance(IWorkspaceContextService, { onDidChangeWorkspace: workspaceChanged.event, onDidChangeWorkspaceFolders: Event.None } as unknown as IWorkspaceContextService);
	const accepted = lifetime.add(new Emitter<{ inBackground: boolean; }>());
	const hidden = lifetime.add(new Emitter<void>());
	const shown = new DeferredPromise<void>();
	const picker = {
		items: [] as IQuickPickItem[], selectedItems: [] as IQuickPickItem[], placeholder: '',
		onDidAccept: accepted.event, onDidHide: hidden.event,
		show: () => { void shown.complete(); }, hide: () => hidden.fire(), dispose() { }, [Symbol.dispose]() { },
	} as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	return {
		[Symbol.dispose]: () => lifetime.dispose(), instance, picker, sent, shown: shown.p, commands,
		run: () => services.invokeFunction(CommandsRegistry.getCommand('workbench.action.terminal.showQuickFixes')!),
		accept: () => { picker.selectedItems = [picker.items[0]! as IQuickPickItem]; accepted.fire({ inBackground: false }); },
		cancel: () => picker.hide(),
		focusCount: () => focusCount,
		input: (value: string) => { input = value; changedInput.fire(); },
		switch: () => { activeInstance = undefined; activeChanged.fire(undefined); activeInstance = instance; activeChanged.fire(instance); },
		reconnect: () => { stateChanged.fire('reconnecting'); stateChanged.fire('running'); },
		replace: () => { processId++; },
		exit: () => exited.fire(0),
		disposeInstance: () => disposed.fire(instance),
		startCommand: () => started.fire(command),
		finishCommand: () => { commands.push(completedCommand('echo newer', 'newer', 0)); finished.fire(commands.at(-1)!); },
		invalidate: () => { commands.length = 0; invalidated.fire([command]); },
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
		assert.deepEqual(state.picker.items.map(item => item.label), expected);
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
