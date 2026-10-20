import '../../../../base/browser/ui/selectbox/selectbox.css';
import '../../../../base/browser/ui/dropdown/dropdown.css';
import { addDisposableListener, fragment, h } from '../../../../base/browser/dom.js';
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
import { isFiniteNumber, isNonNegativeSafeInteger, isSafeInteger } from '../../../../base/common/numbers.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { assertDefined, isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { EditorDom } from '../../../../editor/browser/editorDom.js';
import { createLineDocumentSnapshot, linePoint } from '../../../../editor/common/model/lineDocument.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

/**
 * Versioned mechanisms shared with admitted product editor clients. Service identifiers
 * preserve constructor injection; no service instances or container cross this boundary.
 */
export const editorClientHost = Object.freeze({
	'base/browser/dom.js': Object.freeze({ addDisposableListener, fragment, h }),
	'base/browser/domSanitize.js': Object.freeze({ sanitizeHtmlToFragment }),
	'base/browser/ui/button/button.js': Object.freeze({ Button }),
	'base/browser/ui/inputbox/inputbox.js': Object.freeze({ InputBox }),
	'base/browser/ui/selectbox/selectbox.js': Object.freeze({ SelectBox }),
	'base/browser/ui/toolbar/toolbar.js': Object.freeze({ ToolBar }),
	'base/common/errors.js': Object.freeze({ onUnexpectedError }),
	'base/common/event.js': Object.freeze({ Emitter }),
	'base/common/lifecycle.js': Object.freeze({ Disposable, DisposableStore, MutableDisposable, combinedDisposable, toDisposable }),
	'base/common/lxicons.js': Object.freeze({ Lxicon }),
	'base/common/marked/marked.js': Object.freeze({ lexer }),
	'base/common/numbers.js': Object.freeze({ isFiniteNumber, isNonNegativeSafeInteger, isSafeInteger }),
	'base/common/platform.js': Object.freeze({ isMacintosh }),
	'base/common/types.js': Object.freeze({ assertDefined, isRecord }),
	'base/common/uri.js': Object.freeze({ URI }),
	'base/common/uuid.js': Object.freeze({ generateUuid }),
	'editor/browser/editorDom.js': Object.freeze({ EditorDom }),
	'editor/common/model/lineDocument.js': Object.freeze({ createLineDocumentSnapshot, linePoint }),
	'editor/common/model/textModel.js': Object.freeze({ TextModel }),
	'nls.js': Object.freeze({ localize }),
	'platform/dialogs/common/dialogs.js': Object.freeze({ IDialogService }),
	'platform/opener/common/opener.js': Object.freeze({ IOpenerService }),
	'platform/theme/browser/defaultStyles.js': Object.freeze({ defaultButtonStyles, defaultInputBoxStyles, defaultSelectBoxStyles }),
});
