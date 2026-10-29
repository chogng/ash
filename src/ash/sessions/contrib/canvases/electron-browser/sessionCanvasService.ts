import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import type { ICanvasOwner, CanvasInput } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import {
	autorun,
	derived,
	observableSignalFromEvent,
	observableValue,
	type IReader,
} from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { isCanvasOwner } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { IAgentHostCanvasCollection } from '../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { Event } from '../../../../base/common/event.js';
import { canvasOwnerKey } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { SESSIONS_LAYOUT_SCOPE_SETTING, type ChatLayoutMode } from '../../../common/chatLayout.js';
import {
	ICanvasContextService,
	ICanvasService,
	getCanvasDefinitionInstanceId,
	type ICanvasDefinition,
} from '../../../../workbench/contrib/canvases/common/canvas.js';
import { CanvasDefinitionStore } from '../../../../workbench/contrib/canvases/common/canvasDefinitionStore.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ISessionCanvasRegistryService } from '../common/sessionCanvas.js';
import { CancellationError } from '../../../../base/common/errors.js';

/** Session selection remains authoritative while Code or a product page covers its chat widget. */
export class SessionCanvasContextService extends Disposable implements ICanvasContextService {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeVisibility = this.changed.event;
	private readonly removed = this._register(new Emitter<ICanvasOwner>());
	readonly onDidRemoveOwner = this.removed.event;
	private readonly owners = new Map<string, ICanvasOwner>();
	readonly contexts;
	readonly workingSets;

	constructor(
		@ISessionsService private readonly sessions: ISessionsService,
		@IEditorPart private readonly editors: IEditorPart,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IAgentHostCanvasCollection private readonly collection: IAgentHostCanvasCollection,
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@ISessionsManagementService management: ISessionsManagementService,
	) {
		super();
		this.workingSets = {
			state: layout.editorWorkingSetState,
			registerEditorToRetain: (input: CanvasInput) => layout.retainEditor(input),
			suppressEditorPartAutoVisibility: () => layout.suppressEditorAutoVisibility(),
		};
		const changes = observableSignalFromEvent(this, this.changed.event);
		const visibleOwners = () => {
			const result: ICanvasOwner[] = [];
			for (const selection of sessions.visibleSelections) {
				if (selection.kind !== 'session') {
					continue;
				}
				const owner = {
					providerId: selection.active.session.providerId ?? 'local-agent-host',
					session: URI.from({ scheme: 'ash-session', path: '/' + selection.active.session.sessionId }),
					chat: URI.from({ scheme: 'ash-thread', path: '/' + selection.active.threadId }),
				};
				result.push(owner);
			}
			return result;
		};
		const updateOwners = () => {
			for (const owner of visibleOwners()) {
				this.owners.set(canvasOwnerKey(owner), owner);
			}
			if (management.state === 'ready') {
				for (const [key, owner] of this.owners) {
					const session = management.sessions.find(
						session =>
							session.sessionId === owner.session.path.slice(1) &&
							(session.providerId ?? 'local-agent-host') === owner.providerId,
					);
					if (
						!session ||
						session.status === 'archived' ||
						(session.agentTree !== undefined &&
							!session.chats.some(
								chat => chat.threadId === owner.chat.path.slice(1) && chat.status !== 'archived',
							))
					) {
						this.owners.delete(key);
						collection.removeOwner(owner);
						this.removed.fire(owner);
					}
				}
			}
			this.changed.fire();
		};
		this.contexts = derived(reader => {
			changes.read(reader);
			const visible = visibleOwners().filter(owner => this.owners.has(canvasOwnerKey(owner)));
			return [
				...visible,
				...[...this.owners.values()].filter(owner => !visible.some(current => isCanvasOwner(current, owner))),
			].map(owner => collection.createContext(owner));
		});
		this._register(Event.any(sessions.onDidChange, management.onDidChange)(updateOwners));
		updateOwners();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (
					event.affectsConfiguration(CanvasesEnabledSettingId) ||
					event.affectsConfiguration(ChatAIDisabledSettingId) ||
					event.affectsConfiguration(SESSIONS_LAYOUT_SCOPE_SETTING)
				) {
					this.changed.fire();
				}
			}),
		);
	}

	getContext(owner: ICanvasOwner, reader?: IReader) {
		return (reader ? this.contexts.read(reader) : this.contexts.get()).find(context =>
			isCanvasOwner(context.owner, owner),
		);
	}
	getFrontendSessionResource(owner: ICanvasOwner, reader?: IReader): URI | undefined {
		return this.getContext(owner, reader)?.owner.session;
	}

	isOwnerVisible(owner: ICanvasOwner): boolean {
		return (
			owner.providerId === 'local-agent-host' &&
			this.owners.has(canvasOwnerKey(owner)) &&
			this.configuration.getValue<boolean>(CanvasesEnabledSettingId) !== false &&
			this.configuration.getValue<boolean>(ChatAIDisabledSettingId) !== true &&
			this.sessions.visibleSelections.some(
				selection =>
					selection.kind === 'session' &&
					(selection.active.session.providerId ?? 'local-agent-host') === owner.providerId &&
					selection.active.session.sessionId === owner.session.path.slice(1) &&
					(selection.active.threadId === owner.chat.path.slice(1) ||
						((this.configuration.getValue<ChatLayoutMode>(SESSIONS_LAYOUT_SCOPE_SETTING) ??
							'session-shared') === 'session-shared' &&
							this.owners.has(canvasOwnerKey(owner)))),
			)
		);
	}

	getEditorGroup(_owner: ICanvasOwner, input: CanvasInput, _restore: boolean): IEditorGroup | undefined {
		return (
			this.editors.groups.find(group => group.inputs.includes(input)) ??
			this.editors.groups.find(group => group === this.editors.activeGroup && !group.isLocked) ??
			this.editors.groups.find(group => !group.isLocked)
		);
	}
}

/** The focused conversation determines both listing and dispatch; delayed definitions never choose another owner. */
export class SessionCanvasRegistryService extends Disposable implements ISessionCanvasRegistryService {
	readonly availableCanvases;
	private readonly current;
	constructor(
		@ISessionsService sessions: ISessionsService,
		@ICanvasContextService contexts: ICanvasContextService,
		@ICanvasService canvases: ICanvasService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const selected = observableSignalFromEvent(this, sessions.onDidChange);
		this.current = derived(reader => {
			selected.read(reader);
			const selection = sessions.activeSelection;
			return canvases.enabled.read(reader) && selection?.kind === 'session'
				? contexts.contexts
						.read(reader)
						.find(
							context =>
								context.owner.providerId ===
									(selection.active.session.providerId ?? 'local-agent-host') &&
								context.owner.session.path.slice(1) === selection.active.session.sessionId &&
								context.owner.chat.path.slice(1) === selection.active.threadId &&
								contexts.isOwnerVisible(context.owner),
						)
				: undefined;
		});
		const changes = observableValue(this, 0);
		const listener = this._register(new MutableDisposable());
		this._register(
			autorun(reader => {
				const context = this.current.read(reader);
				listener.value = context?.definitionProvider?.onDidChangeDefinitions(() =>
					changes.set(changes.get() + 1, undefined),
				);
			}),
		);
		const store = this._register(
			instantiation.createInstance(
				CanvasDefinitionStore,
				(reader: IReader) => {
					changes.read(reader);
					const context = this.current.read(reader);
					return context?.definitionProvider
						? { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() }
						: undefined;
				},
				'Session Canvas registry',
			),
		);
		this.availableCanvases = store.definitions;
	}

	async openCanvas(canvas: ICanvasDefinition): Promise<void> {
		const context = this.current.get();
		const admitted = this.availableCanvases
			.get()
			.find(candidate => candidate.extensionId === canvas.extensionId && candidate.canvasId === canvas.canvasId);
		if (!context?.definitionProvider || !admitted) {
			throw new CancellationError();
		}
		await context.definitionProvider.openCanvas(admitted, getCanvasDefinitionInstanceId(admitted));
	}
}
