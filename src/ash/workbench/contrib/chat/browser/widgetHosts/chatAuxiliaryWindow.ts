import './media/chatAuxiliaryWindow.css';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IAuxiliaryWindow } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import type { ITitlebarPart } from '../../../../browser/parts/titlebar/titlebarPart.js';
import { localize } from '../../../../../nls.js';

/** Shared light Agent chrome; each opener retains ownership of its conversation tree. */
export class ChatAuxiliaryWindow extends Disposable implements ITitlebarPart {
	readonly header: HTMLElement;
	readonly title: HTMLElement;
	readonly onMenubarVisibilityChange = Event.None;

	constructor(
		readonly window: IAuxiliaryWindow,
		title: string,
		onDispose: (() => void) | undefined,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		window.container.classList.add('ash-chat-auxiliary-window');
		this.header = h(window.window.document, 'header', { className: 'ash-chat-auxiliary-titlebar' });
		this.title = h(window.window.document, 'span', { className: 'ash-chat-auxiliary-title' });
		this.title.id = `chat-window-title-${window.id}`;
		this.setTitle(title);
		const toolbar = h(window.window.document, 'div', { className: 'ash-chat-auxiliary-actions' });
		this.header.append(this.title, toolbar);
		window.container.append(this.header);
		this._register(toDisposable(() => this.header.remove()));
		if (onDispose) this._register(toDisposable(onDispose));
		this._register(addDisposableListener<KeyboardEvent>(window.window, 'keydown', event => {
			if (!isHTMLElement(event.target) || !window.container.contains(event.target)) return;
			if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'F1' || event.key === 'F2')) {
				event.preventDefault(); event.stopPropagation();
				accessibleViews.show(event.key === 'F1' ? AccessibleViewType.Help : AccessibleViewType.View, event.target);
			}
		}, { capture: true }));
		this._register(AccessibleViewRegistry.register({
			name: `sessions-window-${window.id}`, type: AccessibleViewType.Help, priority: 95,
			getProvider: () => {
				if (!window.window.document.hasFocus()) return undefined;
				const focused = window.window.document.activeElement as HTMLElement | null;
				if (!focused || !this.header.contains(focused)) return undefined;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChat, { type: AccessibleViewType.Help },
					() => localize('sessions.window.help', 'A chat opened in a separate Agent window keeps its conversation and draft. Use Tab to reach Return to main window and Keep window on top in the title bar. Closing the window returns the chat to the IDE or Agent window that opened it.'),
					() => focused.focus(), AccessibilityVerbositySettingId.Chat,
				);
			},
		}));
		this._register(new Button(toolbar, {
			...defaultButtonStyles, presentation: 'quiet', icon: Lxicon.screenNormal, iconOnly: true,
			label: localize('sessions.window.return', 'Return to main window'), onClick: () => window.window.close(),
		}));
		const pin = window.alwaysOnTop;
		if (pin) {
			const button = this._register(new Button(toolbar, {
				...defaultButtonStyles, presentation: 'quiet', iconOnly: true, icon: Lxicon.pinned,
				label: localize('sessions.window.pin', 'Keep window on top'),
				onClick: () => { void pin.set(!pin.value).catch(error => notifications.error(String(error))); },
			}));
			const update = (value: boolean) => button.domNode.setAttribute('aria-pressed', String(value));
			update(pin.value);
			this._register(pin.onDidChange(update));
		}
	}

	// Conversation titles are supplied by the opener and have no editor title template.
	updateProperties(): void { }
	registerVariables(): void { }

	/** The opener retains the conversation; this host owns only its mount presentation. */
	mount(element: HTMLElement): void {
		element.classList.add('ash-chat-auxiliary-content');
		this.window.container.append(element);
		this._register(toDisposable(() => element.classList.remove('ash-chat-auxiliary-content')));
	}

	setTitle(title: string): void {
		this.title.textContent = this.title.title = this.window.window.document.title = title;
		this.window.container.setAttribute('aria-label', title);
	}
}
