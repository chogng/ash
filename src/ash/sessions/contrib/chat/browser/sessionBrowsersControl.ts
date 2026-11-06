import { Emitter } from '../../../../base/common/event.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import type { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { findAgentNode, type AgentTreeNode } from '../../../services/sessions/common/session.js';

function addAgentDescendants(nodes: readonly AgentTreeNode[], owners: Set<string>): void {
	for (const node of nodes) {
		if (node.origin.type !== 'agentSpawn') continue;
		owners.add(node.threadId);
		addAgentDescendants(node.children, owners);
	}
}

/** Lists existing browser inputs owned by this conversation or its delegated agents. */
export class SessionBrowsersControl extends Disposable {
	private readonly dropdown: ActionWidgetDropdown;
	private readonly visibilityChanged = this._register(new Emitter<void>());
	readonly onDidChangeVisibility = this.visibilityChanged.event;
	private visible = true;
	private threadId: string | undefined;
	private pageIds: readonly string[] = [];

	constructor(
		container: HTMLElement,
		private readonly context: Pick<ChatWidgetModel, 'session' | 'threadId' | 'onDidChange'>,
		private readonly focusInput: () => void,
		@IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService,
		@IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IActionWidgetService menus: IActionWidgetService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const label = localize('sessions.browsers.label', 'Browsers');
		this.dropdown = this._register(new ActionWidgetDropdown(container, {
			label, ariaLabel: label,
			buttonOptions: { icon: Lxicon.browserExplore, presentation: 'secondary', size: 'small' },
			listOptions: { ariaLabel: label, presentation: 'details' },
			tabLeavesPopup: true,
			actionProvider: {
				getActions: () => {
					const threadId = this.context.threadId;
					return this.getPages().map(page => ({
						id: page.id,
						label: page.label,
						tooltip: page.model?.state.url ?? '',
						enabled: true,
						run: async () => {
							if (this.isDisposed || !this.visible || this.context.threadId !== threadId || !this.getPages().includes(page)) return;
							const existing = this.groups.groups.find(group => group.inputs.includes(page));
							await this.editors.openEditor(page, { pinned: true }, existing ? { groupId: existing.id } : undefined);
						},
					}));
				}
			},
			onError: error => notifications.error(getErrorMessage(error)),
		}, menus));
		this._register(browsers.onDidChangeBrowserViews(() => this.refresh()));
		this._register(context.onDidChange(() => this.refresh()));
		this.refresh();
	}

	get isShowing(): boolean { return !this.dropdown.element.hidden; }

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.refresh();
	}

	private getPages(): BrowserEditorInput[] {
		const { session, threadId } = this.context;
		if (!this.visible || !session || !threadId) return [];
		const owners = new Set([threadId]);
		const agent = findAgentNode(session.agentTree ?? [], threadId);
		if (agent) addAgentDescendants(agent.children, owners);
		return [...this.browsers.getContextualBrowserViews({ activeSessionId: threadId }).values()].filter(page => {
			const owner = page.model?.info.owner;
			return !page.isDisposed && owner?.type === 'agent' && owners.has(owner.sessionId);
		});
	}

	private refresh(): void {
		const element = this.dropdown.element;
		const previous = this.isShowing;
		const threadChanged = this.threadId !== this.context.threadId;
		this.threadId = this.context.threadId;
		const pages = this.getPages();
		const count = pages.length;
		const pagesChanged = count !== this.pageIds.length || pages.some((page, index) => page.id !== this.pageIds[index]);
		if (pagesChanged) this.pageIds = pages.map(page => page.id);
		if (threadChanged || pagesChanged) this.dropdown.hide();
		if (!count && this.visible && element === element.ownerDocument.activeElement) this.focusInput();
		element.hidden = count === 0;
		if (pagesChanged) {
			const label = localize('sessions.browsers.count', 'Browsers ({0})', count);
			this.dropdown.setLabel(label);
			element.setAttribute('aria-label', label);
		}
		if (previous !== this.isShowing) this.visibilityChanged.fire();
	}
}
