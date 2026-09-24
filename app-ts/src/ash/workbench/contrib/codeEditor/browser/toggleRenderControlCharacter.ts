import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeEditorConfiguration } from '../common/editorConfiguration.js';

class ToggleRenderControlCharacterAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.toggleRenderControlCharacter',
			title: localize2('toggleRenderControlCharacters', 'Toggle Control Characters'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		await configuration.updateValue(CodeEditorConfiguration.renderControlCharacters, !configuration.getValue(CodeEditorConfiguration.renderControlCharacters));
	}
}

registerAction2(ToggleRenderControlCharacterAction);
