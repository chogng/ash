import type { IDisposable } from '../../../base/common/lifecycle.js';

/** A caller-owned result collection; dispose it after its actions are no longer in use. */
export interface ActionSet<T> extends IDisposable {
	readonly validActions: readonly T[];
	readonly allActions: readonly T[];
	readonly hasAutoFix: boolean;
	readonly hasAIFix: boolean;
	/** True when every valid action is AI-generated, including an empty valid set. */
	readonly allAIFixes: boolean;
}
