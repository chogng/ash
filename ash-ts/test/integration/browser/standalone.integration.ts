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

interface StandaloneHarness {
	readonly events: readonly CreationEvent[];
	state(kind: 'caller' | 'owned'): EditorState;
	switchOwnedToCaller(): { readonly ownedModelDisposed: boolean; readonly ownedModelRegistered: boolean; readonly rootRetained: boolean; readonly editorCount: number; readonly currentModelIsCaller: boolean };
	detachOwned(): { readonly modelIsNull: boolean; readonly value: string; readonly rootMounted: boolean; readonly inputCount: number };
	reattachOwned(): void;
	getOwnedValue(): string;
	tryOverlappingSurrogateEdits(): { readonly rejected: boolean; readonly value: string; readonly versionUnchanged: boolean };
	applySurrogateEdit(): string;
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
	releaseCaller: () => {
		callerEditor.dispose();
		callerModel.setValue('changed after editor disposal');
	},
	releaseOwned: () => ownedEditor.dispose(),
	dispose: () => {
		ownedEditor.dispose();
		callerEditor.dispose();
		callerModel.dispose();
		listener.dispose();
	},
};
