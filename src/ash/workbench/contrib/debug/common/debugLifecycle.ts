import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IDebugService } from './debug.js';

/** Participates in the existing shutdown veto; accepted shutdown still uses the usual owners. */
export class DebugLifecycle extends Disposable {
	constructor(
		@ILifecycleService lifecycle: ILifecycleService,
		@IDebugService debug: IDebugService,
		@IConfigurationService configuration: IConfigurationService,
		@IDialogService dialogs: IDialogService,
	) {
		super();
		this._register(
			lifecycle.onBeforeShutdown(event => {
				const roots = debug.sessions.filter(session => !session.parentSession && session.state !== 'terminated' && session.state !== 'error');
				if (!roots.length || configuration.getValue<string>('debug.confirmOnExit') !== 'always') return;
				event.veto(
					dialogs
						.confirm({
							message: localize('debug.confirmClose', 'Stop {0} active debug session(s) and close the window?', roots.length),
							primaryButton: localize('debug.stopAndClose', 'Stop Debugging and Close'),
							cancelButton: localize('debug.keepWindowOpen', 'Keep Window Open'),
						})
						.then(result => !result.confirmed),
					'veto.debug',
				);
			}),
		);
	}
}
