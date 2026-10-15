import { addDisposableListener, getActiveElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { ChatGPTConversation } from './chatGPTClient.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IChatGPTService } from './chatGPTService.js';
import './media/chatGPTNavigationView.css';

export class ChatGPTNavigationView extends ViewPane {
	constructor(parent: HTMLElement, options: IViewPaneOptions,
		@IChatGPTService chat: IChatGPTService,
		@IAccessibleViewService accessible: IAccessibleViewService,
		@IEditorService editors: IEditorService,
		@IOpenerService opener: IOpenerService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(parent, options);
		const document = parent.ownerDocument;
		const root = this.contentElement;
		root.classList.add('ash-chatgpt-navigation');
		const heading = document.createElement('h2');
		heading.className = 'ash-chatgpt-navigation-heading';
		heading.textContent = 'ChatGPT';
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
		const list = document.createElement('nav');
		list.className = 'ash-chatgpt-navigation-list';
		list.setAttribute('aria-label', localize('sessions.chatgpt.recent', 'Recent conversations'));
		const filter = () => {
			const query = search.value.trim().toLocaleLowerCase();
			for (const item of list.querySelectorAll('button')) { item.hidden = !item.textContent?.toLocaleLowerCase().includes(query); }
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
		const more = button(localize('sessions.chatgpt.loadMore', 'Load more'), () => { void chat.loadMore(); });
		const actions = document.createElement('details');
		actions.className = 'ash-chatgpt-navigation-actions';
		const summary = document.createElement('summary');
		summary.textContent = localize('sessions.chatgpt.moreActions', 'More actions');
		const reload = button(localize('sessions.chatgpt.reloadShort', 'Reload'), () => { void chat.reload(); });
		const read = button(localize('sessions.chatgpt.readConversation', 'Read conversation'), () => { accessible.show(AccessibleViewType.View, read); });
		const help = button(localize('sessions.chatgpt.help', 'Help'), () => { accessible.show(AccessibleViewType.Help, help); });
		const open = button(localize('sessions.chatgpt.openLogin', 'Open ChatGPT'), () => { const id = chat.state.get().conversationId; void opener.open(id ? `https://chatgpt.com/c/${encodeURIComponent(id)}` : 'https://chatgpt.com/'); });
		const connect = button(localize('sessions.chatgpt.connect', 'Connect'), () => { void chat.connect(); });
		const actionButtons = document.createElement('div');
		actionButtons.className = 'ash-chatgpt-navigation-action-buttons';
		actionButtons.append(reload, read, help, open, connect);
		actions.append(summary, actionButtons);
		this._register(addDisposableListener(actions, 'keydown', event => {
			if (event.key === 'Escape' && actions.open) {
				event.preventDefault(); event.stopPropagation(); actions.open = false; summary.focus();
			}
		}));
		root.append(heading, newChat, search, list, more, actions);
		let conversations: readonly ChatGPTConversation[] | undefined;
		this._register(autorun(reader => {
			const state = chat.state.read(reader);
			list.setAttribute('aria-busy', String(state.busy));
			newChat.disabled = !state.connected || state.sending;
			more.hidden = !state.hasMore;
			more.disabled = state.busy || state.sending;
			connect.disabled = reload.disabled = state.busy || state.sending;
			open.disabled = state.sending;
			if (conversations !== state.conversations) {
				const focused = getActiveElement(document) as HTMLElement;
				const focusedId = list.contains(focused) ? focused.dataset.conversation : undefined;
				conversations = state.conversations;
				list.replaceChildren(...(conversations ?? []).map(conversation => {
					const item = document.createElement('button');
					item.type = 'button'; item.textContent = conversation.title; item.title = conversation.title;
					item.dataset.conversation = conversation.id;
					return item;
				}));
				if (focusedId) { [...list.querySelectorAll('button')].find(item => item.dataset.conversation === focusedId)?.focus(); }
			}
			for (const item of list.querySelectorAll('button')) {
				item.disabled = state.sending;
				if (item.dataset.conversation === state.conversationId) { item.setAttribute('aria-current', 'page'); }
				else { item.removeAttribute('aria-current'); }
			}
			filter();
		}));
	}

	public override focus(): void {
		this.contentElement.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), summary')?.focus();
	}
}
