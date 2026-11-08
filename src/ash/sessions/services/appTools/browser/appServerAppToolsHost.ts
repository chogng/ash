import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { AppServerProtocolClient } from '../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { APP_SERVER_SERVER_REQUESTS, type AppHostRequestParams } from '../../../../../../.build/protocol/typescript/index.js';
import type { IAppToolsHost } from './appTools.js';

/** Binds one renderer connection to its window-owned application capabilities. */
export class AppServerAppToolsHost extends Disposable {
	private readonly lifetime = new AbortController();

	constructor(client: AppServerProtocolClient, private readonly host: IAppToolsHost) {
		super();
		// Removing the handler prevents new calls; this also cancels calls already running in this window.
		this._register(toDisposable(() => this.lifetime.abort()));
		this._register(host);
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['app/request'], async (params, context) => {
			const signal = AbortSignal.any([context.signal, this.lifetime.signal]);
			throwIfCancelled(signal);
			const result = await this.execute(params, signal);
			throwIfCancelled(signal);
			return { json: JSON.stringify(result) };
		}));
		this._register(client.onStateChange(state => {
			if (state !== 'ready') {
				host.clearTransientState();
			}
		}));
	}

	private async execute({ operation, ...caller }: AppHostRequestParams, signal: AbortSignal): Promise<unknown> {
		switch (operation.type) {
			case 'getComparisonModels':
			case 'createModelComparison':
			case 'listModelComparisons':
			case 'readModelComparison':
				return this.host.modelEvaluation.execute(caller, operation, signal);
			case 'tasksList': return this.host.taskRunner.listTasks(operation.directory, signal);
			case 'tasksDescribe': return this.host.taskRunner.describeTask(operation.directory, operation.taskId, operation.revision, signal);
			case 'tasksRun': return this.host.taskRunner.runTask(operation.directory, operation.taskId, operation.revision, signal);
			case 'tasksStatus': return this.host.taskRunner.taskStatus(operation.directory, operation.runId);
			case 'tasksOutput': return this.host.taskRunner.taskOutput(operation.directory, operation.runId, operation.cursor, operation.maxCharacters);
			case 'tasksCancel': return this.host.taskRunner.cancelTask(operation.directory, operation.runId);
			case 'openFile':
				await this.host.openFile(URI.file(operation.path), operation.line ?? undefined);
				return { opened: true, path: operation.path };
			case 'openReview':
				await this.host.openReview(URI.file(operation.original), URI.file(operation.modified));
				return { opened: true };
			case 'openBrowser':
				return { opened: await this.host.openBrowser(URI.parse(operation.url)) };
			case 'openTerminal':
				return { opened: true, terminalId: await this.host.openTerminal(signal) };
			case 'navigate':
				await this.host.navigate(operation.sessionId, operation.threadId);
				return { opened: true };
			case 'listSections':
				return { sections: this.host.sessionsList.listSections(), tree: this.host.sessionsList.readTree() ?? null };
			case 'createSection':
				return this.host.sessionsList.createSection(operation.name, signal);
			case 'renameSection':
				await this.host.sessionsList.renameSection(operation.sectionId, operation.name, signal);
				return { sections: this.host.sessionsList.listSections() };
			case 'deleteSection':
				await this.host.sessionsList.deleteSection(operation.sectionId, signal);
				return { sections: this.host.sessionsList.listSections() };
			case 'moveSession':
				await this.host.sessionsList.moveSession(operation.sessionId, operation.sectionId, signal);
				return { sections: this.host.sessionsList.listSections() };
			case 'reorderSection':
				await this.host.sessionsList.reorderSection(operation.sectionId, operation.sessionIds, signal);
				return { sections: this.host.sessionsList.listSections() };
			case 'checkUpdate':
				return this.host.checkUpdate();
			case 'confetti':
				return { fired: this.host.fireConfetti() };
		}
	}
}
