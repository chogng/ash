import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type {
	DocumentFormattingEditProvider,
	DocumentRangeFormattingEditProvider,
} from '../../../../editor/common/languages.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { FormattingConflicts, FormattingMode } from '../../../../editor/contrib/format/browser/format.js';
import { localize } from '../../../../nls.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';

type FormattingProvider = DocumentFormattingEditProvider | DocumentRangeFormattingEditProvider;

/** Window-owned selection policy; the configuration service owns the saved preference. */
export class DefaultFormatter extends Disposable {
	static readonly configName = 'editor.defaultFormatter';
	private readonly selection = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
	) {
		super();
		this._register(
			FormattingConflicts.setFormatterSelector((providers, model, mode, _kind, token) =>
				this.select(providers, model, mode, token),
			),
		);
	}

	private async select<T extends FormattingProvider>(
		providers: T[],
		model: ITextModel,
		mode: FormattingMode,
		token: CancellationToken,
	): Promise<T | undefined> {
		const overrides = { resource: model.uri, overrideIdentifier: model.getLanguageId() };
		const configured = this.configuration.getValue<string | null>(DefaultFormatter.configName, overrides);
		const preferred = configured
			? providers.find(provider => ExtensionIdentifier.equals(provider.extensionId, configured))
			: undefined;
		if (preferred) return preferred;
		if (!configured && providers.length === 1) return providers[0];
		// Automatic formatting must never silently choose a different provider or open UI.
		if (mode === FormattingMode.Silent || model.isDisposed() || token.isCancellationRequested) return;
		const lifetime = new DisposableStore();
		this.selection.value = lifetime;
		const picker = lifetime.add(
			this.quickInput.createQuickPick<{
				label: string;
				description?: string;
				provider?: T;
				configure?: boolean;
			}>(),
		);
		const focused = this.codeEditors.getFocusedCodeEditor();
		const choices = providers.map((provider, index) => ({
			label:
				provider.displayName ??
				provider.extensionId?.value ??
				localize('format.numbered', 'Formatter {0}', index + 1),
			description: provider.extensionId?.value,
			provider,
		}));
		picker.items = [
			...choices,
			{ label: localize('format.configure', 'Configure Default Formatter...'), configure: true },
		];
		picker.placeholder = localize('format.select', 'Select a Formatter');
		picker.ariaLabel = picker.placeholder;
		let saveDefault = false;
		try {
			const picked = await new Promise<T | undefined>(resolve => {
				lifetime.add(
					picker.onDidAccept(() => {
						const item = picker.selectedItems[0] ?? picker.activeItems[0];
						if (item?.configure) {
							saveDefault = true;
							picker.placeholder = localize(
								'format.default.select',
								'Select the Default Formatter for {0}',
								model.getLanguageId(),
							);
							picker.items = choices.filter(item => item.provider.extensionId);
							picker.value = '';
							return;
						}
						if (item?.provider) resolve(item.provider);
					}),
				);
				lifetime.add(picker.onDidHide(() => resolve(undefined)));
				lifetime.add(model.onWillDispose(() => picker.hide()));
				lifetime.add(token.onCancellationRequested(() => picker.hide()));
				lifetime.add(toDisposable(() => resolve(undefined)));
				picker.show();
			});
			if (!picked || this.isDisposed || model.isDisposed() || token.isCancellationRequested) return;
			if (saveDefault && picked.extensionId) {
				await this.configuration.updateValue(DefaultFormatter.configName, picked.extensionId.value, {
					overrideIdentifiers: [model.getLanguageId()],
				});
			}
			return token.isCancellationRequested ? undefined : picked;
		} finally {
			if (this.selection.value === lifetime) {
				this.selection.clear();
				if (!this.isDisposed && !model.isDisposed() && focused?.getModel() === model) focused.focus();
			}
		}
	}
}
