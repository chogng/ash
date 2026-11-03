import { captureAnimationTarget, triggerConfettiAnimation } from '../../../../base/browser/ui/animations/animations.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';

/** Retains the row's geometry before archive removes it from the list. */
export class SessionActionFeedback extends Disposable {
	private readonly animation = this._register(new MutableDisposable());

	async archive(row: HTMLElement, run: () => unknown): Promise<unknown> {
		const target = captureAnimationTarget(row);
		const archived = await run();
		if (archived === true && !this.isDisposed) {
			this.animation.value = triggerConfettiAnimation(target);
		}
		return archived;
	}
}
