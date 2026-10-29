import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { IChatService, type TurnChangeSetSummary } from '../../../../../workbench/services/chat/common/chatService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ChangesMultiDiffSourceResolver } from '../../browser/changesMultiDiffSourceResolver.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';

for (const locale of ['en', 'zh-CN'])
	test(`reopened Changes sources retain the original conversation and reject invalid identities before reading (${locale})`, async () => {
		setNlsMessages(locale, productLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
		using localizationOwner = toDisposable(resetNlsResolver);
		using services = new InstantiationService();
		const reads: string[] = [];
		const summary: TurnChangeSetSummary = {
			changeSetId: 'capture',
			sessionId: 'original',
			threadId: 'thread',
			turnId: 'turn',
			repositoryId: 'repo',
			captureState: 'sealed',
			messageState: 'unconfigured',
			commitState: 'idle',
			committedPaths: [],
			revision: 1,
			statistics: { files: 1, additions: 1, deletions: 1 },
			dependencies: [],
			externalDependencyPaths: [],
			warnings: [],
			conflictPaths: [],
		};
		services.registerInstance(ISessionsManagementService, {
			sessions: [{ sessionId: 'original' }, { sessionId: 'other' }],
			active: { session: { sessionId: 'other' }, threadId: 'other-thread' },
		} as unknown as ISessionsManagementService);
		services.registerInstance(IChatService, {
			listTurnChanges: async (sessionId: string, threadId: string) => {
				reads.push(`${sessionId}:${threadId}`);
				return [summary];
			},
			readTurnChange: async () => ({
				summary,
				files: [{ path: 'deleted.ts', kind: 'deleted', additions: 0, deletions: 1 }],
			}),
			readTurnChangeFile: async () => ({ binary: false, truncated: false, before: 'before', after: undefined }),
		} as unknown as IChatService);
		services.registerInstance(IEditorService, {
			...emptyEditorServiceState,
			openEditor: async () => {},
		} as unknown as IEditorService);
		services.registerInstance(IQuickInputService, {
			input: async () => undefined,
		} as unknown as IQuickInputService);
		const resolver = services.createInstance(ChangesMultiDiffSourceResolver);
		assert.deepEqual(
			resolver.sourceActions().map(action => action.label),
			locale === 'zh-CN' ? ['当前轮次', '当前及之前的轮次', '上一轮次'] : ['Current Turn', 'Current Turn and Earlier', 'Previous Turn'],
		);
		const source = URI.parse('ash-multi-diff:/turn/currentTurn?session=original&thread=thread&changes=capture');
		const restored = await resolver.resolveDiffSource(URI.parse(source.toString()));
		assert.deepEqual(reads, ['original:thread']);
		assert.deepEqual(
			restored.resources.map(item => ({ before: item.original.initialText, after: item.modified.initialText })),
			[{ before: 'before', after: '' }],
		);
		assert.equal(restored.source?.repositoryId, 'repo');
		assert.equal(resolver.canHandleUri(URI.parse('file:/turn/currentTurn')), false);
		for (const resource of [
			'ash-multi-diff:/turn/unknown?session=original&thread=thread&changes=capture',
			'ash-multi-diff:/turn/currentTurn?session=original&changes=capture',
			'ash-multi-diff:/turn/currentTurn?session=missing&thread=thread&changes=capture',
			'ash-multi-diff:/turn-commit/commit?session=original',
		]) {
			await assert.rejects(resolver.resolveDiffSource(URI.parse(resource)));
		}
		assert.deepEqual(reads, ['original:thread']);
	});
