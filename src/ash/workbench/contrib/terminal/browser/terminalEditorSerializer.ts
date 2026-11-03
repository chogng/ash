import { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { requireRecord, requireString, type EditorInputSerializer } from '../../../services/editor/common/editorInputSerializer.js';
import { TerminalEditorInput } from './terminalEditorInput.js';
import { parseTerminalUri } from './terminalUri.js';

/** Persist identity only. A missing live instance is displayed as unavailable, never relaunched. */
export class TerminalInputSerializer implements EditorInputSerializer {
	readonly typeId = TerminalEditorInput.ID;
	canSerialize(input: IResourceEditorInput): boolean { return input instanceof TerminalEditorInput; }
	serialize(input: IResourceEditorInput): unknown {
		if (!(input instanceof TerminalEditorInput)) throw new TypeError('Invalid terminal editor input');
		const resource = input.resource.toString();
		const panes = input.panes.get();
		return panes.length === 1 && panes[0]!.resource.path === input.resource.path ? { resource }
			: { resource, panes: panes.map(pane => ({ resource: pane.resource.toString(), size: pane.size })) };
	}
	deserialize(value: unknown): TerminalEditorInput {
		const record = requireRecord(value, 'terminal editor input');
		const resource = URI.parse(requireString(record.resource, 'terminal editor resource'));
		if (record.panes === undefined) return new TerminalEditorInput(resource);
		if (!Array.isArray(record.panes) || !record.panes.length) throw new TypeError('Invalid terminal editor panes');
		const paths = new Set<string>();
		const panes = record.panes.map(value => {
			const pane = requireRecord(value, 'terminal editor pane');
			const uri = URI.parse(requireString(pane.resource, 'terminal pane resource'));
			parseTerminalUri(uri);
			if (paths.has(uri.path)
				|| typeof pane.size !== 'number' || !Number.isFinite(pane.size) || pane.size <= 0 || pane.size > 1) {
				throw new TypeError('Invalid terminal editor pane');
			}
			paths.add(uri.path);
			return { resource: uri, size: pane.size };
		});
		return new TerminalEditorInput(resource, undefined, undefined, panes);
	}
}
