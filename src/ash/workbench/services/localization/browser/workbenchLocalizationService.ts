import { Disposable } from '../../../../base/common/lifecycle.js';
import { formatNlsMessage, localize } from '../../../../nls.js';
import type { ILocalizationService, LocalizationParameters } from '../common/localizationService.js';

/** The startup NLS snapshot is shared by service consumers and direct NLS calls. */
export class WorkbenchLocalizationService extends Disposable implements ILocalizationService {
	public readonly whenReady = Promise.resolve();

	public translate(bundle: string, key: string, original: string, parameters?: LocalizationParameters): string {
		return formatNlsMessage(localize({ bundle, key }, original), parameters);
	}
}
