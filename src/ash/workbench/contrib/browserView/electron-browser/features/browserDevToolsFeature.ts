import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IBrowserViewService } from '../../../../../platform/browserView/common/browserView.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { BrowserEditorInput } from '../../common/browserEditorInput.js';

registerAction2(
	class ToggleDevToolsAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.browser.toggleDevTools',
				title: localize2(
					{ bundle: 'ash.workbench', key: 'browser.devTools' },
					'Browser: Toggle Developer Tools',
				),
				f1: true,
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (input instanceof BrowserEditorInput) {
				await accessor.get(IBrowserViewService).toggleDevTools(input.id);
			}
		}
	},
);
