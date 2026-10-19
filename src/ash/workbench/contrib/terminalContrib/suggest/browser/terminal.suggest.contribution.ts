import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { posix } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileKind, IFileService } from '../../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { PosixShellType } from '../../../../../platform/terminal/common/terminal.js';
import { escapeNonWindowsPath } from '../../../../../platform/terminal/common/terminalEnvironment.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalCommandHistory } from '../../history/common/history.js';
import { TerminalSuggestCommandId } from '../common/terminal.suggest.js';

interface CompletionPick extends IQuickPickItem {
	readonly inputData: string;
}

/** Appends literal suffixes only; the shell remains the owner of editing and Tab completion. */
registerAction2(class TerminalTriggerSuggestAction extends Action2 {
	constructor() {
		super({
			id: TerminalSuggestCommandId.TriggerSuggest,
			title: localize2('terminal.suggest.trigger', 'Terminal: Trigger Suggest'),
			f1: true,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Space,
				mac: { primary: KeyMod.WinCtrl | KeyCode.Space },
				when: TerminalContextKeys.focus.isEqualTo(true),
				weight: KeybindingWeight.WorkbenchContrib + 1,
			},
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const terminals = accessor.get(ITerminalService);
		const instance = terminals.activeInstance;
		const screen = instance?.xterm;
		const capability = instance?.capabilities?.get(TerminalCapability.CommandDetection);
		const model = capability?.promptInputModel;
		if (!instance || instance.isReadOnly || instance.state !== 'running' || !screen || !model || screen.raw.buffer.active.type !== 'normal'
			|| model.state !== PromptInputState.Input || model.cursorIndex !== model.value.length || model.ghostTextIndex >= 0 || /[\x00-\x1f\x7f]/.test(model.value)) return;
		const prefix = model.value;
		const processId = instance.processId;
		const profileId = instance.profile.profileId;
		const shell = instance.shellType;
		const cwd = capability.cwd ?? instance.cwd ?? instance.initialCwd;
		const workspace = accessor.get(IWorkspaceContextService);
		const folder = workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
		const history = new TerminalCommandHistory(accessor.get(IConfigurationService), accessor.get(IStorageService));
		const items: CompletionPick[] = history.getCommands(profileId)
			.filter(entry => entry.command.startsWith(prefix) && entry.command.length > prefix.length && !/[\x00-\x1f\x7f]/.test(entry.command))
			.slice(0, 200)
			.map(entry => ({ label: entry.command, inputData: entry.command.slice(prefix.length), description: localize('terminal.suggest.history', 'Command history') }));
		using lifetime = new DisposableStore();
		const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<CompletionPick>());
		picker.ariaLabel = localize('terminal.suggest.ariaLabel', 'Terminal suggestions');
		picker.placeholder = localize('terminal.suggest.placeholder', 'Select a suggestion to insert without running it');
		picker.items = items;
		picker.sortByLabel = false;
		let retired = false;
		const retire = (): void => { retired = true; picker.hide(); };
		lifetime.add(toDisposable(() => { retired = true; }));
		for (const event of [model.onDidStartInput, model.onDidChangeInput, model.onDidFinishInput, model.onDidInterrupt]) lifetime.add(event(retire));
		lifetime.add(instance.onDidChangeState(retire));
		lifetime.add(instance.onDidExit(retire));
		lifetime.add(terminals.onDidChangeActiveInstance(retire));
		lifetime.add(workspace.onDidChangeWorkspace(retire));
		lifetime.add(instance.capabilities!.onDidChangeCapabilities(retire));
		lifetime.add(terminals.onDidDisposeInstance(disposed => { if (disposed === instance) retire(); }));
		const typed = screen.raw.onData(retire);
		lifetime.add(toDisposable(() => typed.dispose()));
		const canSend = (): boolean => !retired && instance.state === 'running' && !instance.isReadOnly
			&& terminals.activeInstance === instance && terminals.instances.includes(instance) && instance.processId === processId
			&& instance.profile.profileId === profileId && instance.shellType === shell && instance.xterm === screen && !screen.isDisposed
			&& instance.capabilities?.get(TerminalCapability.CommandDetection) === capability && model.state === PromptInputState.Input
			&& model.value === prefix && model.cursorIndex === prefix.length && model.ghostTextIndex < 0
			&& (capability.cwd ?? instance.cwd ?? instance.initialCwd) === cwd && screen.raw.buffer.active.type === 'normal';
		// The file provider may complete after Escape, input changes or a terminal switch.
		// Keep its result local until the original prompt's lifetime is still current.
		if (folder && (shell === PosixShellType.Bash || shell === PosixShellType.Zsh)) {
			picker.busy = true;
			void pathCompletions(prefix, cwd, folder, accessor.get(IPathService), accessor.get(IFileService)).then(paths => {
				if (!canSend()) return;
				picker.busy = false;
				picker.items = [...items, ...paths];
			});
		}
		let selected: CompletionPick | undefined;
		await new Promise<void>(resolve => {
			lifetime.add(picker.onDidAccept(() => { selected = picker.selectedItems[0]; picker.hide(); }));
			lifetime.add(picker.onDidHide(resolve));
			picker.show();
		});
		if (!selected || !canSend()) return;
		await instance.sendText(selected.inputData, false);
		if (canSend()) screen.focus();
	}
});

async function pathCompletions(prefix: string, cwd: string, folder: IWorkspaceFolder, paths: IPathService, files: IFileService): Promise<CompletionPick[]> {
	// A partial quote, expansion, escape or shell operator needs a shell-owned parser.
	// Restrict this producer to plain tokens rather than guessing the shell's editing rules.
	if (!/^[\p{L}\p{N}._/@%+=~ -]*$/u.test(prefix)) return [];
	const token = prefix.slice(prefix.lastIndexOf(' ') + 1);
	if (token.startsWith('~') || !token.includes('/') && !prefix.includes(' ')) return [];
	try {
		const rules = await paths.getPath(folder.uri);
		const root = await paths.getHostPath(folder.uri);
		if (rules !== posix || !root || !rules.isAbsolute(cwd)) return [];
		const slash = token.lastIndexOf('/');
		const directory = rules.resolve(cwd, slash < 0 ? '.' : token.slice(0, slash + 1));
		const relative = rules.relative(root, directory);
		if (relative === '..' || relative.startsWith('../') || rules.isAbsolute(relative)) return [];
		const resource = relative ? URI.joinPath(folder.uri, relative) : folder.uri;
		const typedName = token.slice(slash + 1);
		const entries = await files.readDirectory(resource);
		return entries.filter(entry => (entry.kind === FileKind.File || entry.kind === FileKind.Directory)
			&& entry.name.startsWith(typedName) && !/[\x00-\x1f\x7f]/.test(entry.name)).slice(0, 200).flatMap(entry => {
				const suffix = entry.name.slice(typedName.length) + (entry.kind === FileKind.Directory ? '/' : '');
				if (!suffix) return [];
				return [{
					label: token.slice(0, slash + 1) + entry.name + (entry.kind === FileKind.Directory ? '/' : ''),
					inputData: /^[\p{L}\p{N}._/@%+=-]*$/u.test(suffix) ? suffix : escapeNonWindowsPath(suffix),
					description: entry.kind === FileKind.Directory ? localize('terminal.suggest.folder', 'Folder') : localize('terminal.suggest.file', 'File'),
				}];
			});
	} catch { return []; }
}
