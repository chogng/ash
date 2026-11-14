import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import { ITextModelResourceService, type TextModelInput } from '../../textmodelResolver/common/textModelResourceService.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { EditorWorkingCopy } from '../../../browser/parts/editor/textResourceEditor.js';
import { IBufferCollabService, type BufferCollabProfile } from '../common/bufferCollabService.js';
import { BufferCollabSession } from './bufferCollabSession.js';

export class BufferCollabService extends Disposable implements IBufferCollabService {
	private readonly sessions = new Map<TextModel, { session: BufferCollabSession; lifetime: DisposableStore; connecting: Promise<void>; }>();
	private readonly changed = this._register(new Emitter<TextModel>());
	readonly onDidChange = this.changed.event;
	constructor(@IInstantiationService private readonly instantiation: IInstantiationService,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService) { super(); }
	get(model: TextModel): BufferCollabSession | undefined { return this.sessions.get(model)?.session; }
	async join(model: TextModel, input: TextModelInput, profile: BufferCollabProfile, roomId: string | undefined, signal: AbortSignal): Promise<void> {
		const existing = this.sessions.get(model); if (existing) return existing.connecting;
		const reference = await this.models.acquire(input, signal, { waitForSyntax: false });
		if (this.isDisposed || signal.aborted) { reference.dispose(); return; }
		const concurrent = this.sessions.get(model); if (concurrent) { reference.dispose(); return concurrent.connecting; }
		if (reference.model !== model) { reference.dispose(); throw new Error('Collaboration must bind the existing text model'); }
		const lifetime = new DisposableStore();
		lifetime.add(new EditorWorkingCopy(reference, { ...input }, this.copies, undefined));
		let session: BufferCollabSession;
		try { session = lifetime.add(this.instantiation.createInstance(BufferCollabSession, model, profile, { roomId })); }
		catch (error) { lifetime.dispose(); throw error; }
		const entry = { session, lifetime, connecting: Promise.resolve() };
		this.sessions.set(model, entry);
		lifetime.add(session.onDidChangeState(() => this.changed.fire(model)));
		lifetime.add(model.onWillDispose(() => this.leave(model)));
		this.changed.fire(model);
		// A cancelled join may finish after the same model has joined another room.
		const discard = () => { if (this.sessions.get(model) === entry) this.leave(model); };
		entry.connecting = session.connect(signal).then(joined => { if (!joined) discard(); }, error => { discard(); throw error; });
		return entry.connecting;
	}
	leave(model: TextModel): void { const entry = this.sessions.get(model); if (entry) { this.sessions.delete(model); entry.lifetime.dispose(); this.changed.fire(model); } }
	protected override disposeCore(): void { for (const model of [...this.sessions.keys()]) this.leave(model); super.disposeCore(); }
}
