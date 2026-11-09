import { getKeybindingLabel, getKeybindingLabelParts, KeybindingLabelStyle } from '../../../../base/common/keybindingLabels.js';
import { Keybinding, logicalKey, physicalKey, type KeybindingChord, type KeybindingModifiers, type ResolvedKeybinding } from '../../../../base/common/keybindings.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, type Context, type ContextKeyValue } from '../../../../platform/contextkey/common/contextkey.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { GOTO_NEXT_CHANGE, GOTO_PREVIOUS_CHANGE } from '../../../../workbench/browser/parts/editor/diffEditorCommands.js';
import { ActiveEditorContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { DIFF_EDITOR_ID } from '../../../../workbench/common/editor/diffEditorInput.js';
import { BrowserViewEditorId } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { CONTEXT_DEBUG_STATE } from '../../../../workbench/contrib/debug/common/debug.js';
import { NewSessionPickersAvailableContext } from '../../chat/browser/newChatPickerKeybinding.js';
import { designCanvasShortcutKeys, designVectorShortcutKeys } from '../../artifacts/browser/designShortcutKeys.js';

interface Shortcut {
	readonly title: string;
	readonly bindings: readonly ResolvedKeybinding[];
}

export type ShortcutArea = 'general' | 'browser' | 'debug' | 'diff' | 'apps' | 'agent';

interface ShortcutGroup {
	readonly area: ShortcutArea;
	readonly title: string;
	readonly shortcuts: readonly Shortcut[];
}

const modifierSymbols: Readonly<Record<string, string>> = { '⌃': 'ctrl', '⇧': 'shift', '⌥': 'alt', '⌘': 'cmd' };

export function filterSessionsKeyboardShortcutGroups(groups: readonly ShortcutGroup[], search: string, keybindings: IKeybindingService): readonly ShortcutGroup[] {
	const query = search.trim().toLocaleLowerCase();
	if (!query) return groups;

	const terms = query.split(/\s+/u);
	const keyQuery = query
		.replace(/([⌃⇧⌥⌘])\s*\+?\s*(?=\S)/gu, (_match, symbol: string) => modifierSymbols[symbol] + '+')
		.replace(/\s*\+\s*/gu, '+');
	const parsed = keyQuery === '+'
		? keybindings.resolveKeybinding(Keybinding.single(logicalKey('+')))
		: keybindings.resolveUserBinding(keyQuery.replace(/\bpage\s+(up|down)\b/gu, 'page$1'));
	const queryChords = parsed && chordLabels(parsed);
	const matchesKeys = (binding: ResolvedKeybinding): boolean => {
		if (queryChords) {
			const chords = chordLabels(binding);
			return chords.some((_chord, start) => queryChords.every((chord, offset) => chords[start + offset] === chord));
		}
		return [KeybindingLabelStyle.UI, KeybindingLabelStyle.Aria, KeybindingLabelStyle.UserSettings].some(style =>
			getKeybindingLabel(binding, style).toLocaleLowerCase().includes(keyQuery));
	};

	return groups.map(group => ({
		...group,
		shortcuts: group.shortcuts.filter(shortcut => {
			const name = `${group.title} ${shortcut.title}`.toLocaleLowerCase();
			return terms.every(term => name.includes(term)) || shortcut.bindings.some(matchesKeys);
		}),
	})).filter(group => group.shortcuts.length > 0);
}

function chordLabels(binding: ResolvedKeybinding): readonly string[] {
	return getKeybindingLabelParts(binding).map(part => part.ariaLabel.toLocaleLowerCase());
}

interface Scope {
	readonly group: ShortcutGroupId;
	readonly keys: readonly string[];
	readonly values: Readonly<Record<string, ContextKeyValue>>;
}

const groupAreas = {
	conversations: 'agent',
	newCode: 'agent',
	navigation: 'general',
	terminal: 'general',
	browser: 'browser',
	debug: 'debug',
	diff: 'diff',
	designCanvas: 'apps',
	designLayers: 'apps',
	designVector: 'apps',
	designText: 'apps',
	designPrototype: 'apps',
} satisfies Record<string, ShortcutArea>;

type ShortcutGroupId = keyof typeof groupAreas;

const windowKey = IsSessionsWindowContext.key;
const canvasKey = 'sessionsDesignCanvasActive';
const layersKey = 'sessionsDesignLayersFocused';
const designTextKey = 'sessionsDesignTextEditing';
const codeKey = 'sessions.desktopCode';
const editorToolKey = 'sessions.editorTool';
const pickersKey = NewSessionPickersAvailableContext.key;
const agentKeys = new Set([windowKey, canvasKey, layersKey, designTextKey, codeKey, pickersKey]);

// Resolve the bindings as if the feature owned focus, so shortcuts for hidden
// panes and inactive editing modes are still discoverable from this modal.
const scopes: readonly Scope[] = [
	{ group: 'newCode', keys: [pickersKey], values: { [pickersKey]: true, [ChatContextKeys.inChatInput.key]: true } },
	{ group: 'terminal', keys: [codeKey], values: { [codeKey]: true } },
	{ group: 'designLayers', keys: [layersKey], values: { [layersKey]: true } },
	{ group: 'designCanvas', keys: [canvasKey], values: { [canvasKey]: true } },
	{ group: 'designText', keys: [designTextKey], values: { [designTextKey]: true } },
	{ group: 'conversations', keys: [editorToolKey], values: { [editorToolKey]: false } },
	{ group: 'navigation', keys: [windowKey], values: {} },
];

// Include shared commands from these tools only when the Sessions renderer has
// registered a binding that resolves in a representative tool context.
const toolScopes = [
	{
		group: 'browser',
		matches: (command: string) => command.startsWith('workbench.action.browser.'),
		values: { [ActiveEditorContext.key]: BrowserViewEditorId, browserCanGoBack: true, browserCanGoForward: true, browserHasUrl: true, browserHasError: false },
	},
	{
		group: 'debug',
		matches: (command: string) => command.startsWith('workbench.action.debug.') || command.startsWith('editor.debug.'),
		values: { [ActiveEditorContext.key]: undefined, [CONTEXT_DEBUG_STATE.key]: 'running', [EditorContextKeys.editorTextFocus.key]: true },
	},
	{
		group: 'diff',
		matches: (command: string) => command === GOTO_NEXT_CHANGE || command === GOTO_PREVIOUS_CHANGE,
		values: { [ActiveEditorContext.key]: DIFF_EDITOR_ID },
	},
] as const;

export function getSessionsKeyboardShortcutGroups(keybindings: IKeybindingService, context: Context): readonly ShortcutGroup[] {
	const groups = new Map<ShortcutGroupId, Shortcut[]>(
		(Object.keys(groupAreas) as ShortcutGroupId[]).map(id => [id, []]),
	);
	const names: Record<ShortcutGroupId, string> = {
		conversations: localize('sessions.shortcuts.conversations', 'Conversations'),
		newCode: localize('sessions.shortcuts.newCodeConversation', 'New Code Conversation'),
		navigation: localize('sessions.shortcuts.navigation', 'Navigation and Layout'),
		terminal: localize('sessions.shortcuts.terminal', 'Terminal in Code'),
		browser: localize('sessions.shortcuts.browser', 'Browser'),
		debug: localize('sessions.shortcuts.debug', 'Debug'),
		diff: localize('sessions.shortcuts.diff', 'Diff'),
		designCanvas: localize('sessions.shortcuts.designCanvas', 'Design Canvas'),
		designLayers: localize('sessions.shortcuts.designLayers', 'Design Layers'),
		designVector: localize('sessions.shortcuts.designVector', 'Design Vector Editing'),
		designText: localize('sessions.shortcuts.designText', 'Design Text Editing'),
		designPrototype: localize('sessions.shortcuts.designPrototype', 'Design Prototype Preview'),
	};

	const commands = CommandsRegistry.getCommands();
	const inactive: Readonly<Record<string, ContextKeyValue>> = {
		[pickersKey]: false, [codeKey]: false, [canvasKey]: false, [layersKey]: false,
		[designTextKey]: false, [editorToolKey]: undefined,
	};
	const windowContexts = scopes.map(scope => ({
		scope,
		inside: overlay(context, { ...inactive, ...scope.values, [windowKey]: true }),
		outside: overlay(context, { ...scope.values, ...inactive, [windowKey]: false }),
	}));
	const tools = toolScopes.map(scope => ({ ...scope, inside: overlay(context, { ...inactive, ...scope.values, [windowKey]: true }) }));
	const registered = new Map<string, { command: string; title: string; group: ShortcutGroupId; inside: Context; outside?: Context; keys: Set<string>; }>();
	for (const { command, when, resolvedKeybinding } of keybindings.getKeybindings()) {
		const name = command && commands.get(command)?.metadata?.description;
		if (!command || !name || !resolvedKeybinding) continue;
		const tool = tools.find(tool => tool.matches(command));
		let group: ShortcutGroupId;
		let inside: Context;
		let outside: Context | undefined;
		if (tool) {
			({ group, inside } = tool);
		} else {
			if (!when || !ContextKeyExpr.requiresTruthyKeyFrom(when, agentKeys)) continue;
			const keys = when.keys();
			const match = windowContexts.find(({ scope }) => scope.keys.some(key => keys.has(key)));
			if (!match || !when.evaluate(match.inside)) continue;
			group = match.scope.group;
			({ inside, outside } = match);
		}
		const id = group + '/' + command;
		let row = registered.get(id);
		if (!row) {
			row = { command, title: typeof name === 'string' ? name : name.value, group, inside, outside, keys: new Set() };
			registered.set(id, row);
		}
		row.keys.add(bindingId(resolvedKeybinding));
	}
	for (const { command, title, group, inside, outside, keys } of registered.values()) {
		const shared = new Set(outside && keybindings.lookupKeybindings(command, outside).map(bindingId));
		// Match displayed registrations against effective bindings without listing
		// the keyboard layout's extra dispatch variants.
		const bindings = keybindings.lookupKeybindings(command, inside).filter(binding => {
			const id = bindingId(binding);
			return !shared.has(id) && keys.delete(id);
		});
		if (bindings.length) groups.get(group)!.push({ title, bindings });
	}

	for (const [group, title, chords] of widgetShortcuts()) {
		groups.get(group)!.push({ title, bindings: chords.map(chord => keybindings.resolveKeybinding(Keybinding.single(chord))) });
	}
	return [...groups].filter(([, shortcuts]) => shortcuts.length).map(([id, shortcuts]) => ({ area: groupAreas[id], title: names[id], shortcuts }));
}

function overlay(context: Context, values: Readonly<Record<string, ContextKeyValue>>): Context {
	return { getValue: <T extends ContextKeyValue>(key: string) => Object.hasOwn(values, key) ? values[key] as T : context.getValue<T>(key) };
}

function bindingId(binding: ResolvedKeybinding): string {
	return getKeybindingLabel(binding, KeybindingLabelStyle.UserSettings);
}

const primary = { primaryKey: true } as const;
const altShift = { altKey: true, shiftKey: true } as const;
const shift = { shiftKey: true } as const;
const arrows = ['ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'];

function keys(names: readonly string[], modifiers?: KeybindingModifiers): KeybindingChord[] {
	return names.map(name => logicalKey(name, modifiers));
}

function vectorKey(key: string, modifiers: KeybindingModifiers): KeybindingChord {
	return physicalKey(`Key${key.toUpperCase()}`, modifiers);
}

/** Feature operations handled by their widgets, outside the command keybinding registry. */
function widgetShortcuts(): readonly (readonly [ShortcutGroupId, string, readonly KeybindingChord[]])[] {
	return [
		['conversations', localize({ bundle: 'ash.sessions', key: 'sessions.list.inlineSearch' }, 'Search sessions in the sidebar'), keys(['f'], primary)],
		['conversations', localize('sessions.shortcuts.cancelDictation', 'Cancel active chat dictation'), keys(['Escape'])],
		['navigation', localize('sessions.shortcuts.moveToolPane', 'Move a focused Code tool pane'), keys(arrows, altShift)],
		['designCanvas', localize('sessions.shortcuts.addFrame', 'Add a frame'), keys([designCanvasShortcutKeys.addFrame])],
		['designCanvas', localize('sessions.shortcuts.importImage', 'Import an image'), keys([designCanvasShortcutKeys.importImage])],
		['designCanvas', localize('sessions.shortcuts.selectTool', 'Switch to the selection tool'), keys([designCanvasShortcutKeys.selectTool])],
		['designCanvas', localize('sessions.shortcuts.handTool', 'Switch to the hand tool'), keys([designCanvasShortcutKeys.handTool])],
		['designCanvas', localize('sessions.shortcuts.addRectangle', 'Add a rectangle'), keys([designCanvasShortcutKeys.addRectangle])],
		['designCanvas', localize('sessions.shortcuts.addEllipse', 'Add an ellipse'), keys([designCanvasShortcutKeys.addEllipse])],
		['designCanvas', localize('sessions.shortcuts.textTool', 'Switch to the text tool'), keys([designCanvasShortcutKeys.textTool])],
		['designCanvas', localize('sessions.shortcuts.penTool', 'Switch to the pen tool'), keys([designCanvasShortcutKeys.penTool])],
		['designCanvas', localize('sessions.shortcuts.zoomIn', 'Zoom in'), keys([designCanvasShortcutKeys.zoomIn, designCanvasShortcutKeys.zoomInAlternate])],
		['designCanvas', localize('sessions.shortcuts.zoomOut', 'Zoom out'), keys([designCanvasShortcutKeys.zoomOut, designCanvasShortcutKeys.zoomOutAlternate])],
		['designCanvas', localize('sessions.shortcuts.resetZoom', 'Reset the canvas view'), keys([designCanvasShortcutKeys.resetZoom])],
		['designCanvas', localize('sessions.shortcuts.pan', 'Pan the canvas with no selection'), keys(arrows)],
		['designLayers', localize('sessions.design.group', 'Group'), keys([designCanvasShortcutKeys.group])],
		['designLayers', localize('sessions.design.ungroup', 'Ungroup'), keys([designCanvasShortcutKeys.ungroup])],
		['designLayers', localize('sessions.shortcuts.addToSelection', 'Add the next layer to the selection'), keys([designCanvasShortcutKeys.addToSelection])],
		['designLayers', localize('sessions.shortcuts.nextLayer', 'Select the next layer on the canvas'), keys(['Tab'])],
		['designLayers', localize('sessions.shortcuts.previousLayer', 'Select the previous layer on the canvas'), keys(['Tab'], shift)],
		['designLayers', localize('sessions.shortcuts.deleteLayers', 'Delete selected layers'), keys(['Delete', 'Backspace'])],
		['designLayers', localize('sessions.shortcuts.nudge', 'Move selected layers by one pixel'), keys(arrows)],
		['designLayers', localize('sessions.shortcuts.nudgeFar', 'Move selected layers by ten pixels'), keys(arrows, shift)],
		['designLayers', localize('sessions.shortcuts.clearSelection', 'Clear the canvas selection'), keys(['Escape'])],
		['designVector', localize('sessions.design.vectorFlatten', 'Flatten selection'), [vectorKey(designVectorShortcutKeys.flatten, altShift), vectorKey(designVectorShortcutKeys.transform, primary)]],
		['designVector', localize('sessions.design.vectorOutline', 'Outline stroke'), [vectorKey(designVectorShortcutKeys.outline, { ...primary, altKey: true }), vectorKey(designVectorShortcutKeys.transform, { ...primary, shiftKey: true })]],
		['designVector', localize('sessions.design.vectorUnion', 'Union selection'), [vectorKey(designVectorShortcutKeys.union, altShift)]],
		['designVector', localize('sessions.design.vectorSubtract', 'Subtract selection'), [vectorKey(designVectorShortcutKeys.subtract, altShift)]],
		['designVector', localize('sessions.design.vectorIntersect', 'Intersect selection'), [vectorKey(designVectorShortcutKeys.intersect, altShift)]],
		['designVector', localize('sessions.design.vectorExclude', 'Exclude selection'), [vectorKey(designVectorShortcutKeys.exclude, altShift)]],
		['designVector', localize('sessions.shortcuts.editVector', 'Toggle editing for the selected path'), keys(['Enter'])],
		['designVector', localize('sessions.shortcuts.paintRegions', 'Toggle painting vector regions'), [physicalKey(designVectorShortcutKeys.paintRegions, shift)]],
		['designVector', localize('sessions.shortcuts.finishBranch', 'Finish drawing a pen branch'), keys(['Enter', 'Escape'])],
		['designVector', localize('sessions.shortcuts.deletePoints', 'Delete selected vector nodes, width points, or gradient stops'), keys(['Delete', 'Backspace'])],
		['designVector', localize('sessions.design.vectorHeal', 'Delete and heal'), keys(['Delete', 'Backspace'], shift)],
		['designVector', localize('sessions.shortcuts.movePoints', 'Move selected vector nodes, gradient stops, or blur endpoints'), keys(arrows)],
		['designVector', localize('sessions.shortcuts.movePointsFar', 'Move nodes, stops, or endpoints in larger steps'), keys(arrows, shift)],
		['designVector', localize('sessions.shortcuts.switchBlurEndpoint', 'Switch the progressive blur endpoint'), keys(['Enter'])],
		['designVector', localize('sessions.shortcuts.applyOffset', 'Apply the offset preview'), keys(['Enter'])],
		['designVector', localize('sessions.shortcuts.exitVectorEditing', 'Exit vector, gradient, or blur editing'), keys(['Escape'])],
		['designText', localize('sessions.shortcuts.editText', 'Edit the selected text layer'), keys(['Enter', 'F2'])],
		['designText', localize('sessions.shortcuts.finishText', 'Finish editing text'), [logicalKey('Escape'), logicalKey('Enter', primary)]],
		['designPrototype', localize('sessions.shortcuts.scrollPrototype', 'Scroll the prototype preview'), keys(arrows)],
		['designPrototype', localize('sessions.shortcuts.scrollPrototypePage', 'Scroll the prototype preview by a page'), keys(['PageUp', 'PageDown'])],
		['designPrototype', localize('sessions.shortcuts.scrollPrototypeEdge', 'Jump to the start or end of the scroll region'), keys(['Home', 'End'])],
	];
}
