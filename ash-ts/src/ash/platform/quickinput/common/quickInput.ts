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
	readonly keybinding?: string;
}

/** A short-lived searchable selection UI hosted by the current window. */
export interface IQuickPick<TItem extends IQuickPickItem>
	extends IDisposable {
	readonly onDidAccept: Event<TItem>;
	readonly onDidChangeValue: Event<string>;
	readonly onDidHide: Event<void>;
	readonly onDidBlur: Event<void>;

	items: readonly TItem[];
	ariaLabel: string;
	placeholder: string;
	value: string;
	filterValue: (value: string) => string;

	show(): void;
	hide(): void;
}

/** Creates Quick Input controllers hosted by one Workbench window. */
export interface IQuickInputService {
	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem>;
}

export const IQuickInputService =
	createServiceIdentifier<IQuickInputService>("quickInputService");
