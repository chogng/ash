import './media/bannerpart.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { Link } from '../../../../platform/opener/browser/link.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { BannerFocused } from '../../../common/contextkeys.js';
import { type IBannerItem, IBannerService } from '../../../services/banner/browser/bannerService.js';
import { Part } from '../../part.js';

/** A single window notice surface; pending producers retain their own identity and priority. */
export class BannerPart extends Part implements IBannerService {
	declare readonly _serviceBrand: undefined;
	readonly height = 32;
	private readonly notices = new Map<string, IBannerItem>();
	private readonly content = this._register(new DisposableStore());
	private displayed: IBannerItem | undefined;
	private returnFocus: HTMLElement | undefined;
	private readonly focused: IContextKey<boolean>;

	override get minimumHeight(): number { return this.height; }
	override get maximumHeight(): number { return this.height; }

	constructor(
		container: HTMLElement,
		private readonly setBannerVisible: (visible: boolean) => void,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IMarkdownRendererService private readonly markdown: IMarkdownRendererService,
		@IHoverService private readonly hover: IHoverService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IOpenerService private readonly opener: IOpenerService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super(container, 'banner', themeService, storageService);
		this.titleDomNode.remove();
		this.contentDomNode.remove();
		this.domNode.setAttribute('role', 'region');
		this.domNode.tabIndex = 0;
		this.setVisible(false);
		const focused = this.focused = BannerFocused.bindTo(contextKeys);
		this._register(toDisposable(() => { focused.reset(); this.notices.clear(); }));
		this._register(addDisposableListener(this.domNode, 'focusin', event => {
			// Returning from help must preserve the control that originally led into the banner.
			const previous = event.relatedTarget;
			if (isHTMLElement(previous) && previous.isConnected &&
				previous !== this.domNode.ownerDocument.body && !this.domNode.contains(previous) &&
				!previous.closest('dialog, [role="dialog"]')) {
				this.returnFocus = previous;
			}
			focused.set(true);
			if (!this.domNode.contains(event.relatedTarget as Node | null)) {
				const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Banner);
				if (hint) status(hint);
			}
		}));
		this._register(addDisposableListener(this.domNode, 'focusout', event => {
			if (!this.domNode.contains(event.relatedTarget as Node | null)) focused.set(false);
		}));
	}

	show(item: IBannerItem): void {
		// Replacing a producer also makes it the latest among equal-priority notices.
		this.notices.delete(item.id);
		this.notices.set(item.id, item);
		this.render();
	}

	hide(id: string): void {
		if (this.notices.delete(id)) this.render();
	}

	focus(): void {
		if (this.displayed) this.domNode.focus();
	}

	focusNextAction(): void { this.moveFocus(1); }
	focusPreviousAction(): void { this.moveFocus(-1); }

	private moveFocus(direction: 1 | -1): void {
		if (!this.displayed) return;
		const actions = [...this.domNode.querySelectorAll<HTMLElement>('a, button')];
		const index = actions.findIndex(action => action === this.domNode.ownerDocument.activeElement);
		const next = index < 0 ? (direction === 1 ? 0 : actions.length - 1) : (index + direction + actions.length) % actions.length;
		actions[next]?.focus();
	}

	private restoreFocus(): void {
		if (this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
		else this.layoutService.focus();
	}

	private render(): void {
		let next: IBannerItem | undefined;
		for (const notice of this.notices.values()) {
			if (!next || (notice.priority ?? 0) >= (next.priority ?? 0)) next = notice;
		}
		if (next === this.displayed) return;
		const wasVisible = !!this.displayed;
		const active = this.domNode.ownerDocument.activeElement;
		const hadFocus = this.domNode.contains(active);
		const actionIndex = [...this.domNode.querySelectorAll('a, button')].indexOf(active!);
		this.displayed = next;
		this.content.clear();
		this.domNode.replaceChildren();
		if (!next) {
			this.focused.set(false);
			this.domNode.removeAttribute('aria-label');
			if (wasVisible) this.setBannerVisible(false);
			if (hadFocus) this.restoreFocus();
			return;
		}

		const document = this.domNode.ownerDocument;
		this.domNode.classList.toggle('neutral', next.neutral === true);
		if (next.icon) {
			const icon = h(document, 'span');
			icon.className = 'ash-banner-icon';
			icon.setAttribute('aria-hidden', 'true');
			if (URI.isUri(next.icon)) {
				const image = h(document, 'img');
				image.src = next.icon.toString(true);
				image.alt = '';
				icon.append(image);
			} else appendIcon(next.icon, icon);
			this.domNode.append(icon);
		}
		const message = h(document, 'div');
		message.className = 'ash-banner-message';
		if (typeof next.message === 'string') message.textContent = next.message;
		else message.append(this.content.add(this.markdown.render(next.message, { ownerDocument: document })).element);
		this.domNode.append(message);
		const text = message.textContent?.trim() ?? '';
		const label = next.ariaLabel ?? text;
		this.domNode.setAttribute('aria-label', label);
		this.content.add(this.hover.setupDelayedHover(message, { content: text }));
		const actions = h(document, 'div');
		actions.className = 'ash-banner-actions';
		for (const action of next.actions ?? []) {
			this.content.add(this.instantiation.createInstance(Link, actions, action, {
				opener: (href: string) => { void this.opener.open(href, { allowCommands: true, fromUserGesture: true }).catch(onUnexpectedError); },
			}));
		}
		this.domNode.append(actions);
		const close = h(document, 'button');
		close.className = 'ash-banner-close';
		close.type = 'button';
		const closeLabel = next.closeLabel ?? localize('banner.close', 'Close Banner');
		close.setAttribute('aria-label', closeLabel);
		this.content.add(this.hover.setupDelayedHover(close, { content: closeLabel }));
		appendIcon(Lxicon.close, close);
		const item = next;
		this.content.add(addDisposableListener(close, 'click', () => {
			this.hide(item.id);
			item.onClose?.();
		}));
		this.domNode.append(close);
		if (!wasVisible) this.setBannerVisible(true);
		// State changes never steal editor focus, but keep a keyboard user inside an updated notice.
		if (hadFocus) {
			const controls = this.domNode.querySelectorAll<HTMLElement>('a, button');
			(actionIndex < 0 ? this.domNode : controls[Math.min(actionIndex, controls.length - 1)])?.focus();
		}
		status(label);
	}
}

CommandsRegistry.register('workbench.banner.focusBanner', accessor => accessor.get(IBannerService).focus());
CommandsRegistry.register('workbench.banner.focusNextAction', accessor => accessor.get(IBannerService).focusNextAction());
CommandsRegistry.register('workbench.banner.focusPreviousAction', accessor => accessor.get(IBannerService).focusPreviousAction());

for (const [key, command] of [
	['Escape', 'workbench.banner.focusBanner'],
	['ArrowRight', 'workbench.banner.focusNextAction'],
	['ArrowDown', 'workbench.banner.focusNextAction'],
	['ArrowLeft', 'workbench.banner.focusPreviousAction'],
	['ArrowUp', 'workbench.banner.focusPreviousAction'],
] as const) {
	KeybindingsRegistry.registerKeybindingRule({
		command,
		keybinding: Keybinding.single(logicalKey(key)),
		when: BannerFocused.isEqualTo(true),
		priority: KeybindingWeight.WorkbenchContrib,
	});
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'workbench.action.focusBanner', title: localize2('banner.focus', 'Focus Banner'), f1: true });
	}
	override run(accessor: ServicesAccessor): void { accessor.get(IBannerService).focus(); }
});
