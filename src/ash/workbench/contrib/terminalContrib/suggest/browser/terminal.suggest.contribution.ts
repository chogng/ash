import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { ITerminalCompletionService, TerminalCompletionService } from './terminalCompletionService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
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
import { ITerminalService, type ITerminalContribution, type IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalCommandHistory } from '../../history/common/history.js';
import { TerminalSuggestCommandId } from '../common/terminal.suggest.js';

registerSingleton(ITerminalCompletionService, TerminalCompletionService, InstantiationType.Delayed);

interface CompletionPick extends IQuickPickItem {
	readonly inputData: string;
	readonly isValid?: () => boolean;
}

/** Applies accepted provider ranges through the existing shell input owner. */
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

	public override async run(accessor: ServicesAccessor, triggerCharacter?: string): Promise<void> {
		if (triggerCharacter !== undefined && (typeof triggerCharacter !== 'string' || [...triggerCharacter].length !== 1)) return;
		const terminals = accessor.get(ITerminalService);
		const instance = terminals.activeInstance;
		const screen = instance?.xterm;
		const capability = instance?.capabilities?.get(TerminalCapability.CommandDetection);
		const model = capability?.promptInputModel;
		if (!instance || instance.isReadOnly || instance.state !== 'running' || !screen || !model || screen.raw.buffer.active.type !== 'normal'
			|| model.state !== PromptInputState.Input || model.ghostTextIndex >= 0 || /[\x00-\x1f\x7f]/.test(model.value)) return;
		const prefix = model.value;
		const cursorIndex = model.cursorIndex;
		const completionService = accessor.get(ITerminalCompletionService);
		const extensions = accessor.get(IExtensionService);
		if (cursorIndex !== prefix.length) {
			await extensions.activateByEvent('onTerminal:terminalCompletionProvider');
			if (![...completionService.providers].length || model.value !== prefix || model.cursorIndex !== cursorIndex) return;
		}
		const processId = instance.processId;
		const profileId = instance.profile.profileId;
		const shell = instance.shellType;
		const cwd = capability.cwd ?? instance.cwd ?? instance.initialCwd;
		const workspace = accessor.get(IWorkspaceContextService);
		const folder = workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
		const history = new TerminalCommandHistory(accessor.get(IConfigurationService), accessor.get(IStorageService));
		const items: CompletionPick[] = history.getCommands(profileId)
			.filter(entry => cursorIndex === prefix.length && entry.command.startsWith(prefix) && entry.command.length > prefix.length && !/[\x00-\x1f\x7f]/.test(entry.command))
			.slice(0, 200)
			.map(entry => ({ label: entry.command, inputData: entry.command.slice(prefix.length), description: localize('terminal.suggest.history', 'Command history') }));
		using lifetime = new DisposableStore();
		const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<CompletionPick>());
		picker.ariaLabel = localize('terminal.suggest.ariaLabel', 'Terminal suggestions');
		picker.placeholder = localize('terminal.suggest.placeholder', 'Select a suggestion to insert without running it');
		picker.items = items;
		picker.sortByLabel = false;
		const request = new AbortController();
		lifetime.add(toDisposable(() => request.abort()));
		let retired = false;
		const retire = (): void => { retired = true; request.abort(); picker.hide(); };
		lifetime.add(toDisposable(() => { retired = true; }));
		for (const event of [model.onDidStartInput, model.onDidChangeInput, model.onDidFinishInput, model.onDidInterrupt]) lifetime.add(event(retire));
		lifetime.add(instance.onDidChangeState(retire));
		lifetime.add(instance.onDidExit(retire));
		lifetime.add(terminals.onDidChangeActiveInstance(retire));
		lifetime.add(workspace.onDidChangeWorkspace(retire));
		lifetime.add(workspace.onDidChangeWorkspaceFolders(retire));
		lifetime.add(instance.capabilities!.onDidChangeCapabilities(retire));
		lifetime.add(terminals.onDidDisposeInstance(disposed => { if (disposed === instance) retire(); }));
		const typed = screen.raw.onData(retire);
		lifetime.add(toDisposable(() => typed.dispose()));
		const canSend = (): boolean => !retired && instance.state === 'running' && !instance.isReadOnly
			&& terminals.activeInstance === instance && terminals.instances.includes(instance) && instance.processId === processId
			&& instance.profile.profileId === profileId && instance.shellType === shell && instance.xterm === screen && !screen.isDisposed
			&& instance.capabilities?.get(TerminalCapability.CommandDetection) === capability && model.state === PromptInputState.Input
			&& model.value === prefix && model.cursorIndex === cursorIndex && model.ghostTextIndex < 0
			&& (capability.cwd ?? instance.cwd ?? instance.initialCwd) === cwd && screen.raw.buffer.active.type === 'normal';
		picker.busy = true;
		void extensions.activateByEvent('onTerminal:terminalCompletionProvider', request.signal).then(() => completionService.provideCompletions(instance, prefix, cursorIndex, request.signal, triggerCharacter)).then(completions => {
			if (!canSend()) return;
			const providerItems: CompletionPick[] = completions.map((item): CompletionPick | undefined => {
				const [start, end] = item.replacementRange;
				// Shell line editing consumes characters rather than UTF-16 code units.
				// Do not let an extension split a surrogate pair at either range boundary.
				if ([start, end].some(index => index > 0 && index < prefix.length && /[\uDC00-\uDFFF]/.test(prefix[index]!))) return undefined;
				const movement = end < cursorIndex ? '\x1b[D'.repeat([...prefix.slice(end, cursorIndex)].length) : '\x1b[C'.repeat([...prefix.slice(cursorIndex, end)].length);
				return { label: item.label, description: item.detail, detail: item.documentation, isValid: item.isValid, inputData: movement + '\x7f'.repeat([...prefix.slice(start, end)].length) + (item.insertText ?? item.label) };
			}).filter((item): item is CompletionPick => item !== undefined);
			picker.items = [...picker.items, ...providerItems];
		}).catch(() => undefined).finally(() => { if (canSend()) picker.busy = false; });
		// The file provider may complete after Escape, input changes or a terminal switch.
		// Keep its result local until the original prompt's lifetime is still current.
		if (cursorIndex === prefix.length && folder && (shell === PosixShellType.Bash || shell === PosixShellType.Zsh)) {
			picker.busy = true;
			void pathCompletions(prefix, cwd, folder, accessor.get(IPathService), accessor.get(IFileService)).then(paths => {
				if (!canSend()) return;
				picker.busy = false;
				picker.items = [...picker.items, ...paths];
			});
		}
		let selected: CompletionPick | undefined;
		await new Promise<void>(resolve => {
			lifetime.add(picker.onDidAccept(() => { selected = picker.selectedItems[0]; picker.hide(); }));
			lifetime.add(picker.onDidHide(resolve));
			picker.show();
		});
		if (!selected || !canSend() || selected.isValid?.() === false) return;
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


/** Only shell-confirmed prompt changes trigger providers; raw key input alone is not a prompt snapshot. */
class TerminalSuggestContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.suggest';
	private readonly promptListeners = this._register(new DisposableStore());
	private pendingCharacter: string | undefined;
	constructor(
		private readonly context: ITerminalContributionContext,
		@ITerminalCompletionService private readonly completions: ITerminalCompletionService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ICommandService private readonly commands: ICommandService,
	) { super(); }
	xtermReady(screen: IXtermTerminal): void {
		void this.extensions.activateByEvent('onTerminal:terminalCompletionProvider').catch(() => undefined);
		const input = screen.raw.onData(data => {
			this.pendingCharacter = [...data].length === 1 && !/[\x00-\x1f\x7f]/.test(data) ? data : undefined;
		});
		this._register(toDisposable(() => input.dispose()));
		const bind = (): void => {
			this.promptListeners.clear();
			this.pendingCharacter = undefined;
			const model = this.context.instance.capabilities?.get(TerminalCapability.CommandDetection)?.promptInputModel;
			if (!model) return;
			this.promptListeners.add(model.onDidChangeInput(() => {
				const character = this.pendingCharacter;
				this.pendingCharacter = undefined;
				if (!character || this.terminals.activeInstance !== this.context.instance || model.state !== PromptInputState.Input || !model.value.slice(0, model.cursorIndex).endsWith(character)
					|| !screen.raw.textarea?.matches(':focus') || ![...this.completions.providers].some(provider => provider.triggerCharacters?.includes(character))) return;
				void this.commands.executeCommand(TerminalSuggestCommandId.TriggerSuggest, character).catch(() => undefined);
			}));
		};
		if (this.context.instance.capabilities) this._register(this.context.instance.capabilities.onDidChangeCapabilities(bind));
		this._register(this.context.instance.onDidChangeState(() => { this.pendingCharacter = undefined; }));
		bind();
	}
}
registerTerminalContribution(TerminalSuggestContribution.ID, TerminalSuggestContribution);
