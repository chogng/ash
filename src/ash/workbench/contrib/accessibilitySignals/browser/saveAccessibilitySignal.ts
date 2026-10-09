import { Disposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';

export class SaveAccessibilitySignal extends Disposable {
	constructor(@ITextFileService files: ITextFileService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		// Saving has one owner, including retries and Save As; failures never emit this event.
		this._register(files.onDidSave(() => { void signals.playSignal(AccessibilitySignal.save); }));
	}
}
