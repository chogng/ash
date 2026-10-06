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
import { ActionList, type IActionListDelegate, type IActionListItem, type IActionListOptions } from './actionList.js';
import { TabbedActionListWidget, type ITabbedActionListShowOptions } from './tabbedActionListWidget.js';

export const IActionWidgetService = createDecorator<IActionWidgetService>('actionWidgetService');

/** The window's current action list. Callers retain request and action execution ownership. */
export interface IActionWidgetService {
	readonly _serviceBrand: undefined;
	readonly isVisible: boolean;
	show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: ContextViewAnchor, listOptions?: IActionListOptions, tabs?: ITabbedActionListShowOptions<T>): void;
	hide(didCancel?: boolean): void;
}

export class ActionWidgetService extends Disposable implements IActionWidgetService {
	declare public readonly _serviceBrand: undefined;
	private readonly current = this._register(new MutableDisposable<DisposableStore>());
	private cancelOnHide = true;

	constructor(
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(toDisposable(() => this.hide()));
	}

	public get isVisible(): boolean {
		return this.current.value !== undefined;
	}

	public show<T>(user: string, supportsPreview: boolean, items: readonly IActionListItem<T>[], delegate: IActionListDelegate<T>, anchor: ContextViewAnchor, listOptions: IActionListOptions = {}, tabs?: ITabbedActionListShowOptions<T>): void {
		this.hide();
		const lifetime = new DisposableStore();
		const document = isHTMLElement(anchor) ? anchor.ownerDocument : this.contextViewService.container.ownerDocument;
		const ariaHint = this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.ActionWidget)
			? localize('actionWidget.helpHint', 'Press Alt+F1 for action menu accessibility help.')
			: undefined;
		const list = lifetime.add(tabs
			? this.instantiationService.createInstance(TabbedActionListWidget<T>, user, tabs.createActionList(tabs.initialTab).items, delegate, this.contextViewService.container, ariaHint, supportsPreview, listOptions, tabs)
			: this.instantiationService.createInstance(ActionList<T>, user, items, delegate, this.contextViewService.container, ariaHint, supportsPreview, listOptions));
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
		layout();
		const shown = this.contextViewService.show({
			anchor,
			content: list.domNode,
			presentation: 'plain',
			gap: 4,
			focusRestore: ContextViewFocusRestore.None,
			onHide: reason => {
				const didCancel = this.cancelOnHide;
				// ContextView detaches content before this callback, so remember the last focused node.
				const restore = list.domNode.contains(focused) && isHTMLElement(source) && source.isConnected &&
					(reason === ContextViewHideReason.Escape || reason === ContextViewHideReason.Programmatic);
				if (this.current.value === lifetime) {
					this.current.clear();
				}
				if (restore) {
					source.focus({ preventScroll: true });
				}
				delegate.onHide(didCancel);
			},
		});
		if (shown) {
			list.focus();
		}
	}

	public hide(didCancel = true): void {
		if (!this.isVisible) {
			return;
		}
		this.cancelOnHide = didCancel;
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
