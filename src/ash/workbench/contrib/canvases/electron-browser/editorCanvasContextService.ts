import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IAgentHostCanvasCollection } from '../common/agentHostCanvas.js';
import { Emitter } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { CanvasesEnabledSettingId, IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { canvasOwnerKey, isCanvasOwner, type ICanvasContextService, type ICanvasOwner, type CanvasInput } from '../common/canvas.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

/** Both products register their visible conversations in the same window-scoped registry. */
export class EditorCanvasContextService extends Disposable implements ICanvasContextService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeVisibility = this.changed.event;
	private readonly removed = this._register(new Emitter<ICanvasOwner>());
	readonly onDidRemoveOwner = this.removed.event;
	private readonly owners = new Map<string, ICanvasOwner>();
	private readonly catalogReads = new Map<string, number>();
	readonly contexts;

	constructor(
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@IEditorPart private readonly editors: IEditorPart,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAgentHostCanvasCollection private readonly collection: IAgentHostCanvasCollection,
		@IAgentSessionService private readonly sessions: IAgentSessionService,
		@IChatService chat: IChatService,
	) {
		super();
		const changes = observableSignalFromEvent(this, this.changed.event);
		this.contexts = derived(reader => {
			changes.read(reader);
			return [...this.owners.values()].map(owner => collection.createContext(owner));
		});
		this._register(widgets.onDidChangeWidgets(() => this.collectOwners()));
		this._register(chat.onDidChangeSession(event => { if ([...this.owners.values()].some(owner => owner.session.path.slice(1) === event.sessionId)) { void this.pruneOwners(event.sessionId); } }));
		this._register(chat.onDidBecomeReady(() => { for (const id of new Set([...this.owners.values()].map(owner => owner.session.path.slice(1)))) { void this.pruneOwners(id); } }));
		this.collectOwners();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CanvasesEnabledSettingId) || event.affectsConfiguration(ChatAIDisabledSettingId)) { this.changed.fire(); }
		}));
	}

	private collectOwners(): void {
		for (const widget of this.widgets.getAllWidgets()) {
			if (!widget.sessionId || !widget.threadId) { continue; }
			const owner = { providerId: 'local-agent-host', session: URI.from({ scheme: 'ash-session', path: '/' + widget.sessionId }), chat: URI.from({ scheme: 'ash-thread', path: '/' + widget.threadId }) };
			this.owners.set(canvasOwnerKey(owner), owner);
		}
		this.changed.fire();
	}

	private async pruneOwners(sessionId: string): Promise<void> {
		const revision = (this.catalogReads.get(sessionId) ?? 0) + 1;
		this.catalogReads.set(sessionId, revision);
		try {
			const { session } = await this.sessions.readCatalog({ sessionId });
			if (this.isDisposed || this.catalogReads.get(sessionId) !== revision) { return; }
			for (const [key, owner] of this.owners) {
				if (owner.session.path.slice(1) !== sessionId || session?.status === 'active' && session.threads.some(thread => thread.threadId === owner.chat.path.slice(1) && thread.status === 'active')) { continue; }
				this.owners.delete(key);
				this.collection.removeOwner(owner);
				this.removed.fire(owner);
			}
			this.changed.fire();
		} catch { /* An unavailable catalog is unknown membership, including during reconnect. */ }
	}

	getContext(owner: ICanvasOwner, reader?: IReader) { return (reader ? this.contexts.read(reader) : this.contexts.get()).find(context => isCanvasOwner(context.owner, owner)); }
	getFrontendSessionResource(owner: ICanvasOwner, reader?: IReader): URI | undefined { return this.getContext(owner, reader)?.owner.session; }

	isOwnerVisible(owner: ICanvasOwner): boolean {
		return owner.providerId === 'local-agent-host'
			&& this.owners.has(canvasOwnerKey(owner))
			&& this.configuration.getValue<boolean>(CanvasesEnabledSettingId) !== false
			&& this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true
			&& this.widgets.getAllWidgets().some(widget => widget.visible && widget.sessionId === owner.session.path.slice(1) && widget.threadId === owner.chat.path.slice(1));
	}

	getEditorGroup(_owner: ICanvasOwner, input: CanvasInput, _restore: boolean): IEditorGroup | undefined {
		const existing = this.editors.groups.find(group => group.inputs.includes(input));
		if (existing) { return existing; }
		const visibleChats = this.widgets.getAllWidgets().filter(widget => widget.visible);
		const available = this.editors.groups.filter(group => !group.isLocked && !visibleChats.some(widget => group.domNode.contains(widget.domNode)));
		return available.find(group => group === this.editors.activeGroup) ?? available[0]
			?? this.editors.addGroup(this.editors.activeGroup.id, Direction.Right);
	}
}
