import { addDisposableListener, getActiveElement, getWindow, isHTMLElement } from '../../../base/browser/dom.js';
import { ContextViewFocusRestore, ContextViewHideReason, type ContextViewAnchor } from '../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { IContextViewService } from '../../contextview/browser/contextView.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IInstantiationService, createDecorator } from '../../instantiation/common/instantiation.js';
import { Registry } from '../../registry/common/platform.js';
import { ActionList, type IActionListDelegate, type IActionListItem, type IActionListOptions, type IActionListUpdateOptions } from './actionList.js';
import {
	ACTION_WIDGET_ANIMATED_CLASS,
	ACTION_WIDGET_DROPDOWN_MOTION_CLASS,
	ACTION_WIDGET_DROPDOWN_MOTION_CLOSING_CLASS,
	finishActionWidgetOpeningAnimation,
} from './actionWidgetMotion.js';

export const IActionWidgetService = createDecorator<IActionWidgetService>('actionWidgetService');

/** The window's current action list. Callers retain request and action execution ownership. */
export interface IActionWidgetService {
	readonly _serviceBrand: undefined;
	readonly isVisible: boolean;
	show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: ContextViewAnchor, listOptions?: IActionListOptions, contextViewLayer?: number): void;
	hide(didCancel?: boolean): void;
	updateItems<T>(items: readonly IActionListItem<T>[], options?: IActionListUpdateOptions): void;
	focusFilter(): void;
	focus(): void;
}

export class ActionWidgetService extends Disposable implements IActionWidgetService {
	declare public readonly _serviceBrand: undefined;
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private cancelOnHide = true;
	private list: ActionList<unknown> | undefined;
	private notifyHide: ((didCancel: boolean) => void) | undefined;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(toDisposable(() => {
			if (this.isVisible) {
				this.contextViewService.hide();
			}
		}));
	}

	public get isVisible(): boolean {
		return this.current.value !== undefined;
	}

	public show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: ContextViewAnchor, listOptions: IActionListOptions = {}, contextViewLayer?: number): void {
		// A replacement retires the previous popup synchronously, including its closing animation.
		if (this.isVisible) {
			this.contextViewService.hide();
		}
		const lifetime = new DisposableStore();
		const document = isHTMLElement(anchor) ? anchor.ownerDocument : this.contextViewService.container.ownerDocument;
		const ariaHint = this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.ActionWidget)
			? localize('actionWidget.helpHint', 'Press Alt+F1 for action menu accessibility help.')
			: undefined;
		const list = lifetime.add(this.instantiationService.createInstance(ActionList<T>, user, items, delegate, this.contextViewService.container, ariaHint, supportsPreview, listOptions));
		this.list = list as ActionList<unknown>;
		lifetime.add(toDisposable(() => { this.list = undefined; }));
		let didNotifyHide = false;
		const notifyHide = this.notifyHide = (didCancel: boolean): void => {
			if (didNotifyHide) {
				return;
			}
			didNotifyHide = true;
			delegate.onHide(didCancel);
		};
		lifetime.add(toDisposable(() => {
			if (this.notifyHide === notifyHide) {
				this.notifyHide = undefined;
			}
		}));
		const layout = (): void => {
			list.domNode.style.width = `${list.layout(0)}px`;
			this.contextViewService.layout();
		};
		lifetime.add(list.onDidRequestLayout(layout));
		lifetime.add(addDisposableListener(getWindow(document), 'resize', layout));
		const source = getActiveElement(document);
		let focused = source;
		lifetime.add(addDisposableListener(document, 'focusin', () => { focused = getActiveElement(document); }));
		this.current.value = lifetime;
		this.cancelOnHide = true;
		delegate.onShow?.(list.domNode);
		layout();
		const shown = this.contextViewService.show({
			anchor,
			anchorPosition: listOptions.anchorPosition,
			content: list.domNode,
			presentation: 'plain',
			gap: 4,
			layer: contextViewLayer,
			focusRestore: ContextViewFocusRestore.None,
			blockOutsidePointer: true,
			onHide: reason => {
				const didCancel = this.cancelOnHide;
				// ContextView detaches content before this callback, so remember the last focused node.
				const restore = list.domNode.contains(focused) && isHTMLElement(source) && source.isConnected &&
					(reason === ContextViewHideReason.Escape || reason === ContextViewHideReason.Programmatic || reason === ContextViewHideReason.OutsidePointer);
				if (this.current.value === lifetime) {
					this.current.clear();
				}
				if (restore) {
					source.focus({ preventScroll: true });
				}
				notifyHide(didCancel);
			},
		});
		if (shown) {
			list.domNode.classList.add(ACTION_WIDGET_ANIMATED_CLASS);
			if (listOptions.focusFilterOnOpen && listOptions.filterVisible !== false) {
				list.focusFilter();
			} else {
				list.focus();
			}
		}
	}

	public updateItems<T>(items: readonly IActionListItem<T>[], options?: IActionListUpdateOptions): void {
		(this.list as ActionList<T> | undefined)?.updateItems(items, options);
	}

	public focusFilter(): void {
		this.list?.focusFilter();
	}

	public focus(): void {
		this.list?.focus();
	}

	public hide(didCancel = true): void {
		const lifetime = this.current.value;
		const widget = this.list?.domNode;
		if (!lifetime || !widget || widget.classList.contains(ACTION_WIDGET_DROPDOWN_MOTION_CLOSING_CLASS)) {
			return;
		}
		this.cancelOnHide = didCancel;
		if (widget.classList.contains(ACTION_WIDGET_DROPDOWN_MOTION_CLASS)) {
			finishActionWidgetOpeningAnimation(widget);
			widget.classList.remove(ACTION_WIDGET_ANIMATED_CLASS);
			widget.classList.add(ACTION_WIDGET_DROPDOWN_MOTION_CLOSING_CLASS);
			const cssAnimation = getWindow(widget).CSSAnimation;
			const animations = cssAnimation ? widget.getAnimations().filter(animation =>
				animation instanceof cssAnimation && animation.animationName === 'ash-action-widget-dropdown-close') : [];
			if (animations.length > 0) {
				widget.inert = true;
				// Cancellation (replacement, dismissal or motion policy change) also completes teardown.
				void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
					if (this.current.value === lifetime) {
						this.contextViewService.hide();
					}
				});
				// Action owners can open a replacement or a dialog before the visual exit ends.
				this.notifyHide?.(didCancel);
				return;
			}
		}
		this.contextViewService.hide();
	}
}

registerSingleton(IActionWidgetService, ActionWidgetService, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ActionWidget,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Action menu accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('actionWidget.verbosityTitle', 'Action menu accessibility help'),
		description: localize('actionWidget.verbosityDescription', 'Announce how to open accessibility help when an action menu opens.'),
	},
});
