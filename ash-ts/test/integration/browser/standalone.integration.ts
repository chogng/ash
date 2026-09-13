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

function state(kind: 'caller' | 'owned'): EditorState {
	const editor = kind === 'caller' ? callerEditor : ownedEditor;
	const model = kind === 'caller' ? callerModel : ownedModel;
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
