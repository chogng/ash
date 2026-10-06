import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import { IGitService } from '../../../contrib/git/common/gitService.js';
import { IRecentWorkspacesService } from '../../../services/workspaces/common/recentWorkspacesService.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ConnectToRemoteCommandId } from '../../remote/browser/remoteActions.js';
import { GitCloneCommandId } from '../../git/common/gitCommands.js';
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

	constructor(
		@IRecentWorkspacesService private readonly recentWorkspaces: IRecentWorkspacesService,
		@IWorkspaceOpenService private readonly workspaceOpenService: IWorkspaceOpenService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IGitHubConnectionService private readonly githubConnection: IGitHubConnectionService,
		@IGitService private readonly gitService: IGitService,
	) {
		super();
		this._register(this.recentWorkspaces.onDidChange(() => this.content?.setRecentProjects(this.projects())));
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
		this._register(addDisposableListener(domNode, 'focusout', event => {
			if (!domNode.contains(event.relatedTarget as Node | null)) this.focusedContext?.set(false);
		}));

		this.content = this._register(new GettingStarted(domNode, {
			recentProjects: this.projects(),
			actions: {
				openFolder: this.workspaceOpenService.canOpenFolder ? () => this.workspaceOpenService.openFolder() : undefined,
				cloneRepository: this.gitService.canCloneRepository ? () => this.commandService.executeCommand(GitCloneCommandId) : undefined,
				connectViaSsh: () => this.commandService.executeCommand(ConnectToRemoteCommandId),
				connectGitHub: () => this.githubConnection.connect(),
			},
		}));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isGettingStartedInput(input)) throw new TypeError('Welcome editor requires a Welcome input');
		if (signal.aborted) throw signal.reason;
	}

	public override clearInput(): void { }

	public override layout(_dimension: IDimension): void { }

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		if (!visibility) this.focusedContext?.set(false);
	}

	public override focus(): void {
		this.domNode?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
	}

	private projects(): readonly IGettingStartedProject[] {
		return this.recentWorkspaces.recentWorkspaces.map(project => ({
			name: project.name,
			path: project.path,
			...(this.workspaceOpenService.canOpenWorkspace ? {
				onOpen: () => this.recentWorkspaces.openWorkspace(project.root),
			} : {}),
		}));
	}
}
