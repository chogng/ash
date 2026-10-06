import type { IResourceEditorInput } from '../common/editor.js';
import { Emitter, type Event } from '../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import type { EditorOpenOptions } from '../services/editor/common/editorService.js';
import { EditorPaneMatch, type EditorPaneCreationOptions, type IEditorPane } from './parts/editor/editorPane.js';

/** Resource matchers are pure; Workbench inputs are values rather than input classes. */
export interface IEditorPaneDescriptor {
	readonly id: string;
	readonly name: string;
	canOpen(input: IResourceEditorInput): EditorPaneMatch;
	/** Creates a distinct tab identity when this editor opens beside the source. */
	createInput?(source: IResourceEditorInput): IResourceEditorInput;
	create(options: EditorPaneCreationOptions): IEditorPane;
}

export interface IEditorPaneRegistry {
	readonly onDidChange: Event<void>;
	registerEditorPane(descriptor: IEditorPaneDescriptor): IDisposable;
	getEditorPane(input: IResourceEditorInput, options?: EditorOpenOptions): IEditorPaneDescriptor | undefined;
	getEditorPanes(): readonly IEditorPaneDescriptor[];
	getEditorPanesForInput(input: IResourceEditorInput): readonly IEditorPaneDescriptor[];
}

/** Owns editor declarations and matching; editor groups own the created panes. */
export class EditorPaneRegistry implements IEditorPaneRegistry {
	private readonly descriptors = new Map<string, IEditorPaneDescriptor>();
	private readonly changeEmitter = new Emitter<void>();
	public readonly onDidChange: Event<void> = this.changeEmitter.event;

	public registerEditorPane(descriptor: IEditorPaneDescriptor): IDisposable {
		this.add(descriptor);
		return toDisposable(() => {
			if (this.descriptors.get(descriptor.id) === descriptor) {
				this.descriptors.delete(descriptor.id);
				this.changeEmitter.fire();
			}
		});
	}

	/** Product contributions retain their declarations for the module lifetime. */
	public registerStatic(descriptor: IEditorPaneDescriptor): void {
		this.add(descriptor);
	}

	public getEditorPanes(): readonly IEditorPaneDescriptor[] {
		return [...this.descriptors.values()];
	}

	/** Registration order breaks ties between equally suitable panes. */
	public getEditorPanesForInput(input: IResourceEditorInput): readonly IEditorPaneDescriptor[] {
		return Array.from(this.descriptors.values())
			.map((descriptor, index) => {
				const match = descriptor.canOpen(input);
				validateMatch(match, descriptor.id);
				return { descriptor, index, match };
			})
			.filter(({ match }) => match !== EditorPaneMatch.None)
			.sort((left, right) => right.match - left.match || left.index - right.index)
			.map(({ descriptor }) => descriptor);
	}

	public getEditorPane(input: IResourceEditorInput, options: EditorOpenOptions = {}): IEditorPaneDescriptor | undefined {
		const preferredEditorId = options.preferredEditorId;
		if (preferredEditorId !== undefined) {
			const preferred = this.descriptors.get(preferredEditorId);
			if (!preferred) {
				throw new RangeError(`Unknown editor pane '${preferredEditorId}'`);
			}
			if (preferred.canOpen(input) === EditorPaneMatch.None) {
				throw new RangeError(`Editor pane '${preferredEditorId}' cannot open ${input.resource}`);
			}
			return preferred;
		}
		return this.getEditorPanesForInput(input)[0];
	}

	private add(descriptor: IEditorPaneDescriptor): void {
		validateDescriptor(descriptor);
		if (this.descriptors.has(descriptor.id)) {
			throw new Error(`Editor pane is already registered: ${descriptor.id}`);
		}
		this.descriptors.set(descriptor.id, descriptor);
		this.changeEmitter.fire();
	}
}

/** Shared by product contributions and every editor host in the module realm. */
export const EditorPanes = new EditorPaneRegistry();

export function registerEditorPane(descriptor: IEditorPaneDescriptor): void {
	EditorPanes.registerStatic(descriptor);
}

function validateDescriptor(descriptor: IEditorPaneDescriptor): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(descriptor.id)) {
		throw new TypeError(`Invalid editor pane ID: ${descriptor.id}`);
	}
	if (descriptor.name.trim().length === 0) {
		throw new TypeError(`Editor pane '${descriptor.id}' requires a name`);
	}
}

function validateMatch(match: EditorPaneMatch, editorId: string): void {
	if (match !== EditorPaneMatch.None && match !== EditorPaneMatch.Optional && match !== EditorPaneMatch.Builtin && match !== EditorPaneMatch.Default) {
		throw new TypeError(`Editor pane '${editorId}' returned an invalid match`);
	}
}
