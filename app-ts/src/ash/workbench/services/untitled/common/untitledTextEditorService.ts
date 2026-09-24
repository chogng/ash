import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Options used to create one Workbench-owned untitled text input. */
export interface UntitledTextEditorOptions {
	/** Initial text supplied by the caller instead of a file-system resource. */
	readonly initialText?: string;
	/** Explicit language identity to use until the input is saved. */
	readonly languageId?: string;
}

/** Stable identity and bootstrap snapshot for one untitled editor. */
export interface IUntitledTextEditor {
	readonly resource: URI;
	readonly label: string;
	readonly initialText: string;
	readonly languageId: string | undefined;
}

/**
 * Owns virtual editor identities for unsaved text.
 *
 * The service deliberately owns only the Workbench-facing resource identity
 * and bootstrap snapshot. Text transactions, undo history, and dirty state
 * remain with the editor model service that acquires the input.
 */
export interface IUntitledTextEditorService extends IDisposable {
	readonly onDidCreate: Event<IUntitledTextEditor>;
	readonly onDidChangeLabel: Event<IUntitledTextEditor>;

	/** Creates a new unique `untitled:` editor input. */
	create(options?: UntitledTextEditorOptions): IUntitledTextEditor;

	/** Finds the Workbench input previously created for an exact resource. */
	get(resource: URI): IUntitledTextEditor | undefined;

	/** Changes the display label while keeping the virtual resource identity stable. */
	rename(resource: URI, label: string): IUntitledTextEditor | undefined;

	/** Reports whether a resource belongs to this virtual editor namespace. */
	isUntitled(resource: URI): boolean;
}

export const IUntitledTextEditorService =
	createServiceIdentifier<IUntitledTextEditorService>(
		"untitledTextEditorService",
	);

export const UNTITLED_TEXT_EDITOR_SCHEME = "untitled";
