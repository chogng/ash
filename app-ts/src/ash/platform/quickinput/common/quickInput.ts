import type { Event } from "../../../base/common/event.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
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
	readonly keybinding?: string;
	readonly className?: string;
	readonly buttons?: readonly IQuickPickItemButton[];
}

export interface IQuickPickItemButton {
	readonly id: string;
	readonly label: string;
}

export interface IQuickInputSelection {
	readonly start: number;
	readonly end: number;
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

/** A short-lived searchable selection UI hosted by the current window. */
export interface IQuickPick<TItem extends IQuickPickItem>
	extends IDisposable {
	readonly onDidAccept: Event<TItem>;
	readonly onDidChangeValue: Event<string>;
	readonly onDidHide: Event<void>;
	readonly onDidBlur: Event<void>;
	readonly onDidTriggerItemButton: Event<{ readonly item: TItem; readonly button: IQuickPickItemButton }>;

	items: readonly TItem[];
	ariaLabel: string;
	placeholder: string;
	value: string;
	valueSelection: IQuickInputSelection;
	filterValue: (value: string) => string;

	show(): void;
	hide(): void;
}

export interface IInputOptions {
	readonly title?: string;
	readonly placeHolder?: string;
	readonly value?: string;
	readonly password?: boolean;
	readonly validateInput?: (value: string) => Promise<string | null | undefined>;
}

/** Creates Quick Input controllers hosted by one Workbench window. */
export interface IQuickInputService {
	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem>;
	input(options: IInputOptions): Promise<string | undefined>;
}

export const IQuickInputService =
	createServiceIdentifier<IQuickInputService>("quickInputService");
