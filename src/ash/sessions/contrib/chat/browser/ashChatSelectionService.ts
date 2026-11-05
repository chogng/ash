import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { isNonEmptyString, isRecord } from '../../../../base/common/types.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { isModelReasoningEffort, type ModelReasoningEffort, type ModelRef } from '../../../../platform/models/common/agentModels.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

type AshChatSelection = (
	| { readonly kind: 'draft'; readonly id: string; }
	| { readonly kind: 'thread'; readonly sessionId: string; readonly threadId: string; }
) & { readonly model?: ModelRef; readonly effort?: ModelReasoningEffort; };

export interface IAshChatSelectionService {
	readonly selection: IObservable<AshChatSelection>;
	select(selection: AshChatSelection): void;
}

export const IAshChatSelectionService = createServiceIdentifier<IAshChatSelectionService>('ashChatSelectionService');

const selectionKey = 'sessions.chat.ashSelection';

export class AshChatSelectionService implements IAshChatSelectionService {
	private readonly current;
	readonly selection: IObservable<AshChatSelection>;

	constructor(@IStorageService private readonly storage: IStorageService) {
		this.current = observableValue<AshChatSelection>(this, this.restore() ?? { kind: 'draft', id: createUuid() });
		this.selection = this.current;
	}

	select(selection: AshChatSelection): void {
		this.storage.store(selectionKey, JSON.stringify(selection), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.current.set(selection);
	}

	private restore(): AshChatSelection | undefined {
		let value: unknown;
		try { value = JSON.parse(this.storage.get(selectionKey, StorageScope.WORKSPACE) ?? 'null'); }
		catch { return undefined; }
		if (!isRecord(value)) return undefined;
		const model = isRecord(value.model) && isNonEmptyString(value.model.provider) && isNonEmptyString(value.model.model)
			? { provider: value.model.provider, model: value.model.model }
			: undefined;
		const effort = model && isModelReasoningEffort(value.effort) ? value.effort : undefined;
		const preferences = { ...(model && { model }), ...(effort && { effort }) };
		if (value.kind === 'draft' && isNonEmptyString(value.id)) return { kind: 'draft', id: value.id, ...preferences };
		if (value.kind === 'thread' && isNonEmptyString(value.sessionId) && isNonEmptyString(value.threadId)) {
			return { kind: 'thread', sessionId: value.sessionId, threadId: value.threadId, ...preferences };
		}
		return undefined;
	}
}
