import { LinkedList } from '../../../base/common/linkedList.js';
import { type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { type ITextEditorOptions } from '../../../platform/editor/common/editor.js';
import { type ICodeEditorService } from './codeEditorService.js';

export interface OpenOptions {
	readonly openExternal?: boolean;
	readonly openToSide?: boolean;
	readonly fromUserGesture?: boolean;
	readonly editorOptions?: ITextEditorOptions;
	readonly skipValidation?: boolean;
	readonly allowContributedOpeners?: boolean | string;
}

export interface IOpener {
	open(target: URI | string, options?: OpenOptions): boolean | Promise<boolean>;
}

export interface IValidator {
	shouldOpen(target: URI | string, options?: OpenOptions): boolean | Promise<boolean>;
}

export interface ResolveExternalUriOptions {
	readonly allowTunneling?: boolean;
}

export interface IResolvedExternalUri {
	readonly resolved: URI;
	dispose?(): void;
}

export interface IExternalUriResolver {
	resolveExternalUri(resource: URI, options?: ResolveExternalUriOptions): IResolvedExternalUri | undefined | Promise<IResolvedExternalUri | undefined>;
}

export interface IExternalOpener {
	openExternal(href: string, options: { readonly sourceUri: URI; readonly preferredOpenerId?: string }, signal: AbortSignal): boolean | Promise<boolean>;
}

/** Orders validation, URI resolution and editor/external opening without host policy. */
export class OpenerService {
	declare readonly _serviceBrand: undefined;
	private readonly _openers = new LinkedList<IOpener>();
	private readonly _validators = new LinkedList<IValidator>();
	private readonly _resolvers = new LinkedList<IExternalUriResolver>();
	private readonly _resolvedUriTargets = new Map<string, URI>();
	private _defaultExternalOpener: IExternalOpener | undefined;
	private readonly _externalOpeners = new LinkedList<IExternalOpener>();

	constructor(editorService: ICodeEditorService) {
		this._openers.push({
			open: async (target, options) => {
				const resource = typeof target === 'string' ? URI.parse(target) : target;
				const editor = await editorService.openCodeEditor(
					{ resource, options: options?.editorOptions },
					editorService.getFocusedCodeEditor(),
					options?.openToSide,
				);
				return editor !== null;
			},
		});
	}

	registerOpener(opener: IOpener): IDisposable {
		return toDisposable(this._openers.unshift(opener));
	}

	registerValidator(validator: IValidator): IDisposable {
		return toDisposable(this._validators.push(validator));
	}

	registerExternalUriResolver(resolver: IExternalUriResolver): IDisposable {
		return toDisposable(this._resolvers.push(resolver));
	}

	setDefaultExternalOpener(opener: IExternalOpener): void {
		this._defaultExternalOpener = opener;
	}

	registerExternalOpener(opener: IExternalOpener): IDisposable {
		return toDisposable(this._externalOpeners.unshift(opener));
	}

	async open(target: URI | string, options?: OpenOptions): Promise<boolean> {
		const resource = typeof target === 'string' ? URI.parse(target) : target;
		if (!options?.skipValidation) {
			const validationTarget = this._resolvedUriTargets.get(resource.toString()) ?? target;
			for (const validator of this._validators) {
				if (!await validator.shouldOpen(validationTarget, options)) return false;
			}
		}
		if (options?.openExternal || resource.scheme === 'http' || resource.scheme === 'https' || resource.scheme === 'mailto') {
			return this._doOpenExternal(target, options);
		}
		for (const opener of this._openers) {
			if (await opener.open(target, options)) return true;
		}
		return false;
	}

	async resolveExternalUri(resource: URI, options?: ResolveExternalUriOptions): Promise<IResolvedExternalUri> {
		for (const resolver of this._resolvers) {
			const result = await resolver.resolveExternalUri(resource, options);
			if (!result) continue;
			this._resolvedUriTargets.set(result.resolved.toString(), resource);
			return result;
		}
		throw new Error(`Could not resolve external URI: ${resource.toString()}`);
	}

	private async _doOpenExternal(target: URI | string, options?: OpenOptions): Promise<boolean> {
		const sourceUri = typeof target === 'string' ? URI.parse(target) : target;
		let resolved = sourceUri;
		for (const resolver of this._resolvers) {
			const result = await resolver.resolveExternalUri(sourceUri);
			if (!result) continue;
			resolved = result.resolved;
			this._resolvedUriTargets.set(resolved.toString(), sourceUri);
			break;
		}
		const href = resolved.toString();
		if (options?.allowContributedOpeners) {
			const preferredOpenerId = typeof options.allowContributedOpeners === 'string' ? options.allowContributedOpeners : undefined;
			for (const opener of this._externalOpeners) {
				if (await opener.openExternal(href, { sourceUri, preferredOpenerId }, new AbortController().signal)) return true;
			}
		}
		if (!this._defaultExternalOpener) throw new Error('No default external opener is registered');
		return this._defaultExternalOpener.openExternal(href, { sourceUri }, new AbortController().signal);
	}

	dispose(): void {
		this._openers.clear();
		this._validators.clear();
		this._resolvers.clear();
		this._externalOpeners.clear();
		this._resolvedUriTargets.clear();
		this._defaultExternalOpener = undefined;
	}
}
