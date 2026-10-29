import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID, AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID } from './aiCustomizationManagement.js';

/** One resource identity keeps Hooks management in a retained editor rather than in Settings. */
export class AICustomizationManagementEditorInput extends EditorInput {
	public readonly typeId = AI_CUSTOMIZATION_MANAGEMENT_EDITOR_INPUT_ID;
	public override readonly editorId = AI_CUSTOMIZATION_MANAGEMENT_EDITOR_ID;
	public readonly resource = URI.parse('ash-customizations:/hooks');
	public readonly onDidChangeLabel = undefined;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;

	public getName(): string { return localize('hooks.managementTitle', 'Agent Customizations: Hooks'); }
}
