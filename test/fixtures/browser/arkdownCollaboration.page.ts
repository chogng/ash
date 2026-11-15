import { IBufferCollabService } from '../../../src/ash/workbench/services/collab/common/bufferCollabService.js';
import { BufferCollabService } from '../../../src/ash/workbench/services/collab/browser/bufferCollabService.js';
import './chatFixtureLocalization.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { Emitter } from '../../../src/ash/base/common/event.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';
import { EndOfLineSequence } from '../../../src/ash/editor/common/model.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { CodeEditorWidget } from '../../../src/ash/editor/browser/widget/codeEditor/codeEditorWidget.js';
import { registerCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IDialogService, type IInputDialogOptions } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { CollabError, CollabFailure, ICollabService, type RejoinableRoom, type RemoteRoomEnvelope, type RoomOpenInput } from '../../../src/ash/workbench/services/collab/common/collabService.js';
import { ArkdownEditorPane } from '../../../src/ash/sessions/contrib/docs/browser/arkdown/arkdownEditorPane.js';
import { MemoryResourceStore } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { IFileTextModelService, ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { createTestEditorServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';

const lifetime = new DisposableStore();
const parent = lifetime.add(createTestEditorServices());
registerCodeEditorServices(parent);
const services = lifetime.add(parent.createChild());
services.registerSingleton(IBufferCollabService, () => services.createInstance(BufferCollabService));
let chosenRoom = '';
let confirmJoin = true;
let pendingConfirmation: ((value: { confirmed: boolean; }) => void) | undefined;
let holdConfirmation = false;
let joining: Promise<void> | undefined;
class FixtureDialogs extends DialogService {
	override async input(_options: IInputDialogOptions) { return { confirmed: true, values: [chosenRoom] }; }
	override async confirm() {
		if (holdConfirmation) return new Promise<{ confirmed: boolean; }>(resolve => { pendingConfirmation = resolve; });
		return { confirmed: confirmJoin };
	}
}
services.registerInstance(IDialogService, lifetime.add(new FixtureDialogs()));
interface RawUpdate { clientId: string; sequence: number; baseVersion: number; version: number; transaction: string; }
interface RoomData { epoch: string; document: string; version: number; schema: string; updates: RawUpdate[]; subscribers: Set<(update: RawUpdate) => void>; accepted: Map<string, { request: string; update: RawUpdate; }>; }
const rooms = new Map<string, RoomData>();
let online = true;
let loseResponse = false;
let viewerNext = false;
let duplicateRequests = 0;
let submitAttempts=0, refreshes=0, probes=0, rejected=false, expired=false;
const transport: ICollabService = {
	dispose() { }, [Symbol.dispose]() { },
	async open<TDocument, TTransaction>(input: RoomOpenInput<TDocument, TTransaction>): Promise<RejoinableRoom<TDocument, TTransaction>> {
		if (!online) throw new Error('Offline');
		const roomId = input.roomId ?? `room-${rooms.size + 1}`;
		let room = rooms.get(roomId);
		if (!room) { room = { epoch: 'epoch-1', document: input.codec.serialize(input.document), version: 0, schema: input.schemaId, updates: [], subscribers: new Set(), accepted: new Map() }; rooms.set(roomId, room); }
		if (room.schema !== input.schemaId) throw new Error('Wrong schema');
		const state = room;
		const updates = new Emitter<RemoteRoomEnvelope<TTransaction>>();
		const snapshots = new Emitter<never>();
		const failures = new Emitter<Error>();
		const presences = new Emitter<never>();
		const receiver = (update: RawUpdate) => { if (online) updates.fire({ ...update, transaction: input.codec.deserializeTransaction(update.transaction) }); };
		state.subscribers.add(receiver);
		const canEdit = !viewerNext; viewerNext = false;
		const snapshot = () => ({ roomId, epoch: state.epoch, version: state.version, document: input.codec.deserialize(state.document) });
		return Object.assign(toDisposable(() => { state.subscribers.delete(receiver); updates.dispose(); snapshots.dispose(); failures.dispose(); presences.dispose(); }), {
			roomId, clientId: input.clientId, principalId: undefined, canEdit, canManageMembers: false,
			initialSnapshot: snapshot(), currentPresence: [], onDidReceiveUpdate: updates.event, onDidReceiveSnapshot: snapshots.event, onDidFail: failures.event, onDidReceivePresence: presences.event,
			async readStatus() { probes++; if (expired) { expired=false; throw new CollabError(CollabFailure.Expired,"expired"); } if (!online) throw new Error('Offline'); return { roomId, epoch: state.epoch, version: state.version, canEdit }; },
            async refresh() { refreshes++; if (!online) throw new Error('Offline'); return snapshot(); },
			async submit(envelope, document) {
                submitAttempts++;
                if (rejected) throw new CollabError(CollabFailure.Rejected,'rejected');
                if (envelope.epoch && envelope.epoch !== state.epoch) return { kind: 'resync' as const, snapshot: snapshot() };
				if (!online || !canEdit) throw new Error('Offline or forbidden');
				const transaction = input.codec.serializeTransaction(envelope.transaction);
				const serialized = input.codec.serialize(document);
				const key = `${input.clientId}:${envelope.sequence}`;
				const request = JSON.stringify({ ...envelope, transaction, document: serialized });
				const prior = state.accepted.get(key);
				if (prior) { if (prior.request !== request) throw new Error('Changed retry'); duplicateRequests++; return { kind: 'accepted' as const, update: { ...prior.update, transaction: input.codec.deserializeTransaction(prior.update.transaction) } }; }
				if (envelope.baseVersion !== state.version) return { kind: 'conflict' as const, updates: state.updates.filter(update => update.version > envelope.baseVersion).map(update => ({ ...update, transaction: input.codec.deserializeTransaction(update.transaction) })) };
				const update: RawUpdate = { ...envelope, transaction, version: ++state.version };
				state.document = serialized; state.updates.push(update); state.accepted.set(key, { request, update });
				for (const subscriber of state.subscribers) subscriber(update);
				if (loseResponse) { loseResponse = false; throw new Error('Accepted response lost'); }
				return { kind: 'accepted' as const, update: { ...update, transaction: envelope.transaction } };
			},
			async updatePresence() { },
			async createInvite() { throw new Error('Local room'); }, async listMembers() { return []; }, async rotateMemberAccessToken() { throw new Error('Local room'); }, async revokeMember() { throw new Error('Local room'); },
		} satisfies Omit<RejoinableRoom<TDocument, TTransaction>, 'dispose' | typeof Symbol.dispose>);
	},
};
services.registerInstance(ICollabService, transport);
const a = URI.file('/workspace/first.md'), b = URI.file('/workspace/second.md');
const store = lifetime.add(new MemoryResourceStore([[a, '# Shared\n\nalpha🙂'], [b, 'local draft'], [URI.file('/workspace/other.md'), 'other document']]));
const models = lifetime.add(services.createInstance(BrowserTextModelService, store, {}));
services.registerInstance(IFileTextModelService, models); services.registerInstance(ITextModelResourceService, models);
const panes: ArkdownEditorPane[] = [];
for (const [index, resource] of [a, b].entries()) {
	const pane = lifetime.add(services.createInstance(ArkdownEditorPane, { id: `markdown-${index}` }));
	pane.create(document.getElementById(index ? 'b' : 'a')!); pane.setVisible(true);
	await pane.setInput({ resource, languageId: 'markdown', contentType: 'text/markdown' }, new AbortController().signal); pane.layout({ width: 420, height: 600 }); panes.push(pane);
}
const references = await Promise.all([a, b].map(resource => models.acquire({ resource }, new AbortController().signal)));
for (const reference of references) lifetime.add(reference);
const code = lifetime.add(services.createInstance(CodeEditorWidget, { container: document.getElementById('code')!, model: references[0].model, ariaLabel: 'Shared source' }));
code.layout({ width: 420, height: 600 });
const fixture = {
	beginJoin() { holdConfirmation = true; joining = this.connect(1, 'room-1'); },
	get awaitingConfirmation() { return !!pendingConfirmation; },
	async finishJoin(confirmed: boolean) { holdConfirmation = false; pendingConfirmation?.({ confirmed }); pendingConfirmation = undefined; await joining; },
	async connect(index: number, roomId = '') { chosenRoom = roomId; await panes[index].getActions().find(action => action.id === 'arkdown.editor.collaborate')!.run(); },
	leave(index: number) { void panes[index].getActions().find(action => action.id === 'arkdown.editor.collaborate')!.run(); },
	text(index: number) { return references[index].model.getValue(); },
	recentChanges(index: number) { return services.get(IBufferCollabService).get(references[index].model)?.recentChanges ?? []; },
	source(index: number) { panes[index].setMode('markdown'); },
	accessible(index: number) { return panes[index].getAccessibleContent(); },
	replace(index: number, start: number, end: number, text: string) { const model = references[index].model; model.pushEditOperations(null, [{ range: { startLineNumber: model.getPositionAt(start).lineNumber, startColumn: model.getPositionAt(start).column, endLineNumber: model.getPositionAt(end).lineNumber, endColumn: model.getPositionAt(end).column }, text }], null); },
	edit(index: number, offset: number, text: string) { const model = references[index].model; model.pushEditOperations(null, [{ range: { startLineNumber: model.getPositionAt(offset).lineNumber, startColumn: model.getPositionAt(offset).column, endLineNumber: model.getPositionAt(offset).lineNumber, endColumn: model.getPositionAt(offset).column }, text }], null); },
	crlf(index: number) { references[index].model.pushEOL(EndOfLineSequence.CRLF); },
	undo(index: number) { references[index].model.undo(); }, redo(index: number) { references[index].model.redo(); },
	save(index: number) { return panes[index].save(); }, saved(index: number) { return store.text(index ? b : a); }, dirty(index: number) { return panes[index].isDirty; },
	online(value: boolean) { online = value; }, loseResponse() { loseResponse = true; }, viewer() { viewerNext = true; }, confirm(value: boolean) { confirmJoin = value; },
    async show(index:number, resource: 'other' | 'original' | 'first') {
        const uri=resource==='other'?URI.file('/workspace/other.md'):resource==='first'?a:index?b:a;
        await panes[index].setInput({resource:uri,languageId:'markdown',contentType:'text/markdown'},new AbortController().signal);
    },
    restart() { for (const room of rooms.values()) { room.epoch='epoch-2'; room.version=0; room.updates=[]; room.accepted.clear(); } },
    reject(value:boolean){rejected=value;}, expire(){expired=true;},
    get traffic(){return {submitAttempts,refreshes,probes};},
    get active(){return [!!services.get(IBufferCollabService).get(references[0].model),!!services.get(IBufferCollabService).get(references[1].model)];},

	get duplicates() { return duplicateRequests; }, get listeners() { return [...rooms.values()].reduce((count, room) => count + room.subscribers.size, 0); },
};
declare global { interface Window { arkdownCollaborationFixture: typeof fixture; } }
window.arkdownCollaborationFixture = fixture;
addDisposableListener(window, 'pagehide', () => { code.dispose(); for (const pane of panes) pane.dispose(); lifetime.dispose(); });
document.body.dataset.ready = 'true';
