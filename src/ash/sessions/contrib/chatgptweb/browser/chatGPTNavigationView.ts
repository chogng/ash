import { addDisposableListener, getActiveElement, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { ChatGPTConversation } from './chatGPTClient.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatGPTService } from './chatGPTService.js';
import './media/chatGPTNavigationView.css';

export class ChatGPTNavigationView extends ViewPane {
	constructor(parent: HTMLElement, options: IViewPaneOptions,
		@IChatGPTService chat: IChatGPTService,
		@IEditorService editors: IEditorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(parent, options);
		const document = parent.ownerDocument;
		const root = this.contentElement;
		root.classList.add('ash-chatgpt-navigation');
		this._register(contextKeys.createScoped(root)).createKey('chatGPTFocused', true);
		this._register(addDisposableListener(root, 'focusin', event => {
			if (!root.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatGPT)) {
				status(localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'));
			}
		}));
		const button = (label: string, action: () => void): HTMLButtonElement => {
			const element = document.createElement('button');
			element.type = 'button';
			element.textContent = label;
			this._register(addDisposableListener(element, 'click', action));
			return element;
		};
		const newChat = button(localize('sessions.chatgpt.newChat', 'New chat'), () => { chat.newChat(); editors.focusActiveEditor(); });
		const search = document.createElement('input');
		search.type = 'search';
		search.placeholder = localize('sessions.chatgpt.search', 'Search conversations');
		search.setAttribute('aria-label', search.placeholder);
		root.append(newChat, search);
		const scrollable = this._register(new ScrollableElement(root, { direction: 'vertical', vertical: 'auto', tabIndex: -1 }));
		scrollable.element.classList.add('ash-chatgpt-navigation-scrollable');
		const list = document.createElement('nav');
		list.className = 'ash-chatgpt-navigation-list';
		list.setAttribute('aria-label', localize('sessions.chatgpt.recent', 'Recent conversations'));
		scrollable.append(list);
		const filter = () => {
			const query = search.value.trim().toLocaleLowerCase();
			for (const item of list.querySelectorAll('button')) { item.hidden = !item.textContent?.toLocaleLowerCase().includes(query); }
			scrollable.layout();
		};
		this._register(addDisposableListener(search, 'input', filter));
		this._register(addDisposableListener(list, 'click', event => {
			const item = event.target instanceof Element ? event.target.closest('button') : null;
			if (item instanceof HTMLButtonElement && item.dataset.conversation) { void chat.select(item.dataset.conversation).then(() => editors.focusActiveEditor()); }
		}));
		this._register(addDisposableListener(list, 'keydown', event => {
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
			const items = [...list.querySelectorAll('button')].filter(item => !item.hidden && !item.disabled);
			const index = items.indexOf(getActiveElement(document) as HTMLButtonElement);
			if (index < 0) { return; }
			event.preventDefault();
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
			items[next].focus();
		}));
		const loadMoreIfNeeded = (retry = false): void => {
			const state = chat.state.get();
			const viewport = scrollable.state;
			if (!this.isBodyVisible() || !viewport.height || search.value.trim() || !state.connected || state.busy || state.sending || !state.hasMore || (!retry && state.error)) { return; }
			if (viewport.maximumTop - viewport.top <= 96) { void chat.loadMore(); }
		};
		const pendingLoad = this._register(new MutableDisposable());
		let retryLoad = false;
		const scheduleLoad = (retry = false): void => {
			retryLoad ||= retry;
			pendingLoad.value = scheduleAtNextAnimationFrame(getWindow(list), () => {
				pendingLoad.clear();
				const retry = retryLoad;
				retryLoad = false;
				loadMoreIfNeeded(retry);
			});
		};
		this._register(scrollable.onDidScroll(event => scheduleLoad(event.current.top !== event.previous.top)));
		this._register(observeResize(scrollable.element, () => scheduleLoad()));
		this._register(addDisposableListener(search, 'input', () => scheduleLoad()));
		this._register(this.onDidChangeBodyVisibility(() => { scrollable.layout(); scheduleLoad(); }));
		let conversations: readonly ChatGPTConversation[] | undefined;
		this._register(autorun(reader => {
			const state = chat.state.read(reader);
			list.setAttribute('aria-busy', String(state.busy));
			newChat.disabled = !state.connected || state.sending;
			if (conversations !== state.conversations) {
				const scrollTop = scrollable.state.top;
				const focused = getActiveElement(document) as HTMLElement;
				const focusedId = list.contains(focused) ? focused.dataset.conversation : undefined;
				conversations = state.conversations;
				list.replaceChildren(...(conversations ?? []).map(conversation => {
					const item = document.createElement('button');
					item.type = 'button'; item.textContent = conversation.title; item.title = conversation.title;
					item.dataset.conversation = conversation.id;
					return item;
				}));
				if (focusedId) { [...list.querySelectorAll('button')].find(item => item.dataset.conversation === focusedId)?.focus({ preventScroll: true }); }
				scrollable.layout();
				scrollable.scrollTo(0, scrollTop);
			}
			for (const item of list.querySelectorAll('button')) {
				item.disabled = state.sending;
				if (item.dataset.conversation === state.conversationId) { item.setAttribute('aria-current', 'page'); }
				else { item.removeAttribute('aria-current'); }
			}
			filter();
			// Recheck after layout so short pages fill the viewport without another scroll.
			scheduleLoad();
		}));
	}

	public override focus(): void {
		this.contentElement.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled)')?.focus();
	}
}
