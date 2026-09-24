import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";

/** Visual severity used by a modal message dialog. */
export enum DialogSeverity {
	Info = "info",
	Warning = "warning",
	Error = "error",
}

/** Content shared by message and confirmation dialogs. */
export interface IDialogOptions {
	readonly title?: string;
	readonly message: string;
	readonly detail?: string;
}

/** Options for a modal message that has one dismiss button. */
export interface IMessageDialogOptions extends IDialogOptions {
	readonly severity: DialogSeverity;
	readonly primaryButton?: string;
}

/** Options for a modal question with explicit confirm and cancel actions. */
export interface IConfirmationDialogOptions extends IDialogOptions {
	readonly primaryButton?: string;
	readonly cancelButton?: string;
}

/** Options for a modal decision with save, discard, and cancel-style outcomes. */
export interface IPromptDialogOptions extends IDialogOptions {
	readonly primaryButton: string;
	readonly secondaryButton: string;
	readonly cancelButton?: string;
}

/** Requests understood by a host-specific dialog handler. */
export type DialogRequest =
	| ({
		readonly kind: "message";
	} & IMessageDialogOptions)
	| ({
		readonly kind: "confirmation";
	} & IConfirmationDialogOptions)
	| ({
		readonly kind: "prompt";
	} & IPromptDialogOptions);

/** Result returned by a host-specific dialog handler. */
export enum DialogResult {
	Primary = "primary",
	Secondary = "secondary",
	Cancel = "cancel",
}

/**
 * Presents one dialog using the active host UI.
 *
 * Implementations must observe `signal` and settle as cancelled after abort.
 */
export interface IDialogHandler {
	showDialog(
		request: DialogRequest,
		signal: AbortSignal,
	): Promise<DialogResult>;
}

/** Window-scoped access to modal workbench dialogs. */
export interface IDialogService {
	showMessage(options: IMessageDialogOptions): Promise<void>;
	confirm(options: IConfirmationDialogOptions): Promise<boolean>;
	prompt(options: IPromptDialogOptions): Promise<DialogResult>;
}

export const IDialogService =
	createServiceIdentifier<IDialogService>("dialogService");
