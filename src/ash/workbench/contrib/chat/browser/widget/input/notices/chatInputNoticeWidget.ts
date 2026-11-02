import { addDisposableListener, h } from '../../../../../../../base/browser/dom.js';
import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../../base/common/uuid.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatInputNoticeFocusTarget } from './chatInputNoticeHost.js';
import './media/chatInputNotice.css';

export const enum ChatInputNoticeVariant {
	Onboarding = 'onboarding',
	Tip = 'tip',
	Notification = 'notification',
}

export interface IChatInputNoticeWidgetOptions {
	readonly container: HTMLElement;
	readonly variant: ChatInputNoticeVariant;
	readonly className?: string;
	readonly ariaLabel?: string;
	readonly onEscape?: () => void;
	readonly focusInput?: () => void;
	readonly accessibility?: NoticeAccessibleOptions;
}

interface NoticeAccessibleOptions {
	readonly priority: number;
	readonly verbositySettingKey: string;
	readonly getHelp: () => string;
}

export function getChatInputNoticeHelp(): string {
	return localize('chat.notice.help', 'Chat notices appear above the message. Notifications take priority over introductions and tips. Use {0} to move between the visible notice and the message. Use Tab to reach notice actions. Escape returns from a notification to the message, or closes an introduction and stops its recording. A hidden introduction stops recording and returns when the notification clears. Dismiss notification hides the current notice. Notification actions apply to this input.', '<keybinding:workbench.action.chat.focusTip>');
}

/** Both card widgets and the retained Markdown tip expose the same notice navigation help. */
export function registerChatInputNoticeAccessibleViews(container: HTMLElement, focusInput?: () => void, options?: NoticeAccessibleOptions): IDisposable {
	const registrations = new DisposableStore();
	const id = generateUuid();
	const changed = registrations.add(new Emitter<void>());
	const observer = new container.ownerDocument.defaultView!.MutationObserver(() => changed.fire());
	observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
	registrations.add(toDisposable(() => observer.disconnect()));
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		registrations.add(AccessibleViewRegistry.register({
			type,
			priority: options?.priority ?? 110,
			name: `chatInputNotice-${id}-${type}`,
			getProvider: () => {
				const focused = container.ownerDocument.activeElement as HTMLElement | null;
				if (!focused || !container.contains(focused) || container.closest('[hidden]')) return undefined;
				const provider = new AccessibleContentProvider(
					AccessibleViewProviderId.SessionsChat,
					{ type },
					() => type === AccessibleViewType.Help ? options?.getHelp() ?? getChatInputNoticeHelp() : container.closest('[hidden]') ? '' : container.textContent ?? '',
					() => {
						if (focused.isConnected && !focused.closest('[hidden]')) focused.focus();
						else focusInput?.();
					},
					options?.verbositySettingKey ?? AccessibilityVerbositySettingId.Chat,
				);
				provider.onDidChangeContent = changed.event;
				return provider;
			},
		}));
	}
	return registrations;
}

/** Common focus, visibility and announcement boundary; feature content keeps its own owner. */
export class ChatInputNoticeWidget extends Disposable implements IChatInputNoticeFocusTarget {
	readonly domNode: HTMLElement;

	constructor(options: IChatInputNoticeWidgetOptions) {
		super();
		this.domNode = h(options.container.ownerDocument, 'section', {
			className: `ash-chat-input-notice ash-chat-input-notice-${options.variant}${options.className ? ` ${options.className}` : ''}`,
		});
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('role', 'region');
		this.setAriaLabel(options.ariaLabel);
		options.container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(registerChatInputNoticeAccessibleViews(this.domNode, options.focusInput, options.accessibility));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'Escape' || !options.onEscape) return;
			event.preventDefault();
			event.stopPropagation();
			options.onEscape();
		}));
	}

	setAriaLabel(label: string | undefined): void {
		if (label) this.domNode.setAttribute('aria-label', label);
		else this.domNode.removeAttribute('aria-label');
	}

	announce(): void {
		const label = this.domNode.getAttribute('aria-label');
		if (label && !this.domNode.hidden) status(label);
	}

	hasFocus(): boolean {
		return this.domNode.contains(this.domNode.ownerDocument.activeElement);
	}

	focus(): void {
		if (!this.domNode.hidden && this.domNode.isConnected) this.domNode.focus();
	}

	setVisible(visible: boolean): void {
		if (this.domNode.hidden !== !visible) this.domNode.hidden = !visible;
	}
}
