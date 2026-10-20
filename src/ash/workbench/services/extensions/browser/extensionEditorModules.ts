import { localize } from '../../../../nls.js';
import { $ } from '../../../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { editorClientHost } from './editorClientHost.js';
import type { ExtensionEditorClientModule, ExtensionEditorModule, ExtensionEditorModuleLoader, ExtensionResourceEditorModule } from './extensionEditor.js';

const styledParents = new WeakMap<HTMLElement, object>();
type EditorClientFactory = (host: typeof editorClientHost) => ExtensionEditorClientModule;
// Browser module records survive URL revocation. Share the immutable factory for each digest
// so disabling and enabling one package cannot create an unbounded set of module records.
// Profiles, models and authorization remain scoped to each independently admitted capability.
const importedFactories = new Map<string, Promise<EditorClientFactory>>();

/** Only the backend can admit installed client code; manifest labels and package IDs are not authority. */
export const loadExtensionEditorModule: ExtensionEditorModuleLoader = async request => {
	const { package: owner, entry, expectedDigest, signal } = request;
	signal.throwIfAborted();
	if (owner.sourceKind === 'builtIn') return loadBuiltInModule(owner.name, entry, expectedDigest);
	const admission = owner.rendererClient;
	if (!admission || admission.apiVersion !== 1) {
		throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	}
	if (entry !== admission.entry || expectedDigest !== admission.sourceDigest) {
		throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
	}
	const read = (path: string) => request.resources.readExtensionResourceBytes({ generation: request.generation, extensionId: owner.id, path });
	const [moduleBytes, styleBytes] = await Promise.all([read(admission.entry), read(admission.style)]);
	signal.throwIfAborted();
	await Promise.all([verifyDigest(moduleBytes, admission.digest), verifyDigest(styleBytes, admission.styleDigest)]);
	signal.throwIfAborted();
	await request.assertCurrent();
	signal.throwIfAborted();
	const stylesheet = new TextDecoder('utf-8', { fatal: true }).decode(styleBytes);
	const source = new TextDecoder('utf-8', { fatal: true }).decode(moduleBytes);
	const factory = await importFactory(source, admission.digest);
	signal.throwIfAborted();
	await request.assertCurrent();
	signal.throwIfAborted();
	const component = factory(editorClientHost);
	signal.throwIfAborted();
	if (!component || typeof component !== 'object' || !('getEditorProfile' in component && typeof component.getEditorProfile === 'function' || 'getResourceEditor' in component && typeof component.getResourceEditor === 'function')) {
		throw new TypeError('Installed client modules must provide document profiles or resource editors');
	}
	return withStyles(component, stylesheet, admission.sourceDigest);
};

function importFactory(source: string, digest: string): Promise<EditorClientFactory> {
	let imported = importedFactories.get(digest);
	if (!imported) {
		const load = async () => {
			const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
			try {
				const module: { createEditorModule?: unknown; } = await import(/* @vite-ignore */ url);
				if (typeof module.createEditorModule !== 'function') throw new TypeError('Invalid editor client module factory');
				return module.createEditorModule as EditorClientFactory;
			} finally { URL.revokeObjectURL(url); }
		};
		imported = load();
		importedFactories.set(digest, imported);
		void imported.catch(() => { importedFactories.delete(digest); });
	}
	return imported;
}

async function verifyDigest(bytes: Uint8Array, expectedDigest: string): Promise<void> {
	const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	const digest = `sha256:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
	if (digest !== expectedDigest) throw new Error(localize('extensions.clientEditor.versionMismatch', 'The editor component and extension versions do not match.'));
}

/** Styles follow actual views, including frozen dirty panes retained after the provider retires. */
function withStyles(component: ExtensionEditorModule | ExtensionResourceEditorModule, css: string, identity: string): ExtensionEditorModule | ExtensionResourceEditorModule {
	const styles = new WeakMap<Document, { readonly element: HTMLStyleElement; references: number; }>();
	const acquire = (ownerDocument: Document): IDisposable => {
		let style = styles.get(ownerDocument);
		if (!style) {
			const element = $<HTMLStyleElement>('style');
			element.textContent = css;
			element.dataset.ashEditorClientStyle = identity;
			ownerDocument.head.append(element);
			style = { element, references: 0 };
			styles.set(ownerDocument, style);
		}
		const current = style;
		current.references++;
		return toDisposable(() => {
			if (--current.references === 0) {
				current.element.remove();
				styles.delete(ownerDocument);
			}
		});
	};
	if ('getResourceEditor' in component) return {
		packageId: component.packageId, packageVersion: component.packageVersion,
		getResourceEditor: (editorId, createInstance) => {
			const Pane = component.getResourceEditor(editorId, createInstance);
			return class StyledResourceEditor extends Pane {
				private styleLease: IDisposable | undefined;
				private styleParent: HTMLElement | undefined;
				override create(parent: HTMLElement): void {
					if (this.styleLease) throw new ReferenceError('Editor client view has already been created');
					const lease = acquire(parent.ownerDocument);
					parent.dataset.ashEditorClient = identity;
					styledParents.set(parent, this);
					this.styleParent = parent;
					try { super.create(parent); this.styleLease = lease; }
					catch (error) { lease.dispose(); this.clearStyleParent(); throw error; }
				}
				override dispose(): void {
					try { super.dispose(); }
					finally { this.styleLease?.dispose(); this.styleLease = undefined; this.clearStyleParent(); }
				}
				private clearStyleParent(): void {
					const parent = this.styleParent;
					if (parent && styledParents.get(parent) === this) { delete parent.dataset.ashEditorClient; styledParents.delete(parent); }
					this.styleParent = undefined;
				}
			};
		},
	};
	return {
		packageId: component.packageId,
		packageVersion: component.packageVersion,
		getEditorProfile: editorId => {
			const profile = component.getEditorProfile(editorId);
			return {
				...profile, create: () => {
					const configuration = profile.create();
					const Widget = configuration.widget;
					class StyledEditorWidget extends Widget {
						private styleLease: IDisposable | undefined;
						private styleParent: HTMLElement | undefined;
						public override create(parent: HTMLElement): void {
							if (this.styleLease) throw new ReferenceError('Editor client view has already been created');
							const lease = acquire(parent.ownerDocument);
							parent.dataset.ashEditorClient = identity;
							styledParents.set(parent, this);
							this.styleParent = parent;
							try {
								super.create(parent);
								this.styleLease = lease;
							} catch (error) {
								lease.dispose();
								this.clearStyleParent();
								throw error;
							}
						}
						public override dispose(): void {
							try { super.dispose(); }
							finally {
								this.styleLease?.dispose();
								this.styleLease = undefined;
								this.clearStyleParent();
							}
						}
						private clearStyleParent(): void {
							const parent = this.styleParent;
							if (parent && styledParents.get(parent) === this) {
								delete parent.dataset.ashEditorClient;
								styledParents.delete(parent);
							}
							this.styleParent = undefined;
						}
					}
					return { ...configuration, widget: StyledEditorWidget };
				}
			};
		},
	};
}

/** Code's product-compiled contributions retain their existing source identity until separately externalized. */
async function loadBuiltInModule(packageName: string, entry: string, expectedDigest: string): Promise<ExtensionEditorClientModule> {
	const modules = import.meta.glob<ExtensionEditorClientModule>('../../../../../../extensions/code/browser/editor.ts');
	const sources = import.meta.glob<string>('../../../../../../extensions/code/{browser,common}/**/*.{ts,css}', { query: '?raw', import: 'default' });
	const prefix = `../../../../../../extensions/${packageName}/`;
	const load = modules[`../../../../../../extensions/${packageName}/${entry}`];
	if (!load) throw new Error(localize('extensions.clientEditor.moduleUnavailable', 'This editor component is unavailable in this version of Ash.'));
	const paths = Object.keys(sources).filter(path => path.startsWith(prefix)).sort();
	const content = await Promise.all(paths.map(async path => `${path.slice(prefix.length)}\0${await sources[path]()}\0`));
	await verifyDigest(new TextEncoder().encode(content.join('')), expectedDigest);
	return load();
}
