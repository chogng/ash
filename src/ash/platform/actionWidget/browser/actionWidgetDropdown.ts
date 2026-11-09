import { defaultButtonStyles } from '../../theme/browser/defaultStyles.js';
import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import { getTabbableElements } from '../../../base/browser/focus.js';
import { EventType, Gesture } from '../../../base/browser/touch.js';
import { ContextView } from '../../../base/browser/ui/contextview/contextview.js';
import { CancellationTokenSource, type CancellationToken } from '../../../base/common/cancellation.js';
import { Button, type IButtonOptions } from '../../../base/browser/ui/button/button.js';
import { Separator, type IAction } from '../../../base/common/actions.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { ActionListItemKind, type IActionListItem, type IActionListOptions } from './actionList.js';
import { IActionWidgetService } from './actionWidget.js';
import { ACTION_WIDGET_DROPDOWN_MOTION_CLASS } from './actionWidgetMotion.js';

export interface IActionWidgetDropdownAction extends IAction { }

export interface IActionWidgetDropdownActionProvider {
	getActions(): readonly IActionWidgetDropdownAction[] | Promise<readonly IActionWidgetDropdownAction[]>;
}

export interface IActionWidgetDropdownOptions {
	readonly onOpen?: () => void;
	readonly buttonOptions?: Pick<IButtonOptions, 'icon' | 'presentation' | 'size' | 'title'>;
	readonly label: string;
	readonly ariaLabel: string;
	readonly actions?: readonly IActionWidgetDropdownAction[];
	readonly actionProvider?: IActionWidgetDropdownActionProvider;
	/** A custom renderer owns the trigger's label content; the dropdown retains the trigger and input listeners. */
	readonly labelRenderer?: (element: HTMLElement) => IDisposable | null;
	readonly getAnchor?: () => HTMLElement;
	readonly listOptions?: IActionListOptions;
	/** Installs popup-specific presentation and listeners for the lifetime of the open menu. */
	readonly onShow?: (menu: HTMLElement) => IDisposable;
	readonly tabLeavesPopup?: boolean;
	readonly focusItemOnPointerOpen?: boolean;
	readonly onError?: (error: unknown) => void;
}

interface IActionWidgetDropdownItems<T> {
	readonly load: (token: CancellationToken) => readonly IActionListItem<T>[] | Promise<readonly IActionListItem<T>[]>;
	readonly refresh?: (token: CancellationToken, publish: (items: readonly IActionListItem<T>[]) => void) => Promise<readonly IActionListItem<T>[] | void>;
	readonly filterItems?: (items: readonly IActionListItem<T>[], query: string) => readonly IActionListItem<T>[];
	readonly select: (item: T) => unknown;
	readonly requireIdle?: boolean;
	readonly restoreFocusOnSelect?: boolean;
	readonly focusItemOnOpen?: boolean;
}

const pendingDropdowns = new WeakMap<Document, CancellationTokenSource>();

/** Bind activation for a dropdown trigger without taking over its content or popup. */
export function bindActionWidgetActivation(trigger: HTMLElement, activate: (source: 'pointer' | 'keyboard') => void, isEnabled: () => boolean): IDisposable {
	const listeners = new DisposableStore();
	listeners.add(addDisposableListener(trigger, 'mousedown', event => {
		if (event.button !== 0 || !isEnabled()) { return; }
		stopEvent(event);
		activate('pointer');
	}));
	listeners.add(addDisposableListener(trigger, 'keydown', event => {
		if (event.isComposing || !isEnabled() || (event.key !== 'Enter' && event.key !== ' ')) { return; }
		stopEvent(event);
		activate('keyboard');
	}));
	listeners.add(Gesture.addTarget(trigger));
	listeners.add(addDisposableListener(trigger, EventType.Tap, event => {
		stopEvent(event);
		if (isEnabled()) { activate('pointer'); }
	}));
	return listeners;
}

/** Owns a dropdown trigger; the shared action service owns its popup and dismissal. */
export class ActionWidgetDropdown extends Disposable {
	public readonly element: HTMLButtonElement;
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	public readonly onDidChangeVisibility = this.visibilityChanged.event;
	private readonly popup = this._register(new MutableDisposable());
	private readonly button: Button;
	private visible = false;
	private request: CancellationTokenSource | undefined;
	private readonly openingListeners = this._register(new DisposableStore());

	constructor(
		container: HTMLElement,
		private readonly options: IActionWidgetDropdownOptions,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
	) {
		super();
		if (!options.onOpen && !options.actions && !options.actionProvider) { throw new TypeError('An action dropdown requires actions or an action provider'); }
		const button = this.button = this._register(new Button(container, {
			...defaultButtonStyles,
			label: options.label,
			ariaLabel: options.ariaLabel,
			icon: options.labelRenderer ? undefined : Lxicon.chevronDown,
			presentation: options.labelRenderer ? 'quiet' : 'secondary',
			size: options.labelRenderer ? 'standard' : 'small',
			...options.buttonOptions,
		}));
		this.element = button.domNode;
		this.element.classList.add('ash-action-widget-dropdown');
		if (options.labelRenderer) {
			const label = options.labelRenderer(this.element);
			if (label) { this._register(label); }
		}
		this.element.setAttribute('aria-haspopup', 'menu');
		this.element.setAttribute('aria-expanded', 'false');
		this._register(toDisposable(() => this.hide()));
		this._register(bindActionWidgetActivation(this.element, source => this.activate(source), () => !this.element.disabled));
		// Assistive technology activates semantic buttons via click without a preceding pointer sequence.
		this._register(addDisposableListener(this.element, 'click', event => {
			if (event.detail === 0 && !this.element.disabled) { this.activate(); }
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.isComposing || this.element.disabled) { return; }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				stopEvent(event);
				this.open();
			}
		}));
	}

	private open(source: 'pointer' | 'keyboard' = 'keyboard'): void {
		if (this.visible || this.request || this.element.disabled) { return; }
		if (this.options.onOpen) { this.options.onOpen(); }
		else { this.show(source !== 'pointer' || this.options.focusItemOnPointerOpen !== false); }
	}

	public show(focusItemOnOpen = true): void {
		const toItems = (actions: readonly IActionWidgetDropdownAction[]): readonly IActionListItem<IActionWidgetDropdownAction>[] => actions.map(action => ({
			kind: action instanceof Separator ? ActionListItemKind.Separator : ActionListItemKind.Action,
			item: action,
			label: action.label,
			description: this.options.listOptions?.presentation === 'details' ? action.tooltip : undefined,
			disabled: !action.enabled,
			checked: action.checked,
			group: { title: '', icon: action.icon },
			iconColor: action.iconColor,
		}));
		this.showItems({
			load: () => this.options.actionProvider
				? Promise.resolve(this.options.actionProvider.getActions()).then(toItems)
				: toItems(this.options.actions!),
			select: action => action.run(),
			focusItemOnOpen,
		});
	}

	public showItems<T>(options: IActionWidgetDropdownItems<T>): void {
		if (this.isDisposed || this.visible || this.request || this.element.disabled || (options.requireIdle && this.actionWidgetService.isVisible)) { return; }
		const document = this.element.ownerDocument;
		const revision = ContextView.getPopupRevision(document);
		pendingDropdowns.get(document)?.cancel();
		const request = this.request = new CancellationTokenSource();
		pendingDropdowns.set(document, request);
		const finish = (): void => {
			if (this.request !== request) { return; }
			this.clearRequest();
		};
		const fail = (error: unknown): void => {
			if (this.request !== request || request.token.isCancellationRequested) { return; }
			if (!this.visible) { finish(); }
			this.options.onError?.(error);
		};
		const show = (initial: readonly IActionListItem<T>[]): void => {
			if (this.request !== request || request.token.isCancellationRequested || this.element.disabled ||
				ContextView.getPopupRevision(document) !== revision || (options.requireIdle && this.actionWidgetService.isVisible) || !initial.length) {
				finish();
				return;
			}
			this.openingListeners.clear();
			if (pendingDropdowns.get(document) === request) { pendingDropdowns.delete(document); }
			let items = initial;
			let query = '';
			const projected = () => options.filterItems?.(items, query) ?? items;
			const update = () => this.actionWidgetService.updateItems(projected(), { preserveScrollPosition: true });
			this.visible = true;
			this.element.setAttribute('aria-expanded', 'true');
			this.visibilityChanged.fire(true);
			this.actionWidgetService.show('actionWidgetDropdown', false, projected(), {
				onSelect: async item => {
					if (this.request !== request || request.token.isCancellationRequested) { return; }
					this.hide();
					if (options.restoreFocusOnSelect && this.element.isConnected) { this.element.focus(); }
					try { await options.select(item); }
					catch (error) {
						if (!this.options.onError) { throw error; }
						this.options.onError(error);
					}
				},
				onShow: menu => {
					const resources = this.popup.value = new DisposableStore();
					if (this.options.tabLeavesPopup) {
						resources.add(addDisposableListener(menu, 'keydown', event => {
							if (event.key !== 'Tab' || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) { return; }
							stopEvent(event);
							this.hide();
							const controls = getTabbableElements(this.element.ownerDocument.body);
							const next = controls.indexOf(this.element) + (event.shiftKey ? -1 : 1);
							controls[next]?.focus();
						}, true));
					}
					const decoration = this.options.onShow?.(menu);
					if (decoration) { resources.add(decoration); }
				},
				onHide: () => {
					if (this.request !== request) { return; }
					finish();
					this.resetVisibility();
				},
			}, this.options.getAnchor?.() ?? this.element, {
				...this.options.listOptions,
				focusItemOnOpen: options.focusItemOnOpen ?? this.options.listOptions?.focusItemOnOpen,
				onDidChangeFilter: text => {
					this.options.listOptions?.onDidChangeFilter?.(text);
					if (this.request !== request || !options.filterItems || text === query) { return; }
					query = text;
					update();
				},
				className: [this.options.listOptions?.className, !this.options.onOpen && ACTION_WIDGET_DROPDOWN_MOTION_CLASS].filter(Boolean).join(' '),
			});
			if (this.request === request && options.refresh) {
				const publish = (loaded: readonly IActionListItem<T>[]): void => {
					if (this.request !== request || request.token.isCancellationRequested) { return; }
					items = loaded;
					update();
				};
				void options.refresh(request.token, publish).then(loaded => { if (loaded) publish(loaded); }).catch(fail);
			}
		};
		try {
			const result = options.load(request.token);
			if (result instanceof Promise) {
				this.openingListeners.add(request.token.onCancellationRequested(finish));
				this.openingListeners.add(addDisposableListener(document, 'pointerdown', event => {
					if (!this.element.contains(event.target as Node)) { finish(); }
				}, true));
				this.openingListeners.add(addDisposableListener(document, 'keydown', event => {
					if (!event.isComposing && event.key === 'Escape') { finish(); }
				}, true));
				void result.then(show).catch(fail);
			} else {
				show(result);
			}
		} catch (error) {
			fail(error);
		}
	}

	private resetVisibility(): void {
		if (!this.visible) { return; }
		this.visible = false;
		this.element.setAttribute('aria-expanded', 'false');
		this.popup.clear();
		this.visibilityChanged.fire(false);
	}

	private clearRequest(): void {
		const request = this.request;
		this.request = undefined;
		this.openingListeners.clear();
		if (request && pendingDropdowns.get(this.element.ownerDocument) === request) {
			pendingDropdowns.delete(this.element.ownerDocument);
		}
		request?.dispose(true);
	}

	public hide(): void {
		this.clearRequest();
		if (this.visible) {
			this.actionWidgetService.hide();
			this.resetVisibility();
		}
	}

	public setEnabled(enabled: boolean): void {
		this.element.disabled = !enabled;
		this.element.setAttribute('aria-disabled', String(!enabled));
		if (!enabled) { this.hide(); }
	}

	public focus(): void {
		if (!this.isDisposed && !this.element.disabled) { this.button.focus(); }
	}

	public setIcon(icon: IButtonOptions['icon']): void {
		if (this.button.icon !== icon) { this.button.icon = icon; }
	}

	public setLabel(label: string): void {
		if (this.button.label === label) { return; }
		this.hide();
		this.button.label = label;
	}

	private activate(source: 'pointer' | 'keyboard' = 'keyboard'): void {
		// Pointer activation prevents the native focus action to open the popup on press.
		const focusOptions: FocusOptions & { focusVisible?: boolean; } = {
			focusVisible: source === 'pointer' ? false : undefined,
		};
		this.element.focus(focusOptions);
		if (this.visible || this.request) { this.hide(); }
		else { this.open(source); }
	}
}
