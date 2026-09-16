import { Emitter } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, IFileService, type IFileContent } from '../../../../platform/files/common/files.js';
import { type IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import type { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { bindColorTheme } from '../../../../platform/theme/browser/themeStyles.js';
import type { IFileIconThemeService } from '../../../../platform/theme/browser/fileIconThemeService.js';
import { SetiFileIconThemeService } from '../../../../platform/theme/browser/setiFileIconTheme.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import { resolveWorkbenchColorTheme, SystemColorThemePreference, WorkbenchThemesRegistry } from '../../../common/theme.js';
import type { IUserThemeDeleteResult, IUserThemeLoadIssue, IUserThemeSaveResult, IUserThemeService, IUserThemeSource } from '../../../common/userThemes.js';
import { parseUserColorTheme, userThemeId } from '../common/colorThemeData.js';
import { migrateUserTheme } from '../common/themeMigration.js';
import { registerColorThemeSchemas } from '../common/colorThemeSchema.js';

/** Owns active theme selection and its window-scoped visual resources. */
export class WorkbenchThemeService extends Disposable implements IThemeService {
	private readonly colorThemeChange = this._register(new Emitter<IColorTheme>());
	private readonly systemDarkQuery: MediaQueryList;
	private colorTheme: IColorTheme;
	private initialized = false;
	public readonly onDidColorThemeChange = this.colorThemeChange.event;
	public readonly fileIconTheme: IFileIconThemeService;

	constructor(
		private readonly container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		const ownerWindow = container.ownerDocument.defaultView;
		if (!ownerWindow) {
			throw new Error('Workbench themes require an owner window');
		}
		this.systemDarkQuery = ownerWindow.matchMedia('(prefers-color-scheme: dark)');
		this.colorTheme = this.resolveColorTheme();
		this.fileIconTheme = this._register(new SetiFileIconThemeService(this));
	}

	public initialize(): void {
		this.assertNotDisposed();
		if (this.initialized) {
			throw new Error('Workbench themes are already initialized');
		}
		this.initialized = true;
		this._register(registerColorThemeSchemas());
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WorkbenchConfiguration.colorTheme)) {
				this.updateColorTheme();
			}
		}));
		this._register(WorkbenchThemesRegistry.onDidChange(() => this.updateColorTheme()));
		const updateSystemTheme = (): void => this.updateColorTheme();
		this.systemDarkQuery.addEventListener('change', updateSystemTheme);
		this._register(toDisposable(() => this.systemDarkQuery.removeEventListener('change', updateSystemTheme)));
		this.updateColorTheme();
		this._register(bindColorTheme(this, this.container));
	}

	public getColorTheme(): IColorTheme {
		return this.colorTheme;
	}

	private resolveColorTheme(): IColorTheme {
		const preference = this.configurationService.getValue<string>(WorkbenchConfiguration.colorTheme);
		const registeredTheme = WorkbenchThemesRegistry.getColorTheme(preference);
		return registeredTheme ?? resolveWorkbenchColorTheme(SystemColorThemePreference, this.systemDarkQuery.matches);
	}

	private updateColorTheme(): void {
		const theme = this.resolveColorTheme();
		if (theme === this.colorTheme) {
			return;
		}
		this.colorTheme = theme;
		this.colorThemeChange.fire(theme);
	}
}

interface ThemeSource extends IUserThemeSource {
	readonly fileContent: IFileContent;
	readonly theme: IColorTheme;
}

/** Owns user theme resources and registration independently of the filesystem host. */
class UserThemeResources extends Disposable implements IUserThemeService {
	public readonly available = true;
	private readonly registration = this._register(WorkbenchThemesRegistry.registerColorThemes([]));
	private sources = new Map<string, ThemeSource>();
	private loadIssues: readonly IUserThemeLoadIssue[] = [];

	constructor(private readonly resource: URI, @IFileService private readonly files: IFileService) { super(); }

	public get directory(): string { return this.resource.fsPath; }
	public get issues(): readonly IUserThemeLoadIssue[] { return this.loadIssues; }
	public sourceFor(id: string): IUserThemeSource | undefined { return this.sources.get(id); }
	public getSource(id: string): string | undefined { return this.sources.get(id)?.fileContent.content; }

	public async reload(): Promise<void> {
		const sources = new Map<string, ThemeSource>();
		const issues: IUserThemeLoadIssue[] = [];
		try {
			const entries = (await this.files.readDirectory(this.resource)).filter(entry => entry.kind === FileKind.File && entry.name.toLowerCase().endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 128);
			for (const entry of entries) {
				try {
					let content = await this.read(entry.resource);
					const migration = migrateUserTheme(content.content);
					if (migration) {
						const target = this.child(migration.id + '.json');
						parseUserColorTheme(migration.content, migration.id);
						if (target.toString() === entry.resource.toString()) {
							await this.files.writeFile({ resource: target, content: migration.content, expectedRevision: content.revision });
						} else {
							let existing: IFileContent | undefined;
							try { existing = await this.read(target); } catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
							if (existing && existing.content !== migration.content) throw new Error('Theme migration conflicts with ' + migration.id + '.json');
							if (!existing) await this.create(target, migration.content);
							await this.deleteSource(content);
						}
						content = await this.read(target);
					}
					const file = decodeURIComponent(content.resource.path.slice(content.resource.path.lastIndexOf('/') + 1));
					const id = userThemeId(file.slice(0, -5));
					const theme = parseUserColorTheme(content.content, id);
					const existing = WorkbenchThemesRegistry.getColorTheme(id);
					if (existing && !this.sources.has(id)) throw new Error('Theme id is already in use: ' + id);
					if (sources.has(id) && sources.get(id)!.file !== file) throw new Error('Duplicate user theme id: ' + id);
					sources.set(id, { id, file, fileContent: content, theme });
				} catch (error) { issues.push({ file: entry.name, message: errorMessage(error) }); }
			}
		} catch (error) {
			if (!(error instanceof FileNotFoundError)) {
				this.loadIssues = [{ file: 'themes', message: errorMessage(error) }];
				return;
			}
		}
		this.registration.replace([...sources.values()].map(source => source.theme));
		this.sources = sources;
		this.loadIssues = issues;
	}

	public async save(id: string, source: string): Promise<IUserThemeSaveResult> {
		const existing = this.sources.get(id);
		if (!existing) throw new Error('User theme is not loaded: ' + id);
		parseUserColorTheme(source, id);
		await this.files.writeFile({ resource: existing.fileContent.resource, content: source, expectedRevision: existing.fileContent.revision });
		await this.reload();
		return this.saved(id);
	}

	public async saveAs(source: string): Promise<IUserThemeSaveResult> {
		const theme = parseUserColorTheme(source);
		if (WorkbenchThemesRegistry.getColorTheme(theme.id)) throw new Error('Theme id is already in use: ' + theme.id);
		await this.create(this.child(theme.id + '.json'), source);
		await this.reload();
		return this.saved(theme.id);
	}

	public async delete(id: string): Promise<IUserThemeDeleteResult> {
		const existing = this.sources.get(id);
		if (!existing) throw new Error('User theme is not loaded: ' + id);
		await this.deleteSource(existing.fileContent);
		await this.reload();
		return { file: existing.file, colorScheme: existing.theme.colorScheme };
	}

	private async read(resource: URI): Promise<IFileContent> {
		const stat = await this.files.stat(resource);
		if (stat.kind !== FileKind.File || stat.sizeBytes > 1_048_576) throw new Error('Theme must be a regular file of at most 1 MiB');
		return this.files.readFile(resource);
	}

	private async create(resource: URI, content: string): Promise<void> {
		const temporary = URI.parse(resource.toString() + '.' + crypto.randomUUID() + '.tmp');
		try {
			await this.files.createFile(temporary, 'error');
			await this.files.writeFile({ resource: temporary, content });
			await this.files.rename(temporary, resource, 'error');
		} finally { await this.files.delete(temporary, 'ignore', 'fileOrEmptyDirectory'); }
	}

	private async deleteSource(content: IFileContent): Promise<void> {
		if ((await this.files.readFile(content.resource)).revision !== content.revision) throw new FileRevisionConflictError(content.resource);
		await this.files.delete(content.resource, 'error', 'fileOrEmptyDirectory');
	}

	private child(name: string): URI {
		return URI.parse(this.resource.toString().replace(/\/$/u, '') + '/' + encodeURIComponent(name));
	}

	private saved(id: string): IUserThemeSaveResult {
		const source = this.sources.get(id);
		if (!source) throw new Error('Saved theme could not be reloaded: ' + id);
		return { file: source.file, theme: source.theme };
	}
}

export async function loadUserThemes(services: IInstantiationService, directory: URI): Promise<IUserThemeService & IDisposable> {
	const service = services.createInstance(UserThemeResources, directory);
	try { await service.reload(); return service; }
	catch (error) { service.dispose(); throw error; }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
