import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { LinkedList } from '../../../../base/common/linkedList.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ExternalUriOpenerPriority } from '../../../../editor/common/languages.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defaultExternalUriOpenerId, IOpenerService, type IExternalOpener } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { testUrlMatchesGlob } from '../../../../platform/url/common/urlGlob.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { externalUriOpenersSettingId, type ExternalUriOpenersConfiguration } from './configuration.js';

export interface IExternalOpenerProvider {
	getOpeners(targetUri: URI): AsyncIterable<IExternalUriOpener>;
}

export interface IExternalUriOpener {
	readonly id: string;
	readonly label: string;
	canOpen(uri: URI, token: CancellationToken): Promise<ExternalUriOpenerPriority>;
	openExternalUri(uri: URI, ctx: { sourceUri: URI }, token: CancellationToken): Promise<boolean>;
}

export interface IExternalUriOpenerService {
	readonly _serviceBrand: undefined;
	registerExternalOpenerProvider(provider: IExternalOpenerProvider): IDisposable;
	/** Returns a handler without prompting, including handlers offered only as an option. */
	getOpener(uri: URI, ctx: { sourceUri: URI; preferredOpenerId?: string }, token: CancellationToken): Promise<IExternalUriOpener | undefined>;
}

export const IExternalUriOpenerService = createServiceIdentifier<IExternalUriOpenerService>('externalUriOpenerService');

type OpenerContext = { sourceUri: URI; preferredOpenerId?: string };
type OpenerPick = IQuickPickItem & { opener: IExternalUriOpener | 'default' | 'configure' };

/** Owns provider selection; the platform opener retains validation, resolution and host execution. */
export class ExternalUriOpenerService extends Disposable implements IExternalUriOpenerService, IExternalOpener {
	declare public readonly _serviceBrand: undefined;
	private readonly providers = new LinkedList<IExternalOpenerProvider>();
	private readonly prompts = this._register(new DisposableStore());

	constructor(
		@IOpenerService openerService: IOpenerService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._register(openerService.registerExternalOpener(this));
		this._register(toDisposable(() => this.providers.clear()));
	}

	public registerExternalOpenerProvider(provider: IExternalOpenerProvider): IDisposable {
		this.assertNotDisposed();
		return toDisposable(this.providers.push(provider));
	}

	public async getOpener(uri: URI, ctx: OpenerContext, token: CancellationToken): Promise<IExternalUriOpener | undefined> {
		return (await this.selectOpeners(uri, ctx, token, true))[0];
	}

	public async openExternal(href: string, ctx: OpenerContext, token: CancellationToken): Promise<boolean> {
		const uri = URI.parse(href);
		const openers = await this.selectOpeners(uri, ctx, token, false);
		if (token.isCancellationRequested || this.isDisposed) {
			return true;
		}
		if (openers.length === 0) {
			return false;
		}
		if (openers.length === 1) {
			return openers[0]!.openExternalUri(uri, ctx, token);
		}
		const picked = await this.prompt(openers, uri, token);
		// Dismissing the chooser consumes this request; it must not launch the browser.
		if (!picked || token.isCancellationRequested || this.isDisposed) {
			return true;
		}
		if (picked.opener === 'default') {
			return false;
		}
		if (picked.opener === 'configure') {
			await this.preferencesService.openUserSettings({ revealSetting: { key: externalUriOpenersSettingId, edit: true } });
			return true;
		}
		return picked.opener.openExternalUri(uri, ctx, token);
	}

	private async selectOpeners(uri: URI, ctx: OpenerContext, token: CancellationToken, includeOptions: boolean): Promise<IExternalUriOpener[]> {
		this.assertNotDisposed();
		if (token.isCancellationRequested || ctx.preferredOpenerId === defaultExternalUriOpenerId || (uri.scheme !== Schemas.http && uri.scheme !== Schemas.https)) {
			return [];
		}
		const candidates = new Map<string, IExternalUriOpener>();
		for (const provider of this.providers) {
			try {
				for await (const opener of provider.getOpeners(uri)) {
					if (token.isCancellationRequested || this.isDisposed) {
						return [];
					}
					candidates.set(opener.id, opener);
				}
			} catch (error) {
				this.logService.error('externalUriOpener', error);
			}
		}
		if (token.isCancellationRequested || this.isDisposed) {
			return [];
		}
		if (ctx.preferredOpenerId && candidates.has(ctx.preferredOpenerId)) {
			return [candidates.get(ctx.preferredOpenerId)!];
		}
		const rules = this.configurationService.getValue<ExternalUriOpenersConfiguration>(externalUriOpenersSettingId);
		for (const [pattern, id] of Object.entries(rules)) {
			if (testUrlMatchesGlob(uri, pattern)) {
				if (id === defaultExternalUriOpenerId) {
					return [];
				}
				const configured = candidates.get(id);
				if (configured) {
					return [configured];
				}
			}
		}
		const choices: { opener: IExternalUriOpener; priority: ExternalUriOpenerPriority }[] = [];
		for (const opener of candidates.values()) {
			try {
				const priority = await opener.canOpen(ctx.sourceUri, token);
				if (token.isCancellationRequested || this.isDisposed) {
					return [];
				}
				if (priority === ExternalUriOpenerPriority.Preferred) {
					return [opener];
				}
				if (priority === ExternalUriOpenerPriority.Default || priority === ExternalUriOpenerPriority.Option) {
					choices.push({ opener, priority });
				}
			} catch (error) {
				this.logService.error('externalUriOpener', error);
			}
		}
		return includeOptions || choices.some(choice => choice.priority === ExternalUriOpenerPriority.Default) ? choices.map(choice => choice.opener) : [];
	}

	private async prompt(openers: readonly IExternalUriOpener[], uri: URI, token: CancellationToken): Promise<OpenerPick | undefined> {
		const session = this.prompts.add(new DisposableStore());
		try {
			return await new Promise<OpenerPick | undefined>(resolve => {
				session.add(toDisposable(() => resolve(undefined)));
				const picker = session.add(this.quickInputService.createQuickPick<OpenerPick>());
				picker.ariaLabel = localize('externalUriOpener.choose', 'Choose how to open this link');
				picker.placeholder = localize('externalUriOpener.prompt', 'How would you like to open {0}?', uri.toString());
				picker.items = [
					...openers.map(opener => ({ label: opener.label, opener })),
					{ label: localize('externalUriOpener.default', 'Open in default browser'), opener: 'default' },
					{ label: localize('externalUriOpener.configure', 'Configure default opener...'), opener: 'configure' },
				];
				session.add(picker.onDidAccept(item => resolve(item)));
				session.add(picker.onDidHide(() => resolve(undefined)));
				session.add(picker.onDidBlur(() => resolve(undefined)));
				session.add(token.onCancellationRequested(() => resolve(undefined)));
				picker.show();
			});
		} finally {
			this.prompts.delete(session);
			session.dispose();
		}
	}
}
