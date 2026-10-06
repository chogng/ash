import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { isLanguageFeatureRequestCurrent, type LanguageCodeActionProvider, type LanguageCodeActionRequest } from '../../../common/languages.js';
import { CodeActionItem, CodeActionKind, filtersAction, type CodeActionFilter, type CodeActionSet } from '../common/types.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';

export async function getCodeActions(
	registry: LanguageFeatureRegistry<LanguageCodeActionProvider>,
	request: LanguageCodeActionRequest,
	filter: CodeActionFilter,
	onError: (error: unknown) => void,

): Promise<CodeActionSet> {
	const actions: CodeActionItem[] = [];
	for (const provider of registry.ordered(request.model)) {
		if (!isLanguageFeatureRequestCurrent(request)) { break; }
		try {
			const provided = await provider.provideCodeActions(request, request.signal);
			if (!isLanguageFeatureRequestCurrent(request)) { break; }
			for (const original of provided) {
				const item = new CodeActionItem(original, provider);
				if (request.only && !request.only.some(kind => item.action.kind === kind || item.action.kind?.startsWith(kind + '.'))) { continue; }
				if (filtersAction(filter, item.action)) { actions.push(item); }
			}
		} catch (error) {
			if (isLanguageFeatureRequestCurrent(request)) { onError(error); }
		}
	}
	if (!isLanguageFeatureRequestCurrent(request)) { actions.length = 0; }
	const validActions = actions.filter(item => item.action.disabledReason === undefined);
	return Object.freeze({
		allActions: Object.freeze(actions),
		validActions: Object.freeze(validActions),
		hasAutoFix: validActions.some(item => CodeActionKind.QuickFix.contains(new HierarchicalKind(item.action.kind ?? '')) && item.action.isPreferred),
	});
}
