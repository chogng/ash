import { TerminalLinkResolver } from './terminalLinkResolver.js';
import { isWindowsRemotePath } from '../../../../../platform/remote/common/remote.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import type { IBuffer, IBufferRange, ILink, IViewportRange } from '@xterm/xterm';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { raceCancellationError, timeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { computeLinks } from '../../../../../editor/common/languages/linkComputer.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../../files/browser/files.js';
import { VIEW_ID as EXPLORER_VIEW_ID } from '../../../files/common/files.js';
import type { ITerminalContribution, ITerminalExternalLinkProvider, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { ITerminalConfigurationService } from '../../../terminal/browser/terminal.js';
import { TerminalHover } from '../../../terminal/browser/widgets/terminalHoverWidget.js';
import { detectLinks, type IParsedLink } from './terminalLinkParsing.js';
import { ITerminalLinkProviderService } from './links.js';
import { ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { cancelOnDispose, type CancellationToken } from '../../../../../base/common/cancellation.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';

interface LinkCandidate extends IQuickPickItem {
	readonly text: string;
	readonly range?: IBufferRange;
	readonly cwd?: string;
	readonly file?: IParsedLink;
	readonly url?: string;
	readonly resource?: URI;
	readonly activate?: (text: string) => void;
	readonly provider?: ITerminalExternalLinkProvider;
}

/** Owns both pointer and keyboard links for one instance, including OSC 8 links. */
export class TerminalLinkContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.link';
	private screen: IXtermTerminal | undefined;
	private readonly resolver: TerminalLinkResolver;
	private generation = 0;
	private readonly hover = this._register(new MutableDisposable());
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());
	private readonly searches = this._register(new DisposableStore());
	private readonly activationController = new AbortController();
	private activation: Promise<void> | undefined;

	static get(instance: ITerminalInstance): TerminalLinkContribution | null {
		return instance.getContribution<TerminalLinkContribution>(TerminalLinkContribution.ID);
	}

	constructor(
		private readonly context: ITerminalContributionContext,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IPathService private readonly paths: IPathService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ITerminalConfigurationService private readonly configuration: ITerminalConfigurationService,
		@IViewsService private readonly views: IViewsService,
		@IExplorerService private readonly explorer: IExplorerService,
		@ISearchService private readonly search: ISearchService,
		@ITerminalLinkProviderService private readonly providers: ITerminalLinkProviderService,
		@IHostService private readonly host: IHostService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.resolver = instantiation.createInstance(TerminalLinkResolver);
		const invalidate = (): void => { this.generation++; this.hover.clear(); this.picker.clear(); this.searches.clear(); };
		this._register(context.instance.onDidChangeState(invalidate));
		this._register(workspace.onDidChangeWorkspace(invalidate));
		this._register(configuration.onConfigChanged(invalidate));
		this._register(providers.onDidRemoveLinkProvider(invalidate));
		this._register(providers.onDidAddLinkProvider(() => this.hover.clear()));
		this._register(toDisposable(() => this.activationController.abort()));
	}

	xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		void this.activateProviders();
		const raw = screen.raw;
		const provider = raw.registerLinkProvider({
			provideLinks: (line, callback) => {
				const generation = this.generation;
				const buffer = raw.buffer.active;
				const candidates = this.candidates(buffer, line - 1);
				const sourceLine = this.lineContext(buffer, line - 1, 'picker')?.text;
				const processId = this.context.instance.processId;
				void this.externalCandidates(buffer, line - 1).then(external => Promise.all([...external, ...candidates].slice(0, 32).map(async candidate => {
					if (!candidate.range) return undefined;
					if (candidate.file && !this.canSearch(candidate) && !await this.resolvePath(candidate)) return undefined;
					return {
						text: candidate.text, range: candidate.range,
						activate: () => { void this.open(candidate, generation, processId).catch(onUnexpectedError); },
						hover: (_event: MouseEvent, _text: string) => this.showHover(candidate),
						leave: () => this.hover.clear(),
					} satisfies ILink;
				}))).then(links => callback(this.isCurrent(generation, processId) && raw.buffer.active === buffer && this.lineContext(buffer, line - 1, 'picker')?.text === sourceLine
					? links.filter((link): link is NonNullable<typeof link> => !!link) : undefined), () => callback(undefined));
			}
		});
		this._register(toDisposable(() => provider.dispose()));
		const previousHandler = raw.options.linkHandler;
		const handler = { activate: (_event: MouseEvent, url: string) => { void this.openUrl(url).catch(onUnexpectedError); } };
		raw.options.linkHandler = handler;
		this._register(toDisposable(() => { if (!screen.isDisposed && raw.options.linkHandler === handler) raw.options.linkHandler = previousHandler; }));
		const scroll = raw.onScroll(() => this.hover.clear());
		this._register(toDisposable(() => scroll.dispose()));
	}

	async showLinkQuickpick(): Promise<void> {
		const screen = this.screen;
		if (!screen || screen.isDisposed) return;
		const activation = this.activateProviders();
		const generation = this.generation;
		const processId = this.context.instance.processId;
		const buffer = screen.raw.buffer.active;
		const items = new Map<string, LinkCandidate>();
		const lines: number[] = [];
		const end = buffer.length;
		for (let line = 0; line < end; line++) {
			if (line > 0 && line % 250 === 0) {
				await timeout(0);
				if (!this.isCurrent(generation, processId)) return;
			}
			if (buffer.getLine(line)?.isWrapped) continue;
			lines.push(line);
			for (const candidate of this.candidates(buffer, line, 'picker')) items.set(`${candidate.label}\0${candidate.cwd ?? ''}`, candidate);
		}
		const builtin = [...items.values()];
		const selected = await this.pick(builtin, (pick, lifetime) => {
			pick.busy = true;
			void activation.then(() => {
				if (lifetime.isDisposed || !this.isCurrent(generation, processId)) return;
				if (!this.providers.linkProviders.size) { pick.busy = false; return; }
				return this.populateExternalLinks(pick, lifetime, builtin, lines, buffer, generation, processId);
			}).catch(onUnexpectedError);
		});
		if (selected) await this.open(selected, generation, processId);
		else if (this.isCurrent(generation, processId)) screen.focus();
	}

	private activateProviders(): Promise<void> {
		if (!this.activation) {
			const signal = this.activationController.signal;
			this.activation = Promise.resolve().then(() => {
				if (!signal.aborted) return this.extensions.activateByEvent('onTerminal', signal);
			}).catch(error => {
				if (!signal.aborted) this.log.error('terminal', 'Terminal link provider activation failed', error);
			}).finally(() => this.activation = undefined);
		}
		return this.activation;
	}

	private async populateExternalLinks(pick: IQuickPick<LinkCandidate>, lifetime: DisposableStore, builtin: LinkCandidate[], lines: number[], buffer: IBuffer, generation: number, processId: number): Promise<void> {
		const cancellation = cancelOnDispose(lifetime);
		const results = new Map<number, LinkCandidate[]>();
		// Start near the prompt, where recent diagnostics are useful, while displaying
		// completed results in buffer order regardless of provider completion order.
		let next = lines.length - 1;
		pick.busy = true;
		const worker = async (): Promise<void> => {
			while (next >= 0 && !cancellation.isCancellationRequested && this.isCurrent(generation, processId)) {
				const line = lines[next--]!;
				try {
					const links = await raceCancellationError(this.externalCandidates(buffer, line, cancellation), cancellation);
					if (!this.isCurrent(generation, processId) || cancellation.isCancellationRequested) return;
					if (links.length) {
						results.set(line, links);
						pick.items = [...builtin, ...[...results.entries()].sort(([a], [b]) => a - b).flatMap(([, candidates]) => candidates)];
					}
				} catch { return; }
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, lines.length) }, () => worker()));
		if (!lifetime.isDisposed) pick.busy = false;
	}

	private async pick(items: LinkCandidate[], enrich?: (pick: IQuickPick<LinkCandidate>, lifetime: DisposableStore) => void): Promise<LinkCandidate | undefined> {
		const session = new DisposableStore();
		this.picker.value = session;
		try {
			const selected = await new Promise<LinkCandidate | undefined>(resolve => {
				session.add(toDisposable(() => resolve(undefined)));
				const pick = session.add(this.quickInput.createQuickPick<LinkCandidate>());
				pick.ariaLabel = localize('terminal.links.choose', 'Open a terminal link');
				pick.placeholder = localize('terminal.links.select', 'Select a terminal file, folder or URL to open');
				pick.items = items;
				session.add(pick.onDidAccept(() => { if (pick.selectedItems[0]) resolve(pick.selectedItems[0]); }));
				session.add(pick.onDidHide(() => resolve(undefined)));
				session.add(pick.onDidBlur(() => resolve(undefined)));
				pick.show();
				enrich?.(pick, session);
			});
			// Dismiss before opening the editor so Quick Input cannot steal its focus back.
			session.dispose();
			return selected;
		} finally { session.dispose(); }
	}

	private lineContext(buffer: IBuffer, line: number, mode: 'pointer' | 'picker' = 'pointer') {
		const screen = this.screen;
		if (!screen) return undefined;
		let first = line;
		while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
		let text = '';
		const cells: { x: number; y: number; width: number; }[] = [];
		for (let row = first; row < buffer.length && row < first + 8192; row++) {
			if (row > first && !buffer.getLine(row)?.isWrapped) break;
			const current = buffer.getLine(row);
			if (!current) break;
			const next = buffer.getLine(row + 1);
			const continues = next?.isWrapped === true;
			let content = current.translateToString(!continues);
			// A wide glyph can wrap with one unused cell left in the previous row.
			// Written spaces must survive wrapping; this empty padding cell must not.
			if (continues && !current.getCell(current.length - 1)?.getChars() && next?.getCell(0)?.getWidth() === 2) content = content.slice(0, -1);
			text += content;
			if (text.length > 8192) return undefined;
			if (mode === 'picker') continue;
			let offset = 0;
			for (let col = 0; col < current.length && offset < content.length; col++) {
				const cell = current.getCell(col);
				if (!cell?.getWidth()) continue;
				const chars = cell.getChars() || ' ';
				for (let unit = 0; unit < chars.length; unit++) cells.push({ x: col + 1, y: row + 1, width: cell.getWidth() });
				offset += chars.length;
			}
		}
		const range = (start: number, end: number): IBufferRange | undefined => {
			const a = cells[start], b = cells[end - 1];
			return a && b ? { start: { x: a.x, y: a.y }, end: { x: b.x + b.width - 1, y: b.y } } : undefined;
		};
		return { text, range, first };
	}

	private candidates(buffer: IBuffer, line: number, mode: 'pointer' | 'picker' = 'pointer'): LinkCandidate[] {
		const context = this.lineContext(buffer, line, mode);
		if (!context) return [];
		const { text, range, first } = context;
		const result: LinkCandidate[] = [];
		const parsed = detectLinks(text, isWindowsRemotePath(this.context.instance.initialCwd) ? OperatingSystem.Windows : OperatingSystem.Linux);
		// Word links are deliberately low-confidence: they search only when activated.
		const occupied = parsed.map(file => ({ start: file.path.index, end: file.suffix ? file.suffix.suffix.index + file.suffix.suffix.text.length : file.path.index + file.path.text.length }));
		const separators = new Set(this.configuration.config.wordSeparators ?? ' ()[]{}\',"`─‘’“”|');
		let start = 0;
		for (let i = 0; i <= text.length; i++) {
			if (i < text.length && !/\s/u.test(text[i]!) && !separators.has(text[i]!)) continue;
			if (i > start && !occupied.some(span => start < span.end && i > span.start)) {
				const word = text.slice(start, i);
				if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(word)) parsed.push({ path: { index: start, text: word } });
			}
			start = i + 1;
		}
		for (const file of this.fileLinksEnabled() ? parsed.sort((a, b) => a.path.index - b.path.index) : []) {
			const end = file.suffix ? file.suffix.suffix.index + file.suffix.suffix.text.length : file.path.index + file.path.text.length;
			const bufferRange = mode === 'picker' ? undefined : range(file.path.index, end);
			const cwd = this.context.instance.capabilities?.get(TerminalCapability.CommandDetection)?.getCwdForLine(first)
				?? this.context.instance.cwd ?? this.context.instance.initialCwd;
			const label = file.path.text + (file.suffix ? `:${file.suffix.row}${file.suffix.col === undefined ? '' : `:${file.suffix.col}`}` : '');
			if (mode === 'picker' || bufferRange) result.push({ label, text: text.slice(file.path.index, end), description: cwd, cwd, file, range: bufferRange });
		}
		for (const link of computeLinks({ getLineCount: () => 1, getLineContent: () => text })) {
			const url = String(link.url);
			if (!/^https?:\/\//iu.test(url)) continue;
			const bufferRange = mode === 'picker' ? undefined : range(link.range.startColumn - 1, link.range.endColumn - 1);
			if (mode === 'picker' || bufferRange) result.push({ label: url, text: text.slice(link.range.startColumn - 1, link.range.endColumn - 1), url, range: bufferRange });
		}
		return result;
	}

	private fileLinksEnabled(): boolean {
		const mode = this.configuration.config.enableFileLinks;
		return mode !== 'off' && (mode !== 'notRemote' || this.workspace.getWorkspace().folders.find(folder => folder.id === this.context.instance.dirId)?.uri.scheme === 'file');
	}

	private canSearch(candidate: LinkCandidate): boolean {
		const path = candidate.file?.path.text;
		return !!path && !/^(?:[\\/~]|[a-z]:|file:)/iu.test(path) && !/[\\/]$/u.test(path);
	}

	private async externalCandidates(buffer: IBuffer, line: number, cancellation?: CancellationToken): Promise<LinkCandidate[]> {
		if (!this.providers.linkProviders.size) return [];
		const context = this.lineContext(buffer, line);
		if (!context) return [];
		const result: LinkCandidate[] = [];
		for (const provider of [...this.providers.linkProviders]) {
			if (cancellation?.isCancellationRequested) return [];
			try {
				const links = await provider.provideLinks(this.context.instance, context.text);
				if (!this.providers.linkProviders.has(provider)) continue;
				for (const link of (links ?? []).slice(0, 256)) {
					// Provider coordinates cross an extension boundary and must fit this snapshot.
					if (!Number.isSafeInteger(link.startIndex) || !Number.isSafeInteger(link.length) || link.startIndex < 0 || link.length <= 0 || link.startIndex + link.length > context.text.length) continue;
					const range = context.range(link.startIndex, link.startIndex + link.length);
					if (!range) continue;
					const text = context.text.slice(link.startIndex, link.startIndex + link.length);
					result.push({ text, label: link.label || text, range, provider, activate: link.activate.bind(link) });
				}
			} catch { /* A failed extension does not suppress built-in links. */ }
		}
		result.sort((a, b) => a.range!.start.y - b.range!.start.y || a.range!.start.x - b.range!.start.x);
		return this.lineContext(buffer, line, 'picker')?.text === context.text ? result : [];
	}

	private async resolvePath(candidate: LinkCandidate): Promise<Awaited<ReturnType<TerminalLinkResolver['resolveLink']>> | undefined> {
		const path = candidate.file?.path.text;
		if (!path) return undefined;
		const instance = this.context.instance;
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
		if (!folder) return undefined;
		const rules = await this.paths.getPath(folder.uri);
		if (!rules) return undefined;
		const windows = rules.sep === '\\';
		let userHome: string | undefined;
		if (path.startsWith('~/') || windows && path.startsWith('~\\')) {
			// Resolve home through the selected directory's execution grant, not the ambient App Server.
			try {
				const environment = await this.processes.getEnvironment([windows ? 'USERPROFILE' : 'HOME'], instance.dirId);
				userHome = environment[windows ? 'USERPROFILE' : 'HOME'];
			} catch { return undefined; }
		}
		const result = await this.resolver.resolveLink({
			initialCwd: candidate.cwd ?? instance.initialCwd,
			os: windows ? OperatingSystem.Windows : OperatingSystem.Linux,
			remoteAuthority: folder.uri.scheme === 'ash-remote' ? folder.uri.authority : undefined,
			userHome,
		}, path, path.startsWith('file://') ? URI.parse(path) : undefined);
		// Native window opening currently accepts local paths only. Remote authority must
		// never be discarded by passing an ash-remote resource to the local host owner.
		if (result?.isDirectory && this.workspace.getWorkspaceFolder(result.uri)?.id !== instance.dirId && result.uri.scheme !== 'file') return undefined;
		return result;
	}

	private async open(candidate: LinkCandidate, generation: number, processId: number): Promise<void> {
		if (!this.isCurrent(generation, processId)) return;
		if (candidate.activate) {
			if (candidate.provider && this.providers.linkProviders.has(candidate.provider)) candidate.activate(candidate.text);
			return;
		}
		if (candidate.url) { await this.openUrl(candidate.url); return; }
		let resolved = candidate.resource ? { uri: candidate.resource, isDirectory: false } : await this.resolvePath(candidate);
		if (!this.isCurrent(generation, processId)) return;
		if (!resolved && this.canSearch(candidate)) {
			const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === this.context.instance.dirId);
			if (folder) {
				const path = candidate.file!.path.text.replaceAll('\\', '/').replace(/^\.\//u, '');
				const request = this.searches.add(new DisposableStore());
				try {
					const matches = await this.search.fileSearch({ type: QueryType.File, folderQueries: [{ folder: folder.uri }], filePattern: path, maxResults: 100 }, cancelOnDispose(request));
					if (!this.isCurrent(generation, processId)) return;
					const caseInsensitive = isWindowsRemotePath(this.context.instance.initialCwd);
					const suffix = caseInsensitive ? path.toLowerCase() : path;
					const resources = [...new Map(matches.results.filter(match => {
						if (this.workspace.getWorkspaceFolder(match.resource)?.id !== folder.id) return false;
						const resourcePath = caseInsensitive ? match.resource.path.toLowerCase() : match.resource.path;
						return resourcePath.endsWith(`/${suffix}`) || resourcePath === suffix;
					}).map(match => [match.resource.toString(), match.resource])).values()];
					const choose = resources.length > 1 || matches.limitHit && resources.length > 0;
					const resource = choose ? (await this.pick(resources.map(resource => ({ ...candidate, label: resource.path, resource }))))?.resource : resources[0];
					if (resource) resolved = { uri: resource, isDirectory: false };
					else if (choose) { if (this.isCurrent(generation, processId)) this.screen?.focus(); return; }
				} catch { /* The normal unavailable-path warning handles failed searches. */ }
				finally { this.searches.delete(request); request.dispose(); }
			}
		}
		if (!this.isCurrent(generation, processId)) return;
		if (!resolved) {
			this.notifications.warn(localize('terminal.links.fileUnavailable', 'Could not open the terminal path: {0}', candidate.file?.path.text ?? candidate.label));
			return;
		}
		if (resolved.isDirectory) {
			if (this.workspace.getWorkspaceFolder(resolved.uri)?.id !== this.context.instance.dirId) {
				try { await this.host.openWindow([{ folderUri: resolved.uri }], { forceNewWindow: true }); }
				catch {
					if (this.isCurrent(generation, processId)) this.notifications.warn(localize('terminal.links.fileUnavailable', 'Could not open the terminal path: {0}', candidate.file?.path.text ?? candidate.label));
				}
				return;
			}
			const view = await this.views.openView(EXPLORER_VIEW_ID);
			if (!view || !this.isCurrent(generation, processId)) return;
			await this.explorer.select(resolved.uri, 'force');
			if (this.isCurrent(generation, processId)) view.focus();
			return;
		}
		const row = candidate.file?.suffix?.row ?? 1;
		const col = candidate.file?.suffix?.col ?? 1;
		await this.editors.openEditor({ resource: resolved.uri }, { selection: new Range(row, col, row, col) });
	}

	private async openUrl(url: string): Promise<void> {
		if (!this.isDisposed) await this.opener.open(url, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true });
	}

	private isCurrent(generation: number, processId: number): boolean {
		return !this.isDisposed && generation === this.generation && this.context.instance.processId === processId && !!this.screen && !this.screen.isDisposed;
	}

	private showHover(candidate: LinkCandidate): void {
		const screen = this.screen;
		if (!screen || screen.isDisposed || !candidate.range || !this.configuration.config.showLinkHover || screen.element.hidden) return;
		const rect = screen.element.querySelector('.xterm-screen')?.getBoundingClientRect();
		if (!rect?.width || !rect.height) return;
		const viewportY = screen.raw.buffer.active.viewportY;
		const viewportRange: IViewportRange = {
			start: { x: candidate.range.start.x, y: candidate.range.start.y - viewportY },
			end: { x: candidate.range.end.x, y: candidate.range.end.y - viewportY },
		};
		this.hover.value = screen.attachWidget(this.instantiation.createInstance(TerminalHover, {
			viewportRange, cellDimensions: { width: rect.width / screen.raw.cols, height: rect.height / screen.raw.rows },
			terminalDimensions: { width: rect.width, height: rect.height },
		}, candidate.label));
	}

	protected override disposeCore(): void {
		this.generation++;
		this.screen = undefined;
		super.disposeCore();
	}
}
