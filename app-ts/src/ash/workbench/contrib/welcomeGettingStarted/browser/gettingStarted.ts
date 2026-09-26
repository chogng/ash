import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { IRecentWorkspacesService } from '../../../services/workspaces/common/recentWorkspacesService.js';
import { IWorkspaceOpenService } from '../../../services/workspaces/browser/workspaceOpenService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ConnectToRemoteCommandId } from '../../remote/browser/remoteActions.js';
import { GettingStarted, type IGettingStartedProject } from './gettingStartedContent.js';
import { isGettingStartedInput } from './gettingStartedInput.js';

export const GettingStartedPageId = 'workbench.editor.gettingStarted';
export const GettingStartedFocusedContext = new RawContextKey<boolean>('gettingStartedFocused', false);

/** Owns the Welcome editor's content and focus while its tab is open. */
export class GettingStartedPage extends Disposable implements IEditorPane {
	public readonly id = GettingStartedPageId;
	private domNode: HTMLElement | undefined;
	private content: GettingStarted | undefined;
	private focusedContext: IContextKey<boolean> | undefined;

	constructor(
		@IRecentWorkspacesService private readonly recentWorkspaces: IRecentWorkspacesService,
		@IWorkspaceOpenService private readonly workspaceOpenService: IWorkspaceOpenService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super();
		this._register(this.recentWorkspaces.onDidChange(() => this.content?.setRecentProjects(this.projects())));
	}

	public create(parent: HTMLElement): void {
		const domNode = h(parent.ownerDocument, 'div');
		domNode.className = 'ash-getting-started-pane';
		parent.append(domNode);
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
				connectViaSsh: () => this.commandService.executeCommand(ConnectToRemoteCommandId),
			},
		}));
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isGettingStartedInput(input)) throw new TypeError('Welcome editor requires a Welcome input');
		if (signal.aborted) throw signal.reason;
	}

	public clearInput(): void {}

	public layout(_dimension: IDimension): void {}

	public setVisible(visibility: EditorPaneVisibility): void {
		if (visibility === EditorPaneVisibility.Hidden) this.focusedContext?.set(false);
	}

	public focus(): void {
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
