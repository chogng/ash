import { Disposable, DisposableMap, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IWorkbenchContribution } from "../../../common/contributions.js";
import { StatusbarAlignment, type IStatusbarEntryAccessor, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import type { ISCMProvider, ISCMViewService } from '../common/scm.js';

export interface ScmStatusContributionOptions {
	readonly statusbarService: IStatusbarService;
	readonly scmViewService: ISCMViewService;
}

/** Displays status commands owned by the selected SCM provider. */
export class ScmStatusContribution extends Disposable implements IWorkbenchContribution {
	private readonly entries = this._register(new DisposableMap<string, IStatusbarEntryAccessor>());
	private readonly providerListener = this._register(new MutableDisposable());

	constructor(private readonly options: ScmStatusContributionOptions) {
		super();
		this._register(options.scmViewService.onDidChangeActiveRepository(() => this.bindProvider()));
		this.bindProvider();
	}

	private bindProvider(): void {
		const provider = this.options.scmViewService.activeRepository?.provider;
		this.providerListener.value = provider?.onDidChangeResources(() => this.update(provider));
		this.update(provider);
	}

	private update(provider: ISCMProvider | undefined): void {
		const commands = provider?.statusBarCommands ?? [];
		const activeIds = new Set(commands.map(command => command.id));
		for (const id of this.entries.keys()) {
			if (!activeIds.has(id)) this.entries.deleteAndDispose(id);
		}
		for (const command of commands) {
			const entry = { icon: command.icon, text: command.text, ariaLabel: command.ariaLabel, tooltip: command.tooltip, run: () => command.run() };
			const current = this.entries.get(command.id);
			if (current) {
				current.update(entry);
				continue;
			}
			this.entries.set(command.id, this.options.statusbarService.addEntry(entry, {
				id: command.id,
				alignment: StatusbarAlignment.Left,
				priority: command.priority,
				compactGroup: command.compactGroup,
			}));
		}
	}
}
