import type { ICodeCardLayout } from '../codeCardLayout.js';
import { createUuid } from '../../../base/common/uuid.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { addDisposableListener, h } from '../../../base/browser/dom.js';
import { appendIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { autorun } from '../../../base/common/observable.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { localize } from '../../../nls.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { ISCMService } from '../../../workbench/contrib/scm/common/scm.js';
import { getContextInputBudget } from '../../../workbench/services/chat/common/chatService.js';
import { sessionWorkspaceUri } from '../../common/sessionWorkspace.js';
import { buildAgentHostSessionWorkspace } from '../../common/agentHostSessionWorkspace.js';
import type { ChatWidgetModel } from '../chatWidgetModel.js';
import './media/sessionInfoRail.css';

const pinnedKey = 'sessions.code.infoPinned';

/** Reads the retained chat model. Only presentation preferences belong to this rail. */
export class SessionInfoRail extends Disposable {
	readonly element: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly repositories = this._register(new DisposableStore());
	private readonly interaction = this._register(new DisposableStore());
	private readonly environment: HTMLElement;
	private readonly context: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly contextValue: HTMLElement;
	private readonly usage: HTMLProgressElement;
	private fits = false;
	private popup = false;
	private returnFocus: HTMLElement | undefined;
	private returnActionId: string | undefined;
	private readonly closeButton: HTMLButtonElement;

	constructor(
		private readonly host: HTMLElement,
		private readonly model: ChatWidgetModel,
		private readonly focusChat: () => void,
		private readonly cards: ICodeCardLayout | undefined,
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ISCMService private readonly scm: ISCMService,
	) {
		super();
		const document = host.ownerDocument;
		this.element = h(document, 'aside');
		this.element.className = 'ash-session-info';
		this.element.classList.toggle('managed', !!cards);
		this.element.setAttribute('aria-label', localize('sessions.info.title', 'Session information'));
		this.closeButton = h(document, 'button');
		this.closeButton.type = 'button';
		this.closeButton.hidden = !!cards;
		this.closeButton.className = 'ash-session-info-close';
		this.closeButton.title = localize('sessions.info.close', 'Close session information');
		this.closeButton.setAttribute('aria-label', this.closeButton.title);
		appendIcon(Lxicon.close, this.closeButton);
		this.element.append(this.closeButton);
		this.environment = this.section('environment', localize('sessions.info.environment', 'Environment'));
		this.context = this.section('context', localize('sessions.info.context', 'Context'));
		this.contextValue = h(document, 'span');
		this.contextValue.className = 'ash-session-info-value';
		this.context.previousElementSibling!.append(this.contextValue);
		this.summary = h(document, 'p');
		this.usage = h(document, 'progress');
		this.usage.max = 100;
		this.usage.setAttribute('aria-label', localize('sessions.info.context', 'Context'));
		this.context.append(this.summary, this.usage);
		host.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(addDisposableListener(this.closeButton, 'click', () => this.close(true)));

		const resize = new document.defaultView!.ResizeObserver(entries => {
			this.fits = entries[0]!.contentRect.width >= 820;
			if (this.fits) this.popup = false;
			this.renderVisibility();
		});
		resize.observe(host);
		this._register(toDisposable(() => resize.disconnect()));
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === pinnedKey) this.renderVisibility();
			}),
		);
		this._register(model.onDidChange(() => this.render()));
		this._register(workspace.onDidChangeWorkspaceFolders(() => this.render()));
		const observeRepositories = () => {
			this.repositories.clear();
			for (const repository of scm.repositories) {
				this.repositories.add(repository.provider.onDidChangeResources(() => this.render()));
				const history = repository.provider.historyProvider;
				if (history)
					this.repositories.add(
						autorun(reader => {
							history.historyItemRef.read(reader);
							this.render();
						}),
					);
			}
			this.render();
		};
		this._register(scm.onDidAddRepository(observeRepositories));
		this._register(scm.onDidRemoveRepository(observeRepositories));
		observeRepositories();
		this.renderVisibility();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View])
			this._register(
				AccessibleViewRegistry.register({
					name: 'sessionInfo-' + createUuid(),
					type,
					priority: 95,
					getProvider: () => {
						const focused = this.element.ownerDocument.activeElement as HTMLElement;
						if (!this.element.contains(focused)) return undefined;
						return new AccessibleContentProvider(
							AccessibleViewProviderId.SessionsChat,
							{ type },
							() =>
								type === AccessibleViewType.Help
									? localize(
										'sessions.info.help',
										'The Code toolbar independently toggles Terminal, Files and session information. Closing the Terminal panel keeps its sessions running. Drag a card header onto an edge of another card to arrange it. Separators resize cards. Tab reaches Open in new window, Expand and Close. Expanding preserves the layout; closing a separate window returns the card. Enter or Space expands Environment and Context. Escape cancels dragging. Context shows estimated input against the automatic compaction budget; the unsent draft is excluded.',
									)
									: this.environment.textContent + '\n' + this.summary.textContent,
							() => (focused.isConnected ? focused.focus() : this.focusChat()),
							AccessibilityVerbositySettingId.Chat,
						);
					},
				}),
			);
	}

	get visible(): boolean {
		if (this.cards) return this.cards.isCardVisible('info');
		return this.fits ? this.storage.getBoolean(pinnedKey, StorageScope.PROFILE, false) : this.popup;
	}

	setVisible(visible: boolean): void {
		if (!visible && this.popup) {
			this.popup = false;
			this.renderVisibility();
		}
	}

	toggle(): void {
		if (this.cards) {
			this.cards.toggleInformation();
			return;
		}
		if (this.visible) {
			this.close(true);
			return;
		}
		this.returnFocus = this.host.ownerDocument.activeElement as HTMLElement;
		this.returnActionId = this.returnFocus.closest<HTMLElement>('[data-action-id]')?.dataset.actionId;
		this.bindInteraction();
		if (this.fits) this.storage.store(pinnedKey, true, StorageScope.PROFILE, StorageTarget.USER);
		else this.popup = true;
		this.renderVisibility();
		this.closeButton.focus();
	}

	/** Resolve the current menu item after its toggled state rebuilds the toolbar. */
	private focusTarget(): HTMLElement | undefined {
		if (this.returnFocus?.isConnected) return this.returnFocus;
		return this.returnActionId
			? (this.host.ownerDocument.querySelector<HTMLElement>(
				`[data-action-id="${CSS.escape(this.returnActionId)}"] button`,
			) ?? undefined)
			: undefined;
	}

	private bindInteraction(): void {
		this.interaction.clear();
		// Retained conversations can move to another window; bind to their current document.
		const document = this.host.ownerDocument;
		this.interaction.add(
			addDisposableListener(
				document,
				'pointerdown',
				event => {
					if (
						this.popup &&
						event.target instanceof document.defaultView!.Node &&
						!this.element.contains(event.target) &&
						!this.focusTarget()?.contains(event.target)
					)
						this.close(false);
				},
				true,
			),
		);
		this.interaction.add(
			addDisposableListener(
				document,
				'keydown',
				event => {
					if (event.key === 'Escape' && this.popup) {
						event.preventDefault();
						event.stopPropagation();
						this.close(true);
					}
				},
				true,
			),
		);
	}

	private close(restoreFocus: boolean): void {
		this.popup = false;
		if (this.fits) this.storage.store(pinnedKey, false, StorageScope.PROFILE, StorageTarget.USER);
		this.renderVisibility(false);
		if (restoreFocus) {
			const target = this.focusTarget();
			if (target) target.focus();
			else this.focusChat();
		}
	}

	private renderVisibility(restoreFocus = true): void {
		if (this.cards) {
			this.element.hidden = false;
			return;
		}
		const hadFocus = this.element.contains(this.host.ownerDocument.activeElement);
		this.element.hidden = !this.visible;
		if (!this.visible) this.interaction.clear();
		this.element.classList.toggle('floating', !this.fits);
		this.host.classList.toggle('info-docked', this.visible && this.fits);
		if (!this.visible && hadFocus && restoreFocus) this.focusChat();
		this.changed.fire();
	}

	private section(id: string, label: string): HTMLElement {
		const details = h(this.host.ownerDocument, 'details');
		const key = `sessions.code.info.${id}.expanded`;
		details.open = this.storage.getBoolean(key, StorageScope.PROFILE, true);
		const summary = h(this.host.ownerDocument, 'summary');
		summary.textContent = label;
		const body = h(this.host.ownerDocument, 'div');
		details.append(summary, body);
		this.element.append(details);
		this._register(
			addDisposableListener(details, 'toggle', () =>
				this.storage.store(key, details.open, StorageScope.PROFILE, StorageTarget.USER),
			),
		);
		return body;
	}

	private render(): void {
		const selection = this.model.selectedSession;
		const execution =
			selection.kind === 'session'
				? selection.active.session.chats.find(chat => chat.threadId === selection.active.threadId)?.workspace
				: selection.session.workspace.type === 'local' ||
					selection.session.workspace.type === 'ssh' ||
					selection.session.workspace.type === 'provider'
					? buildAgentHostSessionWorkspace(selection.session.workspace)
					: undefined;
		const folder = execution
			? sessionWorkspaceUri(execution)
			: selection.kind === 'untitled' && selection.session.workspace.type === 'current'
				? this.workspace.getWorkspace().folders[0]?.uri
				: undefined;
		const provider = [...this.scm.repositories].find(
			repository =>
				folder &&
				repository.provider.rootUri &&
				extUriBiasedIgnorePathCase.isEqualOrParent(folder, repository.provider.rootUri),
		)?.provider;
		const branch = provider?.historyProvider?.historyItemRef.get()?.name;
		const rows = [
			[Lxicon.remote, folder?.authority || localize('sessions.info.local', 'This computer')],
			[Lxicon.folder, folder ? basename(folder) : localize('sessions.info.noWorkspace', 'No workspace selected')],
			...(branch ? ([[Lxicon.gitBranch, branch]] as const) : []),
		] as const;
		this.environment.replaceChildren(
			...rows.map(([icon, text]) => {
				const row = h(this.host.ownerDocument, 'div');
				row.className = 'ash-session-info-row';
				appendIcon(icon, row);
				const label = h(this.host.ownerDocument, 'span');
				label.textContent = text;
				row.title = icon === Lxicon.folder && folder ? folder.fsPath : text;
				row.append(label);
				return row;
			}),
		);
		const usage = this.model.inputState.contextUsage;
		const budget = usage && getContextInputBudget(usage);
		this.contextValue.textContent = usage && budget ? `${Math.round((usage.estimatedTokens / budget) * 100)}%` : '';
		this.usage.hidden = !budget;
		if (usage && budget) this.usage.value = Math.min(100, (usage.estimatedTokens / budget) * 100);
		this.summary.textContent = usage
			? budget
				? localize(
					'sessions.info.usage',
					'{0}% · {1} / {2} tokens',
					Math.round((usage.estimatedTokens / budget) * 100),
					usage.estimatedTokens.toLocaleString(),
					budget.toLocaleString(),
				)
				: localize('sessions.info.tokens', '{0} estimated tokens', usage.estimatedTokens.toLocaleString())
			: localize('sessions.info.noUsage', 'Context usage is available after the first response.');
		this.context.title = localize(
			'sessions.info.contextHelp',
			'Estimated input compared with the automatic compaction budget. The unsent draft is excluded.',
		);
	}
}
