import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { FileUserDataProvider } from '../../../../../platform/userData/common/fileUserDataProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IUserDataProfileService } from '../../../userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../userDataProfile/browser/userDataProfileService.js';
import { IFileTextModelService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { getBrowserTextResourceStore } from '../../../../contrib/codeEditor/browser/browserTextResourceStore.js';
import { TextFileService } from '../../../textfile/common/textFileService.js';
import { IKeybindingEditingService, KeybindingsEditingService } from '../../common/keybindingEditing.js';
import type { IUserFriendlyKeybinding } from '../../../../../platform/keybinding/common/keybinding.js';
import { parseUserKeybindings } from '../../common/keybindingIO.js';

/** Real shared file/model assembly for shortcut and Preferences behavior tests. */
export class KeybindingTestServices extends Disposable {
	public readonly services = this._register(new InstantiationService());
	public readonly profiles = new UserDataProfileService();
	public readonly files: FileUserDataProvider;
	public readonly models: BrowserTextModelService;
	public readonly directory = mkdtempSync(join(tmpdir(), 'ash-keybinding-test-'));

	constructor() {
		super();
		this._register(toDisposable(() => rmSync(this.directory, { recursive: true, force: true })));
		const disk = this._register(new DiskFileSystemProvider([URI.file(this.directory)]));
		this.files = this._register(new FileUserDataProvider(disk, URI.file(this.directory)));
		this.models = this._register(new BrowserTextModelService(getBrowserTextResourceStore(new TextFileService(this.files))));
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IFileTextModelService, this.models);
		this.services.registerInstance(IUserDataProfileService, this.profiles);
		this.services.registerSingleton(IKeybindingEditingService, () => this.services.createInstance(KeybindingsEditingService));
	}

	public async write(bindings: readonly IUserFriendlyKeybinding[]): Promise<void> {
		await this.writeSource(JSON.stringify(bindings));
	}

	public async writeSource(content: string): Promise<void> {
		await this.files.writeFile({ resource: this.profiles.currentProfile.keybindingsResource, content });
	}

	public async read(): Promise<readonly IUserFriendlyKeybinding[]> {
		return parseUserKeybindings((await this.files.readFile(this.profiles.currentProfile.keybindingsResource)).content);
	}
}
