import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IChatService, type TurnChangeDetails } from '../../../../../workbench/services/chat/common/chatService.js';
import { IDecorationsService, type IDecorationsProvider } from '../../../../../workbench/services/decorations/common/decorations.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../../../workbench/services/editor/common/editorService.js';
import { EditorInputSerializers } from '../../../../../workbench/services/editor/common/editorInputSerializer.js';
import type { IResourceEditorInput } from '../../../../../workbench/common/editor.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionsChatResponseFileChangesService } from '../../../chat/browser/sessionTurnChanges.js';
import type { ChatWidgetModel } from '../../../../browser/chatWidgetModel.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { SessionChangesService } from '../../browser/sessionChangesService.js';
import { ISessionChangesService } from '../../common/sessionChangesService.js';
import { SessionChangesEditorInput } from '../../browser/sessionChangesEditorInput.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { createSessionFileChange, matchesSessionFileChange, SessionChangesetOperationScope, SessionChangesetOperationStatus } from '../../../../services/sessions/common/session.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../../../workbench/services/editor/common/editorGroupsService.js';

suite('Session Changes opening and capture contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('deleted file identity matches both comparison sides but never another capture or conversation', () => {
		const change = {
			file: { path: 'src/deleted.ts', kind: 'deleted' },
			summary: { sessionId: 'session', threadId: 'thread', changeSetId: 'turn', revision: 7 },
		} as Pick<TurnChangeDetails, 'summary'> & { file: TurnChangeDetails['files'][number]; };
		const normalized = createSessionFileChange(change.summary, change.file);
		const resource = normalized.uri;
		assert.equal(resource.toString(), 'ash-turn-diff:/turn/src/deleted.ts?session=session&thread=thread&revision=7');
		for (const side of ['', '&side=before', '&side=after']) {
			assert.equal(matchesSessionFileChange(normalized, resource.with({ query: resource.query + side })), true);
		}
		for (const query of [
			'session=session&thread=thread&revision=6',
			'session=other&thread=thread&revision=7',
			'session=session&thread=other&revision=7',
			resource.query + '&side=unknown',
		]) {
			assert.equal(matchesSessionFileChange(normalized, resource.with({ query })), false);
		}
		assert.equal(matchesSessionFileChange(normalized, resource.with({ path: '/turn/src/other.ts' })), false);
	});

	test('keeps a selected capture across serialization, preserves reveal options and invalidates count decorations', async () => {
		using services = new InstantiationService();
		let provider: IDecorationsProvider | undefined;
		let providerDisposed = false;
		const opened: { input: IResourceEditorInput; options?: EditorOpenOptions; group?: EditorOpenTarget; }[] = [];
		const editorGroup = { id: 'group', get inputs() { return opened.map(request => request.input); } } as unknown as IEditorGroup;
		services.registerInstance(IEditorGroupsService, { groups: [editorGroup] } as unknown as IEditorGroupsService);
		services.registerInstance(IDecorationsService, {
			registerDecorationsProvider: value => { provider = value; return toDisposable(() => { providerDisposed = true; }); },
		} as IDecorationsService);
		services.registerInstance(IEditorService, {
			onDidActiveEditorChange: Event.None,
			openEditor: async (input, options, group) => { opened.push({ input, options, group }); },
		} as IEditorService);
		services.registerInstance(ISessionsManagementService, {
			sessions: [{ sessionId: 'session', chats: [{ threadId: 'thread' }] }],
		} as unknown as ISessionsManagementService);
		const details: TurnChangeDetails = {
			summary: {
				sessionId: 'session', threadId: 'thread', changeSetId: 'capture', turnId: 'turn', repositoryId: 'repo',
				revision: 3, captureState: 'sealed', messageState: 'unconfigured', commitState: 'idle', committedPaths: [],
				statistics: { files: 1, additions: 0, deletions: 2 }, dependencies: [], externalDependencyPaths: [], warnings: [], conflictPaths: []
			},
			files: [{ path: 'deleted.ts', kind: 'deleted', binary: false, additions: 0, deletions: 2 }],
		};
		const prepared: unknown[] = [];
		let currentDetails = details;
		services.registerInstance(IQuickInputService, { input: async () => 'Delete file' } as unknown as IQuickInputService);
		services.registerInstance(IChatService, {
			readTurnChange: async () => currentDetails,
			prepareTurnCommit: async (_session: string, _thread: string, selections: unknown, message: string) => {
				prepared.push({ selections, message });
				return { commitId: 'prepared', targetBranch: 'main', message, files: details.files, warnings: [] };
			},
			readTurnCommitFile: async () => ({ binary: false, truncated: false, before: 'deleted', after: undefined }),
		} as unknown as IChatService);
		using service = services.createInstance(SessionChangesService);
		const session = URI.parse('ash-session:/session?thread=thread');
		const editor = service.getChangesEditorResource(session);
		assert.equal(service.getSessionResource(editor)?.toString(), session.toString());
		assert.equal(service.getSessionResource(editor.with({ fragment: 'capture' }))?.toString(), session.toString());
		assert.equal(service.getChangesEditorResource(session.with({ fragment: 'capture' })).toString(), editor.toString());
		assert.equal(service.getSessionResource(URI.parse('file:/session')), undefined);
		const changeset = await service.resolveChangeset(session, 'capture');
		const change = changeset.changes.get()[0]!;
		assert.equal(change.uri.toString(), 'ash-turn-diff:/capture/deleted.ts?session=session&thread=thread&revision=3');
		assert.equal(change.deletions, 2);
		const viewState = { revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } };
		assert.equal(await service.openChangesEditor(session, { changesetSelection: { kind: 'id', id: 'capture' }, preserveFocus: true, viewState }, 'sideGroup'), editorGroup);
		const request = opened[0]!;
		assert.equal(request.group, 'sideGroup');
		assert.equal(request.options?.preserveFocus, true);
		assert.equal(request.options?.forceReload, true);
		assert.equal(request.options?.viewState, viewState);
		const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(request.input)))) as SessionChangesEditorInput;
		assert.equal(restored.resource.toString(), editor.toString());
		assert.deepEqual(restored.changesetSelection, { kind: 'id', id: 'capture' });
		const model = { sessionId: 'session', threadId: 'thread', composerGeneration: 0, changeSets: [details.summary], turnChangeDetails: () => currentDetails };
		services.registerInstance(ISessionChangesService, service);
		services.registerInstance(INotificationService, {
			error: (error: unknown) => assert.fail(String(error)),
		} as unknown as INotificationService);
		const responseChanges = services.createInstance(SessionsChatResponseFileChangesService, model as unknown as ChatWidgetModel);
		const turn = responseChanges.getChangesForRequest({
			id: 'prompt', type: 'userMessage', text: 'Delete file', transient: false,
			requestSource: { sessionId: 'session', threadId: 'thread', turnId: 'turn', itemId: 'prompt' },
		});
		assert.deepEqual({ files: turn?.files, insertions: turn?.insertions, deletions: turn?.deletions }, { files: 1, insertions: 0, deletions: 2 });
		const file = turn?.fileDiffs[0];
		assert.equal(file?.path, 'deleted.ts');
		await file?.review();
		assert.deepEqual((opened[1]?.input as SessionChangesEditorInput).changesetSelection, { kind: 'id', id: 'capture' });
		assert.deepEqual(opened[1]?.options?.viewState, viewState);
		await turn?.review();
		const turnInput = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(EditorInputSerializers.serialize(opened[2]!.input)))) as SessionChangesEditorInput;
		assert.deepEqual(turnInput.changesetSelection, { kind: 'turn', turnId: 'turn' });
		assert.equal(opened[2]?.options?.viewState, undefined);
		model.composerGeneration++;
		await file?.review();
		await turn?.review();
		assert.equal(opened.length, 3);

		await assert.rejects(service.openChangesEditor(URI.parse('ash-session:/session?thread=missing')));
		assert.equal(opened.length, 3);
		assert.deepEqual(changeset.operations.get().map(operation => ({ id: operation.id, scopes: operation.scopes, status: operation.status })), [{ id: 'preview', scopes: [SessionChangesetOperationScope.Changeset, SessionChangesetOperationScope.Resource], status: SessionChangesetOperationStatus.Idle }]);
		await changeset.invokeOperation('preview', { kind: 'resource', resource: change.modifiedUri });
		assert.deepEqual(prepared, [{ selections: [{ changeSetId: 'capture', expectedRevision: 3, paths: ['deleted.ts'] }], message: 'Delete file' }]);
		assert.equal(opened[3]?.input.resource.scheme, 'ash-multi-diff');
		currentDetails = { ...details, summary: { ...details.summary, captureState: 'open', revision: 4 } };
		const unsealed = await service.resolveChangeset(session, 'capture');
		assert.equal(unsealed.operations.get()[0]?.status, SessionChangesetOperationStatus.Disabled);
		await assert.rejects(unsealed.invokeOperation('preview'), /sealed file changes/u);
		assert.equal(prepared.length, 1);
		const changed: string[][] = [];
		using listener = provider!.onDidChange(resources => changed.push(resources.map(resource => resource.toString())));
		service.setChangesCount(editor, 1);
		assert.deepEqual(await provider!.provideDecorations(editor, CancellationToken.None), { letter: '1', tooltip: '1 changed files' });
		service.setChangesCount(editor, undefined);
		assert.equal(await provider!.provideDecorations(editor, CancellationToken.None), undefined);
		assert.deepEqual(changed, [[editor.toString()], [editor.toString()]]);
		service.dispose();
		assert.equal(providerDisposed, true);
	});
});
