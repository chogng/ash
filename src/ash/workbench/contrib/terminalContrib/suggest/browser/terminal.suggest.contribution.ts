import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import {
	ITerminalCompletionService,
	TerminalCompletionService,
	type ITerminalCompletion,
} from './terminalCompletionService.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../../base/common/async.js';
import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { TerminalSuggestWidget } from './terminalSuggestWidget.js';
import { TerminalSuggestSettingId, type TerminalQuickSuggestions } from '../common/terminalSuggestConfiguration.js';
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
import {
	ITerminalService,
	type ITerminalContribution,
	type IXtermTerminal,
} from '../../../terminal/browser/terminal.js';
import {
	registerTerminalContribution,
	type ITerminalContributionContext,
} from '../../../terminal/browser/terminalExtensions.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { TerminalCommandHistory } from '../../history/common/history.js';
import { TerminalSuggestCommandId } from '../common/terminal.suggest.js';

registerSingleton(ITerminalCompletionService, TerminalCompletionService, InstantiationType.Delayed);

interface CompletionPick extends IQuickPickItem {
	readonly inputData: string;
	readonly isValid?: () => boolean;
}

/** Applies accepted provider ranges through the existing shell input owner. */
registerAction2(
	class TerminalTriggerSuggestAction extends Action2 {
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
			if (
				triggerCharacter !== undefined &&
				(typeof triggerCharacter !== 'string' || [...triggerCharacter].length !== 1)
			)
				return;
			if (!accessor.get(IConfigurationService).getValue<boolean>(TerminalSuggestSettingId.Enabled)) return;
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance;
			const screen = instance?.xterm;
			const capability = instance?.capabilities?.get(TerminalCapability.CommandDetection);
			const model = capability?.promptInputModel;
			if (
				!instance ||
				instance.isReadOnly ||
				instance.state !== 'running' ||
				!screen ||
				!model ||
				screen.raw.buffer.active.type !== 'normal' ||
				model.state !== PromptInputState.Input ||
				model.ghostTextIndex >= 0 ||
				/[\x00-\x1f\x7f]/.test(model.value)
			)
				return;
			const prefix = model.value;
			const cursorIndex = model.cursorIndex;
			const completionService = accessor.get(ITerminalCompletionService);
			const extensions = accessor.get(IExtensionService);
			const processId = instance.processId;
			const profileId = instance.profile.profileId;
			const shell = instance.shellType;
			const cwd = capability.cwd ?? instance.cwd ?? instance.initialCwd;
			const workspace = accessor.get(IWorkspaceContextService);
			const folder = workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
			const history = new TerminalCommandHistory(
				accessor.get(IConfigurationService),
				accessor.get(IStorageService),
			);
			const items = historyPicks(history, profileId, prefix, cursorIndex);
			using lifetime = new DisposableStore();
			const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<CompletionPick>());
			picker.ariaLabel = localize('terminal.suggest.ariaLabel', 'Terminal suggestions');
			picker.placeholder = localize(
				'terminal.suggest.placeholder',
				'Select a suggestion to insert without running it',
			);
			picker.items = items;
			picker.sortByLabel = false;
			const request = new AbortController();
			lifetime.add(toDisposable(() => request.abort()));
			let retired = false;
			const retire = (): void => {
				retired = true;
				request.abort();
				picker.hide();
			};
			lifetime.add(
				toDisposable(() => {
					retired = true;
				}),
			);
			for (const event of [
				model.onDidStartInput,
				model.onDidChangeInput,
				model.onDidFinishInput,
				model.onDidInterrupt,
			])
				lifetime.add(event(retire));
			lifetime.add(instance.onDidChangeState(retire));
			lifetime.add(instance.onDidExit(retire));
			lifetime.add(terminals.onDidChangeActiveInstance(retire));
			lifetime.add(workspace.onDidChangeWorkspace(retire));
			lifetime.add(workspace.onDidChangeWorkspaceFolders(retire));
			lifetime.add(instance.capabilities!.onDidChangeCapabilities(retire));
			lifetime.add(
				terminals.onDidDisposeInstance(disposed => {
					if (disposed === instance) retire();
				}),
			);
			const typed = screen.raw.onData(retire);
			lifetime.add(toDisposable(() => typed.dispose()));
			const canSend = (): boolean =>
				!retired &&
				instance.state === 'running' &&
				!instance.isReadOnly &&
				terminals.activeInstance === instance &&
				terminals.instances.includes(instance) &&
				instance.processId === processId &&
				instance.profile.profileId === profileId &&
				instance.shellType === shell &&
				instance.xterm === screen &&
				!screen.isDisposed &&
				instance.capabilities?.get(TerminalCapability.CommandDetection) === capability &&
				model.state === PromptInputState.Input &&
				model.value === prefix &&
				model.cursorIndex === cursorIndex &&
				model.ghostTextIndex < 0 &&
				(capability.cwd ?? instance.cwd ?? instance.initialCwd) === cwd &&
				screen.raw.buffer.active.type === 'normal';
			const activation = extensions.activateByEvent('onTerminal:terminalCompletionProvider', request.signal);
			if (cursorIndex !== prefix.length) {
				// Mid-prompt completion needs an extension provider. Establish the prompt
				// lifetime first, so switching away cannot revive this activation later.
				try {
					await raceCancellationError(activation, request.signal);
				} catch (error) {
					if (request.signal.aborted) return;
					throw error;
				}
				if (!canSend() || ![...completionService.providers].length) return;
			}
			picker.busy = true;
			void activation
				.then(() =>
					completionService.provideCompletions(
						instance,
						prefix,
						cursorIndex,
						request.signal,
						triggerCharacter,
					),
				)
				.then(completions => {
					if (!canSend()) return;
					const providerItems = providerPicks(completions, prefix, cursorIndex);
					picker.items = [...picker.items, ...providerItems];
				})
				.catch(() => undefined)
				.finally(() => {
					if (canSend()) picker.busy = false;
				});
			// The file provider may complete after Escape, input changes or a terminal switch.
			// Keep its result local until the original prompt's lifetime is still current.
			if (
				cursorIndex === prefix.length &&
				folder &&
				(shell === PosixShellType.Bash || shell === PosixShellType.Zsh)
			) {
				picker.busy = true;
				void pathCompletions(prefix, cwd, folder, accessor.get(IPathService), accessor.get(IFileService)).then(
					paths => {
						if (!canSend()) return;
						picker.busy = false;
						picker.items = [...picker.items, ...paths];
					},
				);
			}
			let selected: CompletionPick | undefined;
			await new Promise<void>(resolve => {
				lifetime.add(
					picker.onDidAccept(() => {
						selected = picker.selectedItems[0];
						picker.hide();
					}),
				);
				lifetime.add(picker.onDidHide(resolve));
				picker.show();
			});
			if (!selected || !canSend() || selected.isValid?.() === false) return;
			await instance.sendText(selected.inputData, false);
			if (canSend()) screen.focus();
		}
	},
);

function historyPicks(
	history: TerminalCommandHistory,
	profileId: string,
	prefix: string,
	cursorIndex: number,
): CompletionPick[] {
	if (cursorIndex !== prefix.length) return [];
	return history
		.getCommands(profileId)
		.filter(
			entry =>
				entry.command.startsWith(prefix) &&
				entry.command.length > prefix.length &&
				!/[\x00-\x1f\x7f]/.test(entry.command),
		)
		.slice(0, 200)
		.map(entry => ({
			label: entry.command,
			inputData: entry.command.slice(prefix.length),
			description: localize('terminal.suggest.history', 'Command history'),
		}));
}

function providerPicks(
	completions: readonly ITerminalCompletion[],
	prefix: string,
	cursorIndex: number,
): CompletionPick[] {
	return completions
		.map((item): CompletionPick | undefined => {
			const [start, end] = item.replacementRange;
			// Shell line editing consumes characters rather than UTF-16 code units.
			// Do not let an extension split a surrogate pair at either range boundary.
			if (
				[start, end].some(index => index > 0 && index < prefix.length && /[\uDC00-\uDFFF]/.test(prefix[index]!))
			)
				return undefined;
			const movement =
				end < cursorIndex
					? '\x1b[D'.repeat([...prefix.slice(end, cursorIndex)].length)
					: '\x1b[C'.repeat([...prefix.slice(cursorIndex, end)].length);
			return {
				label: item.label,
				description: item.detail,
				detail: item.documentation,
				isValid: item.isValid,
				inputData:
					movement + '\x7f'.repeat([...prefix.slice(start, end)].length) + (item.insertText ?? item.label),
			};
		})
		.filter((item): item is CompletionPick => item !== undefined);
}

async function pathCompletions(
	prefix: string,
	cwd: string,
	folder: IWorkspaceFolder,
	paths: IPathService,
	files: IFileService,
): Promise<CompletionPick[]> {
	// A partial quote, expansion, escape or shell operator needs a shell-owned parser.
	// Restrict this producer to plain tokens rather than guessing the shell's editing rules.
	if (!/^[\p{L}\p{N}._/@%+=~ -]*$/u.test(prefix)) return [];
	const token = prefix.slice(prefix.lastIndexOf(' ') + 1);
	if (token.startsWith('~') || (!token.includes('/') && !prefix.includes(' '))) return [];
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
		return entries
			.filter(
				entry =>
					(entry.kind === FileKind.File || entry.kind === FileKind.Directory) &&
					entry.name.startsWith(typedName) &&
					!/[\x00-\x1f\x7f]/.test(entry.name),
			)
			.slice(0, 200)
			.flatMap(entry => {
				const suffix = entry.name.slice(typedName.length) + (entry.kind === FileKind.Directory ? '/' : '');
				if (!suffix) return [];
				return [
					{
						label: token.slice(0, slash + 1) + entry.name + (entry.kind === FileKind.Directory ? '/' : ''),
						inputData: /^[\p{L}\p{N}._/@%+=-]*$/u.test(suffix) ? suffix : escapeNonWindowsPath(suffix),
						description:
							entry.kind === FileKind.Directory
								? localize('terminal.suggest.folder', 'Folder')
								: localize('terminal.suggest.file', 'File'),
					},
				];
			});
	} catch {
		return [];
	}
}

/** Queries only shell-confirmed input; the popup never takes ownership of PTY input. */
class TerminalSuggestContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.suggest';
	readonly id = TerminalSuggestContribution.ID;
	private readonly promptListeners = this._register(new DisposableStore());
	private readonly scheduler = this._register(
		new RunOnceScheduler(() => {
			void this.query();
		}, 120),
	);
	private readonly inputExpiry = this._register(
		new RunOnceScheduler(() => {
			this.pendingInput = undefined;
		}, 5000),
	);
	private pendingInput: { readonly prefix: string; readonly value: string } | undefined;
	private triggerCharacter: string | undefined;
	private composing = false;
	private screen: IXtermTerminal | undefined;
	private widget: TerminalSuggestWidget<CompletionPick> | undefined;
	private request: AbortController | undefined;
	constructor(
		private readonly context: ITerminalContributionContext,
		@ITerminalCompletionService private readonly completions: ITerminalCompletionService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IExtensionService private readonly extensions: IExtensionService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IPathService private readonly paths: IPathService,
		@IFileService private readonly files: IFileService,
	) {
		super();
	}
	xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		this.widget = this._register(new TerminalSuggestWidget<CompletionPick>(screen, () => this.retire()));
		void this.extensions.activateByEvent('onTerminal:terminalCompletionProvider').catch(() => undefined);
		// Only keyboard events initiate automatic suggestions. IME commits,
		// paste and terminal replies also produce onData and can arrive after a key.
		const input = screen.raw.onKey(({ key: data, domEvent }) => {
			const pending = this.pendingInput;
			this.clearQuery();
			const model = this.context.instance.capabilities?.get(
				TerminalCapability.CommandDetection,
			)?.promptInputModel;
			if (
				this.composing ||
				domEvent.isComposing ||
				[...data].length !== 1 ||
				/[\x00-\x1f\x7f]/.test(data) ||
				model?.state !== PromptInputState.Input ||
				model.cursorIndex !== model.value.length ||
				model.ghostTextIndex >= 0
			) {
				this.retire();
				return;
			}
			const unconfirmed = pending && model.value !== pending.prefix + pending.value;
			this.pendingInput = unconfirmed
				? { prefix: pending.prefix, value: pending.value + data }
				: { prefix: model.value, value: data };
			if (this.pendingInput.value.length > 1024) {
				this.retire();
				return;
			}
			this.inputExpiry.schedule();
		});
		this._register(toDisposable(() => input.dispose()));
		for (const listener of [
			screen.raw.onScroll(() => this.retire()),
			screen.raw.onResize(() => this.retire()),
			screen.raw.buffer.onBufferChange(() => this.retire()),
		])
			this._register(toDisposable(() => listener.dispose()));
		this._register(
			addDisposableListener(screen.element, 'compositionstart', () => {
				this.composing = true;
				this.retire();
			}),
		);
		this._register(
			addDisposableListener(screen.element, 'compositionend', () => {
				this.composing = false;
			}),
		);
		this._register(addDisposableListener(screen.element, 'focusout', () => this.retire()));
		for (const event of [
			this.terminals.onDidChangeActiveInstance,
			this.context.instance.onDidChangeState,
			this.context.instance.onDidExit,
			this.workspace.onDidChangeWorkspace,
			this.workspace.onDidChangeWorkspaceFolders,
			this.completions.onDidChangeProviders,
		])
			this._register(event(() => this.retire()));
		this._register(
			this.configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('terminal.integrated.suggest')) this.retire();
			}),
		);
		const bind = (): void => {
			this.promptListeners.clear();
			this.retire();
			const model = this.context.instance.capabilities?.get(
				TerminalCapability.CommandDetection,
			)?.promptInputModel;
			if (!model) return;
			for (const event of [model.onDidStartInput, model.onDidFinishInput, model.onDidInterrupt])
				this.promptListeners.add(event(() => this.retire()));
			this.promptListeners.add(
				model.onDidChangeInput(() => {
					const pending = this.pendingInput;
					const character = pending?.value && [...pending.value].at(-1);
					// A shell may echo an earlier key before the latest typed trigger.
					// Match the complete bounded input run, not only its last character:
					// an earlier echo fragment may already end in the same trigger.
					this.clearQuery();
					if (!pending || !character || !this.eligible() || model.value !== pending.prefix + pending.value)
						return;
					const triggered =
						this.configuration.getValue<boolean>(TerminalSuggestSettingId.SuggestOnTriggerCharacters) &&
						[...this.completions.providers].some(provider =>
							provider.triggerCharacters?.includes(character),
						);
					const quick = this.configuration.getValue<boolean | TerminalQuickSuggestions>(
						TerminalSuggestSettingId.QuickSuggestions,
					);
					const category = /^[\p{L}\p{N}._/@%+=~ -]*$/u.test(model.value)
						? /\s/.test(model.value.slice(0, model.cursorIndex))
							? 'arguments'
							: 'commands'
						: 'unknown';
					const automatic =
						typeof quick === 'boolean' ? quick && category !== 'unknown' : quick?.[category] === 'on';
					if (!triggered && !automatic) return;
					this.triggerCharacter = triggered ? character : undefined;
					this.scheduler.schedule();
				}),
			);
		};
		if (this.context.instance.capabilities)
			this._register(this.context.instance.capabilities.onDidChangeCapabilities(bind));
		this._register(toDisposable(() => this.retire()));
		bind();
	}
	private eligible(): boolean {
		const instance = this.context.instance;
		const model = instance.capabilities?.get(TerminalCapability.CommandDetection)?.promptInputModel;
		return (
			!!this.screen &&
			!this.screen.isDisposed &&
			!this.screen.element.hidden &&
			this.screen.element.isConnected &&
			!this.composing &&
			this.configuration.getValue<boolean>(TerminalSuggestSettingId.Enabled) &&
			this.terminals.activeInstance === instance &&
			instance.state === 'running' &&
			!instance.isReadOnly &&
			this.screen.raw.buffer.active.type === 'normal' &&
			!!this.screen.raw.textarea?.matches(':focus') &&
			model?.state === PromptInputState.Input &&
			model.ghostTextIndex < 0 &&
			model.value.length > 0 &&
			model.cursorIndex === model.value.length &&
			!/[\x00-\x1f\x7f]/.test(model.value)
		);
	}
	private retire(): void {
		this.pendingInput = undefined;
		this.inputExpiry.cancel();
		this.clearQuery();
	}
	private clearQuery(): void {
		this.scheduler.cancel();
		this.triggerCharacter = undefined;
		this.request?.abort();
		this.request = undefined;
		this.widget?.hide();
	}
	private async query(): Promise<void> {
		if (!this.eligible()) return;
		const instance = this.context.instance;
		const screen = this.screen!;
		const capability = instance.capabilities!.get(TerminalCapability.CommandDetection)!;
		const model = capability.promptInputModel;
		const prefix = model.value,
			cursor = model.cursorIndex,
			processId = instance.processId,
			profileId = instance.profile.profileId;
		const cwd = capability.cwd ?? instance.cwd ?? instance.initialCwd;
		const request = (this.request = new AbortController());
		const trigger = this.triggerCharacter;
		const valid = (): boolean =>
			this.request === request &&
			!request.signal.aborted &&
			this.eligible() &&
			instance.xterm === screen &&
			instance.processId === processId &&
			instance.profile.profileId === profileId &&
			instance.capabilities?.get(TerminalCapability.CommandDetection) === capability &&
			model.value === prefix &&
			model.cursorIndex === cursor &&
			(capability.cwd ?? instance.cwd ?? instance.initialCwd) === cwd;
		let items = historyPicks(
			new TerminalCommandHistory(this.configuration, this.storage),
			profileId,
			prefix,
			cursor,
		);
		const publish = (): void => {
			if (!valid()) return;
			this.widget?.show(items, item => {
				if (!valid() || item.isValid?.() === false) {
					this.retire();
					return;
				}
				this.retire();
				void instance.sendText(item.inputData, false).catch(() => undefined);
			});
		};
		publish();
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
		const paths =
			folder && (instance.shellType === PosixShellType.Bash || instance.shellType === PosixShellType.Zsh)
				? pathCompletions(prefix, cwd, folder, this.paths, this.files)
				: Promise.resolve([]);
		const providers = this.extensions
			.activateByEvent('onTerminal:terminalCompletionProvider', request.signal)
			.then(() => this.completions.provideCompletions(instance, prefix, cursor, request.signal, trigger));
		await Promise.allSettled([
			paths.then(results => {
				if (valid() && results.length) {
					items = [...items, ...results];
					publish();
				}
			}),
			providers.then(results => {
				if (valid() && results.length) {
					items = [...items, ...providerPicks(results, prefix, cursor)];
					publish();
				}
			}),
		]);
	}
}
registerTerminalContribution(TerminalSuggestContribution.ID, TerminalSuggestContribution);
