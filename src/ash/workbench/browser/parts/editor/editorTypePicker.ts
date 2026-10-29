import type { IEditorPaneDescriptor } from '../../editor.js';
import type { IAction } from '../../../../base/common/actions.js';

/** Both title entry points operate on the input and group captured when their menu opens. */
export function createEditorTypeActions(
	choices: readonly IEditorPaneDescriptor[],
	currentId: string,
	select: (id: string) => Promise<unknown>,
): readonly IAction[] {
	return choices.map(choice => ({
		id: choice.id,
		label: choice.name,
		tooltip: choice.name,
		enabled: true,
		checked: choice.id === currentId,
		run: () => select(choice.id),
	}));
}
