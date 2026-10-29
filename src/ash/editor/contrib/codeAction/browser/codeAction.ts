import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import {
	isLanguageFeatureRequestCurrent,
	type LanguageCodeActionProvider,
	type LanguageCodeActionRequest,
} from '../../../common/languages.js';
import {
	CodeActionItem,
	CodeActionKind,
	filtersAction,
	type CodeActionFilter,
	type CodeActionSet,
} from '../common/types.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { LanguageCodeAction, LanguageCodeActionList } from '../../../common/languages.js';

/** Owns provider lists and the cancellation subscription, including while queries are pending. */
class CodeActionResults extends Disposable implements CodeActionSet {
	public allActions: readonly CodeActionItem[] = [];
	public validActions: readonly CodeActionItem[] = [];

	constructor(signal: AbortSignal) {
		super();
		this._register(addDisposableListener(signal, 'abort', () => this.dispose(), { once: true }));
		if (signal.aborted) {
			this.dispose();
		}
	}

	public retain(resource: IDisposable): void {
		if (this.isDisposed) {
			resource.dispose();
		} else {
			this._register(resource);
		}
	}

	public get hasAutoFix(): boolean {
		return this.validActions.some(
			item =>
				CodeActionKind.QuickFix.contains(new HierarchicalKind(item.action.kind ?? '')) &&
				item.action.isPreferred === true,
		);
	}

	public get hasAIFix(): boolean {
		return this.validActions.some(item => item.action.isAI === true);
	}

	public get allAIFixes(): boolean {
		return this.validActions.every(item => item.action.isAI === true);
	}
}

export async function getCodeActions(
	registry: Pick<LanguageFeatureRegistry<LanguageCodeActionProvider>, 'ordered'>,
	request: LanguageCodeActionRequest,
	filter: CodeActionFilter,
	onError: (error: unknown) => void,
): Promise<CodeActionSet> {
	const actions: CodeActionItem[] = [];
	const result = new CodeActionResults(request.signal);
	try {
		for (const provider of registry.ordered(request.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) {
				break;
			}
			let list: LanguageCodeActionList | undefined;
			try {
				const provided: unknown = await provider.provideCodeActions(request, request.signal);
				let entries: readonly LanguageCodeAction[];
				if (Array.isArray(provided)) {
					entries = provided;
				} else {
					if (
						!provided ||
						typeof provided !== 'object' ||
						!('dispose' in provided) ||
						typeof provided.dispose !== 'function' ||
						!(Symbol.dispose in provided) ||
						typeof provided[Symbol.dispose] !== 'function'
					) {
						throw new TypeError('Code action provider must return an array or a disposable action list');
					}
					list = provided as LanguageCodeActionList;
					if (!Array.isArray(list.actions)) {
						throw new TypeError('Code action provider list must contain an action array');
					}
					entries = list.actions;
				}
				if (!isLanguageFeatureRequestCurrent(request)) {
					break;
				}
				const accepted: CodeActionItem[] = [];
				for (const original of entries) {
					const item = new CodeActionItem(original, provider);
					if (
						request.only &&
						!request.only.some(
							kind => item.action.kind === kind || item.action.kind?.startsWith(kind + '.'),
						)
					) {
						continue;
					}
					if (filtersAction(filter, item.action)) {
						accepted.push(item);
					}
				}
				if (list) {
					result.retain(list);
					list = undefined;
				}
				actions.push(...accepted);
			} catch (error) {
				if (isLanguageFeatureRequestCurrent(request)) {
					onError(error);
				}
			} finally {
				// Failed validation and late provider replies never transfer ownership.
				list?.dispose();
			}
		}
		if (!isLanguageFeatureRequestCurrent(request)) {
			actions.length = 0;
			result.dispose();
		}
		result.allActions = Object.freeze(actions);
		result.validActions = Object.freeze(actions.filter(item => item.action.disabledReason === undefined));
		return result;
	} catch (error) {
		result.dispose();
		throw error;
	}
}
