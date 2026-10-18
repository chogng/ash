import { TerminalLinkResolver } from './terminalLinkResolver.js';
import { isWindowsRemotePath } from '../../../../../platform/remote/common/remote.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import type { IBuffer, IBufferRange, ILink, IViewportRange } from '@xterm/xterm';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { timeout } from '../../../../../base/common/async.js';
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
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { ITerminalContribution, ITerminalInstance, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { ITerminalConfigurationService } from '../../../terminal/browser/terminal.js';
import { TerminalHover } from '../../../terminal/browser/widgets/terminalHoverWidget.js';
import { detectLinks, type IParsedLink } from './terminalLinkParsing.js';

interface LinkCandidate extends IQuickPickItem {
	readonly text: string;
	readonly range?: IBufferRange;
	readonly cwd?: string;
	readonly file?: IParsedLink;
	readonly url?: string;
}

/** Owns both pointer and keyboard links for one instance, including OSC 8 links. */
export class TerminalLinkContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.link';
	private screen: IXtermTerminal | undefined;
	private readonly resolver: TerminalLinkResolver;
	private generation = 0;
	private readonly hover = this._register(new MutableDisposable());
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());

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
	) {
		super();
		this.resolver = instantiation.createInstance(TerminalLinkResolver);
		const invalidate = (): void => { this.generation++; this.hover.clear(); this.picker.clear(); };
		this._register(context.instance.onDidChangeState(invalidate));
		this._register(workspace.onDidChangeWorkspace(invalidate));
		this._register(configuration.onConfigChanged(() => this.hover.clear()));
	}

	xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		const raw = screen.raw;
		const provider = raw.registerLinkProvider({
			provideLinks: (line, callback) => {
				const generation = this.generation;
				const buffer = raw.buffer.active;
				const candidates = this.candidates(buffer, line - 1);
				const sourceLine = buffer.getLine(line - 1)?.translateToString();
				const processId = this.context.instance.processId;
				void Promise.all(candidates.slice(0, 16).map(async candidate => {
					if (!candidate.range) return undefined;
					if (candidate.file && !await this.resolveFile(candidate)) return undefined;
					return {
						text: candidate.text, range: candidate.range,
						activate: () => { void this.open(candidate, generation, processId).catch(onUnexpectedError); },
						hover: (_event: MouseEvent, _text: string) => this.showHover(candidate),
						leave: () => this.hover.clear(),
					} satisfies ILink;
				})).then(links => callback(this.isCurrent(generation, processId) && raw.buffer.active === buffer && buffer.getLine(line - 1)?.translateToString() === sourceLine
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
		const generation = this.generation;
		const processId = this.context.instance.processId;
		const buffer = screen.raw.buffer.active;
		const items = new Map<string, LinkCandidate>();
		const end = buffer.length;
		for (let line = 0; line < end; line++) {
			if (line > 0 && line % 250 === 0) {
				await timeout(0);
				if (!this.isCurrent(generation, processId)) return;
			}
			if (buffer.getLine(line)?.isWrapped) continue;
			for (const candidate of this.candidates(buffer, line, 'picker')) items.set(`${candidate.label}\0${candidate.cwd ?? ''}`, candidate);
		}
		const session = new DisposableStore();
		this.picker.value = session;
		try {
			const selected = await new Promise<LinkCandidate | undefined>(resolve => {
				session.add(toDisposable(() => resolve(undefined)));
				const pick = session.add(this.quickInput.createQuickPick<LinkCandidate>());
				pick.ariaLabel = localize('terminal.links.choose', 'Open a terminal link');
				pick.placeholder = localize('terminal.links.select', 'Select a terminal file or URL to open');
				pick.items = [...items.values()];
				session.add(pick.onDidAccept(() => { if (pick.selectedItems[0]) resolve(pick.selectedItems[0]); }));
				session.add(pick.onDidHide(() => resolve(undefined)));
				session.add(pick.onDidBlur(() => resolve(undefined)));
				pick.show();
			});
			// Dismiss before opening the editor so Quick Input cannot steal its focus back.
			session.dispose();
			if (selected) await this.open(selected, generation, processId);
			else if (this.isCurrent(generation, processId)) screen.focus();
		} finally { session.dispose(); }
	}

	private candidates(buffer: IBuffer, line: number, mode: 'pointer' | 'picker' = 'pointer'): LinkCandidate[] {
		const screen = this.screen;
		if (!screen) return [];
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
			if (text.length > 8192) return [];
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
		const result: LinkCandidate[] = [];
		for (const file of detectLinks(text, isWindowsRemotePath(this.context.instance.initialCwd) ? OperatingSystem.Windows : OperatingSystem.Linux)) {
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

	private async resolveFile(candidate: LinkCandidate): Promise<URI | undefined> {
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
		return result && !result.isDirectory ? result.uri : undefined;
	}

	private async open(candidate: LinkCandidate, generation: number, processId: number): Promise<void> {
		if (!this.isCurrent(generation, processId)) return;
		if (candidate.url) { await this.openUrl(candidate.url); return; }
		const resource = await this.resolveFile(candidate);
		if (!this.isCurrent(generation, processId)) return;
		if (!resource) {
			this.notifications.warn(localize('terminal.links.fileUnavailable', 'Could not open the terminal file: {0}', candidate.file?.path.text ?? candidate.label));
			return;
		}
		const row = candidate.file?.suffix?.row ?? 1;
		const col = candidate.file?.suffix?.col ?? 1;
		await this.editors.openEditor({ resource }, { selection: new Range(row, col, row, col) });
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
