import { IEditorService } from '../../editor/common/editorService.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { EditorPanes } from '../../../browser/editor.js';
import { registerResourceEditorAccessibility } from './resourceEditorAccessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import '../../../../base/browser/ui/selectbox/selectbox.css';
import '../../../../base/browser/ui/dropdown/dropdown.css';
import { addDisposableListener, fragment, h, svg } from '../../../../base/browser/dom.js';
import { Separator } from '../../../../base/common/actions.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource, throwIfCancelled } from '../../../../base/common/cancellation.js';
import { sanitizeHtmlToFragment } from '../../../../base/browser/domSanitize.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { ToolBar } from '../../../../base/browser/ui/toolbar/toolbar.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, combinedDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { lexer } from '../../../../base/common/marked/marked.js';
import { clamp, isFiniteNumber, isNonNegativeSafeInteger, isSafeInteger } from '../../../../base/common/numbers.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { assertDefined, isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { createUuid, generateUuid } from '../../../../base/common/uuid.js';
import { EditorDom } from '../../../../editor/browser/editorDom.js';
import { createLineDocumentSnapshot, linePoint } from '../../../../editor/common/model/lineDocument.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';

/**
 * Versioned mechanisms shared with admitted product editor clients. Service identifiers
 * preserve constructor injection; no service instances or container cross this boundary.
 */
export const editorClientHost = Object.freeze({
	'workbench/services/editor/common/editorService.js': Object.freeze({ IEditorService }),
	'workbench/services/workingCopy/common/workingCopyService.js': Object.freeze({ IWorkingCopyService }),
	'workbench/browser/editor.js': Object.freeze({ EditorPanes }),
	'workbench/services/extensions/browser/resourceEditorAccessibility.js': Object.freeze({
		registerResourceEditorAccessibility,
	}),
	'platform/configuration/common/configuration.js': Object.freeze({ IConfigurationService }),
	'base/browser/dom.js': Object.freeze({ addDisposableListener, fragment, h, svg }),
	'base/common/actions.js': Object.freeze({ Separator }),
	'base/common/async.js': Object.freeze({ raceCancellationError }),
	'base/common/buffer.js': Object.freeze({ streamToBuffer }),
	'base/common/cancellation.js': Object.freeze({ CancellationTokenSource, throwIfCancelled }),
	'base/browser/domSanitize.js': Object.freeze({ sanitizeHtmlToFragment }),
	'base/browser/ui/button/button.js': Object.freeze({ Button }),
	'base/browser/ui/inputbox/inputbox.js': Object.freeze({ InputBox }),
	'base/browser/ui/selectbox/selectbox.js': Object.freeze({ SelectBox }),
	'base/browser/ui/toolbar/toolbar.js': Object.freeze({ ToolBar }),
	'base/common/errors.js': Object.freeze({ onUnexpectedError }),
	'base/common/event.js': Object.freeze({ Emitter }),
	'base/common/lifecycle.js': Object.freeze({
		Disposable,
		DisposableStore,
		MutableDisposable,
		combinedDisposable,
		toDisposable,
	}),
	'base/common/lxicons.js': Object.freeze({ Lxicon }),
	'base/common/marked/marked.js': Object.freeze({ lexer }),
	'base/common/numbers.js': Object.freeze({ clamp, isFiniteNumber, isNonNegativeSafeInteger, isSafeInteger }),
	'base/common/platform.js': Object.freeze({ isMacintosh }),
	'base/common/types.js': Object.freeze({ assertDefined, isRecord }),
	'base/common/uri.js': Object.freeze({ URI }),
	'base/common/uuid.js': Object.freeze({ createUuid, generateUuid }),
	'editor/browser/editorDom.js': Object.freeze({ EditorDom }),
	'editor/common/model/lineDocument.js': Object.freeze({ createLineDocumentSnapshot, linePoint }),
	'editor/common/model/textModel.js': Object.freeze({ TextModel }),
	'nls.js': Object.freeze({ localize }),
	'platform/dialogs/common/dialogs.js': Object.freeze({ IDialogService, IFileDialogService }),
	'platform/opener/common/opener.js': Object.freeze({ IOpenerService }),
	'platform/theme/browser/defaultStyles.js': Object.freeze({
		defaultButtonStyles,
		defaultInputBoxStyles,
		defaultSelectBoxStyles,
	}),
	'platform/files/common/files.js': Object.freeze({ FileKind, IFileService }),
	'platform/storage/common/storage.js': Object.freeze({ IStorageService }),
	'platform/theme/common/themeService.js': Object.freeze({ IThemeService }),
	'workbench/browser/parts/editor/editorPane.js': Object.freeze({ EditorPane, EditorPaneMatch }),
});
