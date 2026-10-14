import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalCapability, type IPromptTypeDetectionCapability } from './capabilities.js';

/** Committed prompt identity; decoding and framework discovery belong to the execution host. */
export class PromptTypeDetectionCapability extends Disposable implements IPromptTypeDetectionCapability {
	readonly type = TerminalCapability.PromptTypeDetection;
	private value: string | undefined;
	private readonly changed = this._register(new Emitter<string | undefined>());
	readonly onPromptTypeChanged = this.changed.event;
	get promptType(): string | undefined { return this.value; }

	setPromptType(value: string): void {
		if (this.isDisposed) return;
		this.value = value;
		this.changed.fire(value);
	}
}
