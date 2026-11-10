import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableValue, type IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ChatListWidget } from '../../../../workbench/contrib/chat/browser/widget/chatListWidget.js';
import { renderChatRichContentText } from '../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import type { ChatMarkdownEntity } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import type { ChatGPTBranchSource } from '../browser/chatGPTClient.js';
import { decodeChatGPTReply } from '../browser/chatGPTRichContent.js';
import type { IChatGPTService } from '../browser/chatGPTService.js';
import './chatGPTEntityDetails.css';

export const chatGPTEntityDetailsContainerId = 'sessions.chatgpt.entityDetails';
export const chatGPTEntityDetailsViewId = `${chatGPTEntityDetailsContainerId}.view`;
export const chatGPTEntityDetailsActiveContext = 'sessionsChatGPTEntityDetailsActive';
const detailsFocusContext = 'sessionsChatGPTEntityDetailsFocused';

interface EntityDetailsState {
	readonly label: string;
	readonly items: readonly IChatListItem[];
	readonly status: 'loading' | 'complete' | 'error';
}

export const IChatGPTEntityDetails = createServiceIdentifier<ChatGPTEntityDetails>('chatGPTEntityDetails');

/** Owns the transient detail stream separately from the main chat and its history. */
export class ChatGPTEntityDetails extends Disposable {
	private readonly request = this._register(new MutableDisposable<DisposableStore>());
	private readonly detail = observableValue<EntityDetailsState | undefined>(this, undefined);
	readonly state: IObservable<EntityDetailsState | undefined> = this.detail;
	private active: { readonly backend: IChatGPTService; readonly source: ChatGPTBranchSource; readonly anchor: HTMLElement; readonly signal: AbortSignal; } | undefined;
	private readonly activeContext: IContextKey<boolean>;

	constructor(@IViewsService private readonly views: IViewsService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.activeContext = contextKeys.createKey(chatGPTEntityDetailsActiveContext, false);
		this._register(toDisposable(() => this.activeContext.reset()));
		this._register(views.onDidChangeViewContainerVisibility(event => {
			if (event.id === chatGPTEntityDetailsContainerId && !event.visible) { this.close(false); }
		}));
	}

	async open(backend: IChatGPTService, source: ChatGPTBranchSource, entity: ChatMarkdownEntity, anchor: HTMLElement): Promise<void> {
		const conversation = backend.state.get();
		if (conversation.conversationId !== source.conversationId) { return; }
		const controller = new AbortController();
		const active = this.active = { backend, source, anchor, signal: controller.signal };
		const lifetime = new DisposableStore();
		this.request.value = lifetime;
		lifetime.add(toDisposable(() => controller.abort()));
		lifetime.add(autorun(reader => {
			const current = backend.state.read(reader);
			if (current.localConversationId !== conversation.localConversationId || current.catalogScope !== conversation.catalogScope || current.conversationId !== source.conversationId || (conversation.connected && !current.connected)) {
				this.close(false);
			}
		}));
		this.detail.set({ label: entity.label, items: [], status: 'loading' }, undefined);
		this.activeContext.set(true);
		try {
			if (!await this.views.openView(chatGPTEntityDetailsViewId, true)) {
				if (this.active === active) { this.close(true); }
				return;
			}
			if (controller.signal.aborted) return;
			if (!conversation.connected || !conversation.networkAvailable) {
				this.detail.set({ label: entity.label, items: [], status: 'error' }, undefined);
				return;
			}
			for await (const message of backend.inspectEntity(source, entity, getNLSLanguage(), controller.signal)) {
				if (controller.signal.aborted) return;
				const decoded = decodeChatGPTReply(message.text, message.references, source.conversationId, message.imageGroups);
				const items = [...this.detail.get()!.items];
				const item: IChatListItem = {
					id: message.id, type: 'agentMessage', text: decoded.text, transient: true,
					markdown: { supportHtml: true, richContent: decoded.richContent, linkPolicy: 'external' },
					resources: [...decoded.resources, ...message.resources ?? []],
				};
				const index = items.findIndex(previous => previous.id === item.id);
				if (index < 0) items.push(item); else items[index] = item;
				this.detail.set({ label: entity.label, items, status: 'loading' }, undefined);
			}
			if (controller.signal.aborted) return;
			const items = this.detail.get()!.items.map(item => ({ ...item, transient: false }));
			this.detail.set({ label: entity.label, items, status: items.length ? 'complete' : 'error' }, undefined);
		} catch {
			if (controller.signal.aborted) return;
			const items = this.detail.get()!.items.map(item => ({ ...item, transient: false }));
			this.detail.set({ label: entity.label, items, status: 'error' }, undefined);
		}
	}

	readResource(item: IChatListItem, uri: string, signal: AbortSignal): Promise<Blob> {
		// Finalizing a streamed message can replace the row snapshot while its image starts loading.
		const current = this.detail.get()?.items.find(candidate => candidate.id === item.id);
		const hasResource = current?.resources?.some(resource => resource.uri === uri)
			|| current?.markdown?.richContent?.parts.some(part => part.kind === 'imageGallery' && part.images.some(image => image.uri === uri));
		if (!this.active || !hasResource) {
			throw new Error(localize('sessions.chatgpt.entityResourceUnavailable', 'Entity detail resource is unavailable.'));
		}
		return this.active.backend.readResource(uri, this.active.source.conversationId, item.id, AbortSignal.any([signal, this.active.signal]));
	}

	close(restoreFocus: boolean): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		this.request.clear();
		this.detail.set(undefined, undefined);
		if (this.views.isViewContainerVisible(chatGPTEntityDetailsContainerId)) { this.views.closeViewContainer(chatGPTEntityDetailsContainerId); }
		this.activeContext.reset();
		if (restoreFocus && active.anchor.isConnected) { active.anchor.focus({ preventScroll: true }); }
	}
}

export class ChatGPTEntityDetailsView extends ViewPane {
	private readonly closeButton: Button;

	constructor(
		container: HTMLElement, options: IViewPaneOptions,
		@IChatGPTEntityDetails details: ChatGPTEntityDetails,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(container, options);
		const body = this.contentElement;
		body.classList.add('ash-chatgpt-entity-details');
		const title = h(body.ownerDocument, 'h2', { className: 'ash-chatgpt-entity-details-heading' });
		const closeLabel = localize('sessions.chatgpt.entityClose', 'Close details');
		const titleActions = h(body.ownerDocument, 'div');
		this.closeButton = this._register(new Button(titleActions, {
			...defaultButtonStyles, presentation: 'quiet', size: 'small', icon: Lxicon.close, iconOnly: true,
			label: closeLabel, title: closeLabel, onClick: () => details.close(true),
		}));
		this.closeButton.domNode.classList.add('ash-chatgpt-entity-details-close');
		const status = h(body.ownerDocument, 'div', { className: 'ash-chatgpt-entity-details-status', attributes: { role: 'status' } });
		const transcript = h(body.ownerDocument, 'div', { className: 'ash-chatgpt-entity-details-transcript' });
		body.append(title, status, transcript);
		const scope = this._register(contextKeys.createScoped(body));
		scope.createKey(detailsFocusContext, true);
		const scoped = this._register(instantiation.createChild(new ServiceCollection([IContextKeyService, scope])));
		const list = this._register(scoped.createInstance(ChatListWidget, transcript, {
			readResponseResource: (item: IChatListItem, resource: URI, signal: AbortSignal) => details.readResource(item, resource.toString(), signal),
		}));
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			details.close(true);
		};
		this._register(addDisposableListener(body, 'keydown', closeOnEscape));
		// The projected action sits outside the view body and needs its own focus scope.
		this._register(contextKeys.createScoped(this.closeButton.domNode)).createKey(detailsFocusContext, true);
		this._register(addDisposableListener(this.closeButton.domNode, 'keydown', closeOnEscape));
		this._register(this.onDidChangeBodyVisibility(visible => list.setVisible(visible)));
		this._register(autorun(reader => {
			const state = details.state.read(reader);
			title.textContent = state?.label ?? '';
			const message = state?.status === 'loading' ? localize('sessions.chatgpt.entityLoading', 'Loading entity details…')
				: state?.status === 'error' ? localize('sessions.chatgpt.entityFailed', 'Could not load details. Select the entity again to retry.') : '';
			if (status.textContent !== message) status.textContent = message;
			status.hidden = !message;
			list.render(state?.items ?? []);
		}));
	}

	public override get partTitleProjection(): PartTitleProjection {
		return { actions: this.closeButton.domNode };
	}

	public override focus(): void { this.closeButton.focus(); }
}

export function registerChatGPTEntityDetailsAccessibility(): void {
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		AccessibleViewRegistry.register({
			type, priority: 110, name: `sessionsChatGPTEntityDetails${type}`, when: ContextKeyExpr.has(detailsFocusContext),
			getProvider: accessor => {
				const details = accessor.get(IChatGPTEntityDetails);
				const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
				return new AccessibleContentProvider(AccessibleViewProviderId.ChatGPT, { type }, () => type === AccessibleViewType.Help
					? localize('sessions.chatgpt.entityHelp', 'Entity details opens next to the conversation. Use Tab to reach images and source links. Press Enter to preview an image and Escape to return to it. Press Escape again or use the Close details button in the pane title bar to return to the entity. Open Accessible View to read the details as text.')
					: [details.state.get()?.label, ...details.state.get()?.items.map(item => renderChatRichContentText(item.text, item.markdown?.richContent)) ?? []].filter(Boolean).join('\n\n'),
					() => focused?.focus(), AccessibilityVerbositySettingId.ChatGPT);
			},
		});
	}
}
