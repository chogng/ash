import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import './media/chatContextUsageWidget.css';
import { addDisposableListener, h, isNode, svg } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { getHoverDelegate, type IManagedHover } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { getContextInputBudget, type ChatContextUsage } from '../../../../../services/chat/common/chatService.js';
import { ChatContextUsageDetails } from './chatContextUsageDetails.js';

/** Owns the context meter and its anchored details, using the input's current usage snapshot. */
export class ChatContextUsageWidget extends Disposable {
	readonly domNode: HTMLButtonElement;
	private readonly button: Button;
	private readonly value: SVGCircleElement;
	private readonly hover: IManagedHover;
	private readonly hoverContent: HTMLElement;
	private readonly details = this._register(new MutableDisposable<ChatContextUsageDetails>());
	private readonly detailsListeners = this._register(new DisposableStore());
	private usage: ChatContextUsage | undefined;

	constructor(document: Document, @IContextViewService private readonly contextViews: IContextViewService) {
		super();
		this.button = this._register(new Button(h(document, 'div'), {
			...defaultButtonStyles,
			label: '',
			iconOnly: true,
			ariaLabel: localize('chat.input.contextUsage', 'Context usage'),
			enabled: false,
			onClick: () => this.details.value ? this.hideDetails() : this.showDetails(),
		}));
		this.domNode = this.button.domNode;
		this.domNode.classList.add('ash-chat-context-usage-button');
		this.domNode.setAttribute('aria-haspopup', 'dialog');
		this.domNode.setAttribute('aria-expanded', 'false');
		const ring = svg(document, 'svg', { attributes: { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' } });
		ring.classList.add('ash-chat-context-usage-ring');
		const track = svg(document, 'circle', { attributes: { cx: '8', cy: '8', r: '6', pathLength: '100' } });
		track.classList.add('ash-chat-context-usage-track');
		this.value = svg(document, 'circle', { attributes: { cx: '8', cy: '8', r: '6', pathLength: '100' } });
		this.value.classList.add('ash-chat-context-usage-value');
		ring.append(track, this.value);
		this.domNode.append(ring);
		this.hoverContent = h(document, 'div');
		this.hoverContent.className = 'ash-chat-context-usage-hover';
		this.hover = this._register(getHoverDelegate().setupHover({ target: this.domNode, content: this.hoverContent, groupId: 'actions' }));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 95, name: `chatContextUsage-${type}-${createUuid()}`,
				getProvider: () => {
					const details = this.details.value?.domNode;
					const focused = document.activeElement;
					if (!focused || !details?.contains(focused)) return undefined;
					const detailsText = details.innerText;
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => type === AccessibleViewType.View
						? detailsText
						: localize('chat.input.contextDetailsHelp', 'Context usage details show the estimated token count and a breakdown by category. Percentages use the input budget for automatic compaction; model context capacity is shown separately. The unsent draft is excluded. Unknown capacity shows token counts without percentages. Press Escape or activate Close to return to the context ring. Tab leaves the details.'),
						() => details.isConnected ? details.focus() : this.button.focus(), AccessibilityVerbositySettingId.Chat);
				},
			}));
		}
		this.update(undefined);
	}

	update(usage: ChatContextUsage | undefined): void {
		if (this.isDisposed) return;
		this.usage = usage;
		const capacity = usage && getContextInputBudget(usage);
		const percentage = usage && capacity !== undefined && capacity > 0 ? usage.estimatedTokens / capacity * 100 : undefined;
		const filled = percentage !== undefined ? Math.min(100, Math.max(0, percentage)) : 0;
		this.value.classList.toggle('empty', filled === 0);
		this.value.setAttribute('stroke-dasharray', `${filled} ${100 - filled}`);
		this.button.enabled = usage !== undefined;
		this.button.hidden = usage === undefined;
		this.domNode.setAttribute('aria-label', this.label);
		this.hoverContent.textContent = this.tooltip;
		this.hover.update(this.details.value ? undefined : this.hoverContent);
		if (usage) this.details.value?.update(usage);
		else this.hideDetails();
	}

	showDetails(): boolean {
		if (!this.usage || this.isDisposed || this.domNode.hidden) return false;
		if (this.details.value) {
			this.details.value.domNode.focus({ preventScroll: true });
			return true;
		}
		const details = new ChatContextUsageDetails(this.domNode.ownerDocument, () => this.hideDetails());
		details.update(this.usage);
		this.details.value = details;
		this.detailsListeners.add(addDisposableListener(details.domNode, 'focusout', event => {
			if (!isNode(event.relatedTarget) || (!details.domNode.contains(event.relatedTarget) && event.relatedTarget !== this.domNode)) this.hideDetails();
		}));
		this.hover.hide();
		this.hover.update(undefined);
		this.button.focus();
		this.domNode.setAttribute('aria-controls', details.domNode.id);
		this.domNode.setAttribute('aria-expanded', 'true');
		const shown = this.contextViews.show({
			anchor: this.domNode, content: details.domNode,
			anchorPosition: AnchorPosition.Above, anchorAlignment: AnchorAlignment.Right,
			presentation: 'default', focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				this.detailsListeners.clear();
				this.details.clear();
				this.domNode.setAttribute('aria-expanded', 'false');
				this.domNode.removeAttribute('aria-controls');
				this.hover.update(this.hoverContent);
			},
		});
		if (shown) details.domNode.focus({ preventScroll: true });
		return shown;
	}

	hide(): void {
		this.hideDetails();
		this.button.hidden = true;
	}

	override dispose(): void {
		this.hideDetails();
		super.dispose();
	}

	private hideDetails(): void {
		if (this.details.value) this.contextViews.hide();
	}

	private get label(): string {
		const usage = this.usage;
		if (!usage) return localize('chat.input.contextUsage', 'Context usage');
		const budget = getContextInputBudget(usage);
		return budget !== undefined
			? localize('chat.input.contextRingLabel', 'Context budget: {0}%, estimated input {1} of {2} tokens', Math.round(usage.estimatedTokens / budget * 100), usage.estimatedTokens.toLocaleString(), budget.toLocaleString())
			: localize('chat.input.contextRingUnknownLabel', 'Context usage: {0} tokens, capacity unavailable', usage.estimatedTokens.toLocaleString());
	}

	private get tooltip(): string {
		const usage = this.usage;
		if (!usage) return this.label;
		const budget = getContextInputBudget(usage);
		return budget !== undefined
			? localize('chat.input.contextRingHover', 'Context budget: {0}%\nEstimated input tokens: {1} / {2}', Math.round(usage.estimatedTokens / budget * 100), usage.estimatedTokens.toLocaleString(), budget.toLocaleString())
			: localize('chat.input.contextRingUnknownHover', 'Estimated context: {0} tokens\nContext capacity unavailable.', usage.estimatedTokens.toLocaleString());
	}
}
