import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { applyEdits, setProperty } from '../../../../base/common/jsonEdit.js';
import { localize } from '../../../../nls.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ResolvedKeybindingItem } from '../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { IFileTextModelService } from '../../textmodelResolver/common/textModelResourceService.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { parseUserKeybindings } from './keybindingIO.js';

export interface IKeybindingEditingService {
	editKeybinding(item: ResolvedKeybindingItem, key: string, when: string | undefined): Promise<void>;
	removeKeybinding(item: ResolvedKeybindingItem): Promise<void>;
}

export const IKeybindingEditingService = createDecorator<IKeybindingEditingService>('keybindingEditingService');

/** Edits the shared profile model and saves with its exact-content file revision. */
export class KeybindingsEditingService extends Disposable implements IKeybindingEditingService {
	private pending: Promise<void> = Promise.resolve();
	private readonly lifetime = new AbortController();

	constructor(
		@IFileTextModelService private readonly models: IFileTextModelService,
		@IFileService private readonly files: IFileService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
	) {
		super();
		this._register(toDisposable(() => this.lifetime.abort()));
	}

	public editKeybinding(item: ResolvedKeybindingItem, key: string, when: string | undefined): Promise<void> {
		return this.edit(item, item.isDefault ? 'add' : 'edit', key, when);
	}

	public removeKeybinding(item: ResolvedKeybindingItem): Promise<void> {
		return this.edit(item, 'remove');
	}

	private edit(item: ResolvedKeybindingItem, operation: 'add' | 'edit' | 'remove', key?: string, when?: string): Promise<void> {
		this.assertNotDisposed();
		const result = this.pending.then(async () => {
			const resource = this.profiles.currentProfile.keybindingsResource;
			await this.files.createFile(resource, 'ignore');
			using reference = await this.models.acquire({ resource, languageId: 'jsonc' }, this.lifetime.signal);
			if (reference.isDirty) {
				throw new Error(localize({ bundle: 'ash', key: 'keybindings.saveFirst' }, 'Save keybindings.json before changing a shortcut in the Keyboard Shortcuts editor.'));
			}
			const model = reference.model;
			let source = model.getValue();
			const bindings = parseUserKeybindings(source);
			const formatting = { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' };
			if (operation === 'add') {
				source = applyEdits(source, setProperty(source, [bindings.length], { key, command: item.command, ...(item.commandArgs === undefined ? {} : { args: item.commandArgs }), ...(when ? { when } : {}) }, formatting));
			} else {
				const identity = item.userBinding;
				if (!identity || JSON.stringify(bindings[identity.index]) !== JSON.stringify(identity.entry)) {
					throw new Error(localize({ bundle: 'ash', key: 'keybindings.changed' }, 'This shortcut changed. Select it again before editing.'));
				}
				if (operation === 'remove') {
					source = applyEdits(source, setProperty(source, [identity.index], undefined, formatting));
				} else {
					source = applyEdits(source, setProperty(source, [identity.index, 'key'], key, formatting));
					source = applyEdits(source, setProperty(source, [identity.index, 'when'], when, formatting));
				}
			}
			parseUserKeybindings(source);
			if (source === model.getValue()) {
				return;
			}
			model.pushStackElement();
			model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: source }], null);
			model.pushStackElement();
			await reference.save(this.lifetime.signal);
		});
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
}
