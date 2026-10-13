import type { Event } from "../../../base/common/event.js";
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { ResolvedKeybinding } from "../../../base/common/keybindings.js";
import type { IQuickAccessController } from './quickAccess.js';
import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

/** Presentation shared by searchable Quick Pick providers. */
export interface IQuickPickItem {
	readonly label: string;
	readonly description?: string;
	readonly detail?: string;
	/** Marks the chosen item independently of the row being browsed. */
	readonly picked?: boolean;
	readonly keybinding?: ResolvedKeybinding;
	readonly className?: string;
	readonly buttons?: readonly IQuickPickItemButton[];
	readonly iconClass?: string;
	readonly alwaysShow?: boolean;
}

export interface IQuickPickSeparator {
	readonly type: 'separator';
	readonly label?: string;
}

export interface IKeyMods {
	readonly ctrlCmd: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

export interface IQuickPickItemButton {
	readonly id: string;
	readonly label: string;
	readonly iconClass?: string;
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
	InputBox = 'inputBox',
}

/** The active control, including prompts that do not contain a result list. */
export interface IQuickInput extends IDisposable {
	readonly type: QuickInputType;
	readonly onDidHide: Event<void>;
	focus(): void;
	accept(inBackground?: boolean): void | Promise<void>;
	hide(): void;
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
	readonly onDidHide: Event<void>;
	readonly onDidBlur: Event<void>;
	readonly onDidTriggerItemButton: Event<{ readonly item: TItem; readonly button: IQuickPickItemButton; }>;

	items: readonly (TItem | IQuickPickSeparator)[];
	/** Disable search sorting when the provider owns item order and grouping. */
	sortByLabel: boolean;
	canSelectMany: boolean;
	selectedItems: readonly TItem[];
	readonly onDidChangeSelection: Event<readonly TItem[]>;
	busy?: boolean;
	canAcceptInBackground?: boolean;
	keyMods?: IKeyMods;
	ariaLabel: string;
	/** An optional HTMLElement anchor; unanchored pickers retain the window's default placement. */
	anchor?: unknown;
	anchorPosition?: 'above' | 'below';
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
	navigate(next: boolean): void;
	accept(keyMods?: IKeyMods): Promise<void>;
	cancel(): Promise<void>;
	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem>;
	input(options: IInputOptions, token?: CancellationToken): Promise<string | undefined>;
}

export const IQuickInputService =
	createServiceIdentifier<IQuickInputService>("quickInputService");
