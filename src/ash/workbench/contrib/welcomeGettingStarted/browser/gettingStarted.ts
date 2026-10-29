import { URI } from '../../../../base/common/uri.js';
import { IWorkspacesService, recentWorkspaceUri } from '../../../../platform/workspaces/common/workspaces.js';
import { basename } from '../../../../base/common/resources.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { OpenFolderWorkspaceSupportContext, BrowserLocalFolderSupportContext } from '../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ConnectToRemoteCommandId } from '../../remote/browser/remoteActions.js';
import { GettingStarted, type IGettingStartedProject } from './gettingStartedContent.js';
import { isGettingStartedInput } from './gettingStartedInput.js';

export const GettingStartedPageId = 'workbench.editor.gettingStarted';
export const GettingStartedFocusedContext = new RawContextKey<boolean>('gettingStartedFocused', false);

/** Owns the Welcome editor's content and focus while its tab is open. */
export class GettingStartedPage extends EditorPane implements IEditorPane {
	public readonly id = GettingStartedPageId;
	private domNode: HTMLElement | undefined;
	private content: GettingStarted | undefined;
	private focusedContext: IContextKey<boolean> | undefined;
	private recentGeneration = 0;

	constructor(
		@IWorkspacesService private readonly workspacesService: IWorkspacesService,
		@IHostService private readonly host: IHostService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IGitHubConnectionService private readonly githubConnection: IGitHubConnectionService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(GettingStartedPageId, themeService, storageService);
		this._register(
			CommandsRegistry.onDidChangeCommands(() => this.content?.setCloneRepositoryAction(this.cloneAction())),
		);
		this._register(
			this.workspacesService.onDidChangeRecentlyOpened(() => {
				void this.refreshProjects();
			}),
		);
	}

	public override create(parent: HTMLElement): void {
		const domNode = h(parent.ownerDocument, 'div');
		domNode.className = 'ash-getting-started-pane';
		parent.append(domNode);
		super.create(domNode);
		this.domNode = domNode;
		this._register(toDisposable(() => domNode.remove()));
		const scopedContext = this._register(this.contextKeyService.createScoped(domNode));
		this.focusedContext = GettingStartedFocusedContext.bindTo(scopedContext);
		this._register(addDisposableListener(domNode, 'focusin', () => this.focusedContext?.set(true)));
		this._register(
			addDisposableListener(domNode, 'focusout', event => {
				if (!domNode.contains(event.relatedTarget as Node | null)) this.focusedContext?.set(false);
			}),
		);

		this.content = this._register(
			new GettingStarted(domNode, {
				recentProjects: [],
				actions: {
					openFolder: this.canOpenFolder ? () => this.fileDialogs.pickFolderAndOpen() : undefined,
					cloneRepository: this.cloneAction(),
					connectViaSsh: () => this.commandService.executeCommand(ConnectToRemoteCommandId),
					connectGitHub: () => this.githubConnection.connect(),
				},
			}),
		);
		void this.refreshProjects();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isGettingStartedInput(input)) throw new TypeError('Welcome editor requires a Welcome input');
		if (signal.aborted) throw signal.reason;
	}

	public override clearInput(): void {}

	public override layout(_dimension: IDimension): void {}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		if (!visibility) this.focusedContext?.set(false);
	}

	public override focus(): void {
		// Enter the page without selecting an action; Tab moves to the first available button.
		this.content?.domNode.focus();
	}

	private cloneAction(): (() => Promise<void>) | undefined {
		return CommandsRegistry.hasCommand('git.clone') && this.canOpenFolder
			? () => this.commandService.executeCommand('git.clone')
			: undefined;
	}

	private get canOpenFolder(): boolean {
		return this.contextKeyService.contextMatchesRules(
			ContextKeyExpr.or(
				OpenFolderWorkspaceSupportContext.isEqualTo(true),
				BrowserLocalFolderSupportContext.isEqualTo(true),
			),
		);
	}

	private async refreshProjects(): Promise<void> {
		const generation = ++this.recentGeneration;
		try {
			const recents = await this.workspacesService.getRecentlyOpened();
			if (this.isDisposed || generation !== this.recentGeneration) return;
			const projects: IGettingStartedProject[] = recents.workspaces.map(recent => {
				const resource = recentWorkspaceUri(recent);
				return {
					name: recent.label ?? basename(resource),
					path: resource.fsPath,
					onRemove: () => this.workspacesService.removeRecentlyOpened([resource]),
					...(this.canOpenFolder
						? {
								onOpen: () =>
									this.host.openWindow([
										'workspace' in recent ? { workspaceUri: resource } : { folderUri: resource },
									]),
							}
						: {}),
				};
			});
			this.content?.setRecentProjects(projects);
		} catch (error) {
			console.error('Failed to read recent projects', error);
		}
	}
}
