import { LinkedList } from '../../../base/common/linkedList.js';
import { AbstractDisposable, type IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { getWindow, windowOpenNoOpener } from '../../../base/browser/dom.js';
import { defaultExternalUriOpenerId, normalizeExternalUrl, extractSelection } from '../../../platform/opener/common/opener.js';
import type {
	IExternalOpener,
	IExternalUriResolver,
	IOpener,
	IOpenerService,
	IResolvedExternalUri,
	IValidator,
	OpenOptions,
	ResolveExternalUriOptions,
} from '../../../platform/opener/common/opener.js';
import { ICodeEditorService } from './codeEditorService.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';

/** Orders validation, URI resolution and editor/external opening without host policy. */
export class OpenerService extends AbstractDisposable implements IOpenerService {
	declare readonly _serviceBrand: undefined;
	private readonly _openers = new LinkedList<IOpener>();
	private readonly _validators = new LinkedList<IValidator>();
	private readonly _resolvers = new LinkedList<IExternalUriResolver>();
	private readonly _resolvedUriTargets = new Map<string, URI>();
	private _defaultExternalOpener: IExternalOpener | undefined;
	private readonly _externalOpeners = new LinkedList<IExternalOpener>();

	constructor(@ICodeEditorService editorService: ICodeEditorService, @ICommandService private readonly commandService: ICommandService) {
		super();
		this._defaultExternalOpener = {
			openExternal: async href => {
				const url = normalizeExternalUrl(href);
				if (URI.parse(url).scheme === 'mailto') {
					// Mail handlers should launch without leaving an empty browser tab.
					getWindow().location.href = url;
				} else {
					windowOpenNoOpener(url);
				}
				return true;
			},
		};
		this._openers.push({
			open: async (target, options) => {
				const parsed = extractSelection(typeof target === 'string' ? URI.parse(target) : target);
				const resource = parsed.uri;
				const editor = await editorService.openCodeEditor(
					{ resource, options: { ...options?.editorOptions, selection: parsed.selection ?? options?.editorOptions?.selection } },
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
		if (resource.scheme === 'command') {
			const id = resource.path.replace(/^\/+/, '');
			const allowed = options?.allowCommands;
			if (allowed !== true && !(Array.isArray(allowed) && allowed.includes(id))) {
				return true;
			}
			// URI components are already decoded; decoding again would corrupt literal percent sequences.
			let args: unknown[] = [];
			if (resource.query) {
				const value: unknown = JSON.parse(resource.query);
				args = Array.isArray(value) ? value : [value];
			}
			await this.commandService.executeCommand(id, ...args);
			return true;
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
		let resolution: IResolvedExternalUri | undefined;
		for (const resolver of this._resolvers) {
			const result = await resolver.resolveExternalUri(sourceUri);
			if (!result) continue;
			resolved = result.resolved;
			resolution = result;
			this._resolvedUriTargets.set(resolved.toString(), sourceUri);
			break;
		}
		try {
			const href = resolved.toString();
			if (options?.allowContributedOpeners && options.allowContributedOpeners !== defaultExternalUriOpenerId) {
				const preferredOpenerId = typeof options.allowContributedOpeners === 'string' ? options.allowContributedOpeners : undefined;
				for (const opener of this._externalOpeners) {
					if (await opener.openExternal(href, { sourceUri, preferredOpenerId }, CancellationToken.None)) return true;
				}
			}
			if (!this._defaultExternalOpener) throw new Error('No default external opener is registered');
			return await this._defaultExternalOpener.openExternal(href, { sourceUri }, CancellationToken.None);
		} finally {
			resolution?.dispose();
		}
	}

	protected override disposeCore(): void {
		this._openers.clear();
		this._validators.clear();
		this._resolvers.clear();
		this._externalOpeners.clear();
		this._resolvedUriTargets.clear();
		this._defaultExternalOpener = undefined;
	}
}
