import type {
	IDimension,
} from "../../../../base/browser/dom.js";
import type {
	IDisposable,
} from "../../../../base/common/lifecycle.js";
import type { URI } from "../../../../base/common/uri.js";
import type {
	IConfigurationService,
} from "../../../../platform/configuration/common/configuration.js";
import { type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { EditorInput } from "./editorInput.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IWorkingCopyService, IWorkingCopy } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { Range } from "../../../../editor/common/core/range.js";
import { type LanguageLocation, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import type { ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IKeybindingsResourceService } from "../../../../platform/keybinding/common/keybindingsResource.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { IMenuService } from "../../../../platform/actions/common/menuService.js";
import type { Event } from "../../../../base/common/event.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { TextResourceLanguageResolver } from '../../../../platform/language/common/textResourceLanguage.js';

export enum EditorPaneVisibility {
	Hidden,
	Visible,
}

/**
 * One editor implementation hosted by the central Editor Part.
 *
 * Implementations create their DOM exactly once in the supplied parent.
 * `setInput` may resolve asynchronously, must observe the abort signal, and
 * must reject when the input cannot be opened. The host owns the pane and
 * disposes it after hiding it.
 */
export interface IEditorPane extends IDisposable {
	getControl?(): unknown;
	readonly id: string;
	/** Optional format-specific document exposed through the shared Workbench lifecycle. */
	readonly workingCopy?: IWorkingCopy;

	create(parent: HTMLElement): void;
	setInput(input: EditorInput, signal: AbortSignal): Promise<void>;
	clearInput(): void;
	layout(dimension: IDimension): void;
	setVisible(visibility: EditorPaneVisibility): void;
	focus(): void;
	/** Reveals an editor-owned text range when this pane supports text navigation. */
	revealRange?(range: Range): void;
	/** Persists the active editor's current resource when that editor is writable. */
	save?(): Promise<void>;
	/** Serializes and persists the active document to a new resource when supported. */
	saveAs?(resource: URI): Promise<void>;
}

/** Optional pane capability for JSON-safe, instance-local view state. */
export interface IEditorPaneWithViewState extends IEditorPane {
	readonly viewStateTypeId: string;
	saveViewState(): unknown;
	restoreViewState(state: unknown): void;
}

export function isEditorPaneWithViewState(pane: IEditorPane): pane is IEditorPaneWithViewState {
	const candidate = pane as Partial<IEditorPaneWithViewState>;
	return typeof candidate.viewStateTypeId === "string" && candidate.viewStateTypeId.length > 0 && typeof candidate.saveViewState === "function" && typeof candidate.restoreViewState === "function";
}

/** Format-neutral status details projected into the Workbench status bar. */
export interface EditorPaneStatus {
	readonly lineNumber?: number;
	readonly columnNumber?: number;
	readonly selectionCount?: number;
	readonly languageId?: string;
	readonly encoding?: string;
	readonly endOfLine?: string;
}

export interface IEditorPaneWithStatus extends IEditorPane {
	readonly onDidChangeStatus: Event<void>;
	getStatus(): EditorPaneStatus;
}

export function isEditorPaneWithStatus(pane: IEditorPane | undefined): pane is IEditorPaneWithStatus {
	const candidate = pane as Partial<IEditorPaneWithStatus> | undefined;
	return typeof candidate?.onDidChangeStatus === "function" && typeof candidate.getStatus === "function";
}

export interface EditorPaneCreationOptions {
	/** The input used to choose a profile-specific pane implementation. */
	readonly input?: EditorInput;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	/** Group-scoped action services for pane-owned menus and toolbars. */
	readonly actionServices?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
		readonly contextKeyService?: IContextKeyService;
	};
	readonly keybindingService?: IKeybindingService;
	readonly keybindingsResourceService?: IKeybindingsResourceService;
	readonly keyboardLayoutService?: IKeyboardLayoutService;
	readonly fileService?: IFileService;
	readonly textFileService?: ITextFileService;
	readonly textMateService?: ITextMateService;
	readonly languageResolver?: TextResourceLanguageResolver;
	readonly diffService?: IDiffService;
	readonly instantiationService?: IInstantiationService;
	readonly accessibilityService?: IAccessibilityService;
	readonly languageDiagnosticsService?: ILanguageDiagnosticsService;
	readonly documentCollaborationApi?: IDocumentCollaborationApi;
	readonly serverEvents?: IServerEventApi;
	readonly workingCopyService?: IWorkingCopyService;
	readonly onSave?: () => Promise<void | boolean>;
	readonly onOpenLocation?: (location: LanguageLocation) => void | Promise<void>;
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => void | Promise<void>;
}

export enum EditorPaneMatch {
	None,
	Optional,
	Default,
}

/**
 * Declares how one editor implementation is matched and constructed.
 *
 * Descriptors must keep `canOpen` pure. Product contribution modules register
 * descriptors before the Workbench creates its Editor Part.
 */
export interface IEditorPaneDescriptor {
	readonly id: string;
	readonly name: string;
	canOpen(input: EditorInput): EditorPaneMatch;
	create(options: EditorPaneCreationOptions): IEditorPane;
}
