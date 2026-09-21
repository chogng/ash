import { Disposable } from "../../../../base/common/lifecycle.js";
import { type Range } from "../../../common/core/range.js";
import { type LanguageDiagnostic, createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageFeatureRequest, normalizeLanguageWorkspaceEdit, type LanguageWorkspaceEdit } from '../../../common/languages.js';
import { LanguageFeatureRegistry } from "../../../common/languageFeatureRegistry.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { type URI } from "../../../../base/common/uri.js";

export type { LanguageWorkspaceEdit } from "../../../common/languages.js";

export interface LanguageCodeAction {
	readonly title: string;
	readonly kind?: string;
	readonly isPreferred?: boolean;
	readonly disabledReason?: string;
	readonly edit?: LanguageWorkspaceEdit;
	readonly data?: unknown;
}

export interface LanguageCodeActionRequest extends LanguageFeatureRequest {
	readonly resource: URI;
	readonly range: Range;
	readonly diagnostics: readonly LanguageDiagnostic[];
	readonly only?: readonly string[];
}

export interface LanguageCodeActionProvider {
	provideCodeActions(request: LanguageCodeActionRequest, signal: AbortSignal): readonly LanguageCodeAction[] | Promise<readonly LanguageCodeAction[]>;
	resolveCodeAction?(action: LanguageCodeAction, request: LanguageCodeActionRequest, signal: AbortSignal): LanguageCodeAction | Promise<LanguageCodeAction>;
}

/** Collects code actions and keeps edit application in the editor command layer. */
export class CodeActionService extends Disposable {
	private readonly actionOwners = new WeakMap<LanguageCodeAction, { readonly provider: LanguageCodeActionProvider; readonly action: LanguageCodeAction }>();

	constructor(private readonly model: TextModel, private readonly resource: URI, private readonly providers: LanguageFeatureRegistry<LanguageCodeActionProvider>) {
		super();
	}

	async provideCodeActions(languageId: string, range: Range, diagnostics: readonly LanguageDiagnostic[] = [], only?: readonly string[], signal: AbortSignal = new AbortController().signal): Promise<readonly LanguageCodeAction[]> {
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), resource: this.resource, range, diagnostics, ...(only ? { only } : {}) };
		const result: LanguageCodeAction[] = [];
		for (const provider of this.providers.ordered(this.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			const actions = await provider.provideCodeActions(request, signal);
			if (!isLanguageFeatureRequestCurrent(request)) return Object.freeze([]);
			for (const action of actions) {
				const normalized = normalizeLanguageCodeAction(action);
				this.actionOwners.set(normalized, { provider, action });
				result.push(normalized);
			}
		}
		return Object.freeze(result);
	}

	async resolveCodeAction(languageId: string, range: Range, action: LanguageCodeAction, diagnostics: readonly LanguageDiagnostic[] = [], signal: AbortSignal = new AbortController().signal): Promise<LanguageCodeAction> {
		const owner = this.actionOwners.get(action);
		if (!owner?.provider.resolveCodeAction) {
			return action;
		}
		const request = { ...createLanguageFeatureRequest(this.model, languageId, signal), resource: this.resource, range, diagnostics };
		const resolved = await owner.provider.resolveCodeAction(owner.action, request, signal);
		if (!isLanguageFeatureRequestCurrent(request)) throw new Error("Code action result became stale");
		const normalized = normalizeLanguageCodeAction(resolved);
		this.actionOwners.set(normalized, { provider: owner.provider, action: resolved });
		return normalized;
	}
}

function normalizeLanguageCodeAction(action: LanguageCodeAction): LanguageCodeAction {
	if (!action || typeof action !== "object" || typeof action.title !== "string" || action.title.trim().length === 0) throw new TypeError("Code action title must be a non-empty string");
	return Object.freeze({
		title: action.title,
		...(action.kind !== undefined ? { kind: action.kind } : {}),
		...(action.isPreferred !== undefined ? { isPreferred: action.isPreferred } : {}),
		...(action.disabledReason !== undefined ? { disabledReason: action.disabledReason } : {}),
		...(action.edit ? { edit: normalizeLanguageWorkspaceEdit(action.edit) } : {}),
		...(action.data !== undefined ? { data: action.data } : {}),
	});
}
