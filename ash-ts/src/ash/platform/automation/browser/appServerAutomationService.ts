import { AppServerRemoteError } from '../../app-server/common/appServerError.js';
import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import type { Automation, AutomationDefinition, AutomationRun, AutomationStatus, IAutomationService } from '../common/automationService.js';

export class AppServerAutomationService extends Disposable implements IAutomationService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;

	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onStateChange(state => { if (state === 'ready') { this.changed.fire(); } }));
		this._register(client.onNotification(notification => {
			if (notification.method === 'automation/changed') { this.changed.fire(); }
		}));
	}

	public async list(): Promise<readonly Automation[]> {
		return (await this.client.request(APP_SERVER_METHODS['automation/list'], {}).catch(explain)).automations;
	}

	public save(id: string, revision: number, definition: AutomationDefinition, status: AutomationStatus): Promise<Automation> {
		const schedule = definition.schedule.type === 'weekly' ? { ...definition.schedule, weekdays: [...definition.schedule.weekdays] } : definition.schedule;
		return this.client.request(APP_SERVER_METHODS['automation/write'], { id, expectedRevision: revision, commandId: generateUuid(), definition: { ...definition, schedule }, status }).catch(explain);
	}

	public async delete(id: string, revision: number): Promise<void> {
		await this.client.request(APP_SERVER_METHODS['automation/delete'], { id, expectedRevision: revision }).catch(explain);
	}

	public run(id: string): Promise<AutomationRun> {
		return this.client.request(APP_SERVER_METHODS['automation/run'], { id, commandId: generateUuid() }).catch(explain);
	}

	public async runs(id: string): Promise<readonly AutomationRun[]> {
		return (await this.client.request(APP_SERVER_METHODS['automation/runs'], { id, limit: 50 }).catch(explain)).runs;
	}

	public stop(runId: string): Promise<AutomationRun> {
		return this.client.request(APP_SERVER_METHODS['automation/stop'], { runId }).catch(explain);
	}
}

function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'AutomationConflict': throw new Error('This automation changed in another window. Select it again to load the latest version.');
			case 'AutomationBusy': throw new Error('This automation still has an unfinished run. Stop it or wait for it to finish.');
			case 'AutomationNotFound': throw new Error('This automation no longer exists. Refresh the list.');
			case 'AutomationUnavailable': throw new Error('Automations are unavailable on this backend.');
			case 'InvalidParams': throw new Error('Check the instructions, execution directory and schedule.');
		}
	}
	throw error;
}
