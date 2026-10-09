import { RunOnceScheduler } from '../../../base/common/async.js';
import { Disposable, MutableDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from './accessibilitySignalService.js';

/** Delays progress feedback and owns its loop until the operation ends. */
export class AccessibilityProgressSignalScheduler extends Disposable {
	constructor(msDelayTime: number, msLoopTime: number | undefined, @IAccessibilitySignalService accessibilitySignalService: IAccessibilitySignalService) {
		super();
		const loopTime = msLoopTime ?? 5000;
		if (!Number.isFinite(loopTime) || loopTime <= 0) { throw new TypeError('Signal loop interval must be positive.'); }
		const loop = this._register(new MutableDisposable<IDisposable>());
		const delay = this._register(new RunOnceScheduler(() => {
			loop.value = accessibilitySignalService.playSignalLoop(AccessibilitySignal.progress, loopTime);
		}, msDelayTime));
		delay.schedule();
	}
}
