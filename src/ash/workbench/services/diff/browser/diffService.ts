import { IDiffProviderFactoryService } from '../../../../editor/browser/widget/diffEditor/diffProviderFactoryService.js';
import { type IDiffService } from '../common/diffService.js';

/** Creates frontend computations for editor comparisons and dirty-buffer Quick Diff. */
export class DiffService implements IDiffService {
	constructor(@IDiffProviderFactoryService private readonly factory: IDiffProviderFactoryService) {}

	public createComputationService(): ReturnType<IDiffService['createComputationService']> {
		return this.factory.createDiffProvider();
	}
}
