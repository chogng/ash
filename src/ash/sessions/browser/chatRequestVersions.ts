import { equals } from '../../base/common/objects.js';
import { getAcceptedChatRequest, type IChatService, type Thread } from '../../workbench/services/chat/common/chatService.js';
import type { ISession } from '../services/sessions/common/session.js';
import { readComparableTurnChanges, type TurnCaptureTarget } from './turnMultiDiffSource.js';

export interface ChatRequestVersionPair {
	readonly original: TurnCaptureTarget;
	readonly alternate: TurnCaptureTarget;
}

/** Match completed results through the durable rewind boundary and the accepted submission. */
export async function readChatRequestVersions(chat: IChatService, session: ISession, threadId: string): Promise<readonly ChatRequestVersionPair[]> {
	const sessionId = session.sessionId;
	const active = session.chats.find(candidate => candidate.threadId === threadId);
	const parentId = active?.origin.type === 'fork' || active?.origin.type === 'rewind' ? active.origin.parentThreadId : undefined;
	const children = session.chats.filter(candidate => (candidate.origin.type === 'fork' || candidate.origin.type === 'rewind') && candidate.origin.parentThreadId === threadId);
	if (!parentId && !children.length) return [];

	const reads = new Map<string, Promise<Thread>>();
	const read = (id: string): Promise<Thread> => {
		let pending = reads.get(id);
		if (!pending) {
			pending = chat.readThread(sessionId, id).then(result => result.thread);
			reads.set(id, pending);
		}
		return pending;
	};
	const childIds = [...(parentId ? [threadId] : []), ...children.map(child => child.threadId)];
	const pairs = await Promise.allSettled(childIds.map(async id => {
		const alternate = await read(id);
		const origin = alternate.origin;
		if (origin.type !== 'rewind') return undefined;
		const original = await read(origin.parentThreadId);
		const originalTurn = original.turns.find(turn => turn.turnId === origin.beforeTurnId);
		if (originalTurn?.status !== 'completed') return undefined;
		const inherited = new Set(original.turns.map(turn => turn.turnId));
		const alternateTurn = alternate.turns.find(turn => !inherited.has(turn.turnId));
		if (alternateTurn?.status !== 'completed' || alternateTurn.mode !== originalTurn.mode) return undefined;
		const accepted = getAcceptedChatRequest(originalTurn);
		if (!accepted || !equals(accepted.input, getAcceptedChatRequest(alternateTurn)?.input)) return undefined;
		const pair = {
			original: { sessionId, threadId: original.threadId, turnId: originalTurn.turnId },
			alternate: { sessionId, threadId: alternate.threadId, turnId: alternateTurn.turnId },
		};
		return await readComparableTurnChanges(chat, pair.original, pair.alternate) ? pair : undefined;
	}));
	return pairs.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
}
