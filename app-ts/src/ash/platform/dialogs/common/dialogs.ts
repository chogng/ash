import {
	createServiceIdentifier,
} from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';

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
	readonly checkbox?: { readonly label: string; readonly checked?: boolean };
}

export interface IDialogInput {
	readonly type?: "text" | "password";
	readonly placeholder?: string;
	readonly value?: string;
}

export interface IInputDialogOptions extends IDialogOptions {
	readonly inputs: readonly IDialogInput[];
	readonly primaryButton?: string;
	readonly cancelButton?: string;
}

export interface IInputDialogResult {
	readonly confirmed: boolean;
	readonly values?: readonly string[];
	readonly checkboxChecked?: boolean;
}

export interface IConfirmationDialogResult {
	readonly confirmed: boolean;
	readonly checkboxChecked?: boolean;
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
	} & IPromptDialogOptions)
	| ({
		readonly kind: "input";
	} & IInputDialogOptions);

/** Result returned by a host-specific dialog handler. */
export enum DialogResult {
	Primary = "primary",
	Secondary = "secondary",
	Cancel = "cancel",
}

export interface IDialogOutcome {
	readonly button: DialogResult;
	readonly values?: readonly string[];
	readonly checkboxChecked?: boolean;
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
	): Promise<IDialogOutcome>;
}

/** Window-scoped access to modal workbench dialogs. */
export interface IDialogService {
	showMessage(options: IMessageDialogOptions): Promise<void>;
	confirm(options: IConfirmationDialogOptions): Promise<IConfirmationDialogResult>;
	prompt(options: IPromptDialogOptions): Promise<DialogResult>;
	input(options: IInputDialogOptions): Promise<IInputDialogResult>;
}

export const IDialogService =
	createServiceIdentifier<IDialogService>("dialogService");

/** Selects a file path for an editor Save As operation. */
export interface IFileDialogService {
	pickFileToSave(defaultUri: URI): Promise<URI | undefined>;
	showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined>;
	showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined>;
}

export interface FileFilter {
	readonly name: string;
	readonly extensions: readonly string[];
}

export interface ISaveDialogOptions {
	readonly title?: string;
	readonly defaultUri?: URI;
	readonly filters?: readonly FileFilter[];
	readonly saveLabel?: string;
	readonly availableFileSystems?: readonly string[];
}

export interface IOpenDialogOptions {
	readonly title?: string;
	readonly defaultUri?: URI;
	readonly openLabel?: string;
	readonly canSelectFiles?: boolean;
	readonly canSelectFolders?: boolean;
	readonly canSelectMany?: boolean;
	readonly filters?: readonly FileFilter[];
	readonly availableFileSystems?: readonly string[];
}

export const IFileDialogService =
	createServiceIdentifier<IFileDialogService>('fileDialogService');
