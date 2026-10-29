import type { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import type { ContextKeyExpression } from '../../contextkey/common/contextkey.js';
import type { IUserFriendlyKeybinding } from './keybinding.js';

/** One shortcut and its origin, used by the resolver and the shortcuts editor. */
export class ResolvedKeybindingItem {
	constructor(
		public readonly resolvedKeybinding: ResolvedKeybinding | undefined,
		public readonly command: string | null,
		public readonly commandArgs: unknown,
		public readonly when: ContextKeyExpression | undefined,
		public readonly isDefault: boolean,
		public readonly extensionId: string | null,
		public readonly isBuiltinExtension: boolean,
		// Retain the exact rule identity so a stale editor row cannot edit a different rule.
		public readonly userBinding?: { readonly index: number; readonly entry: IUserFriendlyKeybinding; },
	) { }
}
