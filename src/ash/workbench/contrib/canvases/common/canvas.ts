import { Emitter, type Event } from '../../../../base/common/event.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInputCapabilities } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { IBrowserViewModel } from '../../browserView/common/browserView.js';
import type { IReader } from '../../../../base/common/observable.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { StringSHA1 } from '../../../../base/common/hash.js';

export const REVEAL_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.revealCanvas';

export interface ICanvas {
	readonly resource: URI;
	readonly instanceId: string | undefined;
	readonly title: string;
	readonly status?: string;
	readonly source: URI | undefined;
}

export type CanvasExtensionSource = 'user' | 'project' | 'session' | 'plugin' | 'unknown';

export interface ICanvasDefinition {
	readonly canvasId: string;
	readonly extensionId: string;
	readonly extensionSource: CanvasExtensionSource;
	readonly extensionName?: string;
	readonly displayName: string;
	readonly description: string;
	readonly requiresInput: boolean;
}

export type CanvasDefinitionSnapshot = readonly ICanvasDefinition[] | undefined;

export interface ICanvasDefinitionProvider {
	readonly onDidChangeDefinitions: Event<void>;
	listCanvases(): Promise<CanvasDefinitionSnapshot>;
	openCanvas(canvas: ICanvasDefinition, instanceId: string): Promise<void>;
}

export interface ICanvasOwner {
	readonly providerId: string;
	readonly session: URI;
	readonly chat: URI;
}

export interface ICanvasReference extends ICanvasOwner {
	readonly canvas: URI;
}

export interface ICanvasReopenTarget {
	readonly reference: ICanvasReference;
	readonly canvas: ICanvas;
}

export interface ICanvasModelResolution {
	readonly model: IBrowserViewModel;
	readonly reused: boolean;
}

export interface ICanvasOpenRequest {
	readonly id: string;
	readonly succeeded: boolean;
}

export interface ICanvasContext {
	readonly owner: ICanvasOwner;
	readonly canvases: IObservable<readonly ICanvas[] | undefined>;
	readonly openRequests?: IObservable<ReadonlyMap<string, ICanvasOpenRequest>>;
	readonly definitionProvider?: ICanvasDefinitionProvider;
	readonly closeCanvas?: (canvas: ICanvas) => Promise<void>;
}

export interface ICanvasWorkingSetOwner {
	readonly sessionResource: URI;
	readonly chatResource: URI | undefined;
}
export interface ICanvasWorkingSetState {
	readonly owner: ICanvasWorkingSetOwner | undefined;
	readonly restoring: boolean;
	readonly applying: boolean;
}

export interface ICanvasWorkingSets {
	readonly state: IObservable<ICanvasWorkingSetState>;
	registerEditorToRetain(input: CanvasInput): IDisposable;
	suppressEditorPartAutoVisibility(): IDisposable;
}

export const ICanvasContextService = createServiceIdentifier<ICanvasContextService>('canvasContextService');

/** Window presentation policy; the native browser service owns live page membership. */
export interface ICanvasContextService {
	readonly contexts: IObservable<readonly ICanvasContext[]>;
	readonly onDidRemoveOwner: Event<ICanvasOwner>;
	readonly workingSets?: ICanvasWorkingSets;
	readonly onDidChangeVisibility: Event<void>;
	isOwnerVisible(owner: ICanvasOwner, reader?: IReader): boolean;
	getContext(owner: ICanvasOwner, reader?: IReader): ICanvasContext | undefined;
	getFrontendSessionResource(owner: ICanvasOwner, reader?: IReader): URI | undefined;
	getEditorGroup(owner: ICanvasOwner, input: CanvasInput, restore: boolean): IEditorGroup | undefined;
}

export const ICanvasService = createServiceIdentifier<ICanvasService>('sessionCanvasService');

export interface ICanvasService {
	readonly enabled: IObservable<boolean>;
	readonly reopenableCanvases: IObservable<readonly ICanvasReopenTarget[]>;
	isOwnerPresentable(reference: ICanvasReference): boolean;
	revealCanvas(reference: ICanvasReference): Promise<void>;
	reopenCanvas(reference: ICanvasReference): Promise<void>;
	closeCanvas(reference: ICanvasReference): Promise<void>;
	restoreCanvasInput(serializationId: string): CanvasInput | undefined;
	resolveCanvasModel(reference: ICanvasReference, source: URI): Promise<ICanvasModelResolution>;
}

export function canvasOwnerKey(owner: ICanvasOwner): string {
	return JSON.stringify([owner.providerId, owner.session.toString(), owner.chat.toString()]);
}
export function isCanvasOwner(first: ICanvasOwner, second: ICanvasOwner): boolean {
	return canvasOwnerKey(first) === canvasOwnerKey(second);
}
export function getCanvasReferenceKey(reference: ICanvasReference): string {
	return JSON.stringify([canvasOwnerKey(reference), reference.canvas.toString()]);
}

export function isOpenableExtensionCanvasDefinition(canvas: ICanvasDefinition): boolean {
	return !canvas.requiresInput;
}
export function compareCanvasDefinitions(first: ICanvasDefinition, second: ICanvasDefinition): number {
	return first.displayName.localeCompare(second.displayName) || first.extensionId.localeCompare(second.extensionId) || first.canvasId.localeCompare(second.canvasId);
}

export function getCanvasDefinitionInstanceId(canvas: ICanvasDefinition): string {
	const digest = new StringSHA1();
	digest.update(JSON.stringify([canvas.extensionId, canvas.canvasId]));
	return 'canvas-' + digest.digest();
}

export function getCanvasInstanceLabels(canvases: readonly ICanvas[]): readonly string[] {
	return disambiguate(
		canvases,
		canvas => canvas.title,
		(canvas, index) => canvas.instanceId ?? String(index + 1),
	);
}

export function getCanvasDefinitionLabels(canvases: readonly ICanvasDefinition[]): readonly string[] {
	return disambiguate(
		canvases,
		canvas => canvas.displayName || canvas.canvasId,
		canvas => `${canvas.extensionName || canvas.extensionId}: ${canvas.canvasId}`,
	);
}

function disambiguate<T>(values: readonly T[], title: (value: T) => string, detail: (value: T, index: number) => string): string[] {
	const titles = values.map(title);
	const used = new Set<string>();
	return values.map((value, index) => {
		const name = titles[index]!;
		let label = titles.filter(title => title === name).length > 1 ? localize('canvas.instanceTitle', '{0} ({1})', name, detail(value, index)) : name;
		let suffix = 1;
		while (used.has(label)) {
			label = localize('canvas.instanceTitle', '{0} ({1})', name, `${detail(value, index)}, ${++suffix}`);
		}
		used.add(label);
		return label;
	});
}

/** A live handle, never a saved source URL or a grant that can recreate an old page. */
export class CanvasInput extends EditorInput {
	static readonly ID = 'sessions.editorInput.canvas';
	static readonly EDITOR_ID = 'sessions.editor.canvas';
	readonly typeId = CanvasInput.ID;
	override readonly editorId = CanvasInput.EDITOR_ID;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;
	readonly capabilities = EditorInputCapabilities.Singleton;
	readonly resource: URI;
	readonly canvas;
	readonly serializationId = crypto.randomUUID();
	private readonly labelChanged = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChanged.event;

	constructor(
		readonly reference: ICanvasReference,
		canvas: ICanvas,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
	) {
		super();
		this.resource = URI.from({ scheme: 'session-canvas', path: reference.canvas.path });
		this.canvas = observableValue(this, canvas);
	}

	getName(): string {
		return this.canvas.get().title;
	}
	getDescription(): string {
		return localize('canvas.description', 'Closing this tab hides the Canvas. Use Open Canvas to reopen it beside its conversation.');
	}

	setCanvas(canvas: ICanvas): void {
		const previous = this.canvas.get();
		this.canvas.set(canvas, undefined);
		if (previous.title !== canvas.title) {
			this.labelChanged.fire();
		}
	}

	canMove(_sourceGroup: number, targetGroup: number): true | string {
		return this.groups.getGroup(targetGroup) ? true : localize('canvas.mainWindowOnly', 'Keep the Canvas in its conversation window.');
	}
}
