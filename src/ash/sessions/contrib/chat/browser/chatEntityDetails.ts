import { addDisposableListener, getActiveElement, h } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
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
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ChatListWidget } from '../../../../workbench/contrib/chat/browser/widget/chatListWidget.js';
import { renderChatRichContentText } from '../../../../workbench/contrib/chat/browser/widget/chatMarkdownRichContent.js';
import type { ChatMarkdownEntity } from '../../../../workbench/contrib/chat/common/model/chatMarkdownRichContent.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { ChatEntityDetailsCache, type ChatEntityDetailsReply } from './chatEntityDetailsCache.js';
import './media/chatEntityDetails.css';

const entityDetailsContainerId = 'sessions.chat.entityDetails';
const entityDetailsViewId = `${entityDetailsContainerId}.view`;
const entityDetailsActiveContext = 'sessionsChatEntityDetailsActive';
const detailsFocusContext = 'sessionsChatEntityDetailsFocused';

export interface ChatEntityDetailsSource {
	/** Stable, opaque backend, account, conversation and reply identity. Undefined disables persistence. */
	readonly cacheIdentity?: readonly [backend: string, account: string, conversation: string, reply: string];
	readonly current: IObservable<boolean>;
	read(entity: ChatMarkdownEntity, locale: string, signal: AbortSignal): AsyncIterable<ChatEntityDetailsReply>;
	readResource(itemId: string, uri: string, signal: AbortSignal): Promise<Blob>;
}

interface EntityDetailsState {
	readonly label: string;
	readonly items: readonly IChatListItem[];
	readonly status: 'loading' | 'complete' | 'error';
}

export const IChatEntityDetails = createServiceIdentifier<ChatEntityDetails>('chatEntityDetails');

/** Owns the transient detail stream separately from the main chat and its history. */
export class ChatEntityDetails extends Disposable {
	private readonly request = this._register(new MutableDisposable<DisposableStore>());
	private readonly detail = observableValue<EntityDetailsState | undefined>(this, undefined);
	readonly state: IObservable<EntityDetailsState | undefined> = this.detail;
	private readonly cache = this._register(new ChatEntityDetailsCache());
	private active: { readonly source: ChatEntityDetailsSource; readonly cacheKey?: string; readonly anchor: HTMLElement; readonly signal: AbortSignal; } | undefined;
	private readonly activeContext: IContextKey<boolean>;

	constructor(@IViewsService private readonly views: IViewsService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.activeContext = contextKeys.createKey(entityDetailsActiveContext, false);
		this._register(toDisposable(() => this.activeContext.reset()));
		this._register(views.onDidChangeViewContainerVisibility(event => {
			if (event.id === entityDetailsContainerId && !event.visible) { this.close(false); }
		}));
	}

	async open(source: ChatEntityDetailsSource, entity: ChatMarkdownEntity, anchor: HTMLElement): Promise<void> {
		if (!source.current.get()) return;
		const controller = new AbortController();
		const signal = controller.signal;
		const locale = getNLSLanguage();
		const cacheKey = source.cacheIdentity && JSON.stringify([...source.cacheIdentity, locale, entity.category, entity.label, entity.disambiguation]);
		const active = this.active = { source, cacheKey, anchor, signal };
		const lifetime = new DisposableStore();
		this.request.value = lifetime;
		lifetime.add(toDisposable(() => controller.abort()));
		lifetime.add(autorun(reader => {
			if (!source.current.read(reader)) this.close(false);
		}));
		const items = new Map<string, ChatEntityDetailsReply>();
		const publish = (status: EntityDetailsState['status']) => {
			this.detail.set({ label: entity.label, status, items: [...items.values()].map(item => ({ ...item, type: 'agentMessage', transient: status === 'loading' })) }, undefined);
		};
		publish('loading');
		this.activeContext.set(true);
		try {
			if (!await this.views.openView(entityDetailsViewId, true)) {
				if (this.active === active) this.close(true);
				return;
			}
			const cached = cacheKey ? await this.cache.read(cacheKey) : undefined;
			signal.throwIfAborted();
			if (cached) {
				for (const item of cached) items.set(item.id, item);
				publish('complete');
				return;
			}
			for await (const item of source.read(entity, locale, signal)) {
				signal.throwIfAborted();
				items.set(item.id, item);
				publish('loading');
			}
			signal.throwIfAborted();
			if (cacheKey && items.size) await this.cache.write(cacheKey, [...items.values()]);
			if (!signal.aborted) publish(items.size ? 'complete' : 'error');
		} catch {
			if (!signal.aborted) publish('error');
		}
	}

	async readResource(item: IChatListItem, uri: string, signal: AbortSignal): Promise<Blob> {
		const active = this.active;
		const current = this.detail.get()?.items.find(candidate => candidate.id === item.id);
		const hasResource = current?.resources?.some(resource => resource.uri === uri)
			|| current?.markdown?.richContent?.parts.some(part => part.kind === 'imageGallery' && part.images.some(image => image.uri === uri));
		if (!active || !hasResource) throw new Error(localize('sessions.chat.entityResourceUnavailable', 'Entity detail resource is unavailable.'));
		const readSignal = AbortSignal.any([signal, active.signal]);
		const cached = active.cacheKey ? await this.cache.readResource(active.cacheKey, item.id, uri) : undefined;
		readSignal.throwIfAborted();
		if (cached) return cached;
		const blob = await active.source.readResource(item.id, uri, readSignal);
		readSignal.throwIfAborted();
		if (active.cacheKey) await this.cache.writeResource(active.cacheKey, item.id, uri, blob);
		readSignal.throwIfAborted();
		return blob;
	}

	close(restoreFocus: boolean): void {
		const active = this.active;
		if (!active) return;
		this.active = undefined;
		this.request.clear();
		this.detail.set(undefined, undefined);
		if (this.views.isViewContainerVisible(entityDetailsContainerId)) { this.views.closeViewContainer(entityDetailsContainerId); }
		this.activeContext.reset();
		if (restoreFocus && active.anchor.isConnected) { active.anchor.focus({ preventScroll: true }); }
	}
}

class ChatEntityDetailsView extends ViewPane {
	private readonly toolbar: WorkbenchToolBar;

	constructor(
		container: HTMLElement, options: IViewPaneOptions,
		@IChatEntityDetails details: ChatEntityDetails,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super(container, options);
		const body = this.contentElement;
		body.classList.add('ash-chat-entity-details');
		const title = h(body.ownerDocument, 'h2', { className: 'ash-chat-entity-details-heading' });
		const closeLabel = localize('sessions.chat.entityClose', 'Close details');
		const close = this._register(new Action('sessions.chat.closeEntityDetails', closeLabel, undefined, true, () => details.close(true)));
		close.icon = Lxicon.close;
		close.tooltip = closeLabel;
		this.toolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, menus, { ariaLabel: localize('sessions.chat.entityDetails', 'Entity details') }));
		this.toolbar.element.classList.add('ash-chat-entity-details-actions');
		this.toolbar.setActions([close]);
		const status = h(body.ownerDocument, 'div', { className: 'ash-chat-entity-details-status', attributes: { role: 'status' } });
		const transcript = h(body.ownerDocument, 'div', { className: 'ash-chat-entity-details-transcript' });
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
		this._register(contextKeys.createScoped(this.headerActionsElement)).createKey(detailsFocusContext, true);
		this._register(addDisposableListener(this.headerActionsElement, 'keydown', closeOnEscape));
		this._register(this.onDidChangeBodyVisibility(visible => list.setVisible(visible)));
		this._register(autorun(reader => {
			const state = details.state.read(reader);
			title.textContent = state?.label ?? '';
			const message = state?.status === 'loading' ? localize('sessions.chat.entityLoading', 'Loading entity details…')
				: state?.status === 'error' ? localize('sessions.chat.entityFailed', 'Could not load details. Select the entity again to retry.') : '';
			if (status.textContent !== message) status.textContent = message;
			status.hidden = !message;
			list.render(state?.items ?? []);
		}));
	}

	public override get partTitleProjection(): PartTitleProjection {
		return { actions: this.headerActionsElement };
	}

	public override focus(): void { this.toolbar.focus(0); }
}

export function registerChatEntityDetails(): void {
	registerSingleton(IChatEntityDetails, ChatEntityDetails, InstantiationType.Delayed);
	const title = localize('sessions.chat.entityDetails', 'Entity details');
	const localizationKey = { bundle: 'ash', key: 'sessions.chat.entityDetails' };
	SessionsViewRegistry.registerStaticViewContainer({ id: entityDetailsContainerId, title, localizationKey, location: ViewContainerLocation.AuxiliaryBar, hideIfEmpty: true });
	SessionsViewRegistry.registerStaticViews(entityDetailsContainerId, [{
		id: entityDetailsViewId, title, localizationKey, ctorDescriptor: new SyncDescriptor(ChatEntityDetailsView),
		canToggleVisibility: false, when: ContextKeyExpr.has(entityDetailsActiveContext),
	}]);
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		AccessibleViewRegistry.register({
			type, priority: 110, name: `sessionsChatEntityDetails${type}`, when: ContextKeyExpr.has(detailsFocusContext),
			getProvider: accessor => {
				const details = accessor.get(IChatEntityDetails);
				const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
				return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => type === AccessibleViewType.Help
					? localize('sessions.chat.entityHelp', 'Entity details opens next to the conversation. Use Tab to reach images and source links. Use the Left and Right Arrow keys in a gallery to change images. Press Enter to open the preview, where the image viewport and gallery controls also support the Left and Right Arrow keys. Press Escape to return to the current image. Press Escape again or use the Close details button in the pane title bar to return to the entity. Open Accessible View to read the details as text.')
					: [details.state.get()?.label, ...details.state.get()?.items.map(item => renderChatRichContentText(item.text, item.markdown?.richContent)) ?? []].filter(Boolean).join('\n\n'),
					() => focused?.focus(), AccessibilityVerbositySettingId.Chat);
			},
		});
	}
}
