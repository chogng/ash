import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { type ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { type LanguageCodeAction } from '../../../common/languages.js';
import { CodeActionKind } from '../common/types.js';

const commandKinds = new Map([
	['editor.action.codeAction', HierarchicalKind.Empty],
	['editor.action.refactor', CodeActionKind.Refactor],
	['editor.action.sourceAction', CodeActionKind.Source],
	['editor.action.organizeImports', CodeActionKind.SourceOrganizeImports],
	['editor.action.fixAll', CodeActionKind.SourceFixAll],
]);

/** Chooses the most specific matching action shortcut; later rules win equal specificity. */
export class CodeActionKeybindingResolver {
	constructor(@IKeybindingService private readonly keybindings: IKeybindingService) { }

	public getResolver(): (action: LanguageCodeAction) => ResolvedKeybinding | undefined {
		const bindings = this.keybindings.getKeybindings().flatMap(binding => {
			const defaultKind = binding.command ? commandKinds.get(binding.command) : undefined;
			if (!defaultKind || !binding.resolvedKeybinding) { return []; }
			const args = binding.commandArgs as { kind?: unknown; preferred?: unknown; } | undefined;
			return [{
				kind: typeof args?.kind === 'string' ? new HierarchicalKind(args.kind) : defaultKind,
				preferred: args?.preferred === true,
				keybinding: binding.resolvedKeybinding,
			}];
		});
		return action => {
			let selected: ResolvedKeybinding | undefined;
			let specificity = -1;
			const kind = new HierarchicalKind(action.kind ?? '');
			for (const binding of bindings) {
				if (!binding.kind.contains(kind) || (binding.preferred && !action.isPreferred)) { continue; }
				const score = binding.kind.value.length * 2 + Number(binding.preferred);
				if (score >= specificity) { selected = binding.keybinding; specificity = score; }
			}
			return selected;
		};
	}
}
