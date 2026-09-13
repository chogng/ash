import * as stanza from '../../../src/ash/editor/editor.main.js';

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

interface StandaloneHarness {
	readonly events: readonly CreationEvent[];
	state(kind: 'caller' | 'owned'): EditorState;
	switchOwnedToCaller(): { readonly ownedModelDisposed: boolean; readonly ownedModelRegistered: boolean; readonly rootRetained: boolean; readonly editorCount: number; readonly currentModelIsCaller: boolean };
	detachOwned(): { readonly modelIsNull: boolean; readonly value: string; readonly rootMounted: boolean; readonly inputCount: number };
	reattachOwned(): void;
	getOwnedValue(): string;
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
let codeActionRegistration: ReturnType<typeof stanza.languages.registerCodeActionProvider> | undefined;
let longLineId: string | undefined;

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

window.ashStandaloneIntegration = {
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
	releaseCaller: () => {
		callerEditor.dispose();
		callerModel.setValue('changed after editor disposal');
	},
	releaseOwned: () => ownedEditor.dispose(),
	dispose: () => {
		codeActionRegistration?.dispose();
		ownedEditor.dispose();
		callerEditor.dispose();
		callerModel.dispose();
		listener.dispose();
	},
};
