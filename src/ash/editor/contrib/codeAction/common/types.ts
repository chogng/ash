import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { CodeActionTriggerType, normalizeLanguageWorkspaceEdit, type LanguageCodeAction, type LanguageCodeActionProvider, type LanguageCodeActionRequest, } from '../../../common/languages.js';
import { localize } from '../../../../nls.js';

export const CodeActionKind = Object.freeze({
	QuickFix: new HierarchicalKind('quickfix'),
	Refactor: new HierarchicalKind('refactor'),
	RefactorExtract: new HierarchicalKind('refactor.extract'),
	RefactorInline: new HierarchicalKind('refactor.inline'),
	RefactorMove: new HierarchicalKind('refactor.move'),
	RefactorRewrite: new HierarchicalKind('refactor.rewrite'),
	Source: new HierarchicalKind('source'),
	SourceOrganizeImports: new HierarchicalKind('source.organizeImports'),
	SourceFixAll: new HierarchicalKind('source.fixAll'),
});

export enum CodeActionAutoApply {
	IfSingle = 'ifSingle',
	First = 'first',
	Never = 'never',
}
export enum CodeActionTriggerSource {
	Default = 'other (default)',
	QuickFix = 'quick fix action',
	Lightbulb = 'lightbulb',
	Refactor = 'refactor',
	SourceAction = 'source action',
	OrganizeImports = 'organize imports',
	FixAll = 'fix all',
}
export interface CodeActionFilter {
	readonly include?: HierarchicalKind;
	readonly excludes?: readonly HierarchicalKind[];
	readonly onlyIncludePreferredActions?: boolean;
	readonly includeSourceActions?: boolean;
}
export interface CodeActionTrigger {
	readonly type: CodeActionTriggerType;
	readonly triggerAction: CodeActionTriggerSource;
	readonly filter?: CodeActionFilter;
	readonly autoApply?: CodeActionAutoApply;
}

export class CodeActionCommandArgs {
	constructor(public readonly kind: HierarchicalKind, public readonly apply: CodeActionAutoApply, public readonly preferred: boolean) { }

	public static fromUser(arg: unknown, defaults: { kind: HierarchicalKind; apply: CodeActionAutoApply }): CodeActionCommandArgs {
		const values = arg === undefined ? {} : arg;
		if (!values || typeof values !== 'object') { throw new TypeError(localize('codeAction.invalidArguments', 'Code action arguments must be an object.')); }
		const options = values as { kind?: unknown; apply?: unknown; preferred?: unknown };
		if (options.kind !== undefined && typeof options.kind !== 'string') { throw new TypeError(localize('codeAction.invalidKind', 'Code action kind must be a string.')); }
		if (options.preferred !== undefined && typeof options.preferred !== 'boolean') { throw new TypeError(localize('codeAction.invalidPreferred', 'Code action preferred must be a boolean.')); }
		if (options.apply !== undefined && !Object.values(CodeActionAutoApply).includes(options.apply as CodeActionAutoApply)) {
			throw new TypeError(localize('codeAction.invalidApply', 'Code action apply must be first, ifSingle or never.'));
		}
		return new CodeActionCommandArgs(typeof options.kind === 'string' ? new HierarchicalKind(options.kind) : defaults.kind,
			(options.apply ?? defaults.apply) as CodeActionAutoApply, options.preferred === true);
	}
}

export function filtersAction(filter: CodeActionFilter, action: LanguageCodeAction): boolean {
	const kind = new HierarchicalKind(action.kind ?? '');
	if (filter.include && !filter.include.contains(kind)) { return false; }
	if (filter.excludes?.some(excluded => excluded.contains(kind) && !excluded.contains(filter.include ?? HierarchicalKind.None))) { return false; }
	if (filter.onlyIncludePreferredActions && !action.isPreferred) { return false; }
	return filter.includeSourceActions !== false || !CodeActionKind.Source.contains(kind);
}

/** Keeps the original object for its provider; the menu only reads validated immutable values. */
export class CodeActionItem {
	public action: LanguageCodeAction;
	private resolved: Promise<this> | undefined;

	constructor(private readonly original: LanguageCodeAction, public readonly provider: LanguageCodeActionProvider) {
		this.action = normalizeAction(original);
	}

	public async resolve(request: LanguageCodeActionRequest): Promise<this> {
		if (this.action.edit || !this.provider.resolveCodeAction) { return this; }
		if (!this.resolved) {
			this.resolved = Promise.resolve(this.provider.resolveCodeAction(this.original, request, request.signal))
				.then(action => { this.action = normalizeAction(action); return this; })
				.catch(error => { this.resolved = undefined; throw error; });
		}
		return this.resolved;
	}
}

export interface CodeActionSet {
	readonly allActions: readonly CodeActionItem[];
	readonly validActions: readonly CodeActionItem[];
	readonly hasAutoFix: boolean;
}

function normalizeAction(action: LanguageCodeAction): LanguageCodeAction {
	if (!action || typeof action.title !== 'string' || action.title.trim().length === 0) {
		throw new TypeError('Code action title must be a non-empty string');
	}
	return Object.freeze({
		...action,
		...(action.edit ? { edit: normalizeLanguageWorkspaceEdit(action.edit) } : {}),
	});
}
