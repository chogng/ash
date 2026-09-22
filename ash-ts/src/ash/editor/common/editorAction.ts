import { validateConstraints } from '../../base/common/types.js';
import type { ICommandMetadata } from '../../platform/commands/common/commands.js';
import type { ContextKeyExpression, IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import type { IEditorAction } from './editorCommon.js';

export class InternalEditorAction implements IEditorAction {
	constructor(
		public readonly id: string,
		public readonly label: string,
		public readonly alias: string,
		public readonly metadata: ICommandMetadata | undefined,
		private readonly precondition: ContextKeyExpression | undefined,
		private readonly execute: (args: unknown) => Promise<void>,
		private readonly context: IContextKeyService,
	) {}

	public isSupported(): boolean {
		return this.context.contextMatchesRules(this.precondition);
	}

	public async run(args?: unknown): Promise<void> {
		if (this.isSupported()) {
			if (this.metadata?.args) {
				validateConstraints(args === undefined ? [] : [args], this.metadata.args.map(argument => argument.constraint));
			}
			await this.execute(args);
		}
	}
}
