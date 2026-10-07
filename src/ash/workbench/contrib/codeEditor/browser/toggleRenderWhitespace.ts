import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { CodeEditorConfiguration } from '../common/editorConfiguration.js';

class ToggleRenderWhitespaceAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.toggleRenderWhitespace',
			title: localize2('toggleRenderWhitespace', 'Toggle Render Whitespace'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		const value = configuration.getValue(CodeEditorConfiguration.renderWhitespace);
		await configuration.updateValue(CodeEditorConfiguration.renderWhitespace, value === 'none' ? 'all' : 'none');
	}
}

registerAction2(ToggleRenderWhitespaceAction);
