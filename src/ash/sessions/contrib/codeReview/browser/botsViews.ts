import { addDisposableListener, Dimension, getWindow, h, type IDimension } from '../../../../base/browser/dom.js';
import { isAncestorOfActiveElement } from '../../../../base/browser/focus.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { ObjectTreeElementCollapseState } from '../../../../base/browser/ui/tree/tree.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewPane, ViewPaneShowActions, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { ChatMessagePresentation } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { NewChatView } from '../../chat/browser/chatView.js';
import { SessionCodeReviewEditor } from './sessionCodeReviewEditor.js';
import { codeReviewRequestPrefix, codeReviewResource, ISessionCodeReviewService, type CodeReviewTarget, type SessionCodeReviewService } from './sessionCodeReviewService.js';
import './media/bots.css';

export const botsNavigationId = 'sessions.navigation.bots';
export const botsResource = URI.from({ scheme: 'ash-bots', path: '/page' });
export const botsFocusContext = 'sessionsBotsFocused';

const botsTitle = localize('sessions.bots.title', 'Bots');
const reviewName = localize('sessions.codeReview.title', 'Code Review');
const reviewGroupId = 'codeReview';

type BotTreeItem =
	| { readonly kind: 'bot'; readonly id: string; readonly label: string; }
	| { readonly kind: 'thread'; readonly id: string; readonly label: string; readonly detail: string; readonly target: CodeReviewTarget; };

function reviewThreadNodeId(sessionId: string, threadId: string): string {
	return JSON.stringify([sessionId, threadId]);
}

function bindAccessibility(
	root: HTMLElement, owner: DisposableStore, contexts: IContextKeyService,
	accessibleViews: IAccessibleViewService, configuration: IConfigurationService,
): void {
	owner.add(contexts.createScoped(root)).createKey(botsFocusContext, true);
	const update = () => {
		const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Bots);
		if (hint) root.setAttribute('aria-description', hint);
		else root.removeAttribute('aria-description');
	};
	owner.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(AccessibilityVerbositySettingId.Bots)) update();
	}));
	update();
}

export class BotsNavigationView extends ViewPane {
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		parent: HTMLElement, options: IViewPaneOptions,
		@ISessionCodeReviewService reviews: SessionCodeReviewService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IContextKeyService contexts: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super(parent, { ...options, showActions: ViewPaneShowActions.Always });
		const root = this.contentElement;
		const document = root.ownerDocument;
		root.classList.add('ash-bots-sidebar');
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', botsTitle);
		bindAccessibility(root, this._store, contexts, accessibleViews, configuration);
		// The sidebar projects title actions outside the view body.
		this._register(contexts.createScoped(this.headerActionsElement)).createKey(botsFocusContext, true);
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenus, { ariaLabel: botsTitle }));
		const back = localize({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back');
		this.toolbar.setActions([{
			id: 'sessions.open.code',
			label: back,
			tooltip: back,
			icon: Lxicon.arrowLeft,
			enabled: true,
			run: () => commands.executeCommand('sessions.open.code').catch(error => notifications.error(error)),
		}]);
		const search = this._register(new InputBox(root, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize('sessions.bots.search', 'Search Bots and Threads'),
			type: 'search',
			presentation: 'field',
			leadingIcon: Lxicon.search,
			placeholder: localize('sessions.bots.searchPlaceholder', 'Search'),
		}));
		const group: BotTreeItem = { kind: 'bot', id: reviewGroupId, label: reviewName };
		const tree = this._register(new WorkbenchObjectTree<BotTreeItem>(root, {
			configurationService: configuration,
			ariaLabel: botsTitle,
			scrolling: 'external',
			multipleSelectionSupport: false,
			expandOnlyOnTwistieClick: false,
			expandOnDoubleClick: false,
			modelOptions: { identityProvider: { getId: item => item.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.label },
			accessibilityProvider: {
				getAriaLabel: item => item.kind === 'thread' && item.detail ? `${item.label}, ${item.detail}` : item.label,
			},
			getHeight: item => item.kind === 'bot' ? 36 : 40,
			renderElement: item => {
				const label = h(document, 'span', { className: 'ash-bots-tree-label' }, item.label);
				if (item.kind === 'bot') {
					const avatar = h(document, 'span', { className: 'ash-bots-avatar', attributes: { 'aria-hidden': 'true' } });
					return h(document, 'span', { className: 'ash-bots-tree-group' }, avatar, label);
				}
				const detail = h(document, 'span', { className: 'ash-bots-thread-detail', attributes: { 'aria-hidden': 'true' } }, item.detail);
				return h(document, 'span', { className: 'ash-bots-tree-thread' }, label, detail);
			},
		}));
		tree.domNode.classList.add('ash-bots-tree');
		const empty = h(document, 'p', { className: 'ash-bots-empty', attributes: { role: 'status' } });
		root.append(empty);

		const searchChanged = observableSignalFromEvent(this, search.onDidChange);
		// Searching reveals matches without replacing the unfiltered tree's collapse state.
		let collapseBeforeSearch: boolean | undefined;
		const clearSearchAfterToggle = (collapsed: boolean): void => {
			if (collapseBeforeSearch === undefined) return;
			collapseBeforeSearch = collapsed;
			search.value = '';
		};
		const syncSelection = (entry: ReturnType<typeof reviews.activeEntry.get>): void => {
			// Focus can move through the tree before the user opens a conversation.
			tree.setSelection(entry ? [reviewThreadNodeId(entry.session.sessionId, entry.threadId)] : []);
		};
		this._register(tree.onDidChangeCollapseState(({ browserEvent, collapsed }) => {
			if (browserEvent) clearSearchAfterToggle(collapsed);
			syncSelection(reviews.activeEntry.get());
		}));
		this._register(tree.onDidAccept(({ element, node }) => {
			if (element.kind === 'thread') reviews.select(element.target);
			else if (node.collapsible) {
				const collapsed = !node.collapsed;
				tree.toggleCollapsed(reviewGroupId);
				clearSearchAfterToggle(collapsed);
			}
		}));
		this._register(tree.onPointer(({ element, browserEvent }) => {
			if (browserEvent.button === 0 && element.kind === 'thread') reviews.select(element.target);
		}));
		this._register(tree.onDidChangeSelection(({ browserEvent }) => {
			if (browserEvent) syncSelection(reviews.activeEntry.get());
		}));
		this._register(search.onKeyDown(event => {
			if (event.key === 'Escape' && !event.isComposing && search.value) {
				event.preventDefault();
				event.stopPropagation();
				search.value = '';
			}
		}));
		this._register(autorun(reader => {
			searchChanged.read(reader);
			const query = search.value.trim().toLocaleLowerCase();
			const matchingBot = reviewName.toLocaleLowerCase().includes(query);
			const entries = reviews.entries.read(reader).filter(entry => matchingBot
				|| [entry.label, entry.detail].some(value => value.toLocaleLowerCase().includes(query)));
			const currentCollapse = tree.isCollapsed(reviewGroupId) ?? false;
			if (query) collapseBeforeSearch ??= currentCollapse;
			const collapsed = !query && (collapseBeforeSearch ?? currentCollapse)
				? ObjectTreeElementCollapseState.Collapsed : ObjectTreeElementCollapseState.Expanded;
			if (!query) collapseBeforeSearch = undefined;
			const children = entries.map(entry => ({
				element: {
					kind: 'thread', id: reviewThreadNodeId(entry.session.sessionId, entry.threadId), label: entry.label, detail: entry.detail,
					target: { sessionId: entry.session.sessionId, threadId: entry.threadId },
				} satisfies BotTreeItem,
			}));
			const hasGroup = matchingBot || children.length > 0;
			tree.domNode.hidden = !hasGroup;
			tree.setChildren(hasGroup ? [{ element: group, collapsed, children }] : []);
			if (hasGroup && !tree.focus) tree.setFocus(reviewGroupId);
			syncSelection(reviews.activeEntry.read(reader));
			empty.hidden = children.length > 0;
			empty.textContent = hasGroup ? localize('sessions.bots.noThreads', 'No review threads yet.')
				: localize('sessions.bots.noMatches', 'No matching bots or threads.');
		}));
	}

	public override focus(): void { this.toolbar.focus(); }

	public getAccessibleContent(): string { return this.contentElement.innerText; }
}

/** The Bots page mounts the existing chat and comparison in independent regions. */
export class BotsEditor extends EditorPane {
	static readonly ID = 'sessions.editor.bots';
	readonly id = BotsEditor.ID;
	private readonly chat = this._register(new MutableDisposable<NewChatView>());
	private readonly comparison = this._register(new MutableDisposable<DisposableStore>());
	private readonly comparisonLoad = this._register(new MutableDisposable());
	private comparisonEditor: SessionCodeReviewEditor | undefined;
	private returnFocus: HTMLElement | undefined;
	private root!: HTMLElement;
	private conversation!: HTMLElement;
	private detail!: HTMLElement;
	private comparisonHost!: HTMLElement;
	private comparisonError!: HTMLElement;
	private closeButton!: Button;
	private chatKey: string | undefined;

	constructor(
		@ISessionCodeReviewService private readonly reviews: SessionCodeReviewService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ISessionsService private readonly sessionViews: ISessionsService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(BotsEditor.ID, theme, storage); }

	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.root = h(document, 'section', {
			className: 'ash-bots-page', properties: { tabIndex: -1 }, attributes: { 'aria-label': botsTitle },
		});
		parent.append(this.root);
		super.create(this.root);
		this._register(toDisposable(() => this.root.remove()));
		bindAccessibility(this.root, this._store, this.contexts, this.accessibleViews, this.configuration);

		const avatar = h(document, 'span', { className: 'ash-bots-avatar', attributes: { 'aria-hidden': 'true' } });
		const title = h(document, 'h1', reviewName);
		const context = h(document, 'p', reviewName);
		const header = h(document, 'header', { className: 'ash-bots-header' }, avatar, h(document, 'div', { className: 'ash-bots-heading' }, title, context));
		const review = this._register(new Button(header, {
			...defaultButtonStyles, label: localize('sessions.codeReview.reviewChanges', 'Review Changes'),
			icon: Lxicon.codeReview, presentation: 'secondary',
			onClick: () => {
				const active = this.sessions.active;
				if (!active) return;
				void this.openComparison(codeReviewResource({ sessionId: active.session.sessionId, threadId: active.threadId }), review.domNode);
			},
		}));
		const empty = h(document, 'p', { className: 'ash-bots-welcome' });
		this.conversation = h(document, 'div', { className: 'ash-bots-conversation ash-chat-content-layout' }, empty);
		const detailHeader = h(document, 'header', { className: 'ash-bots-detail-header' }, h(document, 'h2', localize('sessions.bots.comparison', 'Comparison')));
		this.closeButton = this._register(new Button(detailHeader, {
			...defaultButtonStyles, label: localize('sessions.bots.closeComparison', 'Close Comparison'),
			icon: Lxicon.close, iconOnly: true, presentation: 'quiet',
			onClick: () => this.closeComparison(true),
		}));
		this.comparisonHost = h(document, 'div', { className: 'ash-bots-comparison' });
		this.comparisonError = h(document, 'p', {
			className: 'ash-bots-comparison-error', properties: { hidden: true }, attributes: { role: 'status' },
		});
		this.detail = h(document, 'section', {
			className: 'ash-bots-detail', properties: { hidden: true },
			attributes: { 'aria-label': localize('sessions.bots.comparison', 'Comparison') },
		}, detailHeader, this.comparisonError, this.comparisonHost);
		this.root.append(header, h(document, 'div', { className: 'ash-bots-body' }, this.conversation, this.detail));
		this._register(addDisposableListener(this.detail, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.preventDefault();
				event.stopPropagation();
				this.closeComparison(true);
			}
		}));

		const sessionsChanged = observableSignalFromEvent(this, this.sessions.onDidChange);
		this._register(autorun(reader => {
			sessionsChanged.read(reader);
			const active = this.sessions.active;
			const entry = this.reviews.activeEntry.read(reader);
			const canReview = !!active && active.session.kind === 'code' && active.session.status !== 'archived';
			review.enabled = canReview;
			empty.textContent = canReview
				? localize('sessions.bots.startReview', 'Choose Review Changes to start a thread with Code Review.')
				: localize('sessions.codeReview.selectConversation', 'Open a conversation with code changes to start a review.');
			title.textContent = entry?.label ?? reviewName;
			context.textContent = entry ? localize('sessions.bots.threadContext', 'Code Review · {0}', entry.detail) : '';
			empty.hidden = !!entry;
			const key = entry && JSON.stringify([entry.session.sessionId, entry.threadId]);
			if (key === this.chatKey) return;
			this.chatKey = key;
			if (this.chat.value) this.chat.value.setVisible(false);
			this.chat.clear();
			this.closeComparison(false);
			if (!entry) return;
			const target = { sessionId: entry.session.sessionId, threadId: entry.threadId };
			this.chat.value = this.instantiation.createInstance(NewChatView, this.conversation, {
				panelId: 'ash-bots-chat',
				selection: {
					kind: 'session', active: { session: entry.session, threadId: entry.threadId },
					firstRequestClientId: entry.firstRequestClientId,
				},
				createNewSession: () => { if (review.enabled) review.domNode.click(); },
				onDidChangeInfo: () => { },
				messagePresentation: this.messagePresentation(target),
			});
			this.chat.value.setVisible(this.isVisible());
		}));
		const markViewed = () => this.markThreadViewed();
		this._register(this.onDidFocus(markViewed));
		this._register(addDisposableListener(getWindow(document), 'focus', markViewed));
		this._register(addDisposableListener(document, 'visibilitychange', markViewed));
		this._register(autorun(reader => this.markThreadViewed(reader)));
	}

	private markThreadViewed(reader?: IReader): void {
		const entry = this.reviews.activeEntry.read(reader);
		if (!entry || !this.chat.value || !this.isVisible()) return;
		const document = this.root.ownerDocument;
		if (!document.hidden && document.hasFocus() && isAncestorOfActiveElement(this.root)) {
			this.sessionViews.markVisibleThreadViewed({ sessionId: entry.session.sessionId, threadId: entry.threadId });
		}
	}

	private messagePresentation(target: CodeReviewTarget): ChatMessagePresentation {
		return {
			user: { name: localize('sessions.bots.you', 'You'), icon: Lxicon.account },
			assistant: { name: reviewName },
			getReferences: item => {
				const id = item.requestClientId;
				if (item.type !== 'userMessage' || !id?.startsWith(codeReviewRequestPrefix)) return [];
				const snapshot = this.reviews.snapshotForMessage(target, id);
				if (!snapshot) return [];
				return snapshot.batch.comments.map(comment => {
					const file = snapshot.batch.files.find(file => file.key === comment.file)!;
					const name = posix.basename(file.path);
					const label = comment.endLine
						? localize('sessions.bots.fileRange', '{0} · Lines {1}–{2}', name, comment.line, comment.endLine)
						: localize('sessions.bots.fileLine', '{0} · Line {1}', name, comment.line);
					const resource = codeReviewResource(snapshot.source, id).with({ fragment: comment.id });
					return { id: comment.id, label, open: trigger => void this.openComparison(resource, trigger) };
				});
			},
		};
	}

	private async openComparison(resource: URI, trigger?: HTMLElement): Promise<void> {
		if (trigger) this.returnFocus = trigger;
		if (!this.comparison.value) {
			const lifetime = this.comparison.value = new DisposableStore();
			const editor = this.comparisonEditor = lifetime.add(this.instantiation.createInstance(SessionCodeReviewEditor,
				(next: URI) => this.openComparison(next)));
			this.detail.hidden = false;
			editor.create(this.comparisonHost);
			editor.setVisible(true);
		}
		const editor = this.comparisonEditor!;
		this.comparisonError.hidden = true;
		const controller = new AbortController();
		const load = this.comparisonLoad.value = toDisposable(() => controller.abort());
		try {
			await editor.setInput({ resource }, controller.signal);
			if (this.comparisonLoad.value === load && this.isVisible()) {
				if (trigger) this.closeButton.focus();
				else editor.focus();
			}
		} catch (error) {
			if (!isCancellationError(error) && !controller.signal.aborted) {
				editor.clearInput();
				this.comparisonError.textContent = localize('sessions.codeReview.loadFailed', 'Could not load this comparison: {0}', toErrorMessage(error));
				this.comparisonError.hidden = false;
			}
		}
	}

	private closeComparison(restoreFocus: boolean): void {
		this.comparisonLoad.clear();
		this.comparison.clear();
		this.comparisonEditor = undefined;
		this.detail.hidden = true;
		if (restoreFocus) {
			const trigger = this.returnFocus;
			const referenceId = trigger?.dataset.chatReferenceId;
			const replacement = referenceId && Array.from(this.conversation.querySelectorAll<HTMLElement>('[data-chat-reference-id]'))
				.find(button => button.dataset.chatReferenceId === referenceId);
			if (trigger?.isConnected) trigger.focus();
			else if (replacement) replacement.focus();
			else this.focus();
		}
		this.returnFocus = undefined;
	}

	public getAccessibleContent(focused: Element | null): string {
		if (focused && this.detail.contains(focused)) return this.comparisonEditor?.getAccessibleContent() ?? '';
		return this.chat.value?.model.items.map(item => {
			const name = item.type === 'userMessage' ? localize('sessions.bots.you', 'You')
				: item.type === 'agentMessage' ? reviewName : item.label;
			return name ? name + '\n' + item.text : item.text;
		}).join('\n\n') || this.root.innerText;
	}

	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { throwIfCancelled(signal); }
	public override clearInput(): void { this.closeComparison(false); }
	public override layout(dimension: IDimension): void {
		this.comparisonEditor?.layout(new Dimension(this.comparisonHost.clientWidth, dimension.height));
	}
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.chat.value?.setVisible(visible);
		this.comparisonEditor?.setVisible(visible);
		if (visible) this.markThreadViewed();
	}
	public override focus(): void {
		if (this.chat.value) this.chat.value.focus();
		else this.root.focus();
	}
}
