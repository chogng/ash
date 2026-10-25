import { URI } from '../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../common/editor.js';

/** A stable resource identity lets editor groups reuse the models management pane. */
export class ModelsManagementEditorInput extends EditorInput {
	public static readonly ID = 'workbench.input.modelsManagement';
	public readonly typeId = ModelsManagementEditorInput.ID;
	public override readonly editorId = 'workbench.editor.modelsManagement';
	public readonly resource = URI.parse('ash-models:/management');
	public readonly onDidChangeLabel = undefined;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public readonly capabilities = EditorInputCapabilities.Singleton;

	public getIcon(): ThemeIcon { return Lxicon.settings; }

	public getName(): string {
		return localize('modelsManagementEditorInputName', 'Language Models');
	}
}
