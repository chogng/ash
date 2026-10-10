import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type IMultiDiffEditorWidgetOptions } from './multiDiffEditorOptions.js';
import { MultiDiffEditorWidgetImpl } from './multiDiffEditorWidgetImpl.js';

/** Public entry point for the multi-file diff editor. */
export class MultiDiffEditorWidget extends MultiDiffEditorWidgetImpl {
	constructor(
		options: IMultiDiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(options, instantiationService, logService, configurationService);
	}
}
