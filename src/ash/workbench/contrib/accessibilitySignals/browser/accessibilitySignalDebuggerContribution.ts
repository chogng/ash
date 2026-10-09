import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IDebugService, type IDebugSession } from '../../../services/debug/common/debugService.js';

export class AccessibilitySignalDebuggerContribution extends Disposable {
	private readonly sessionListener = this._register(new MutableDisposable());
	private session: IDebugSession | undefined;

	constructor(@IDebugService debug: IDebugService, @IAccessibilitySignalService signals: IAccessibilitySignalService) {
		super();
		const attach = (session: IDebugSession | undefined): void => {
			if (this.session === session) { return; }
			this.session = session;
			this.sessionListener.clear();
			if (!session) { return; }
			// Re-selecting a paused session is quiet; only a live transition emits a cue.
			this.sessionListener.value = session.onDidChangeState(state => {
				if (state === 'stopped') { void signals.playSignal(AccessibilitySignal.onDebugBreak); }
			});
		};
		this._register(debug.onDidChangeSession(attach));
		attach(debug.session);
	}
}
