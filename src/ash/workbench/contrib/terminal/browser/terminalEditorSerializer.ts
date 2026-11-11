import { URI } from '../../../../base/common/uri.js';
import { Orientation } from '../../../../base/browser/ui/grid/grid.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { requireRecord, requireString, type EditorInputSerializer } from '../../../services/editor/common/editorInputSerializer.js';
import { TerminalEditorInput, type TerminalEditorPaneLayout, type TerminalEditorPaneState } from './terminalEditorInput.js';
import { parseTerminalUri } from './terminalUri.js';

/** Persist tab and pane identities without executable or process launch data. */
export class TerminalInputSerializer implements EditorInputSerializer {
	readonly typeId = TerminalEditorInput.ID;
	canSerialize(input: IResourceEditorInput): boolean { return input instanceof TerminalEditorInput; }
	serialize(input: IResourceEditorInput): unknown {
		if (!(input instanceof TerminalEditorInput)) throw new TypeError('Invalid terminal editor input');
		const resource = input.resource.toString();
		const layout = input.layout.get();
		return !layout || ('resource' in layout && layout.resource.path === input.resource.path) ? { resource }
			: { resource, layout: serializeLayout(layout) };
	}
	deserialize(value: unknown): TerminalEditorInput {
		const record = requireRecord(value, 'terminal editor input');
		const resource = URI.parse(requireString(record.resource, 'terminal editor resource'));
		const paths = new Set<string>();
		if (record.layout !== undefined) return new TerminalEditorInput(resource, undefined, undefined, parseLayout(record.layout, paths));
		if (record.panes === undefined) return new TerminalEditorInput(resource);
		if (!Array.isArray(record.panes) || !record.panes.length) throw new TypeError('Invalid terminal editor panes');
		const panes = record.panes.map(value => parsePane(requireRecord(value, 'terminal editor pane'), paths));
		const layout = panes.length === 1 ? panes[0]! : { orientation: Orientation.VERTICAL, size: 1, children: panes };
		return new TerminalEditorInput(resource, undefined, undefined, layout);
	}
}

function serializeLayout(layout: TerminalEditorPaneLayout): unknown {
	return 'resource' in layout ? { resource: layout.resource.toString(), size: layout.size }
		: { orientation: layout.orientation, size: layout.size, children: layout.children.map(serializeLayout) };
}

function paneSize(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) throw new TypeError('Invalid terminal editor pane size');
	return value;
}

function parsePane(pane: Record<string, unknown>, paths: Set<string>): TerminalEditorPaneState {
	const resource = URI.parse(requireString(pane.resource, 'terminal pane resource'));
	parseTerminalUri(resource);
	if (paths.has(resource.path)) throw new TypeError('Duplicate terminal editor pane');
	paths.add(resource.path);
	return { resource, size: paneSize(pane.size) };
}

function parseLayout(value: unknown, paths: Set<string>, depth = 0, parentOrientation?: Orientation): TerminalEditorPaneLayout {
	if (depth > 64) throw new TypeError('Terminal editor layout is too deeply nested');
	const node = requireRecord(value, 'terminal editor layout');
	if (node.children === undefined) return parsePane(node, paths);
	const { orientation, children } = node;
	if ((orientation !== Orientation.VERTICAL && orientation !== Orientation.HORIZONTAL) || orientation === parentOrientation
		|| !Array.isArray(children) || children.length < 2) throw new TypeError('Invalid terminal editor split');
	return { orientation, size: paneSize(node.size), children: children.map(child => parseLayout(child, paths, depth + 1, orientation)) };
}
