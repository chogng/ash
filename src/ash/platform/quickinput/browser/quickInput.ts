import { defaultInputBoxStyles } from '../../theme/browser/defaultStyles.js';
import { addDisposableListener, stopEvent, h, isHTMLElement } from '../../../base/browser/dom.js';
import { TabList } from '../../../base/browser/ui/tablist/tabList.js';
import { ActionBar } from '../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../base/browser/ui/actionbar/actionViewItems.js';
import { ToolBar } from '../../../base/browser/ui/toolbar/toolbar.js';
import type { IAction } from '../../../base/common/actions.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { getViewport } from '../../../base/browser/geometry.js';
import { AnchorAlignment, AnchorPosition, layout2d } from '../../../base/common/layout.js';
import {
	setAriaAttribute,
	setRole,
} from '../../../base/browser/ui/aria/aria.js';
import {
	InputBox,
	type InputSelection,
} from '../../../base/browser/ui/inputbox/inputbox.js';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { getRegisteredIcon } from '../../../base/browser/ui/lxicons/lxicon.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import type {
	IQuickPick,
	IQuickPickItem,
	IQuickPickItemButton,
	IQuickPickSeparator,
	IQuickInputNavigation,
	IKeyMods,
	IQuickInput,
	IQuickWidget,
	IQuickPickDidAcceptEvent,
	IQuickInputButton,
	IQuickInputHideEvent,
} from '../common/quickInput.js';
import { QuickInputList } from './quickInputList.js';
import { QuickInputHideReason, QuickInputType, QuickPickFocus } from '../common/quickInput.js';
import { localize } from '../../../nls.js';
import { RawContextKey } from '../../contextkey/common/contextkey.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { IOpenerService } from '../../opener/common/opener.js';
import { IContextMenuService } from '../../contextview/browser/contextView.js';
import { quickInputButtonsToActionArrays, renderQuickInputDescription } from './quickInputUtils.js';

export const inQuickInputContext = new RawContextKey<boolean>('inQuickInput', false);
export const quickInputTypeContextKey = new RawContextKey<string>('quickInputType', '');
export const endOfQuickInputBoxContext = new RawContextKey<boolean>('cursorAtEndOfQuickInputBox', false);
export const quickInputFocusContext = new RawContextKey<boolean>('quickInputFocus', false);

export interface BrowserQuickInputHostOptions {
	readonly onShow: (quickInput: IBrowserQuickInputHost) => void;
	readonly onHide: (quickInput: IBrowserQuickInputHost, reason?: QuickInputHideReason) => void;
	readonly onDispose: (quickInput: IBrowserQuickInputHost) => void;
	readonly onContextKeyChange: (quickInput: IBrowserQuickInputHost) => void;
}

/** Narrow controller used by the shared Workbench host. */
export interface IBrowserQuickInputHost extends IQuickInput {
	readonly element: HTMLDivElement;
	readonly isContextMenuVisible: boolean;
	focus(): void;
	layout(): void;
	dispose(): void;
}

/** Owns presentation and lifetime shared by every input mounted in the window host. */
export abstract class QuickInput extends Disposable implements IBrowserQuickInputHost {
	abstract readonly type: QuickInputType;
	readonly element: HTMLDivElement;
	protected visible = false;
	protected readonly descriptionElement: HTMLDivElement;
	protected readonly progress: HTMLDivElement;
	private readonly header: HTMLDivElement;
	private readonly heading: HTMLSpanElement;
	private readonly steps: HTMLSpanElement;
	private readonly actions: HTMLDivElement;
	private readonly titleActions: ToolBar;
	private readonly descriptionLinks = this._register(new DisposableStore());
	private readonly hiding = this._register(new Emitter<IQuickInputHideEvent>());
	private readonly hidden = this._register(new Emitter<IQuickInputHideEvent>());
	private readonly disposed = this._register(new Emitter<void>());
	private readonly triggered = this._register(new Emitter<IQuickInputButton>());
	readonly onWillHide = this.hiding.event;
	readonly onDidHide = this.hidden.event;
	readonly onDispose = this.disposed.event;
	readonly onDidTriggerButton = this.triggered.event;
	private titleValue: string | undefined;
	private descriptionValue: string | undefined;
	private stepValue: number | undefined;
	private totalStepsValue: number | undefined;
	private buttonsValue: readonly IQuickInputButton[] = [];
	private enabledValue = true;
	private busyValue = false;
	private menuVisible = false;
	get isContextMenuVisible(): boolean { return this.menuVisible; }
	private contextKeyValue: string | undefined;
	ignoreFocusOut = false;
	anchor?: unknown;
	anchorPosition?: 'above' | 'below' | 'overlay';
	anchorAlignment?: 'left' | 'right';
	width?: number;

	constructor(
		protected readonly host: HTMLElement,
		private readonly hostOptions: BrowserQuickInputHostOptions,
		private readonly opener: IOpenerService,
		private readonly menus: IContextMenuService,
		className: string,
	) {
		super();
		const document = host.ownerDocument;
		this.element = h(document, 'div', { className });
		this.element.tabIndex = -1;
		this.header = h(document, 'div', { className: 'ash-quick-input-titlebar' });
		this.header.hidden = true;
		this.heading = h(document, 'span', { className: 'ash-quick-input-title' });
		this.steps = h(document, 'span', { className: 'ash-quick-input-steps' });
		this.actions = h(document, 'div', { className: 'ash-quick-input-title-actions' });
		this.titleActions = this._register(new ToolBar(this.actions, {
			contextMenuProvider: menus,
			actionViewItemProvider: action => {
				const descriptor = this.buttons[Number(action.id.split('-').at(-1))];
				return descriptor ? new QuickInputTitleActionViewItem(action, descriptor, document) : undefined;
			},
		}));
		this.header.append(this.heading, this.steps, this.actions);
		this.descriptionElement = h(document, 'div', { className: 'ash-quick-tree-description-text' });
		this.descriptionElement.hidden = true;
		this.progress = h(document, 'div', { className: 'ash-quick-pick-progress' });
		this.progress.setAttribute('role', 'status');
		this.progress.textContent = localize('quickInput.searching', 'Searching…');
		this.progress.hidden = true;
		this.element.append(this.header, this.descriptionElement, this.progress);
		this._register(menus.onDidShowContextMenu(() => { if (this.visible) this.menuVisible = true; }));
		this._register(menus.onDidHideContextMenu(() => { this.menuVisible = false; }));
		// Disabled inputs keep Escape available on the surface while content cannot act.
		for (const name of ['click', 'keydown'] as const) this._register(addDisposableListener(this.element, name, event => {
			if (!this.enabled && !(event instanceof document.defaultView!.KeyboardEvent && event.key === 'Escape')) stopEvent(event);
		}, true));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key !== 'Tab' || event.defaultPrevented) return;
			const controls = [...this.element.querySelectorAll<HTMLElement>('input, textarea, button, a[href], [tabindex]')]
				.filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length > 0);
			const destination = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
				: !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined;
			if (destination) { event.preventDefault(); destination.focus(); }
		}));
	}

	get title(): string | undefined { return this.titleValue; }
	set title(value: string | undefined) { this.titleValue = value; this.updateTitle(); }
	get contextKey(): string | undefined { return this.contextKeyValue; }
	set contextKey(value: string | undefined) {
		this.contextKeyValue = value;
		if (this.visible) this.hostOptions.onContextKeyChange(this);
	}
	get step(): number | undefined { return this.stepValue; }
	set step(value: number | undefined) { this.stepValue = value; this.updateTitle(); }
	get totalSteps(): number | undefined { return this.totalStepsValue; }
	set totalSteps(value: number | undefined) { this.totalStepsValue = value; this.updateTitle(); }
	private updateTitle(): void {
		this.heading.textContent = this.title ?? '';
		this.steps.textContent = this.step === undefined ? '' : this.totalSteps === undefined
			? localize('quickInput.step', 'Step {0}', this.step)
			: localize('quickInput.steps', 'Step {0} of {1}', this.step, this.totalSteps);
		this.header.hidden = !this.title && this.step === undefined && !this.buttons.length;
		if (this.visible) this.layout();
	}
	get description(): string | undefined { return this.descriptionValue; }
	set description(value: string | undefined) {
		this.descriptionValue = value;
		this.renderDescription(value, this.descriptionElement, this.descriptionLinks);
	}
	protected renderDescription(value: string | undefined, element: HTMLElement, listeners: DisposableStore): void {
		const focused = element.contains(element.ownerDocument.activeElement);
		listeners.clear();
		renderQuickInputDescription(value ?? '', element, {
			disposables: listeners,
			callback: href => { void this.opener.open(href, { allowCommands: true, fromUserGesture: true }).catch(onUnexpectedError); },
		});
		element.hidden = !value;
		if (focused) this.focus();
		if (this.visible) this.layout();
	}
	get buttons(): readonly IQuickInputButton[] { return this.buttonsValue; }
	set buttons(value: readonly IQuickInputButton[]) {
		const focused = this.actions.contains(this.element.ownerDocument.activeElement);
		this.buttonsValue = value;
		const actions = quickInputButtonsToActionArrays(value, 'quickInput.title', button => this.triggered.fire(button));
		const owner = this;
		const enabledAction = (action: IAction): IAction => ({
			...action,
			get enabled() { return owner.enabled; },
			get checked() { return action.checked; },
			run: (...args) => this.enabled ? action.run(...args) : undefined,
		});
		this.titleActions.setActions(actions.primary.map(enabledAction), actions.secondary.map(enabledAction));
		this.updateTitle();
		if (focused) this.focus();
	}
	get enabled(): boolean { return this.enabledValue; }
	set enabled(value: boolean) {
		const focused = this.element.contains(this.element.ownerDocument.activeElement);
		this.enabledValue = value;
		this.element.setAttribute('aria-disabled', String(!value));
		this.updateEnabled();
		for (const button of this.actions.querySelectorAll('button')) button.disabled = !value;
		if (focused) { if (value) this.focus(); else this.element.focus(); }
	}
	protected updateEnabled(): void { }
	get busy(): boolean { return this.busyValue; }
	set busy(value: boolean) {
		this.busyValue = value;
		this.progress.hidden = !value;
		this.element.classList.toggle('busy', value);
		this.element.setAttribute('aria-busy', String(value));
		if (this.visible) this.layout();
	}
	show(): void {
		this.assertNotDisposed();
		if (this.visible) { this.focus(); return; }
		this.visible = true;
		this.hostOptions.onShow(this);
		if (this.visible) { this.layout(); this.focus(); }
	}
	hide(reason = QuickInputHideReason.Other): void {
		if (this.visible) this.hostOptions.onHide(this, reason);
	}
	willHide(reason = QuickInputHideReason.Other): void { this.hiding.fire({ reason }); }
	didHide(reason = QuickInputHideReason.Other): void {
		if (!this.visible) return;
		this.visible = false;
		if (this.menuVisible) this.menus.hideContextMenu();
		this.menuVisible = false;
		this.hidden.fire({ reason });
	}
	layout(): void {
		const anchor = this.anchor;
		if (!anchor) { this.layoutContents(); return; }
		if (isHTMLElement(anchor) && !anchor.isConnected) { this.hide(); return; }
		const viewport = getViewport(this.element.ownerDocument.defaultView!);
		const bounds = { left: viewport.left + 8, top: viewport.top + 8, width: Math.max(0, viewport.width - 16), height: Math.max(0, viewport.height - 16) };
		const rect = isHTMLElement(anchor) ? anchor.getBoundingClientRect() : undefined;
		const point = anchor as { x: number; y: number; };
		const target = rect ?? { left: point.x, top: point.y, right: point.x, bottom: point.y, width: 0, height: 0 };
		this.element.style.width = `${Math.min(this.anchorPosition === 'overlay' && rect ? rect.width : this.width ?? 380, bounds.width)}px`;
		const room = this.anchorPosition === 'overlay' ? bounds.height : Math.max(target.top - bounds.top - 4, bounds.top + bounds.height - target.bottom - 4, 0);
		this.layoutContents(Math.min(360, room));
		const size = this.element.getBoundingClientRect();
		const position = {
			...layout2d(bounds, size, target, {
				anchorPosition: this.anchorPosition === 'below' ? AnchorPosition.Below : AnchorPosition.Above,
				anchorAlignment: this.anchorAlignment === 'right' ? AnchorAlignment.Right : AnchorAlignment.Left,
				gap: 4,
			})
		};
		if (this.anchorPosition === 'overlay' && rect) {
			const field = this.element.querySelector('input, textarea')?.getBoundingClientRect();
			position.top = Math.max(bounds.top, Math.min(bounds.top + bounds.height - size.height, rect.top - ((field?.top ?? size.top) - size.top)));
		}
		this.element.style.left = `${position.left}px`;
		this.element.style.top = `${position.top}px`;
	}
	protected layoutContents(_availableHeight?: number): void { }
	abstract focus(): void;
	abstract accept(inBackground?: boolean): void | Promise<void>;
	protected override disposeCore(): void {
		this.hide();
		this.disposed.fire();
		this.hostOptions.onDispose(this);
		this.element.remove();
		super.disposeCore();
	}
}

class QuickInputTitleActionViewItem extends LabelActionViewItem {
	constructor(action: IAction, private readonly descriptor: IQuickInputButton, document: Document) {
		const iconId = descriptor.iconClass?.split(/\s+/).find(name => name.startsWith('ash-icon-'))?.slice(9);
		super(action, {
			icon: iconId ? getRegisteredIcon(iconId, document) : undefined,
			label: descriptor.iconClass || descriptor.iconPath ? '' : action.label || action.tooltip,
			ariaLabel: descriptor.label || descriptor.tooltip,
		});
	}
	override render(container: HTMLElement): void {
		super.render(container);
		const button = container.querySelector<HTMLButtonElement>('button')!;
		button.classList.add('ash-quick-input-title-button');
		if (this.descriptor.hasPopup) button.setAttribute('aria-haspopup', this.descriptor.hasPopup);
		if (!this.descriptor.iconPath) return;
		for (const [theme, uri] of [['dark', this.descriptor.iconPath.dark], ['light', this.descriptor.iconPath.light ?? this.descriptor.iconPath.dark]] as const) {
			const image = h(container.ownerDocument, 'img', { className: `ash-quick-input-button-image-${theme}` });
			image.src = uri.toString();
			image.alt = '';
			button.prepend(image);
		}
	}
}

/** Hosts borrowed content; hiding or disposing the host never disposes that content. */
export class QuickWidget extends QuickInput implements IQuickWidget {
	readonly type = QuickInputType.QuickWidget;
	private content: HTMLElement | undefined;
	private readonly contentHost: HTMLDivElement;

	constructor(host: HTMLElement, options: BrowserQuickInputHostOptions, @IOpenerService opener: IOpenerService, @IContextMenuService menus: IContextMenuService) {
		super(host, options, opener, menus, 'ash-quick-widget');
		this.contentHost = h(host.ownerDocument, 'div');
		this.element.append(this.contentHost);
	}

	get widget(): unknown { return this.content; }
	set widget(value: unknown) {
		if (value !== undefined && !isHTMLElement(value)) throw new TypeError('Quick Widget content must be an HTMLElement');
		this.content = value;
		this.contentHost.replaceChildren(...(value ? [value] : []));
	}
	protected override updateEnabled(): void { this.contentHost.inert = !this.enabled; }

	focus(): void {
		const selector = 'textarea, input, [contenteditable="true"], [tabindex="0"], button';
		const target = this.content?.matches(selector) ? this.content : this.content?.querySelector<HTMLElement>(selector);
		target?.focus();
	}

	// The embedded component owns Enter and submission, including IME and modifier behavior.
	accept(): void { }
}

/** DOM implementation of one searchable Quick Pick controller. */
export class QuickPick<TItem extends IQuickPickItem>
	extends QuickInput
	implements IQuickPick<TItem>, IBrowserQuickInputHost {
	public readonly type = QuickInputType.QuickPick;
	private readonly inputBox: InputBox;
	private readonly inputActions: ActionBar;
	private readonly list: QuickInputList<TItem>;
	private readonly navigationHost: HTMLDivElement;
	private readonly navigationTabs = this._register(new MutableDisposable<TabList<string>>());
	private navigationValue: IQuickInputNavigation | undefined;
	public get navigation(): IQuickInputNavigation | undefined { return this.navigationValue; }
	public set navigation(value: IQuickInputNavigation | undefined) {
		this.navigationValue = value;
		this.navigationHost.hidden = !value;
		if (!value) {
			this.navigationTabs.clear();
			this.list.element.removeAttribute('role');
			this.list.element.removeAttribute('aria-labelledby');
		} else {
			if (!this.navigationTabs.value) {
				this.navigationTabs.value = new TabList(this.navigationHost, {
					ariaLabel: localize('quickInput.searchModes', 'Search modes'),
					presentation: 'inset',
					onActivate: id => this.navigationValue?.onSelect(id),
				});
				this.navigationTabs.value.setSizing({ mode: 'fixed', minWidth: 0, maxWidth: 600 });
			}
			const tabs = value.items.map(item => ({
				...item, value: item.id,
				tabId: `${this.list.listId}-tab-${encodeURIComponent(item.id)}`,
				panelId: this.list.element.id,
			}));
			this.navigationTabs.value.setTabs(tabs, value.selectedId);
			this.list.element.setAttribute('role', 'tabpanel');
			const selected = tabs.find(tab => tab.id === value.selectedId);
			if (selected) { this.list.element.setAttribute('aria-labelledby', selected.tabId); }
			else { this.list.element.removeAttribute('aria-labelledby'); }
		}
		if (this.visible) this.layout();
	}
	public canAcceptInBackground = false;
	public get keyMods() { return this.list.keyMods; }
	public set keyMods(value: IKeyMods) { this.list.keyMods = value; }
	private readonly _onDidAccept = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	private acceptingInBackground = false;
	private readonly _onDidChangeValue = this._register(new Emitter<string>());
	private readonly _onDidBlur = this._register(new Emitter<void>());
	private readonly _onDidTriggerItemButton = this._register(new Emitter<{ readonly item: TItem; readonly button: IQuickPickItemButton; readonly anchor?: unknown; readonly fromKeyboard?: boolean; }>());
	private _ariaLabel = localize('quickInput.title', 'Quick Pick');
	private _placeholder = '';
	private _filterValue = (value: string): string => value;

	readonly onDidAccept: Event<IQuickPickDidAcceptEvent> = this._onDidAccept.event;
	public get activeItems(): readonly TItem[] { return this.list.activeItem ? [this.list.activeItem] : []; }
	public set activeItems(items: readonly TItem[]) { if (items[0]) this.list.setActiveItem(items[0]); }
	readonly onDidChangeValue: Event<string> =
		this._onDidChangeValue.event;
	readonly onDidBlur: Event<void> = this._onDidBlur.event;
	readonly onDidTriggerItemButton = this._onDidTriggerItemButton.event;
	public get canSelectMany(): boolean { return this.list.canSelectMany; }
	public set canSelectMany(value: boolean) { this.list.canSelectMany = value; }
	public get selectedItems(): readonly TItem[] { return this.list.selectedItems; }
	public set selectedItems(items: readonly TItem[]) { this.list.selectedItems = items; }
	public get onDidChangeSelection(): Event<readonly TItem[]> { return this.list.onDidChangeSelection; }

	constructor(
		host: HTMLElement,
		options: BrowserQuickInputHostOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService opener: IOpenerService,
		@IContextMenuService menus: IContextMenuService,
	) {
		super(host, options, opener, menus, 'ash-quick-pick');
		const ownerDocument = host.ownerDocument;
		setRole(this.element, 'dialog');
		setAriaAttribute(this.element, 'label', this._ariaLabel);
		try {
			this.list = this._register(instantiationService.createInstance(QuickInputList<TItem>, this.element, 'quickPick'));
		} catch (error) {
			// A missing list dependency must also release this picker's initialized emitters.
			this.dispose();
			throw error;
		}
		this.list.element.id = `${this.list.listId}-panel`;
		this.inputBox = this._register(new InputBox(this.element, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'text',
			ariaLabel: localize('quickInput.title', 'Quick Pick'),
			role: 'combobox',
			ariaAutoComplete: 'list',
			ariaControls: this.list.listId,
			ariaExpanded: true,
		}));
		this.inputBox.element.classList.add('ash-quick-pick-input', 'ash-quick-pick-filter');
		const clearLabel = localize('quickInput.clearInput', 'Clear input');
		this.inputActions = this._register(new ActionBar(this.inputBox.element, {
			ariaLabel: clearLabel,
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: '', ariaLabel: action.label }),
			actions: [{
				id: 'quickInput.clearInput',
				label: clearLabel,
				tooltip: clearLabel,
				icon: Lxicon.clearAll,
				enabled: true,
				run: () => {
					// Focus the field before its now-empty value hides the action that was activated.
					this.inputBox.focus();
					this.value = '';
				},
			}],
		}));
		this.inputActions.domNode.classList.add('ash-quick-pick-input-actions');
		this.inputActions.domNode.hidden = true;
		this.navigationHost = h(ownerDocument, 'div');
		this.navigationHost.className = 'ash-quick-pick-navigation';
		this.navigationHost.hidden = true;
		this._register(addDisposableListener(this.navigationHost, 'keydown', event => {
			if (event.key === 'ArrowDown') {
				stopEvent(event);
				this.inputBox.focus();
			}
		}));
		this.element.append(
			this.inputBox.element,
			this.descriptionElement,
			this.navigationHost,
			this.progress,
			this.list.element,
		);

		this._register(this.inputBox.onDidChange(
			(value) => this.handleValueChange(value),
		));
		this._register(this.inputBox.onDidBlur(() => {
			queueMicrotask(() => {
				if (this.visible && !this.element.contains(this.element.ownerDocument.activeElement)) {
					this._onDidBlur.fire();
				}
			});
		}));
		this._register(this.list.onDidAccept((item) => {
			if (!this.enabled) return;
			if (!this.canSelectMany) this.list.selectedItems = [item];
			this._onDidAccept.fire({ inBackground: this.acceptingInBackground || this.canAcceptInBackground && this.keyMods.ctrlCmd });
		}));
		this._register(this.list.onDidChangeActive(({ rowId }) => {
			this.inputBox.ariaActiveDescendant = rowId;
		}));
		this._register(this.list.onDidTriggerItemButton(event => this._onDidTriggerItemButton.fire(event)));
	}

	get items(): readonly (TItem | IQuickPickSeparator)[] {
		return this.list.items;
	}

	public get sortByLabel(): boolean { return this.list.sortByLabel; }
	public set sortByLabel(value: boolean) { this.list.sortByLabel = value; }

	get ariaLabel(): string {
		return this._ariaLabel;
	}

	set ariaLabel(value: string) {
		this._ariaLabel = value;
		setAriaAttribute(this.element, 'label', value);
		setAriaAttribute(this.inputBox.inputElement, 'label', value);
	}

	set items(items: readonly (TItem | IQuickPickSeparator)[]) {
		this.list.items = items;
		if (this.visible) this.layout();
	}

	get placeholder(): string {
		return this._placeholder;
	}

	set placeholder(value: string) {
		this._placeholder = value;
		this.inputBox.placeholder = value;
	}

	get value(): string {
		return this.inputBox.value;
	}

	set value(value: string) {
		this.inputBox.value = value;
	}

	get valueSelection(): InputSelection {
		return {
			start: this.inputBox.inputElement.selectionStart ?? 0,
			end: this.inputBox.inputElement.selectionEnd ?? 0,
		};
	}

	set valueSelection(value: InputSelection) {
		this.inputBox.select(value);
	}

	get filterValue(): (value: string) => string {
		return this._filterValue;
	}

	set filterValue(value: (value: string) => string) {
		this._filterValue = value;
		this.list.filter(value(this.inputBox.value));
	}

	protected override layoutContents(anchoredHeight?: number): void {
		const ownerWindow = this.element.ownerDocument.defaultView!;
		const chromeHeight = [...this.element.children].filter(child => child !== this.list.element)
			.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0);
		if (anchoredHeight !== undefined) {
			const style = ownerWindow.getComputedStyle(this.element);
			const listStyle = ownerWindow.getComputedStyle(this.list.element);
			const reservedHeight = chromeHeight
				+ Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth)
				+ Number.parseFloat(listStyle.paddingTop) + Number.parseFloat(listStyle.paddingBottom);
			this.list.layout(Math.max(0, anchoredHeight - reservedHeight));
			return;
		}
		const hostBounds = this.host.getBoundingClientRect();
		const pickerBounds = this.element.getBoundingClientRect();
		const pickerStyle = ownerWindow.getComputedStyle(this.element);
		const maxPickerHeight = Number.parseFloat(pickerStyle.maxHeight);
		if (!Number.isFinite(maxPickerHeight) || hostBounds.height === 0) return;
		const hostStyle = ownerWindow.getComputedStyle(this.host);
		const listStyle = ownerWindow.getComputedStyle(this.list.element);
		const roomBelow = hostBounds.bottom - pickerBounds.top - Number.parseFloat(hostStyle.paddingBottom);
		const reservedHeight = chromeHeight
			+ Number.parseFloat(pickerStyle.borderTopWidth)
			+ Number.parseFloat(pickerStyle.borderBottomWidth)
			+ Number.parseFloat(listStyle.paddingTop)
			+ Number.parseFloat(listStyle.paddingBottom);
		const availableHeight = Math.min(maxPickerHeight, roomBelow) - reservedHeight;
		// Keep results proportional to the host while leaving room for the editor below.
		this.list.layout(Math.max(0, Math.min(hostBounds.height * 0.4, availableHeight)));
	}

	protected override updateEnabled(): void {
		this.inputBox.enabled = this.enabled;
		this.inputActions.domNode.inert = !this.enabled;
		this.navigationHost.inert = !this.enabled;
		this.list.element.inert = !this.enabled;
	}

	focus(what?: QuickPickFocus): void {
		if (what !== undefined) this.list.focus(what);
		else {
			this.inputBox.focus();
			this.inputBox.select();
		}
	}

	public accept(inBackground = false): void {
		if (!this.enabled) return;
		if (inBackground && !this.canAcceptInBackground) return;
		this.acceptingInBackground = inBackground || this.canAcceptInBackground && this.keyMods.ctrlCmd;
		try { this.list.acceptActive(); }
		finally { this.acceptingInBackground = false; }
	}

	public toggle(): void {
		if (this.enabled && this.canSelectMany) this.list.toggleActive();
	}

	private handleValueChange(value: string): void {
		this.inputActions.domNode.hidden = value.length === 0;
		this.inputBox.element.classList.toggle('has-value', value.length > 0);
		this.list.filter(this._filterValue(value));
		if (this.visible) this.layout();
		this._onDidChangeValue.fire(value);
	}

}
