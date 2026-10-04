import { Disposable, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IDebugService } from '../../../services/debug/common/debugService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';

/** Signals a paused active session in window titles while the application is unfocused. */
export class DebugTitleContribution extends Disposable implements IWorkbenchContribution {
	private readonly sessionListener = this._register(new MutableDisposable<IDisposable>());

	constructor(
		@IDebugService private readonly debugService: IDebugService,
		@IHostService private readonly hostService: IHostService,
		@ITitleService private readonly titleService: ITitleService,
	) {
		super();
		this._register(debugService.onDidChangeSession(() => this.bindSession()));
		this._register(hostService.onDidChangeFocus(() => this.updateTitle()));
		this.bindSession();
	}

	private bindSession(): void {
		this.sessionListener.value = this.debugService.session?.onDidChangeState(() => this.updateTitle());
		this.updateTitle();
	}

	private updateTitle(): void {
		this.titleService.updateProperties({
			prefix: this.debugService.session?.state === 'stopped' && !this.hostService.hasFocus ? '🔴' : '',
		});
	}
}
