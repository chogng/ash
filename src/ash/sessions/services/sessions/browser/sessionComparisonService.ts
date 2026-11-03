import type { Event } from '../../../../base/common/event.js';
import { isRecord } from '../../../../base/common/types.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { Thread, Turn } from '../../../../workbench/services/chat/common/chatService.js';
import type { ComparisonThread, ComparisonVerdict, SessionComparison } from '../common/sessionComparison.js';

export const ISessionComparisonService = createServiceIdentifier<SessionComparisonService>('sessionComparisonService');

export class SessionComparisonService {
	private readonly running = new Set<string>();

	readonly onDidChange: Event<void>;

	constructor(@IStorageService private readonly storage: IStorageService) {
		this.onDidChange = listener => storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith(this.key(''))) listener();
		});
	}

	get(id: string): SessionComparison | undefined {
		try {
			const value: unknown = JSON.parse(this.storage.get(this.key(id), StorageScope.PROFILE) ?? 'null');
			if (!isRecord(value) || value.id !== id || typeof value.task !== 'string' || typeof value.isolated !== 'boolean'
				|| typeof value.providerId !== 'string' || !Number.isSafeInteger(value.sourceSequence) || !isComparisonThread(value.source)
				|| !Array.isArray(value.attempts) || value.attempts.length < 2
				|| !value.attempts.every(attempt => isRecord(attempt) && isComparisonThread(attempt) && Number.isSafeInteger(attempt.number) && typeof attempt.agent === 'string' && isOptionalParticipantSettings(attempt.settings))
				|| !isOptionalAgent(value.judgeAgent) || !isOptionalAgent(value.synthesisAgent)
				|| !isOptionalParticipantSettings(value.judgeSettings) || !isOptionalParticipantSettings(value.synthesisSettings)
				|| (value.judgeFailed !== undefined && typeof value.judgeFailed !== 'boolean')
				|| (value.judge !== undefined && !isComparisonThread(value.judge))
				|| (value.synthesis !== undefined && !isComparisonThread(value.synthesis))
				|| (value.verdict !== undefined && !isVerdict(value.verdict, value.attempts.map(attempt => attempt.number)))) return undefined;
			return value as unknown as SessionComparison;
		} catch {
			return undefined;
		}
	}

	async save(comparison: SessionComparison): Promise<void> {
		this.storage.store(this.key(comparison.id), JSON.stringify(comparison), StorageScope.PROFILE, StorageTarget.MACHINE);
		await this.storage.flush();
	}

	readSynthesisDraft(id: string): { readonly choices: readonly (number | null)[]; readonly instructions: string; } {
		try {
			const value: unknown = JSON.parse(this.storage.get(`sessions.comparisonDraft.${id}`, StorageScope.PROFILE) ?? 'null');
			if (isRecord(value) && Array.isArray(value.choices) && value.choices.length <= 6
				&& value.choices.every(choice => choice === null || Number.isSafeInteger(choice))
				&& typeof value.instructions === 'string' && value.instructions.length <= 8000) {
				return { choices: value.choices, instructions: value.instructions };
			}
		} catch { /* A damaged draft does not prevent opening the comparison. */ }
		return { choices: [], instructions: '' };
	}

	saveSynthesisDraft(id: string, draft: ReturnType<SessionComparisonService['readSynthesisDraft']>): void {
		this.storage.store(`sessions.comparisonDraft.${id}`, JSON.stringify(draft), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	async runExclusive(id: string, run: (comparison: SessionComparison) => Promise<void>): Promise<void> {
		if (this.running.has(id)) return;
		this.running.add(id);
		const readAndRun = async (): Promise<void> => {
			const comparison = this.get(id);
			if (comparison) await run(comparison);
		};
		try {
			const locks = globalThis.navigator?.locks;
			if (locks) {
				await locks.request(this.key(id), { ifAvailable: true }, lock => lock ? readAndRun() : undefined);
			} else {
				await readAndRun();
			}
		} finally {
			this.running.delete(id);
		}
	}

	private key(id: string): string {
		return `sessions.comparison.${id}`;
	}
}

function isOptionalAgent(value: unknown): boolean {
	return value === undefined || isRecord(value) && typeof value.name === 'string'
		&& typeof value.sourceId === 'string' && typeof value.description === 'string';
}

function isOptionalParticipantSettings(value: unknown): boolean {
	return value === undefined || isRecord(value)
		&& (value.model === undefined || isRecord(value.model) && typeof value.model.provider === 'string' && typeof value.model.model === 'string')
		&& (value.reasoningEffort === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'extraHigh', 'max'].some(effort => effort === value.reasoningEffort))
		&& (value.approvalMode === undefined || value.approvalMode === 'auto' || value.approvalMode === 'manual');
}

function isComparisonThread(value: unknown): value is ComparisonThread {
	return isRecord(value) && typeof value.sessionId === 'string' && typeof value.threadId === 'string'
		&& (value.afterTurn === undefined || typeof value.afterTurn === 'string');
}

export function comparisonTurn(thread: Thread, reference: ComparisonThread, prompt: string): Turn | undefined {
	const previous = reference.afterTurn === undefined ? -1 : thread.turns.findIndex(turn => turn.turnId === reference.afterTurn);
	if (reference.afterTurn !== undefined && previous === -1) return undefined;
	const turn = thread.turns[previous + 1];
	return turn?.items.some(item => item.type === 'userMessage' && item.text === prompt) ? turn : undefined;
}

export function parseComparisonVerdict(reply: string, attempts: readonly number[]): ComparisonVerdict | undefined {
	if (reply.length > 16000) return undefined;
	try {
		const value: unknown = JSON.parse(reply.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/iu, '$1'));
		if (isVerdict(value, attempts)) return value;
	} catch { /* Invalid model output can be retried. */ }
	return undefined;
}

function isVerdict(value: unknown, attempts: readonly number[]): value is ComparisonVerdict {
	return isRecord(value) && typeof value.winner === 'number' && attempts.includes(value.winner)
		&& [value.comparison, value.validation, value.quality, value.solution].every(field => typeof field === 'string' && field.trim().length > 0 && field.length <= 1000)
		&& (value.decisions === undefined || (Array.isArray(value.decisions) && value.decisions.length > 0 && value.decisions.length <= 6
			&& value.decisions.every(decision => isRecord(decision) && typeof decision.topic === 'string' && decision.topic.trim().length > 0 && decision.topic.length <= 160
				&& typeof decision.recommended === 'number' && Array.isArray(decision.options) && decision.options.length > 0
				&& decision.options.length <= attempts.length && decision.options.every(option => isRecord(option) && typeof option.attempt === 'number'
					&& attempts.includes(option.attempt) && typeof option.assessment === 'string' && option.assessment.trim().length > 0 && option.assessment.length <= 200)
				&& new Set(decision.options.map(option => option.attempt)).size === decision.options.length
				&& decision.options.some(option => option.attempt === decision.recommended))));
}
