import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { MultiDiffReviewPreviewContext, type IMultiDiffEditorWidgetOptions } from './multiDiffEditorOptions.js';
import { MultiDiffEditorWidgetImpl } from './multiDiffEditorWidgetImpl.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';

// The preview owns model-based Select All, including source lines outside its DOM window.
KeybindingsRegistry.registerKeybindingPassThrough({
	command: 'editor.action.selectAll', keybinding: Keybinding.single(logicalKey('a', { primaryKey: true })),
	when: MultiDiffReviewPreviewContext.isEqualTo(true), priority: KeybindingWeight.WorkbenchContrib + 10,
});

/** Public entry point for the multi-file diff editor. */
export class MultiDiffEditorWidget extends MultiDiffEditorWidgetImpl {
	constructor(
		options: IMultiDiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
	) {
		super(options, instantiationService, logService, configurationService, themeService);
	}
}
