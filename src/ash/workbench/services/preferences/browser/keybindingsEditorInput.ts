import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';
import { EditorInputSerializers, requireString } from '../../editor/common/editorInputSerializer.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Event } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { KeybindingsEditorModel } from './keybindingsEditorModel.js';

const keybindingsEditorContentType = 'application/vnd.ash.keyboard-shortcuts';
const keybindingsEditorResource = URI.parse('ash-preferences:/keyboard-shortcuts');

/** Owns the resolved shortcut model while an open request or pane retains the input. */
export class KeybindingsEditorInput extends EditorInput {
	public static readonly ID = 'workbench.input.keybindings';
	private static readonly restoredInputs = new WeakMap<IResourceEditorInput, WeakRef<KeybindingsEditorInput>>();
	public readonly typeId = KeybindingsEditorInput.ID;
	public readonly resource = keybindingsEditorResource;
	public readonly contentType = keybindingsEditorContentType;
	public readonly readOnly = true;
	public readonly onDidChangeLabel = Event.None;
	private model: KeybindingsEditorModel | undefined;
	private references = 0;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}

	public static getOrCreate(input: IResourceEditorInput, instantiationService: IInstantiationService): KeybindingsEditorInput {
		if (!isKeybindingsEditorInput(input)) throw new TypeError('Expected a Keyboard Shortcuts input');
		if (input instanceof KeybindingsEditorInput && !input.isDisposed) return input;
		const restored = this.restoredInputs.get(input)?.deref();
		if (restored && !restored.isDisposed) return restored;
		const editorInput = instantiationService.createInstance(KeybindingsEditorInput);
		// Restored resource objects are frozen and can be shared by split panes.
		// Preserve their live input identity without extending the serializer contract.
		this.restoredInputs.set(input, new WeakRef(editorInput));
		return editorInput;
	}

	public getName(): string {
		return localize('workbench.manageKeyboardShortcuts', 'Keyboard Shortcuts');
	}

	public async resolve(): Promise<KeybindingsEditorModel> {
		this.assertNotDisposed();
		this.model ??= this._register(this.instantiationService.createInstance(KeybindingsEditorModel));
		await this.model.resolve();
		this.assertNotDisposed();
		return this.model;
	}

	public acquire(): IDisposable {
		this.assertNotDisposed();
		this.references += 1;
		// Ash disposes panes, but does not dispose supplied inputs. Open requests also
		// retain a reference so ignored duplicates and failures release their inputs.
		return toDisposable(() => {
			this.references -= 1;
			if (this.references === 0) this.dispose();
		});
	}
}

export function isKeybindingsEditorInput(input: IResourceEditorInput): boolean {
	return input instanceof KeybindingsEditorInput || input.contentType === keybindingsEditorContentType || input.resource.toString() === keybindingsEditorResource.toString();
}

/** Uses the profile resource identity shared by the text model and shortcut services. */
export function createKeybindingsJsonEditorInput(resource: URI): IResourceEditorInput {
	return Object.freeze({
		resource,
		languageId: 'jsonc',
		get label(): string { return localize({ bundle: 'ash', key: 'keybindings.jsonLabel' }, 'Keyboard Shortcuts (JSON)'); },
	});
}

EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.keybindingsJson',
	canSerialize: input => input.resource.scheme === Schemas.vscodeUserData && input.resource.path === '/user/keybindings.json' && !input.resource.authority && !input.resource.query && !input.resource.fragment,
	serialize: input => input.resource.toString(),
	deserialize: value => {
		const resource = URI.parse(requireString(value, 'keybindings JSON resource'));
		if (resource.scheme !== Schemas.vscodeUserData || resource.path !== '/user/keybindings.json' || resource.authority || resource.query || resource.fragment) throw new TypeError('Invalid keybindings JSON resource');
		return createKeybindingsJsonEditorInput(resource);
	},
});
