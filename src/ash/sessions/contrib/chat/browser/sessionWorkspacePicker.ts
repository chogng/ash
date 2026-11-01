import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { appendLabelIcon } from '../../../../base/browser/ui/iconlabel/iconLabels.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { WorkspaceSelection, selectionFromWorkspace } from '../../../browser/workspaceSelection.js';
import type { IAgentHostSessionsProvider } from '../../../common/agentHostSessionsProvider.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';

interface IWorkspaceModeItem extends IQuickPickItem {
	readonly mode: 'workspace' | 'container' | 'folder';
}

/** Edits the owning draft; container startup remains part of first-send preparation. */
export class SessionWorkspacePicker extends Disposable {
	private readonly domNode: HTMLButtonElement;
	private readonly label: HTMLSpanElement;
	private readonly pending = this._register(new MutableDisposable<DisposableStore>());
	private pendingDraftId: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly model: IChatWidgetModel,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsProvidersService private readonly providers: ISessionsProvidersService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'button', { className: 'ash-button ash-button-small ash-button-quiet ash-sessions-chat-input-workspace' });
		this.domNode.type = 'button';
		this.domNode.setAttribute('aria-haspopup', 'listbox');
		this.domNode.setAttribute('aria-expanded', 'false');
		appendLabelIcon(this.domNode, Lxicon.folder);
		this.label = h(container.ownerDocument, 'span');
		this.domNode.append(this.label);
		container.prepend(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.domNode, 'click', () => {
			void this.show().catch(error => {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
			});
		}));
		this._register(sessions.onDidChange(() => this.render()));
		this._register(model.onDidChange(() => this.render()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.render()));
		this.render();
	}

	private get draft(): IUntitledChatSession | undefined {
		return this.sessions.untitledSessions.find(draft => draft.untitledSessionId === this.model.untitledSessionId);
	}

	private render(): void {
		const draft = this.draft;
		const session = this.sessions.sessions.find(session => session.sessionId === this.model.sessionId);
		const selection = draft?.workspace;
		const root = selection && 'root' in selection ? selection.root : session?.workspace?.root;
		const name = root?.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
			|| this.workspace.getWorkspace().folders.map(folder => folder.name).join(', ')
			|| localize('sessions.workspace.select', 'Select workspace');
		const label = draft?.devContainer || session?.workspace?.runtime?.providerId === 'ash.dev-containers'
			? localize('sessions.workspace.containerLabel', 'Dev Container · {0}', name) : name;
		this.label.textContent = label;
		this.domNode.title = root ? `${label}\n${root}` : label;
		this.domNode.setAttribute('aria-label', localize('sessions.workspace.label', 'Workspace: {0}', label));
		this.domNode.disabled = !draft || this.model.inputState.phase === 'submitting';
		if (!draft || this.domNode.disabled || this.pendingDraftId && this.pendingDraftId !== draft.untitledSessionId) this.pending.clear();
	}

	private async show(): Promise<void> {
		const draft = this.draft;
		if (!draft || this.domNode.disabled) return;
		this.pending.clear();
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		this.pendingDraftId = draft.untitledSessionId;
		const cancellation = new CancellationTokenSource();
		lifetime.add(toDisposable(() => cancellation.dispose(true)));
		const picker = lifetime.add(this.quickInput.createQuickPick<IWorkspaceModeItem>());
		const selected = draft.workspace.type === 'current' ? selectionFromWorkspace(this.workspace.getWorkspace()) : draft.workspace;
		const source = selected.type === 'local' || selected.type === 'ssh' || selected.type === 'remote' ? selected : undefined;
		const workspaceItem: IWorkspaceModeItem = { label: localize('sessions.workspace.useHost', 'Use workspace host'), mode: 'workspace', picked: !draft.devContainer };
		const folderItem: IWorkspaceModeItem = { label: localize('sessions.workspace.changeFolder', 'Select folder…'), mode: 'folder' };
		picker.items = [workspaceItem, folderItem];
		picker.placeholder = localize('sessions.workspace.mode', 'Choose where this conversation runs');
		picker.ariaLabel = picker.placeholder;
		picker.busy = !!source;
		this.domNode.setAttribute('aria-expanded', 'true');
		lifetime.add(toDisposable(() => {
			this.pendingDraftId = undefined;
			this.domNode.setAttribute('aria-expanded', 'false');
			if (!this.isDisposed && !this.domNode.disabled) this.domNode.focus();
		}));
		lifetime.add(picker.onDidHide(() => lifetime.dispose()));
		lifetime.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item || this.draft?.untitledSessionId !== draft.untitledSessionId) return;
			lifetime.dispose();
			if (item.mode === 'folder') {
				void this.selectFolder(draft).catch(error => {
					if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
				});
				return;
			}
			this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, source ?? draft.workspace, { devContainer: item.mode === 'container' });
			status(item.label);
		}));
		picker.show();
		if (!source) return;
		const provider = this.providers.getProvider(draft.providerId ?? '') as IAgentHostSessionsProvider | undefined;
		try {
			const available = await provider?.isDevContainerWorkspaceAvailable?.(sessionWorkspaceUri(buildAgentHostSessionWorkspace(source)!), cancellation.token);
			if (cancellation.token.isCancellationRequested) return;
			if (available) {
				picker.items = [workspaceItem, { label: localize('sessions.workspace.useContainer', 'Use Dev Container'), mode: 'container', picked: draft.devContainer }, folderItem];
			}
		} finally {
			if (!cancellation.token.isCancellationRequested) picker.busy = false;
		}
	}

	private async selectFolder(draft: IUntitledChatSession): Promise<void> {
		const lifetime = new DisposableStore();
		this.pending.value = lifetime;
		this.pendingDraftId = draft.untitledSessionId;
		lifetime.add(toDisposable(() => { this.pendingDraftId = undefined; }));
		const selection = lifetime.add(this.instantiation.createInstance(WorkspaceSelection));
		try {
			const folders = selectionFromWorkspace(this.workspace.getWorkspace());
			const source = draft.workspace;
			const choices = folders.type === 'multiple' ? folders.folders
				: folders.type === 'current' ? [] : [{ label: folders.root, target: folders }];
			const target = await selection.pick(choices, candidate =>
				source.type === 'ssh' ? candidate.type === 'ssh' && candidate.host === source.host : source.type === 'remote' ? candidate.type === 'remote' && candidate.authority === source.authority : candidate.type === 'local');
			if (target && !this.isDisposed && this.draft?.untitledSessionId === draft.untitledSessionId) {
				this.sessions.setUntitledSessionWorkspace(draft.untitledSessionId, target);
			}
		} finally {
			lifetime.dispose();
		}
	}
}
