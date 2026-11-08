import { addDisposableListener, Dimension, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableSignalFromEvent, observableValue } from '../../../../base/common/observable.js';
import { posix } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { ChatMessagePresentation } from '../../../../workbench/contrib/chat/browser/chat.js';
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
	private readonly back: Button;
	private readonly search: InputBox;
	private readonly rows = this._register(new DisposableStore());
	private readonly expanded = observableValue(this, true);

	constructor(
		parent: HTMLElement, options: IViewPaneOptions,
		@ISessionCodeReviewService reviews: SessionCodeReviewService,
		@ICommandService commands: ICommandService,
		@INotificationService notifications: INotificationService,
		@IContextKeyService contexts: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(parent, options);
		const root = this.contentElement;
		const document = root.ownerDocument;
		root.classList.add('ash-bots-sidebar');
		root.setAttribute('role', 'region');
		root.setAttribute('aria-label', botsTitle);
		bindAccessibility(root, this._store, contexts, accessibleViews, configuration);
		this.back = this._register(new Button(root, {
			...defaultButtonStyles, label: localize({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back'),
			icon: Lxicon.arrowLeft, presentation: 'quiet',
			onClick: () => void commands.executeCommand('sessions.open.code').catch(error => notifications.error(error)),
		}));
		const searchLabel = localize('sessions.bots.search', 'Search Bots and Threads');
		this.search = this._register(new InputBox(root, {
			inputBoxStyles: defaultInputBoxStyles, ariaLabel: searchLabel, type: 'search', presentation: 'field',
			placeholder: localize('sessions.bots.searchPlaceholder', 'Search'),
		}));
		this.search.element.classList.add('ash-bots-search');
		this.search.element.prepend(appendIcon(Lxicon.search, this.search.element));
		const group = h(document, 'div', { className: 'ash-bots-list' });
		const heading = h(document, 'h2', botsTitle);
		const bot = this._register(new Button(group, {
			...defaultButtonStyles, label: reviewName, presentation: 'quiet',
		}));
		bot.domNode.classList.add('ash-bots-group');
		bot.domNode.prepend(h(document, 'span', { className: 'ash-bots-avatar', attributes: { 'aria-hidden': 'true' } }));
		const chevron = h(document, 'span', { className: 'ash-bots-chevron', attributes: { 'aria-hidden': 'true' } });
		appendIcon(Lxicon.chevronRight, chevron);
		bot.domNode.append(chevron);
		const threads = h(document, 'ul', {
			className: 'ash-bots-threads', attributes: { id: 'ash-bots-review-threads', 'aria-label': reviewName },
		});
		bot.domNode.setAttribute('aria-controls', threads.id);
		const empty = h(document, 'p', { className: 'ash-bots-empty', attributes: { role: 'status' } });
		group.prepend(heading);
		group.append(threads, empty);
		root.append(group);

		const searchChanged = observableSignalFromEvent(this, this.search.onDidChange);
		this._register(bot.onDidClick(() => {
			this.expanded.set(bot.domNode.getAttribute('aria-expanded') !== 'true', undefined);
			if (this.search.value) this.search.value = '';
		}));
		this._register(addDisposableListener(this.search.inputElement, 'keydown', event => {
			if (event.key === 'Escape' && this.search.value) {
				this.search.value = '';
				event.stopPropagation();
			}
		}));
		this._register(addDisposableListener(group, 'keydown', event => {
			if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
			const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.closest('[hidden]'));
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			if (index < 0) return;
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
				: Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
			buttons[next]?.focus();
			event.preventDefault();
		}));

		let rendered = '';
		this._register(autorun(reader => {
			searchChanged.read(reader);
			const query = this.search.value.trim().toLocaleLowerCase();
			const matchingBot = reviewName.toLocaleLowerCase().includes(query);
			const entries = reviews.entries.read(reader).filter(entry => matchingBot
				|| [entry.label, entry.detail].some(value => value.toLocaleLowerCase().includes(query)));
			const expanded = this.expanded.read(reader) || !!query;
			const active = reviews.activeEntry.read(reader)?.threadId;
			bot.hidden = !matchingBot && !entries.length;
			bot.domNode.setAttribute('aria-expanded', String(expanded));
			threads.hidden = !expanded;
			empty.hidden = entries.length > 0 || !expanded;
			empty.textContent = query && !matchingBot ? localize('sessions.bots.noMatches', 'No matching bots or threads.')
				: localize('sessions.bots.noThreads', 'No review threads yet.');

			const key = JSON.stringify(entries.map(entry => [entry.threadId, entry.label, entry.detail]));
			if (key !== rendered) {
				rendered = key;
				const focused = threads.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.thread : undefined;
				this.rows.clear();
				threads.replaceChildren();
				for (const entry of entries) {
					const item = h(document, 'li');
					const button = this.rows.add(new Button(item, {
						...defaultButtonStyles, label: entry.label, title: entry.label, presentation: 'quiet',
						onClick: () => reviews.select({ sessionId: entry.session.sessionId, threadId: entry.threadId }),
					}));
					button.domNode.dataset.thread = entry.threadId;
					button.domNode.append(h(document, 'span', { className: 'ash-bots-thread-detail' }, entry.detail));
					threads.append(item);
				}
				if (focused) {
					const retained = Array.from(threads.querySelectorAll('button')).find(button => button.dataset.thread === focused);
					(retained ?? bot.domNode).focus({ preventScroll: true });
				}
			}
			for (const button of threads.querySelectorAll('button')) {
				if (button.dataset.thread === active) button.setAttribute('aria-current', 'true');
				else button.removeAttribute('aria-current');
			}
		}));
	}

	public override focus(): void { this.back.focus(); }
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
	}
	public override focus(): void {
		if (this.chat.value) this.chat.value.focus();
		else this.root.focus();
	}
}
