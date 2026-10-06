import type { IEditorPane, IResourceEditorInput } from '../../../common/editor.js';
import { Composite } from '../../composite.js';
import type { IBulkEditOptions } from '../../../../editor/browser/services/bulkEditService.js';
import type { IDimension } from "../../../../base/browser/dom.js";
import type { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { type ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { type ITextMateService } from "../../../services/textMate/common/textMateService.js";
import type { IDiffService } from "../../../services/diff/common/diffService.js";
import type { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { type LanguageLocation, type LanguageWorkspaceEdit } from "../../../../editor/common/languages.js";
import type { ILanguageDiagnosticsService } from "../../../services/language/common/languageDiagnosticsService.js";
import type { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import type { IKeyboardLayoutService } from "../../../../platform/keyboardLayout/common/keyboardLayout.js";
import type { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import type { IMenuService } from "../../../../platform/actions/common/actions.js";
import type { IAccessibilityService } from "../../../../platform/accessibility/common/accessibility.js";
import type { TextResourceLanguageResolver } from '../../../../platform/language/common/textResourceLanguage.js';

/**
 * One editor implementation hosted by the central Editor Part.
 *
 * Implementations create their DOM exactly once in the supplied parent.
 * `setInput` may resolve asynchronously, must observe the abort signal, and
 * must reject when the input cannot be opened. The host owns the pane and
 * disposes it after hiding it.
 */
export abstract class EditorPane extends Composite implements IEditorPane {
	public abstract setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void>;
	public abstract clearInput(): void;
	public abstract layout(dimension: IDimension): void;
}

export interface EditorPane extends IEditorPane { }

export interface EditorPaneCreationOptions {
	/** The input used to choose a profile-specific pane implementation. */
	readonly input?: IResourceEditorInput;
	readonly configurationService?: IConfigurationService;
	readonly contextKeyService?: IContextKeyService;
	/** Group-scoped action services for pane-owned menus and toolbars. */
	readonly actionServices?: {
		readonly menuService: IMenuService;
		readonly contextMenuProvider: IContextMenuProvider;
		readonly contextKeyService?: IContextKeyService;
	};
	readonly keybindingService?: IKeybindingService;
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
	readonly onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit, options?: IBulkEditOptions) => void | Promise<void>;
}

export enum EditorPaneMatch {
	None,
	Optional,
	/** Product editor used when no resource-specific default matches. */
	Builtin,
	Default,
}
