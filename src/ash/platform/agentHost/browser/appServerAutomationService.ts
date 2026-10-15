import { AppServerRemoteError } from '../common/appServerError.js';
import { APP_SERVER_METHODS } from '../../../../../.build/protocol/typescript/index.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import type { Automation, AutomationDefinition, AutomationRun, AutomationRunResult, AutomationSchedule, AutomationStatus, IAutomationBackendService } from '../common/automation.js';

export class AppServerAutomationService extends Disposable implements IAutomationBackendService {
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

	public async preview(schedule: AutomationSchedule): Promise<readonly number[]> {
		const value = schedule.type === 'weekly' ? { ...schedule, weekdays: [...schedule.weekdays] } : schedule;
		return (await this.client.request(APP_SERVER_METHODS['automation/preview'], { schedule: value }).catch(explain)).occurrences;
	}

	public async readResult(run: AutomationRun): Promise<AutomationRunResult> {
		if (!run.sessionId || !run.threadId || !run.turnId) return { output: '', files: [] };
		const source = { sessionId: run.sessionId, threadId: run.threadId };
		const result = await this.client.request(APP_SERVER_METHODS['session/thread/read'], source);
		const turn = result.thread.turns.find(turn => turn.turnId === run.turnId);
		const output = turn?.items.flatMap(item => item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null) ? [item.text] : []).join('\n\n') ?? '';
		// A continued conversation may contain many runs. Never attribute another Turn's output or files to this run.
		let files: AutomationRunResult['files'];
		try {
			const changes = await this.client.request(APP_SERVER_METHODS['turnChanges/list'], source);
			const collected: NonNullable<AutomationRunResult['files']>[number][] = [];
			for (const change of changes.changeSets.filter(change => change.turnId === run.turnId)) {
				const details = await this.client.request(APP_SERVER_METHODS['turnChanges/read'], { ...source, changeSetId: change.changeSetId });
				collected.push(...details.files.map(file => ({ path: file.path, kind: file.kind, additions: file.additions, deletions: file.deletions })));
			}
			files = collected;
		} catch {
			// Keep the Agent's result readable when its separate file-change ledger is unavailable.
			files = undefined;
		}
		return { output, files };
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
