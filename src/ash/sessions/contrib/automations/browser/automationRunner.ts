import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IAutomationDescriptor } from '../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import type {
	IAutomationRunner,
	IAutomationRunOperation,
	IAutomationRunDispatch,
} from '../../../../workbench/contrib/chat/common/automations/automationRunner.js';

/** Manual dispatch and observation only. Session creation and scheduling remain host operations. */
export class AutomationRunner implements IAutomationRunner {
	constructor(
		@IAutomationService private readonly automations: IAutomationService,
		@INotificationService private readonly notifications: INotificationService,
	) {}

	runOnce(automation: IAutomationDescriptor, token = CancellationToken.None): IAutomationRunOperation {
		const dispatched = new DeferredPromise<IAutomationRunDispatch>();
		let admitted = false;
		const whenCompleted = (async () => {
			try {
				if (token.isCancellationRequested) {
					await dispatched.complete({ kind: 'notStarted', reason: 'cancelled' });
					return;
				}
				if (!this.automations.getAutomation(automation.id)) {
					await dispatched.complete({ kind: 'notStarted', reason: 'deleted' });
					return;
				}
				if (!this.automations.canRunAutomation(automation.id)) {
					await dispatched.complete({ kind: 'notStarted', reason: 'targetUnavailable' });
					return;
				}
				const result = await this.automations.runAutomation(automation.id, token);
				admitted = true;
				await dispatched.complete(
					result.run.sessionResource
						? { kind: 'started', run: result.run, sessionResource: result.run.sessionResource }
						: result.run.status === 'failed'
							? { kind: 'notStarted', reason: 'error' }
							: { kind: 'accepted' },
				);
				let cancellationForwarded = false;
				const cancel = (): void => {
					if (!cancellationForwarded) {
						cancellationForwarded = true;
						result.cancel();
					}
				};
				const listener = token.onCancellationRequested(cancel);
				try {
					if (token.isCancellationRequested) cancel();
					await result.whenCompleted;
					// The catalogue contribution owns terminal-state notifications for both manual and scheduled runs.
				} finally {
					listener.dispose();
				}
			} catch (error) {
				if (!admitted)
					await dispatched.complete({
						kind: 'notStarted',
						reason: token.isCancellationRequested ? 'cancelled' : 'error',
					});
				if (!token.isCancellationRequested)
					this.notifications.error(
						localize(
							'automations.runFailed',
							'Automation {0}: {1}',
							automation.name,
							error instanceof Error ? error.message : String(error),
						),
					);
			}
		})();
		return { whenDispatched: dispatched.p, whenCompleted };
	}
}
