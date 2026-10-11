import { h, type IDimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IExtensionManagementService, type ExtensionsInstalledPackage, type ExtensionsPackageDetails } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { ExtensionsInput } from '../common/extensionsInput.js';
import './extensions.css';

/** Package review and mutations share the same exact-version confirmation in rows and editor. */
export async function changeExtensionPackage(service: IExtensionManagementService, dialogs: IDialogService, operation: 'install' | 'update' | 'uninstall', details: ExtensionsPackageDetails | undefined, installation?: ExtensionsInstalledPackage): Promise<ExtensionsInstalledPackage | null | undefined> {
	if (operation === 'uninstall' && installation) {
		const review = await dialogs.confirm({
			title: localize({ bundle: 'ash.extensions', key: 'uninstallTitle' }, 'Uninstall extension'),
			message: localize({ bundle: 'ash.extensions', key: 'uninstallMessage' }, 'Uninstall {0} {1}?', installation.package.id, installation.package.version),
			detail: localize({ bundle: 'ash.extensions', key: 'uninstallReview' }, 'This removes all capabilities in this package:\n{0}\nActive consumers may delay removal.', installation.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n')),
			primaryButton: localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'),
		});
		if (!review.confirmed) { return undefined; }
		await service.uninstall(installation.installationId);
		return null;
	}
	if (operation === 'update' && installation) { details = await service.get(installation.package.id); }
	if (!details) { return undefined; }
	const label = operation === 'install' ? localize({ bundle: 'ash.extensions', key: 'install' }, 'Install') : localize({ bundle: 'ash.extensions', key: 'update' }, 'Update');
	const review = await dialogs.confirm({
		title: label,
		message: localize({ bundle: 'ash.extensions', key: 'installMessage' }, '{0} {1} {2}?', label, details.displayName, details.package.version),
		detail: localize({ bundle: 'ash.extensions', key: 'installReview' }, '{0}\nSource: {1}\n{2}\nAll capabilities in this package are installed together.', details.package.id, details.source === 'official' ? localize({ bundle: 'ash.extensions', key: 'official' }, 'Official package') : localize({ bundle: 'ash.extensions', key: 'thirdParty' }, 'Third-party package'), describeExtensionCapabilities(details)),
		primaryButton: label,
	});
	if (!review.confirmed) { return undefined; }
	return operation === 'update' && installation ? service.update(installation.installationId, details.package.version) : service.install(details.package.id, details.package.version);
}

function describeExtensionCapabilities(details: ExtensionsPackageDetails): string {
	const notice = details.packageType === 'editorExtension' ? localize({ bundle: 'ash.extensions', key: 'declarativeOnly' }, 'Installation loads supported themes, syntax and snippets without running scripts. Use Manage extension execution to enable and authorize JavaScript separately.') : '';
	return [notice, ...details.capabilities.map(capability => `${capability.kind}: ${capability.id}${capability.permissions.length ? '\n' + localize({ bundle: 'ash.extensions', key: 'localExtensionPermissions' }, 'Requested permissions: {0}', capability.permissions.join(', ')) : ''}`)].filter(Boolean).join('\n');
}

/** A retained editor presents package metadata while the backend owns installed state and authority. */
export class ExtensionsEditor extends EditorPane {
	public readonly id = 'ash.extensions.editor';
	private domNode!: HTMLElement;
	private title!: HTMLElement;
	private metadata!: HTMLElement;
	private description!: HTMLElement;
	private capabilities!: HTMLElement;
	private status!: HTMLElement;
	private actions!: HTMLElement;
	private readonly actionResources = this._register(new DisposableStore());
	private loadVersion = 0;
	private working = false;

	constructor(@IExtensionManagementService private readonly extensions: IExtensionManagementService,
		@IDialogService private readonly dialogs: IDialogService,
		@ICommandService private readonly commands: ICommandService,
		@IThemeService theme: IThemeService, @IStorageService storage: IStorageService) { super('ash.extensions.editor', theme, storage); }

	public override create(container: HTMLElement): void {
		this.domNode = h(mainWindow.document, 'section');
		this.domNode.className = 'ash-extension-editor';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		super.create(this.domNode);
		this.title = h(mainWindow.document, 'h1');
		this.metadata = h(mainWindow.document, 'p'); this.metadata.className = 'extension-metadata';
		this.description = h(mainWindow.document, 'p');
		this.actions = h(mainWindow.document, 'div'); this.actions.className = 'extension-actions';
		this.status = h(mainWindow.document, 'p'); this.status.setAttribute('role', 'status');
		const heading = h(mainWindow.document, 'h2'); heading.textContent = localize({ bundle: 'ash.extensions', key: 'capabilities' }, 'Capabilities');
		this.capabilities = h(mainWindow.document, 'div'); this.capabilities.className = 'extension-capabilities';
		this.domNode.append(this.title, this.metadata, this.description, this.actions, this.status, heading, this.capabilities);
	}

	public async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!(input instanceof ExtensionsInput)) { throw new TypeError('Extensions editor requires an Extensions input'); }
		const version = ++this.loadVersion;
		this.actionResources.clear();
		this.title.textContent = input.summary.displayName;
		this.metadata.textContent = `${input.summary.id} · ${input.summary.version}`;
		this.description.textContent = input.summary.description;
		this.capabilities.textContent = '';
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		const installed = await this.extensions.listInstalled();
		if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
		const installation = installed.find(entry => entry.installationId === input.installationId);
		// Installed operations remain available even if every registry is offline.
		const details = await this.extensions.get(input.summary.id, input.summary.version).catch(error => {
			if (!installation) { throw error; }
			return undefined;
		});
		if (signal.aborted || this.isDisposed || version !== this.loadVersion) { return; }
		this.title.textContent = details?.displayName ?? input.summary.displayName;
		this.description.textContent = details?.description ?? input.summary.description;
		this.metadata.textContent = [input.summary.id, input.summary.version, details?.license].filter(Boolean).join(' · ');
		this.capabilities.textContent = details ? describeExtensionCapabilities(details) : installation?.capabilities.map(capability => `${capability.kind}: ${capability.id}`).join('\n') ?? '';
		const hasInstalled = installed.some(entry => entry.package.id === input.summary.id);
		this.status.textContent = installation?.state === 'pendingRemoval' ? localize({ bundle: 'ash.extensions', key: 'removalPending' }, 'Removal pending') : hasInstalled ? localize({ bundle: 'ash.extensions', key: 'installed' }, 'Installed · activation is separate') : '';
		const button = (label: string, action: () => Promise<void>, enabled = true) => {
			const control = this.actionResources.add(new Button(this.actions, { label, presentation: 'secondary', enabled }));
			this.actionResources.add(control.onDidClick(() => {
				if (this.working) { return; }
				this.working = true;
				this.domNode.setAttribute('aria-busy', 'true');
				void action().catch(error => { if (!this.isDisposed && version === this.loadVersion) { this.status.textContent = error instanceof Error ? error.message : String(error); } }).finally(() => { this.working = false; if (!this.isDisposed) { this.domNode.setAttribute('aria-busy', 'false'); } });
			}));
		};
		const mutate = async (operation: 'install' | 'update' | 'uninstall') => {
			const result = await changeExtensionPackage(this.extensions, this.dialogs, operation, details, installation);
			if (result !== undefined && !this.isDisposed && version === this.loadVersion) {
				const nextInput = result ? new ExtensionsInput({ ...input.summary, version: result.package.version }, result.installationId) : input;
				try { await this.setInput(nextInput, signal); } finally { if (nextInput !== input) { nextInput.dispose(); } }
			}
		};
		if (installation) {
			button(localize({ bundle: 'ash.extensions', key: 'update' }, 'Update'), () => mutate('update'), installation.state === 'installed');
			button(localize({ bundle: 'ash.extensions', key: 'uninstall' }, 'Uninstall'), () => mutate('uninstall'), installation.state === 'installed');
		} else if (!hasInstalled) { button(localize({ bundle: 'ash.extensions', key: 'install' }, 'Install'), () => mutate('install'), !!details); }
		if (hasInstalled) {
			button(localize({ bundle: 'ash.extensions', key: 'showInstalled' }, 'Show installed versions'), () => this.commands.executeCommand('ash.extensions.installed', { query: input.summary.id }));
			if (details?.packageType === 'editorExtension' || installation?.capabilities.some(capability => capability.kind === 'editorExtension')) {
				button(localize({ bundle: 'ash.extensions', key: 'manageExtensionExecution' }, 'Manage extension execution'), () => this.commands.executeCommand('ash.extensions.manageExtensions'));
			}
		}
	}

	public clearInput(): void { ++this.loadVersion; this.actionResources.clear(); }
	public layout(_dimension: IDimension): void { }
	public focus(): void { this.actions.querySelector<HTMLButtonElement>('button')?.focus(); }
}

registerEditorPane({
	id: 'ash.extensions.editor', name: 'Extensions',
	canOpen: input => input instanceof ExtensionsInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Extensions editor requires the Instantiation Service'); }
		return options.instantiationService.createInstance(ExtensionsEditor);
	},
});
