import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { IMarkerService, MarkerSeverity } from '../../../src/ash/platform/markers/common/markers.js';
import { Color } from '../../../src/ash/base/common/color.js';
import { TokenizationRegistry } from '../../../src/ash/editor/common/languages.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';
import { EditorOption } from '../../../src/ash/editor/common/config/editorOptions.js';
import { ScrollType } from '../../../src/ash/editor/common/editorCommon.js';

interface EditorState {
	readonly value: string | null;
	readonly disposed: boolean;
	readonly registered: boolean;
	readonly modelRegistered: boolean;
	readonly mounted: boolean;
	readonly placeholder: boolean;
	readonly theme: string | null;
}

interface CreationEvent {
	readonly model: string;
	readonly registered: boolean;
	readonly mounted: boolean;
	readonly placeholder: boolean;
	readonly theme: string | null;
}

interface UndoState {
	readonly value: string;
	readonly version: number;
	readonly callerSelections: readonly string[];
	readonly ownedSelections: readonly string[];
	readonly callerFocused: boolean;
	readonly ownedFocused: boolean;
	readonly activeInput: 'caller' | 'owned' | 'other';
}

interface LineIdentityState {
	readonly value: string;
	readonly version: number;
	readonly ids: readonly string[];
	readonly longLineIndex: number;
	readonly longLineEnd: readonly [number, number];
}

interface KeyboardEditingState {
	readonly value: string;
	readonly version: number;
	readonly selection: string | null;
	readonly focused: boolean;
}

interface WrappedLayoutState {
	readonly value: string;
	readonly version: number;
	readonly modelLineCount: number;
	readonly contentHeight: number;
}

interface ViewZoneState {
	readonly version: number;
	readonly lineTop: number;
	readonly contentHeight: number;
	readonly computedHeights: readonly number[];
}

interface StandaloneHarness {
	prepareReferencePreview(): void;
	setParentFontSize(): void;
	updateRenderingOptions(enabled: boolean): number;
	setTestMarkers(enabled: boolean): void;
	setMinimapColor(color: string): void;
	readMinimapPixel(): number[];

	checkContracts(): Promise<{ wrapping: string; wrapped: boolean; animated: boolean; settled: boolean; top: number; interrupted: boolean; detached: boolean; eventTexts: string[] }>;
	readonly events: readonly CreationEvent[];
	state(kind: 'caller' | 'owned'): EditorState;
	switchOwnedToCaller(): { readonly ownedModelDisposed: boolean; readonly ownedModelRegistered: boolean; readonly rootRetained: boolean; readonly editorCount: number; readonly currentModelIsCaller: boolean };
	detachOwned(): { readonly modelIsNull: boolean; readonly value: string; readonly rootMounted: boolean; readonly inputCount: number };
	reattachOwned(): void;
	getOwnedValue(): string;
	getCallerVersion(): number;
	tryOverlappingSurrogateEdits(): { readonly rejected: boolean; readonly value: string; readonly versionUnchanged: boolean };
	applySurrogateEdit(): string;
	resetSameValue(): {
		readonly beforeVersion: number;
		readonly afterVersion: number;
		readonly alternativeVersion: number;
		readonly snapshotValue: string | null;
		readonly events: readonly { readonly version: number; readonly reason: string; readonly changes: number }[];
	};
	prepareSelectionUndo(): UndoState;
	applySelectionEdit(): UndoState;
	readSelectionUndo(): UndoState;
	enableCodeActions(): void;
	prepareLineIdentity(): LineIdentityState;
	splitLineIdentity(): LineIdentityState;
	readLineIdentity(): LineIdentityState;
	openLargeModel(): {
		readonly textUnits: number;
		readonly lineCount: number;
		readonly tooLargeForTokenization: boolean;
		readonly tooLargeForSynchronization: boolean;
		readonly attachedEditors: number;
		readonly firstChunkPrefix: string;
	};
	enableCompletionNavigation(snippet?: boolean): void;
	getCallerPosition(): { readonly lineNumber: number; readonly column: number } | null;
	prepareKeyboardEditing(): KeyboardEditingState;
	readKeyboardEditing(): KeyboardEditingState;
	selectRange(): KeyboardEditingState;
	prepareClipboard(): KeyboardEditingState;
	prepareWrappedLayout(): WrappedLayoutState;
	prepareProportionalWrap(): WrappedLayoutState;
	resizeWrappedLayout(width: number): WrappedLayoutState;
	editWrappedText(value: string): WrappedLayoutState;
	readWrappedLayout(): WrappedLayoutState;
	prepareViewZone(unit: 'pixels' | 'lines'): ViewZoneState;
	prepareFoldedViewZone(showInHiddenAreas: boolean): number;
	resizeViewZone(height: number, afterLineNumber: number): ViewZoneState;
	removeViewZone(): ViewZoneState;
	prepareVisibleRows(): { readonly lineCount: number; readonly version: number };
	scrollVisibleRows(top: number): number;
	editVisibleRow(lineIndex: number): string;
	prepareCursorGutter(): { readonly version: number; readonly modelLineCount: number };
	moveGutterCaret(lineNumber: number, column: number): void;
	shortenGutterLine(): number;
	preparePointerSelection(): void;
	readPointerSelection(): { readonly value: string; readonly version: number; readonly selection: string | null; readonly ownedSelection: string | null; readonly focused: boolean; readonly mouseUpEvents: number };
	prepareMultiCursor(): void;
	readMultiCursor(): { readonly value: string; readonly version: number; readonly selections: readonly string[]; readonly ownedSelections: readonly string[]; readonly focused: boolean };
	releaseCaller(): void;
	releaseOwned(): void;
	dispose(): void;
}

declare global {
	interface Window {
		ashStandaloneIntegration: StandaloneHarness;
	}
}

const callerContainer = document.querySelector<HTMLElement>('#caller')!;
const ownedContainer = document.querySelector<HTMLElement>('#owned')!;
const callerResource = stanza.URI.parse('inmemory://stanza/caller.txt');
const ownedResource = stanza.URI.parse('inmemory://stanza/owned.txt');
const events: CreationEvent[] = [];
const listener = stanza.editor.onDidCreateEditor(editor => {
	const model = editor.getModel();
	if (!model) throw new Error('Created standalone editor has no model');
	const container = model.uri.toString() === callerResource.toString() ? callerContainer : ownedContainer;
	events.push({
		model: model.uri.toString(),
		registered: stanza.editor.getEditors().includes(editor),
		mounted: container.contains(editor.getDomNode()),
		placeholder: editor.getContribution('editor.contrib.placeholderText') !== null,
		theme: container.getAttribute('data-color-theme'),
	});
});
const callerModel = stanza.editor.createModel('caller', 'plaintext', callerResource);
const callerEditor = stanza.editor.create(callerContainer, { model: callerModel, placeholder: 'Caller model' });
const ownedEditor = stanza.editor.create(ownedContainer, { value: 'owned', language: 'plaintext', resource: ownedResource, placeholder: 'Owned model' });
callerEditor.layout({ width: callerContainer.clientWidth, height: callerContainer.clientHeight });
ownedEditor.layout({ width: ownedContainer.clientWidth, height: ownedContainer.clientHeight });
const ownedModel = ownedEditor.getModel();
if (!ownedModel) throw new Error('Owned standalone editor has no model');
let pointerMouseUpEvents = 0;
const pointerMouseUpListener = callerEditor.onMouseUp(() => { pointerMouseUpEvents += 1; });
let referenceRegistration: { dispose(): void } | undefined;
let codeActionRegistration: ReturnType<typeof stanza.languages.registerCodeActionProvider> | undefined;
let completionRegistration: ReturnType<typeof stanza.languages.registerCompletionItemProvider> | undefined;
let viewZone: stanza.IViewZone | undefined;
let viewZoneId = '';
const computedZoneHeights: number[] = [];
let longLineId: string | undefined;
let largeModel: ReturnType<typeof stanza.editor.createModel> | undefined;

function state(kind: 'caller' | 'owned'): EditorState {
	const editor = kind === 'caller' ? callerEditor : ownedEditor;
	const model = kind === 'caller' ? callerModel : ownedModel;
	if (!model) throw new Error('Standalone integration model is missing');
	const container = kind === 'caller' ? callerContainer : ownedContainer;
	return {
		value: model.isDisposed() ? null : model.getValue(),
		disposed: model.isDisposed(),
		registered: stanza.editor.getEditors().includes(editor),
		modelRegistered: stanza.editor.getModel(model.uri) === model,
		mounted: container.contains(editor.getDomNode()),
		placeholder: container.querySelector('.stanza-editor-placeholder-text') !== null,
		theme: container.getAttribute('data-color-theme'),
	};
}

function readSelectionUndo(): UndoState {
	const callerSelections = callerEditor.getSelections();
	const ownedSelections = ownedEditor.getSelections();
	if (!callerSelections || !ownedSelections) throw new Error('Shared editor selections are unavailable');
	const activeElement = document.activeElement;
	let activeInput: UndoState['activeInput'] = 'other';
	if (callerContainer.contains(activeElement)) activeInput = 'caller';
	else if (ownedContainer.contains(activeElement)) activeInput = 'owned';
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		callerSelections: callerSelections.map(selection => selection.toString()),
		ownedSelections: ownedSelections.map(selection => selection.toString()),
		callerFocused: callerEditor.hasTextFocus(),
		ownedFocused: ownedEditor.hasTextFocus(),
		activeInput,
	};
}

function readLineIdentity(): LineIdentityState {
	if (!(callerModel instanceof stanza.TextModel) || !longLineId) throw new Error('Line identity model is unavailable');
	const end = callerModel.textPositionAt({ lineId: longLineId, offset: 6 });
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		ids: callerModel.lineDocument.lines.values.map(line => line.id),
		longLineIndex: callerModel.getLineIndex(longLineId),
		longLineEnd: [end.lineNumber, end.column],
	};
}

function readKeyboardEditing(): KeyboardEditingState {
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selection: callerEditor.getSelection()?.toString() ?? null,
		focused: callerEditor.hasTextFocus(),
	};
}

function readWrappedLayout(): WrappedLayoutState {
	return {
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		modelLineCount: callerModel.getLineCount(),
		contentHeight: callerEditor.getContentHeight(),
	};
}

function readViewZone(): ViewZoneState {
	return {
		version: callerModel.getVersionId(),
		lineTop: callerEditor.getTopForLineNumber(2),
		contentHeight: callerEditor.getContentHeight(),
		computedHeights: [...computedZoneHeights],
	};
}

window.ashStandaloneIntegration = {
	updateRenderingOptions: enabled => {
		callerEditor.updateOptions({
			minimap: { enabled, side: 'left', showSlider: 'always' },
			mouseStyle: enabled ? 'copy' : 'default',
			fontSize: enabled ? 18 : 14,
			wordWrap: enabled ? 'on' : 'off',
		});
		return callerModel.getVersionId();
	},
	prepareReferencePreview: () => {
		callerEditor.setValue('alpha beta\nalpha gamma');
		callerEditor.setPosition(new stanza.Position(1, 2));
		referenceRegistration?.dispose();
		referenceRegistration = stanza.languages.registerReferenceProvider('plaintext', {
			provideReferences: () => [
				{ resource: callerResource, range: new stanza.Range(1, 1, 1, 6) },
				{ resource: callerResource, range: new stanza.Range(2, 1, 2, 6) },
			],
		});
	},
	setParentFontSize: () => callerEditor.updateOptions({ fontSize: 18 }),
	setTestMarkers: enabled => {
		const markers = StandaloneServices.get().instantiationService.get(IMarkerService);
		if (enabled) markers.set('integration', [{ resource: callerResource, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 3 } }, severity: MarkerSeverity.Error, message: 'Test marker' }]);
		else markers.remove('integration');
	},
	setMinimapColor: color => {
		callerEditor.setValue('abcdefghijk');
		callerEditor.updateOptions({ minimap: { enabled: true } });
		TokenizationRegistry.setColorMap([Color.fromHex('#000000'), Color.fromHex(color), Color.fromHex('#ffffff')]);
	},
	readMinimapPixel: () => {
		const canvas = callerContainer.querySelector<HTMLCanvasElement>('.minimap canvas')!;
		const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
		for (let index = 0; index < data.length; index += 4) {
			if (data[index + 3] > 0) return Array.from(data.slice(index, index + 4));
		}
		return [];
	},
	checkContracts: async () => {
		const host = document.createElement('div');
		document.body.append(host);
		const instance = stanza.editor.create(host, { value: 'long text '.repeat(100) + '\n' + 'line\n'.repeat(100), wordWrap: 'on', smoothScrolling: true });
		const eventTexts: string[] = [];
		const listener = instance.onDidChangeModelContent(event => eventTexts.push(...event.changes.map(change => change.text)));
		try {
			instance.layout({ width: 260, height: 100 });
			const wrapping = instance.getOption(EditorOption.wordWrap);
			const wrapped = instance.getTopForLineNumber(2) > instance.getOption(EditorOption.lineHeight);
			instance.setScrollTop(600, ScrollType.Smooth);
			const animated = instance.hasPendingScrollAnimation();
			const deadline = performance.now() + 2000;
			while (instance.hasPendingScrollAnimation() && performance.now() < deadline) {
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			}
			const settled = !instance.hasPendingScrollAnimation();
			const top = instance.getScrollTop();
			instance.setScrollTop(900, ScrollType.Smooth);
			const root = instance.getDomNode()!;
			root.scrollTop = 200;
			root.dispatchEvent(new Event('scroll'));
			const interrupted = !instance.hasPendingScrollAnimation() && instance.getScrollTop() === 200;
			instance.executeEdits('test', [{ range: new stanza.Range(1, 1, 1, 1), text: 'X' }]);
			instance.setModel(null);
			instance.changeViewZones(() => { throw new Error('Detached callback must not run'); });
			instance.restoreViewState(null);
			const detached = instance.saveViewState() === null && !instance.hasPendingScrollAnimation();
			return { wrapping, wrapped, animated, settled, top, interrupted, detached, eventTexts };
		} finally {
			listener.dispose();
			instance.dispose();
			host.remove();
		}
	},
	events,
	state,
	switchOwnedToCaller: () => {
		const root = ownedEditor.getDomNode();
		ownedEditor.setModel(callerModel);
		return {
			ownedModelDisposed: ownedModel.isDisposed(),
			ownedModelRegistered: stanza.editor.getModel(ownedResource) !== null,
			rootRetained: ownedEditor.getDomNode() === root,
			editorCount: stanza.editor.getEditors().length,
			currentModelIsCaller: ownedEditor.getModel() === callerModel,
		};
	},
	detachOwned: () => {
		ownedEditor.setModel(null);
		return {
			modelIsNull: ownedEditor.getModel() === null,
			value: ownedEditor.getValue(),
			rootMounted: ownedContainer.contains(ownedEditor.getDomNode()),
			inputCount: ownedContainer.querySelectorAll('.stanza-editor-input').length,
		};
	},
	reattachOwned: () => ownedEditor.setModel(callerModel),
	getOwnedValue: () => ownedEditor.getValue(),
	getCallerVersion: () => callerModel.getVersionId(),
	tryOverlappingSurrogateEdits: () => {
		callerEditor.setValue('a📚b');
		const version = callerModel.getVersionId();
		let rejected = false;
		try {
			callerEditor.executeEdits('browser', [
				{ range: new stanza.Range(1, 2, 1, 3), text: 'X' },
				{ range: new stanza.Range(1, 3, 1, 4), text: 'Y' },
			]);
		} catch (error) {
			if (!(error instanceof Error) || !/overlap/u.test(error.message)) throw error;
			rejected = true;
		}
		return { rejected, value: callerModel.getValue(), versionUnchanged: callerModel.getVersionId() === version };
	},
	applySurrogateEdit: () => {
		callerEditor.executeEdits('browser', [{ range: new stanza.Range(1, 2, 1, 3), text: '' }]);
		return callerModel.getValue();
	},
	resetSameValue: () => {
		callerEditor.setValue('stable');
		const snapshot = callerModel.createSnapshot();
		const beforeVersion = callerModel.getVersionId();
		const events: Array<{ readonly version: number; readonly reason: string; readonly changes: number }> = [];
		using listener = callerModel.onDidChangeContent(change => events.push({
			version: change.version,
			reason: change.reason,
			changes: change.changes.length,
		}));
		callerEditor.setValue('stable');
		return {
			beforeVersion,
			afterVersion: callerModel.getVersionId(),
			alternativeVersion: callerModel.getAlternativeVersionId(),
			snapshotValue: snapshot.read(),
			events,
		};
	},
	prepareSelectionUndo: () => {
		callerEditor.setValue('alpha\nbeta');
		callerEditor.setSelections([
			new stanza.Selection(1, 6, 1, 1),
			new stanza.Selection(2, 1, 2, 5),
		]);
		ownedEditor.setSelections([new stanza.Selection(2, 3, 2, 3)]);
		return readSelectionUndo();
	},
	applySelectionEdit: () => {
		callerEditor.pushUndoStop();
		callerEditor.executeEdits('browser', [
			{ range: new stanza.Range(1, 1, 1, 6), text: 'A' },
			{ range: new stanza.Range(2, 1, 2, 5), text: 'B' },
		], [
			new stanza.Selection(1, 2, 1, 2),
			new stanza.Selection(2, 2, 2, 2),
		]);
		callerEditor.pushUndoStop();
		return readSelectionUndo();
	},
	readSelectionUndo,
	enableCodeActions: () => {
		codeActionRegistration?.dispose();
		codeActionRegistration = stanza.languages.registerCodeActionProvider('plaintext', {
			provideCodeActions: () => [{ title: 'Example code action' }],
		});
	},
	prepareLineIdentity: () => {
		callerEditor.setValue('a\nlonger');
		if (!(callerModel instanceof stanza.TextModel)) throw new Error('Line identity model is unavailable');
		longLineId = callerModel.getLineId(1);
		return readLineIdentity();
	},
	splitLineIdentity: () => {
		callerEditor.executeEdits('browser', [{ range: new stanza.Range(1, 2, 1, 2), text: '\n' }]);
		return readLineIdentity();
	},
	readLineIdentity,
	openLargeModel: () => {
		const value = Array(20_500).fill('x'.repeat(1_024)).join('\n');
		largeModel = stanza.editor.createModel(value, 'plaintext', stanza.URI.parse('inmemory://stanza/large.txt'));
		const snapshot = largeModel.createSnapshot();
		callerEditor.setModel(largeModel);
		ownedEditor.setModel(largeModel);
		return {
			textUnits: largeModel.getValueLength(),
			lineCount: largeModel.getLineCount(),
			tooLargeForTokenization: largeModel.isTooLargeForTokenization(),
			tooLargeForSynchronization: largeModel.isTooLargeForSyncing(),
			attachedEditors: largeModel.getAttachedEditorCount(),
			firstChunkPrefix: snapshot.read()?.slice(0, 32) ?? '',
		};
	},
	enableCompletionNavigation: snippet => {
		completionRegistration?.dispose();
		completionRegistration = stanza.languages.registerCompletionItemProvider('plaintext', {
			id: 'standalone.keyboard-navigation',
			provideCompletions: request => ({
				items: ['constant', 'console'].map(label => ({
					id: label,
					label,
					kind: stanza.languages.LanguageCompletionItemKind.Text,
					range: stanza.Range.fromPositions(request.position),
					insertText: snippet ? '${1:name}(${2:value})$0' : label,
					insertTextFormat: snippet ? stanza.languages.LanguageCompletionInsertTextFormat.Snippet : stanza.languages.LanguageCompletionInsertTextFormat.PlainText,
				})),
				isIncomplete: false,
			}),
		});
		callerEditor.setValue('con');
		callerEditor.setPosition(new stanza.Position(1, 4));
	},
	getCallerPosition: () => {
		const position = callerEditor.getPosition();
		return position ? { lineNumber: position.lineNumber, column: position.column } : null;
	},
	prepareKeyboardEditing: () => {
		callerEditor.setValue('first\nsecond');
		callerEditor.setPosition(new stanza.Position(1, 3));
		return readKeyboardEditing();
	},
	readKeyboardEditing,
	selectRange: () => {
		callerEditor.setSelection({ startLineNumber: 1, startColumn: 2, endLineNumber: 2, endColumn: 4 });
		return readKeyboardEditing();
	},
	prepareClipboard: () => {
		callerEditor.setValue('alpha beta');
		callerEditor.setSelection(new stanza.Selection(1, 1, 1, 6));
		return readKeyboardEditing();
	},
	prepareWrappedLayout: () => {
		callerContainer.style.width = '120px';
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: 120, height: 80 });
		callerEditor.updateOptions({ wordWrap: 'on', wrappingIndent: 'none' });
		callerEditor.setValue('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
		callerEditor.setPosition(new stanza.Position(1, 1));
		return readWrappedLayout();
	},
	prepareProportionalWrap: () => {
		callerContainer.style.width = '320px';
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: 320, height: 80 });
		callerEditor.updateOptions({ fontFamily: 'Arial', wordWrap: 'wordWrapColumn', wordWrapColumn: 6, wrappingIndent: 'none' });
		callerEditor.setValue('abc defgh');
		return readWrappedLayout();
	},
	resizeWrappedLayout: width => {
		callerContainer.style.width = `${width}px`;
		callerEditor.layout({ width, height: 80 });
		return readWrappedLayout();
	},
	editWrappedText: value => {
		callerEditor.executeEdits('wrap', [{ range: new stanza.Range(1, 1, 1, callerModel.getLineMaxColumn(1)), text: value }]);
		return readWrappedLayout();
	},
	readWrappedLayout,
	prepareViewZone: unit => {
		callerEditor.updateOptions({ lineHeight: 20, padding: { top: 0, bottom: 0 }, scrollBeyondLastLine: false });
		callerEditor.setValue(['first', 'second', ...Array.from({ length: 10 }, (_, index) => `line-${index + 3}`)].join('\n'));
		callerEditor.setPosition(new stanza.Position(2, 1));
		callerEditor.createDecorationsCollection([{
			range: new stanza.Range(2, 1, 2, 7),
			options: { description: 'view zone geometry', blockClassName: 'ash-zone-block-probe' },
		}]);
		const domNode = document.createElement('div');
		domNode.className = 'ash-zone-probe';
		const marginDomNode = document.createElement('div');
		marginDomNode.className = 'ash-zone-margin-probe';
		viewZone = {
			afterLineNumber: 1,
			domNode,
			marginDomNode,
			suppressMouseDown: true,
			onComputedHeight(height) {
				computedZoneHeights.push(height);
				this.domNode.dataset.computedHeight = String(height);
			},
			onDomNodeTop(top) {
				this.domNode.dataset.top = String(top);
			},
		};
		if (unit === 'pixels') {
			viewZone.heightInPx = 0;
		} else {
			viewZone.heightInLines = 0;
		}
		callerEditor.changeViewZones(accessor => { viewZoneId = accessor.addZone(viewZone!); });
		return readViewZone();
	},
	prepareFoldedViewZone: showInHiddenAreas => {
		callerEditor.updateOptions({ lineHeight: 20, padding: { top: 0, bottom: 0 }, wordWrap: 'wordWrapColumn', wordWrapColumn: 10, wrappingIndent: 'none', showFoldingControls: 'always', scrollBeyondLastLine: false });
		callerEditor.setValue(['abcdefghijklmnopqrstuvwxy', '  x', '  y', ...Array.from({ length: 30 }, () => 'tail')].join('\n'));
		callerEditor.setPosition(new stanza.Position(1, 1));
		const domNode = document.createElement('div');
		domNode.className = 'ash-folded-zone-probe';
		const marginDomNode = document.createElement('div');
		marginDomNode.className = 'ash-folded-zone-margin-probe';
		callerEditor.changeViewZones(accessor => accessor.addZone({
			afterLineNumber: 2,
			heightInPx: 40,
			showInHiddenAreas,
			domNode,
			marginDomNode,
			onComputedHeight(height) {
				this.domNode.dataset.computedHeight = String(height);
			},
			onDomNodeTop(top) {
				this.domNode.dataset.top = String(top);
			},
		}));
		return callerModel.getVersionId();
	},
	resizeViewZone: (height, afterLineNumber) => {
		if (!viewZone) throw new Error('View zone has not been created');
		if (viewZone.heightInPx !== undefined) {
			viewZone.heightInPx = height;
		} else {
			viewZone.heightInLines = height;
		}
		viewZone.afterLineNumber = afterLineNumber;
		callerEditor.changeViewZones(accessor => accessor.layoutZone(viewZoneId));
		return readViewZone();
	},
	removeViewZone: () => {
		callerEditor.changeViewZones(accessor => accessor.removeZone(viewZoneId));
		return readViewZone();
	},
	prepareVisibleRows: () => {
		callerContainer.style.height = '80px';
		callerEditor.layout({ width: callerContainer.clientWidth, height: 80 });
		callerEditor.setValue(Array.from({ length: 80 }, (_, index) => `line-${String(index).padStart(2, '0')}`).join('\n'));
		return { lineCount: callerModel.getLineCount(), version: callerModel.getVersionId() };
	},
	scrollVisibleRows: top => {
		callerEditor.setScrollTop(top);
		return callerEditor.getScrollTop();
	},
	editVisibleRow: lineIndex => {
		const lineNumber = lineIndex + 1;
		callerEditor.executeEdits('visible-row', [{
			range: new stanza.Range(lineNumber, 1, lineNumber, callerModel.getLineMaxColumn(lineNumber)),
			text: `changed-${lineIndex}`,
		}]);
		return callerModel.getLineContent(lineNumber);
	},
	prepareCursorGutter: () => {
		callerContainer.style.width = '220px';
		callerContainer.style.height = '320px';
		callerEditor.layout({ width: 220, height: 320 });
		callerEditor.updateOptions({ wordWrap: 'on', lineNumbers: 'relative', glyphMargin: true, cursorBlinking: 'solid' });
		callerEditor.setValue('abcdefghijklmnopqrstuvwxyz0123456789\nnext');
		callerEditor.setPosition(new stanza.Position(1, callerModel.getLineMaxColumn(1)));
		callerEditor.createDecorationsCollection([{
			range: new stanza.Range(1, 1, 1, 1),
			options: { description: 'gutter integration marker', glyphMarginClassName: 'ash-gutter-probe' },
		}]);
		return { version: callerModel.getVersionId(), modelLineCount: callerModel.getLineCount() };
	},
	moveGutterCaret: (lineNumber, column) => callerEditor.setPosition(new stanza.Position(lineNumber, column)),
	shortenGutterLine: () => {
		callerEditor.executeEdits('gutter', [{ range: new stanza.Range(1, 1, 1, callerModel.getLineMaxColumn(1)), text: 'short' }]);
		return callerModel.getVersionId();
	},
	preparePointerSelection: () => {
		pointerMouseUpEvents = 0;
		callerEditor.setValue('alpha beta\nsecond line');
	},
	readPointerSelection: () => ({
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selection: callerEditor.getSelection()?.toString() ?? null,
		ownedSelection: ownedEditor.getSelection()?.toString() ?? null,
		focused: callerEditor.hasTextFocus(),
		mouseUpEvents: pointerMouseUpEvents,
	}),
	prepareMultiCursor: () => {
		callerEditor.setValue('abcd\nefgh');
	},
	readMultiCursor: () => ({
		value: callerModel.getValue(),
		version: callerModel.getVersionId(),
		selections: callerEditor.getSelections()?.map(selection => selection.toString()) ?? [],
		ownedSelections: ownedEditor.getSelections()?.map(selection => selection.toString()) ?? [],
		focused: callerEditor.hasTextFocus(),
	}),
	releaseCaller: () => {
		callerEditor.dispose();
		callerModel.setValue('changed after editor disposal');
	},
	releaseOwned: () => ownedEditor.dispose(),
	dispose: () => {
		referenceRegistration?.dispose();
		TokenizationRegistry.setColorMap([]);
		codeActionRegistration?.dispose();
		completionRegistration?.dispose();
		ownedEditor.dispose();
		callerEditor.dispose();
		largeModel?.dispose();
		callerModel.dispose();
		pointerMouseUpListener.dispose();
		listener.dispose();
	},
};
