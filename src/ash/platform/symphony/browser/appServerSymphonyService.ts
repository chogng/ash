import { APP_SERVER_METHODS, type SymphonyConversation as ConversationDto, type SymphonySnapshot as SnapshotDto } from '../../../../../.build/protocol/typescript/index.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { AppServerRemoteError } from '../../agentHost/common/appServerError.js';
import type { ISymphonyBackend, SymphonyConversation, SymphonyControl, SymphonySnapshot } from '../common/symphonyService.js';

export class AppServerSymphonyService extends Disposable implements ISymphonyBackend {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	constructor(private readonly client: AppServerProtocolClient) {
		super();
		this._register(client.onStateChange(state => { if (state === 'ready') { this.changed.fire(); } }));
		this._register(client.onNotification(notification => { if (notification.method === 'symphony/changed') { this.changed.fire(); } }));
	}
	public async read(): Promise<SymphonySnapshot> { return snapshot(await this.client.request(APP_SERVER_METHODS['symphony/read'], {}).catch(explain)); }
	public async configure(path: string): Promise<SymphonySnapshot> { return snapshot(await this.client.request(APP_SERVER_METHODS['symphony/configure'], { path, commandId: generateUuid() }).catch(explain)); }
	public async submit(workflowId: string, title: string, prompt: string): Promise<SymphonyConversation> { return conversation(await this.client.request(APP_SERVER_METHODS['symphony/submit'], { workflowId, title, prompt, commandId: generateUuid() }).catch(explain)); }
	public async control(id: string, control: SymphonyControl): Promise<void> { await this.client.request(APP_SERVER_METHODS['symphony/control'], { id, control, commandId: generateUuid() }).catch(explain); }
	public async enable(workflowId: string, enabled: boolean): Promise<void> { await this.client.request(APP_SERVER_METHODS['symphony/enable'], { workflowId, enabled, commandId: generateUuid() }).catch(explain); }
	public async messages(id: string) {
		const result = await this.client.request(APP_SERVER_METHODS['symphony/messages'], { id }).catch(explain);
		return { conversation: conversation(result.conversation), messages: result.messages };
	}
}

function snapshot(value: SnapshotDto): SymphonySnapshot {
	return { workflows: value.workflows.map(workflow => ({ ...workflow, error: workflow.error ?? undefined })), conversations: value.conversations.map(conversation) };
}
function conversation(value: ConversationDto): SymphonyConversation {
	return {
		id: value.id, workflowId: value.workflowId, identifier: value.identifier, title: value.title, status: value.status,
		tokens: value.usage.inputTokens.reported + value.usage.outputTokens.reported, tokensComplete: value.usage.inputTokens.complete && value.usage.outputTokens.complete,
		durationMs: value.durationMs, error: value.error ?? undefined
	};
}
function explain(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		switch (error.errorName) {
			case 'SymphonyUnavailable': throw new Error(localize('symphony.backendUnavailable', 'This host does not support the built-in Symphony scheduler.'));
			case 'SymphonyNotFound': throw new Error(localize('symphony.notFound', 'This workflow or conversation no longer exists. Refresh Symphony.'));
			case 'SymphonyConflict': throw new Error(localize('symphony.conflict', 'This command conflicts with an earlier request. Refresh Symphony and try again.'));
			case 'SymphonyInvalid': throw new Error(localize('symphony.invalidWorkflow', 'Check the WORKFLOW.md path, tracker settings and template.'));
			case 'SymphonyOperationFailed': throw new Error(localize('symphony.storageFailure', 'Symphony could not save this change. Try again.'));
		}
	}
	throw error;
}
