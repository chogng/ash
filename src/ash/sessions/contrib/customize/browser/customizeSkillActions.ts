import { canceled } from '../../../../base/common/errors.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { PromptFileParser } from '../../../../workbench/contrib/chat/common/promptSyntax/promptFileParser.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../browser/agentHost/sessionProviderScopeService.js';

interface SkillFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

/** File publication stays in FileService; catalog configuration stays in PromptsService. */
export class CustomizeSkillActions extends Disposable {
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		private readonly document: Document,
		@IFileService private readonly files: IFileService,
		@IDialogService private readonly dialogs: IDialogService,
		@IPathService private readonly paths: IPathService,
		@ISessionPrimaryProviderServices private readonly primary: SessionProviderServices,
		@IEditorService private readonly editors: IEditorService,
		@ISessionsService private readonly views: ISessionsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
	) {
		super();
	}

	public get isAvailable(): boolean {
		return !!this.primary.host.userDataHome;
	}

	public async upload(): Promise<boolean> {
		const selection = await this.dialogs.prompt<readonly File[]>({
			title: localize('customize.uploadSkill', 'Upload skill'),
			message: localize('customize.chooseSkillUpload', 'Upload a skill folder with its resources, or a single SKILL.md file.'),
			buttons: [
				{ label: localize('customize.skillFolder', 'Skill folder'), run: () => this.pickFiles(true) },
				{ label: 'SKILL.md', run: () => this.pickFiles(false) },
			],
		});
		return selection.result?.length ? this.uploadFiles(selection.result) : false;
	}

	/** Browser File snapshots carry only the contents explicitly selected by the user. */
	public async uploadFiles(selected: readonly File[]): Promise<boolean> {
		this.assertActive();
		if (!selected.length) return false;
		if (selected.length > 1024) throw new Error(localize('customize.skillPackageLimit', 'The skill package exceeds the supported file count or path length.'));
		const folder = selected[0].webkitRelativePath?.split('/')[0];
		const files: SkillFile[] = [];
		const paths = new Set<string>();
		let size = 0;
		for (const file of selected) {
			this.assertActive();
			const path = folder ? file.webkitRelativePath.slice(folder.length + 1) : file.name;
			if (
				(folder && !file.webkitRelativePath.startsWith(`${folder}/`)) ||
				!path ||
				path.length > 1024 ||
				path.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[\\\x00-\x1f\x7f]/.test(segment)) ||
				paths.has(path)
			) {
				throw new Error(localize('customize.invalidSkillPath', 'The skill contains an unsupported file path.'));
			}
			const limit = path === 'SKILL.md' ? 1024 * 1024 : 256 * 1024;
			if (file.size > limit) throw new Error(localize('customize.invalidSkillFile', 'Skill files must be regular files within the supported size limits.'));
			size += file.size;
			if (size > 16 * 1024 * 1024) throw new Error(localize('customize.skillPackageSize', 'The skill package exceeds 16 MiB.'));
			paths.add(path);
			files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
		}
		const manifest = files.find(file => file.path === 'SKILL.md');
		if (!manifest) throw new Error(localize('customize.chooseSkill', 'Choose SKILL.md or a folder containing SKILL.md.'));
		const name = this.skillName(URI.from({ scheme: 'untitled', path: '/SKILL.md' }), new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes));
		if (folder && folder !== name) throw new Error(localize('customize.skillFolderName', 'The skill folder must have the same name as the skill: {0}.', name));
		await this.publish(name, files);
		return true;
	}

	private pickFiles(folder: boolean): Promise<readonly File[]> {
		this.assertActive();
		return new Promise((resolve, reject) => {
			const input = this.document.createElement('input');
			input.type = 'file';
			input.accept = folder ? '' : '.md';
			input.webkitdirectory = folder;
			input.multiple = folder;
			input.hidden = true;
			this.document.body.append(input);
			let settled = false;
			const lifetime = new DisposableStore();
			const finish = (files: readonly File[]) => {
				settled = true;
				this.picker.clear();
				resolve(files);
			};
			lifetime.add(
				toDisposable(() => {
					input.remove();
					if (!settled) reject(canceled());
				}),
			);
			lifetime.add(addDisposableListener(input, 'change', () => finish([...(input.files ?? [])])));
			lifetime.add(addDisposableListener(input, 'cancel', () => finish([])));
			this.picker.value = lifetime;
			try {
				input.click();
			} catch (error) {
				settled = true;
				this.picker.clear();
				reject(error);
			}
		});
	}

	public async create(): Promise<boolean> {
		const result = await this.dialogs.input({
			title: localize('customize.createSkill', 'Create a skill'),
			message: localize('customize.skillFields', 'Give your skill a name, describe when to use it, and write its instructions.'),
			inputs: [
				{ placeholder: localize('customize.skillName', 'Name (for example, meeting-notes)') },
				{ placeholder: localize('customize.skillDescription', 'Description and when to use this skill') },
				{ placeholder: localize('customize.skillInstructions', 'Instructions for Ash') },
			],
			primaryButton: localize('customize.create', 'Create'),
		});
		if (!result.confirmed) return false;
		this.assertActive();
		const [name = '', description = '', instructions = ''] = result.values?.map(value => value.trim()) ?? [];
		if (!instructions) throw new Error(localize('customize.instructionsRequired', 'Enter the instructions for this skill.'));
		const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`;
		this.skillName(URI.from({ scheme: 'untitled', path: '/SKILL.md' }), content);
		const resource = await this.publish(name, [{ path: 'SKILL.md', bytes: new TextEncoder().encode(content) }]);
		this.assertActive();
		await this.editors.openEditor({ resource, label: 'SKILL.md' }, { pinned: true });
		return true;
	}

	public createWithAsh(): void {
		this.assertActive();
		this.views.openNewSession(localize('customize.createSkill', 'Create a skill'));
		this.navigation.appendToActiveDraft(
			'$skill-creator\n' + localize('customize.createSkillPrompt', 'Help me create a reusable skill. Ask me what it should do and when to use it, then help me write and validate it.'),
		);
	}

	private skillName(resource: URI, content: string): string {
		if (new TextEncoder().encode(content).length > 1024 * 1024) throw new Error(localize('customize.invalidSkillFile', 'Skill files must be regular files within the supported size limits.'));
		const parsed = new PromptFileParser().parse(resource, content);
		const name = parsed.header?.getAttribute('name')?.value;
		const description = parsed.header?.getAttribute('description')?.value;
		if (
			!parsed.header ||
			parsed.header.errors.length ||
			name?.type !== 'scalar' ||
			name.value.length > 64 ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.value) ||
			description?.type !== 'scalar' ||
			!description.value.trim()
		) {
			throw new Error(
				localize('customize.invalidSkill', 'The skill needs a valid name (up to 64 lowercase letters, numbers and single hyphens), a description, and valid SKILL.md frontmatter.'),
			);
		}
		return name.value;
	}

	private async publish(name: string, files: readonly SkillFile[]): Promise<URI> {
		this.assertActive();
		const home = this.primary.host.userDataHome;
		const root = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/skills' });
		const rootReference = home && (await this.paths.getHostPath(URI.joinPath(home, 'skills')));
		if (!rootReference) throw new Error(localize('customize.skillStorageUnavailable', 'Skill storage is unavailable on this host.'));
		const temporary = URI.from({ scheme: Schemas.vscodeUserData, path: `/user/.skill-import-${generateUuid()}` });
		const target = URI.joinPath(root, name);
		await this.files.createDirectory(root);
		await this.files.createDirectory(temporary);
		try {
			for (const file of files) {
				this.assertActive();
				const resource = URI.joinPath(temporary, file.path);
				const slash = file.path.lastIndexOf('/');
				if (slash >= 0) await this.files.createDirectory(URI.joinPath(temporary, file.path.slice(0, slash)));
				await this.files.writeFileBytes(resource, file.bytes, { create: true, overwrite: false });
			}
			this.assertActive();
			await this.primary.prompts.registerSkillSource(rootReference);
			this.assertActive();
			// Publishing one directory rejects collisions and never overwrites an existing skill.
			await this.files.rename(temporary, target, 'error');
		} finally {
			await this.files.delete(temporary, 'ignore', 'recursive').catch(() => {});
		}
		return URI.joinPath(target, 'SKILL.md');
	}

	private assertActive(): void {
		if (this.isDisposed) throw canceled();
	}
}
