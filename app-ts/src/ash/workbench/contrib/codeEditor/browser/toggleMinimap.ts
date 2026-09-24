import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorMinimapConfiguration } from '../../../../editor/common/config/editorConfigurationSchema.js';

class ToggleMinimapAction extends Action2 {
	constructor() {
		super({
			id: 'editor.action.toggleMinimap',
			title: localize2('toggleMinimap', 'Toggle Minimap'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		await configuration.updateValue(EditorMinimapConfiguration.enabled, !configuration.getValue(EditorMinimapConfiguration.enabled));
	}
}

registerAction2(ToggleMinimapAction);
