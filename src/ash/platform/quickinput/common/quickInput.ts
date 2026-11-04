import type { Event } from '../../../base/common/event.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import type { URI } from '../../../base/common/uri.js';
import type Severity from '../../../base/common/severity.js';
import type { ThemeColor } from '../../../base/common/themables.js';
import type { IQuickAccessController } from './quickAccess.js';
import {
	createServiceIdentifier,
} from '../../instantiation/common/instantiation.js';

/** Presentation shared by searchable Quick Pick providers. */
export interface IQuickPickItem {
	readonly id?: string;
	readonly ariaLabel?: string;
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	readonly tooltip?: string;
	/** Marks the chosen item independently of the row being browsed. */
	readonly picked?: boolean;
	readonly keybinding?: ResolvedKeybinding;
	readonly className?: string;
	readonly buttons?: readonly IQuickPickItemButton[];
	readonly iconClass?: string;
	readonly iconColor?: ThemeColor;
	/** Resource icon classes resolved by the active file icon theme. */
	readonly iconClasses?: readonly string[];
	readonly alwaysShow?: boolean;
}

export interface IQuickPickSeparator {
	readonly type: 'separator';
	readonly label?: string;
	/** Section headings take their own line; inline labels retain the compact default. */
	readonly presentation?: 'section';
}

export interface IKeyMods {
	readonly ctrlCmd: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

export interface IQuickInputButton {
	readonly iconPath?: { readonly dark: URI; readonly light?: URI; };
	readonly alwaysVisible?: boolean;
	readonly label?: string;
	readonly tooltip?: string;
	readonly iconClass?: string;
	readonly secondary?: boolean;
	readonly toggle?: { checked: boolean; };
	readonly hasPopup?: 'menu';
}

export interface IQuickPickItemButton extends IQuickInputButton {
	readonly id: string;
	readonly label: string;
	readonly iconClass?: string;
	readonly hasPopup?: 'menu';
}

export interface IQuickInputSelection {
	readonly start: number;
	readonly end: number;
}

/** Optional search navigation; selection and search state remain with the caller. */
export interface IQuickInputNavigation {
	readonly items: readonly { readonly id: string; readonly label: string; }[];
	readonly selectedId: string | undefined;
	readonly onSelect: (id: string) => void;
}

export enum QuickPickFocus {
	First = 1,
	Second,
	Last,
	Next,
	Previous,
	NextPage,
	PreviousPage,
}

export enum QuickInputType {
	QuickPick = 'quickPick',
	QuickTree = 'quickTree',
	InputBox = 'inputBox',
	QuickWidget = 'quickWidget',
}

export enum QuickInputHideReason {
	Blur = 1,
	Gesture,
	Other,
}

export interface IQuickInputHideEvent {
	readonly reason: QuickInputHideReason;
}

/** The active control, including prompts that do not contain a result list. */
export interface IQuickInput extends IDisposable {
	readonly type: QuickInputType;
	readonly onDidHide: Event<IQuickInputHideEvent>;
	readonly onWillHide: Event<IQuickInputHideEvent>;
	readonly onDispose: Event<void>;
	title: string | undefined;
	description: string | undefined;
	step: number | undefined;
	totalSteps: number | undefined;
	buttons: readonly IQuickInputButton[];
	readonly onDidTriggerButton: Event<IQuickInputButton>;
	enabled: boolean;
	busy: boolean;
	contextKey: string | undefined;
	ignoreFocusOut: boolean;
	/** HTMLElement or viewport coordinates. */
	anchor?: unknown | { x: number; y: number; };
	anchorPosition?: 'above' | 'below' | 'overlay';
	show(): void;
	focus(): void;
	accept(inBackground?: boolean): void | Promise<void>;
	hide(reason?: QuickInputHideReason): void;
	willHide(reason?: QuickInputHideReason): void;
	didHide(reason?: QuickInputHideReason): void;
}

/** A caller-owned interactive surface using the window's Quick Input lifetime. */
export interface IQuickWidget extends IQuickInput {
	readonly type: QuickInputType.QuickWidget;
	widget: unknown | undefined;
	show(): void;
}

export interface IQuickPickDidAcceptEvent {
	readonly inBackground: boolean;
}

/** A short-lived searchable selection UI hosted by the current window. */
export interface IQuickPick<TItem extends IQuickPickItem>
	extends IQuickInput {
	readonly type: QuickInputType.QuickPick;
	navigation?: IQuickInputNavigation;
	readonly onDidAccept: Event<IQuickPickDidAcceptEvent>;
	activeItems: readonly TItem[];
	readonly onDidChangeValue: Event<string>;
	readonly onDidBlur: Event<void>;
	readonly onDidTriggerItemButton: Event<{ readonly item: TItem; readonly button: IQuickPickItemButton; readonly anchor?: unknown; readonly fromKeyboard?: boolean; }>;

	items: readonly (TItem | IQuickPickSeparator)[];
	/** Disable search sorting when the provider owns item order and grouping. */
	sortByLabel: boolean;
	canSelectMany: boolean;
	selectedItems: readonly TItem[];
	readonly onDidChangeSelection: Event<readonly TItem[]>;
	canAcceptInBackground?: boolean;
	keyMods?: IKeyMods;
	ariaLabel: string;
	/** An optional HTMLElement anchor; unanchored pickers retain the window's default placement. */
	anchor?: unknown;
	/** Preferred edge alignment; placement can flip to remain inside the viewport. */
	anchorAlignment?: 'left' | 'right';
	/** Preferred anchored-picker width in CSS pixels, capped by the available viewport. */
	width?: number;
	placeholder: string;
	value: string;
	valueSelection: IQuickInputSelection;
	filterValue: (value: string) => string;

	show(): void;
	hide(): void;
	focus(what?: QuickPickFocus): void;
	toggle(): void;
}

export interface IInputOptions {
	readonly title?: string;
	readonly placeHolder?: string;
	readonly value?: string;
	readonly password?: boolean;
	readonly validationMessage?: string;
	readonly validateInput?: (value: string) => Promise<string | null | undefined>;
}

/** Creates Quick Input controllers hosted by one Workbench window. */
export interface IQuickInputService {
	readonly quickAccess: IQuickAccessController;
	readonly onShow: Event<void>;
	readonly onHide: Event<void>;
	readonly currentQuickInput: IQuickInput | undefined;
	focus(): void;
	toggle(): void;
	/** Presets or host-relative fractions (top edge and horizontal center). */
	setAlignment(alignment: 'top' | 'center' | { top: number; left: number; }): void;
	navigate(next: boolean): void;
	accept(keyMods?: IKeyMods): Promise<void>;
	cancel(): Promise<void>;
	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem>;
	createQuickTree<TItem extends IQuickTreeItem>(): IQuickTree<TItem>;
	createQuickWidget(): IQuickWidget;
	input(options: IInputOptions, token?: CancellationToken): Promise<string | undefined>;
}

export const IQuickInputService =
	createServiceIdentifier<IQuickInputService>('quickInputService');

/** Checkbox state belongs to these items; the tree projects it without a second selection model. */
export interface IQuickTreeItem extends Omit<IQuickPickItem, 'buttons' | 'picked'> {
	checked?: boolean | 'mixed';
	collapsed?: boolean;
	readonly children?: readonly IQuickTreeItem[];
	readonly pickable?: boolean;
	readonly disabled?: boolean;
	readonly buttons?: readonly IQuickInputButton[];
}

export interface IQuickTreeCheckboxEvent<T extends IQuickTreeItem> {
	readonly item: T;
	readonly checked: boolean | 'mixed';
}

export interface IQuickTreeItemButtonEvent<T extends IQuickTreeItem> {
	readonly item: T;
	readonly button: IQuickInputButton;
}

/** Searchable hierarchical selection hosted by the window's existing Quick Input service. */
export interface IQuickTree<T extends IQuickTreeItem> extends IQuickInput {
	readonly type: QuickInputType.QuickTree;
	value: string;
	ariaLabel: string | undefined;
	placeholder: string | undefined;
	description: string | undefined;
	matchOnDescription: boolean;
	matchOnLabel: boolean;
	sortByLabel: boolean;
	activeItems: readonly T[];
	validationMessage: string | undefined;
	severity: Severity;
	readonly itemTree: readonly T[];
	readonly checkedLeafItems: readonly T[];
	readonly onDidChangeValue: Event<string>;
	readonly onDidAccept: Event<void>;
	readonly onDidChangeActive: Event<readonly T[]>;
	readonly onDidChangeCheckedLeafItems: Event<readonly T[]>;
	readonly onDidChangeCheckboxState: Event<T>;
	readonly onDidTriggerItemButton: Event<IQuickTreeItemButtonEvent<T>>;
	setItemTree(items: T[]): void;
	getParent(item: T): T | undefined;
	expand(item: T): void;
	collapse(item: T): void;
	isCollapsed(item: T): boolean;
	focusOnInput(): void;
	reveal(item: T): void;
	focus(what?: QuickPickFocus): void;
	show(): void;
}
