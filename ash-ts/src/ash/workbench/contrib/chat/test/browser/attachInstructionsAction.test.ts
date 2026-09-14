import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IInstructionApi, InstructionCatalog } from '../../../../../platform/instructions/common/instructionApi.js';
import type { ISessionsManagementService } from '../../../../../sessions/services/sessions/common/sessionsManagementService.js';
import type { ChatContextPicker, IChatContextPickService, ResolvedChatAttachment } from '../../../../services/chat/common/chatContextService.js';
import { ChatInstructionContextContribution } from '../../browser/promptSyntax/attachInstructionsAction.js';

suite('Chat instruction attachment', () => {
	test('offers only OnDemand entries and preserves the selected catalog reference', async () => {
		let picker: ChatContextPicker<ResolvedChatAttachment> | undefined;
		let requestedSession: string | undefined;
		let lists = 0;
		const reference = {
			source: { type: 'directory' as const, root: '/workspace' },
			relativePath: '.ash/instructions/manual.md',
			digest: `sha256:${'b'.repeat(64)}`,
		};
		const catalog: InstructionCatalog = {
			instructions: [
				{ reference, name: 'manual', loadPolicy: 'onDemand', path: '/workspace/.ash/instructions/manual.md' },
				{ reference: { ...reference, relativePath: '.ash/instructions/global.md' }, name: 'global', loadPolicy: 'global', path: '/workspace/.ash/instructions/global.md' },
			],
			diagnostics: [],
		};
		const api = { list: async (sessionId?: string) => { requestedSession = sessionId; lists += 1; return catalog; } } as IInstructionApi;
		const sessions = { active: { session: { sessionId: 'session-1' } } } as ISessionsManagementService;
		const pickService = {
			registerPicker(value: ChatContextPicker<ResolvedChatAttachment>) {
				picker = value;
				return toDisposable(() => { picker = undefined; });
			},
		} as IChatContextPickService;
		using contribution = new ChatInstructionContextContribution(pickService, api, sessions);

		assert.equal(await picker?.isEnabled(), true);
		const picks = await picker?.providePicks('manual');
		assert.equal(requestedSession, 'session-1');
		assert.equal(lists, 1);
		assert.deepEqual(picks?.map(pick => pick.label), ['manual']);
		assert.deepEqual(await picks?.[0]?.attachment.resolve(), { type: 'instruction', reference });
	});
});
