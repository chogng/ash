import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import type { ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { EditorInputSerializers, requireRecord, requireString, optionalString } from '../../../services/editor/common/editorInputSerializer.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export enum ExtensionsInputSource {
	Registry = 'registry',
	BuiltIn = 'builtIn',
	Local = 'local',
}

/** Built-ins without licensed artwork use Ash monograms, never file-theme brand guesses. */
export function getExtensionFallbackIcon(id: string, source = ExtensionsInputSource.Registry): ThemeIcon | URI {
	if (source !== ExtensionsInputSource.BuiltIn) { return Lxicon.extensions; }
	const name = id.split('.').at(-1) ?? id;
	const abbreviations: Record<string, string> = { clojure: 'CLJ', coffeescript: 'COF', javascript: 'JS', typescript: 'TS' };
	const words = name.split('-');
	const abbreviation = Object.hasOwn(abbreviations, name) ? abbreviations[name] : undefined;
	const letters = (abbreviation ?? (words.length > 1 ? words.map(word => word[0]).join('') : name.slice(0, 4))).replace(/[^a-z0-9]/giu, '').toUpperCase();
	const artwork = name === 'bazel'
		? '<path d="m24 72 34-34m-9-12 21 21m-25-13 9-9 17 17-9 9" fill="none" stroke="GrayText" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
		: `<text x="48" y="50" fill="GrayText" font-family="monospace" font-size="${letters.length > 3 ? 32 : 40}" font-weight="600" text-anchor="middle" dominant-baseline="middle">${letters}</text>`;
	return URI.from({ scheme: 'data', path: `image/svg+xml;base64,${encodeBase64(VSBuffer.fromString(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">${artwork}</svg>`))}` });
}

/** An installed version has a separate identity so actions always target the reviewed installation. */
export class ExtensionsInput extends EditorInput {
	public readonly typeId = 'ash.extensions.input';
	public override readonly editorId = 'ash.extensions.editor';
	private readonly labelChanged = this._register(new Emitter<void>());
	public readonly onDidChangeLabel = this.labelChanged.event;
	private icon: URI | undefined;
	private readonly fallbackIcon: ThemeIcon | URI;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public readonly resource: URI;

	constructor(public readonly summary: ExtensionsPackageSummary, public readonly installationId?: string, public readonly source = ExtensionsInputSource.Registry) {
		super();
		this.resource = URI.from({ scheme: Schemas.ashExtension, path: `/${source}/${installationId ?? summary.id}`, query: summary.version });
		this.fallbackIcon = getExtensionFallbackIcon(summary.id, source);
	}

	public getName(): string { return this.summary.displayName; }
	public getIcon(): ThemeIcon | URI { return this.icon ?? this.fallbackIcon; }

	/** The retained pane publishes its live icon, then resets it before releasing the image URL. */
	public setIcon(icon: URI | undefined): void {
		if (this.isDisposed || this.icon === icon) { return; }
		this.icon = icon;
		this.labelChanged.fire();
	}
}

// Persist identity and inert metadata, then resolve the installation from the backend on restore.
EditorInputSerializers.registerStatic({
	typeId: 'ash.extensions.input',
	canSerialize: input => input instanceof ExtensionsInput,
	serialize: input => {
		if (!(input instanceof ExtensionsInput)) { throw new TypeError('Invalid Extensions input'); }
		return { ...input.summary, installationId: input.installationId, source: input.source };
	},
	deserialize: value => {
		const record = requireRecord(value, 'Extensions input');
		const source = optionalString(record.source, 'extension source') ?? ExtensionsInputSource.Registry;
		if (!Object.values(ExtensionsInputSource).includes(source as ExtensionsInputSource)) { throw new TypeError('Invalid extension source'); }
		const id = requireString(record.id, 'extension ID');
		return new ExtensionsInput({
			// Resolve the renamed built-in before constructing its resource identity.
			id: source === ExtensionsInputSource.BuiltIn && id === 'vscode.rust' ? 'ash.rust' : id,
			version: requireString(record.version, 'extension version'),
			displayName: requireString(record.displayName, 'extension name'),
			packageType: requireString(record.packageType, 'extension type'),
			description: optionalString(record.description, 'extension description') ?? '',
		}, optionalString(record.installationId, 'extension installation ID'), source as ExtensionsInputSource);
	},
});

export type ExtensionsCapabilityTarget =
	| { readonly kind: 'skill'; readonly source: string; readonly name: string; readonly sessionId?: string; }
	| { readonly kind: 'connector'; readonly connectorId: string; }
	| { readonly kind: 'mcp'; readonly serverId: string; readonly installationId?: string; readonly capabilityId?: string; };

/** Capability tabs retain identity only; their details are re-read from the owning service. */
export class ExtensionsCapabilityInput extends EditorInput {
	public readonly typeId = 'ash.extensions.capabilityInput';
	public override readonly editorId = 'ash.extensions.editor';
	public readonly onDidChangeLabel = undefined;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public readonly resource: URI;

	constructor(public readonly target: ExtensionsCapabilityTarget) {
		super();
		this.resource = URI.from({ scheme: Schemas.ashExtension, path: `/${target.kind}/${encodeURIComponent(JSON.stringify(target))}` });
	}

	public getName(): string { return this.target.kind === 'skill' ? this.target.name : this.target.kind === 'connector' ? this.target.connectorId : this.target.serverId; }
}

EditorInputSerializers.registerStatic({
	typeId: 'ash.extensions.capabilityInput',
	canSerialize: input => input instanceof ExtensionsCapabilityInput,
	serialize: input => {
		if (!(input instanceof ExtensionsCapabilityInput)) { throw new TypeError('Invalid capability input'); }
		return input.target;
	},
	deserialize: value => {
		const record = requireRecord(value, 'Capability input');
		if (record.kind === 'skill') {
			return new ExtensionsCapabilityInput({ kind: 'skill', source: requireString(record.source, 'skill source'), name: requireString(record.name, 'skill name'), sessionId: optionalString(record.sessionId, 'skill session') });
		}
		if (record.kind === 'mcp') {
			return new ExtensionsCapabilityInput({ kind: 'mcp', serverId: requireString(record.serverId, 'MCP server'), installationId: optionalString(record.installationId, 'MCP installation'), capabilityId: optionalString(record.capabilityId, 'MCP capability') });
		}
		if (record.kind === 'connector') {
			return new ExtensionsCapabilityInput({ kind: 'connector', connectorId: requireString(record.connectorId, 'connector ID') });
		}
		throw new TypeError('Invalid capability kind');
	},
});
