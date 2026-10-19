import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { ITerminalQuickFixService, type ITerminalQuickFix } from './quickFix.js';
import { TerminalQuickFixService } from './terminalQuickFixService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TerminalCapability, type ITerminalCommand } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';

registerSingleton(ITerminalQuickFixService, TerminalQuickFixService, InstantiationType.Delayed);

interface QuickFixPick extends IQuickPickItem { readonly fix: ITerminalQuickFix; }

const enum TerminalQuickFixCommandId {
	ShowQuickFixes = 'workbench.action.terminal.showQuickFixes',
}

/** Suggestions only use a completed command's retained output, never the live screen. */
function commandFixes(command: ITerminalCommand | undefined): string[] {
	if (!command || command.wasReplayed || command.exitCode === undefined || command.exitCode === 0 || command.command.length > 4096
		|| /[\x00-\x08\x0a-\x1f\x7f;&|<>`$()]/u.test(command.command)) return [];
	const invocation = /^\s*git[ \t]+([a-z][a-z0-9-]*)([ \t]+[^\r\n]*)?$/u.exec(command.command);
	if (!invocation) return [];
	const fixes = new Set<string>();
	const typo = command.getOutputMatch({ lineMatcher: /^git: '([^']+)' is not a git command\./u, anchor: 'top', offset: 0, length: 40, multipleMatches: true });
	if (typo?.regexMatch[1] === invocation[1]) {
		const header = typo.outputLines.findIndex(line => /^The most similar commands? (?:is|are)\s*$/u.test(line.trim()));
		if (header >= 0) {
			for (const line of typo.outputLines.slice(header + 1, header + 7)) {
				if (!line.trim()) continue;
				const candidate = /^[ \t]+([a-z][a-z0-9-]{0,63})[ \t]*$/u.exec(line)?.[1];
				if (!candidate) break;
				if (candidate !== invocation[1]) fixes.add(`git ${candidate}${invocation[2] ?? ''}`);
			}
		}
	}
	if (invocation[1] === 'push') {
		const upstream = command.getOutputMatch({ lineMatcher: /^fatal: The current branch (\S+) has no upstream branch\.$/u, anchor: 'top', offset: 0, length: 40, multipleMatches: true });
		if (upstream) {
			for (const line of upstream.outputLines) {
				// Only a literal, single Git invocation is eligible. Shell operators,
				// escapes, substitutions and control characters in output are rejected.
				const candidate = /^[ \t]*git push --set-upstream ([\p{L}\p{N}][\p{L}\p{N}._/-]{0,255}) ([\p{L}\p{N}][\p{L}\p{N}._/-]{0,255})[ \t]*$/u.exec(line);
				if (candidate && candidate[2] === upstream.regexMatch[1]) fixes.add(`git push --set-upstream ${candidate[1]} ${candidate[2]}`);
			}
		}
	}
	return [...fixes];
}

registerAction2(class ShowTerminalQuickFixesAction extends Action2 {
	constructor() {
		super({
			id: TerminalQuickFixCommandId.ShowQuickFixes,
			title: localize2('workbench.action.terminal.showQuickFixes', 'Show Terminal Quick Fixes'),
			f1: true,
			precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.Period, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const terminals = accessor.get(ITerminalService);
		const instance = terminals.activeInstance;
		const screen = instance?.xterm;
		if (!instance || instance.isReadOnly || instance.state !== 'running' || !screen || screen.isDisposed) return;
		const detection = instance.capabilities?.get(TerminalCapability.CommandDetection);
		const command = detection?.commands.at(-1);
		const processId = instance.processId;
		const prompt = detection?.promptInputModel;
		const workspace = accessor.get(IWorkspaceContextService);
		const emptyInput = (): boolean => !!prompt && prompt.state === PromptInputState.Input && prompt.value === '' && prompt.cursorIndex === 0
			&& prompt.ghostTextIndex < 0 && screen.raw.buffer.active.type === 'normal';
		using lifetime = new DisposableStore();
		const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<QuickFixPick>());
		picker.ariaLabel = localize('terminal.quickFix.aria', 'Terminal Quick Fixes');
		const fixes = emptyInput() && !detection?.executingCommandObject ? commandFixes(command) : [];
		picker.items = fixes.map(label => ({ label, fix: { label, terminalCommand: label }, description: localize('terminal.quickFix.insert', 'Insert command'), detail: localize('terminal.quickFix.detail', 'Review the inserted command, then press Enter to run it.') }));
		const builtInItems = picker.items;
		picker.placeholder = !emptyInput()
			? localize('terminal.quickFix.inputNotEmpty', 'Quick fixes require an empty shell prompt; current input is preserved')
			: fixes.length ? localize('terminal.quickFix.choose', 'Select a fix to insert without running it') : localize('terminal.quickFix.empty', 'No quick fixes for the latest failed command');
		const request = new AbortController();
		lifetime.add(toDisposable(() => request.abort()));
		let retired = false;
		const retire = (): void => { retired = true; request.abort(); picker.hide(); };
		lifetime.add(instance.onDidChangeState(retire));
		lifetime.add(instance.onDidExit(retire));
		lifetime.add(terminals.onDidChangeActiveInstance(retire));
		lifetime.add(terminals.onDidDisposeInstance(disposed => { if (disposed === instance) retire(); }));
		lifetime.add(workspace.onDidChangeWorkspace(retire));
		lifetime.add(workspace.onDidChangeWorkspaceFolders(retire));
		const rawInput = screen.raw.onData(retire);
		lifetime.add(toDisposable(() => rawInput.dispose()));
		if (instance.capabilities) lifetime.add(instance.capabilities.onDidChangeCapabilities(retire));
		if (detection) {
			lifetime.add(detection.onCommandStarted(retire));
			lifetime.add(detection.onCommandExecuted(retire));
			lifetime.add(detection.onCommandFinished(retire));
			lifetime.add(detection.onCommandInvalidated(retire));
			lifetime.add(detection.onCurrentCommandInvalidated(retire));
			lifetime.add(detection.promptInputModel.onDidChangeInput(retire));
			lifetime.add(detection.promptInputModel.onDidInterrupt(retire));
		}
		const extensionService = accessor.get(IExtensionService);
		const providers = accessor.get(ITerminalQuickFixService);
		const opener = accessor.get(IOpenerService);
		if (command && !command.wasReplayed && command.exitCode !== undefined && emptyInput() && !detection?.executingCommandObject) {
			picker.busy = true;
			void extensionService.activateByEvent('onTerminal:terminalQuickFixProvider', request.signal).then(() => providers.provideTerminalQuickFixes(instance, command, request.signal)).then(results => {
				if (retired || request.signal.aborted || !emptyInput()) return;
				picker.items = [...picker.items, ...results.map(fix => ({ label: fix.label, fix }))];
				if (picker.items.length) picker.placeholder = localize('terminal.quickFix.chooseAction', 'Choose a quick fix');
			}).catch(() => undefined).finally(() => { if (!request.signal.aborted) picker.busy = false; });
		}
		let accepted: QuickFixPick | undefined;
		const selected = await new Promise<QuickFixPick | undefined>(resolve => {
			lifetime.add(picker.onDidAccept(() => { accepted = picker.selectedItems[0]; picker.hide(); }));
			lifetime.add(picker.onDidHide(() => resolve(accepted)));
			lifetime.add(toDisposable(() => resolve(undefined)));
			picker.show();
		});
		const current = (): boolean => !retired && terminals.activeInstance === instance && terminals.instances.includes(instance)
			&& instance.processId === processId && instance.state === 'running' && !instance.isReadOnly && !screen.isDisposed && instance.xterm === screen;
		if (selected && selected.fix.isValid?.() !== false && current() && detection === instance.capabilities?.get(TerminalCapability.CommandDetection)
			&& command === detection?.commands.at(-1) && !detection?.executingCommandObject && emptyInput() && picker.items.includes(selected) && (!builtInItems.includes(selected) || commandFixes(command).includes(selected.label))) {
			if (selected.fix.terminalCommand !== undefined) await instance.sendText(selected.fix.terminalCommand, selected.fix.shouldExecute === true, true);
			else if (selected.fix.uri) await opener.open(selected.fix.uri, { fromUserGesture: true, allowCommands: false });
			else await selected.fix.run?.();
		}
		if (current()) instance.xterm?.focus();
	}
});
