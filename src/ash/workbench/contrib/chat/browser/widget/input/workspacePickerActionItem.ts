import type { Event } from '../../../../../../base/common/event.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { basename } from '../../../../../../base/common/resources.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { IWorkspacePickerDelegate } from '../../chat.js';
import { ChatInputPickerActionViewItem } from './chatInputPickerActionItem.js';

/** Selects a Welcome submission target; it never changes the Sessions execution environment. */
export class WorkspacePickerActionItem extends ChatInputPickerActionViewItem {
	constructor(
		action: IAction,
		private readonly delegate: IWorkspacePickerDelegate,
		onDidChange: Event<void>,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(action, {
			actionProvider: {
				getActions: () => {
					const selected = delegate.getSelectedWorkspace();
					const choices: IAction[] = delegate.getWorkspaces().map(workspace => ({
						id: `workspace.${workspace.uri.toString()}`,
						label: workspace.label || basename(workspace.uri), tooltip: workspace.uri.fsPath,
						icon: workspace.isFolder ? Lxicon.folder : Lxicon.file,
						enabled: action.enabled, checked: selected?.uri.toString() === workspace.uri.toString(),
						run: () => { if (!this.isDisposed) { delegate.setSelectedWorkspace(workspace); } },
					}));
					choices.push({
						id: 'workspace.openFolder', label: localize('chat.workspace.openFolder', 'Open Folder…'),
						tooltip: '', enabled: action.enabled,
						run: async () => {
							try { await commands.executeCommand(delegate.openFolderCommand); }
							catch (error) { if (!this.isDisposed) { notifications.error(error instanceof Error ? error : String(error)); } }
						},
					});
					return choices;
				},
			},
			listOptions: { ariaLabel: localize('chat.workspace.choose', 'Choose a workspace') },
		}, instantiation);
		this._register(onDidChange(() => { if (this.element) { this.updateEnabled(); } }));
		const update = (): void => {
			if (!this.element) { return; }
			this.hide();
			this.updateLabel(this.element);
		};
		this._register(delegate.onDidChangeSelectedWorkspace(update));
		this._register(delegate.onDidChangeWorkspaces(update));
	}

	protected override renderLabel(element: HTMLElement): IDisposable | null {
		this.updateLabel(element);
		return super.renderLabel(element);
	}

	private updateLabel(element: HTMLElement): void {
		const workspace = this.delegate.getSelectedWorkspace();
		const label = workspace ? workspace.label || basename(workspace.uri) : localize('chat.workspace.label', 'Workspace');
		const caption = element.querySelector('.ash-button-label');
		if (caption) { caption.textContent = label; }
		element.setAttribute('aria-label', localize('chat.workspace.selected', 'Workspace: {0}', label));
		element.classList.add('ash-chat-input-workspace-picker');
	}
}
