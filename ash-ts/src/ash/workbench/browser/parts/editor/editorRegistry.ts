import {
	type IDisposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import type {
	EditorOpenOptions,
	EditorInput,
} from "./editorInput.js";
import {
	EditorPaneMatch,
	type IEditorPaneDescriptor,
} from "./editorPane.js";

/** Owns the editor implementations available in one product module graph. */
export class EditorPaneRegistry {
	private readonly descriptors = new Map<string, IEditorPaneDescriptor>();

	register(descriptor: IEditorPaneDescriptor): IDisposable {
		this.add(descriptor);
		return toDisposable(() => {
			if (this.descriptors.get(descriptor.id) === descriptor) {
				this.descriptors.delete(descriptor.id);
			}
		});
	}

	/** Registers a descriptor that intentionally lives for the module realm. */
	registerStatic(descriptor: IEditorPaneDescriptor): void {
		this.add(descriptor);
	}

	get(id: string): IEditorPaneDescriptor | undefined {
		return this.descriptors.get(id);
	}

	/**
	 * Returns compatible editors in default-selection order.
	 *
	 * Higher matches come first. Registration order resolves equal matches so
	 * mode contribution order remains deterministic.
	 */
	getEditors(input: EditorInput): readonly IEditorPaneDescriptor[] {
		return Array.from(this.descriptors.values())
			.map((descriptor, index) => {
				const match = descriptor.canOpen(input);
				validateMatch(match, descriptor.id);
				return { descriptor, index, match };
			})
			.filter(({ match }) => match !== EditorPaneMatch.None)
			.sort((left, right) =>
				right.match - left.match || left.index - right.index
			)
			.map(({ descriptor }) => descriptor);
	}

	resolve(
		input: EditorInput,
		options: EditorOpenOptions = {},
	): IEditorPaneDescriptor {
		const preferredEditorId = options.preferredEditorId;
		if (preferredEditorId !== undefined) {
			const preferred = this.descriptors.get(preferredEditorId);
			if (!preferred) {
				throw new RangeError(`Unknown editor pane '${preferredEditorId}'`);
			}
			if (preferred.canOpen(input) === EditorPaneMatch.None) {
				throw new RangeError(
					`Editor pane '${preferredEditorId}' cannot open ${input.resource}`,
				);
			}
			return preferred;
		}

		const selected = this.getEditors(input)[0];
		if (!selected) {
			throw new RangeError(`No editor can open ${input.resource}`);
		}
		return selected;
	}

	private add(descriptor: IEditorPaneDescriptor): void {
		validateDescriptor(descriptor);
		if (this.descriptors.has(descriptor.id)) {
			throw new Error(`Editor pane is already registered: ${descriptor.id}`);
		}
		this.descriptors.set(descriptor.id, descriptor);
	}
}

/** Realm-scoped declarations populated by the selected build-mode contribution. */
export const EditorPanes = new EditorPaneRegistry();

export function registerEditorPane(
	descriptor: IEditorPaneDescriptor,
): void {
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
	if (
		match !== EditorPaneMatch.None &&
		match !== EditorPaneMatch.Optional &&
		match !== EditorPaneMatch.Builtin &&
		match !== EditorPaneMatch.Default
	) {
		throw new TypeError(
			`Editor pane '${editorId}' returned an invalid match`,
		);
	}
}
