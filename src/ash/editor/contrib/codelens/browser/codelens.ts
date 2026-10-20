import { type CancellationToken } from '../../../../base/common/cancellation.js';
import { onUnexpectedExternalError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type ITextModel } from '../../../common/model.js';
import { Range } from '../../../common/core/range.js';
import { Command, type CodeLens, type CodeLensList, type CodeLensProvider } from '../../../common/languages.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';

export interface CodeLensItem {
	readonly symbol: CodeLens;
	readonly provider: CodeLensProvider;
}

export class CodeLensModel {
	public static readonly Empty = new CodeLensModel();

	public lenses: CodeLensItem[] = [];
	private store: DisposableStore | undefined;

	public get isDisposed(): boolean {
		return this.store?.isDisposed ?? false;
	}

	public add(list: CodeLensList, provider: CodeLensProvider): void {
		if (list.dispose) {
			this.store ??= new DisposableStore();
			this.store.add(toDisposable(() => list.dispose!()));
		}
		for (const symbol of list.lenses) this.lenses.push({ symbol, provider });
	}

	public dispose(): void {
		this.store?.dispose();
	}
}

/** Collects CodeLens results and keeps every result owned by its provider. */
export async function getCodeLensModel(registry: LanguageFeatureRegistry<CodeLensProvider>, model: ITextModel, token: CancellationToken): Promise<CodeLensModel> {
	const providers = registry.ordered(model);
	const ranks = new Map(providers.map((provider, index) => [provider, index] as const));
	const result = new CodeLensModel();

	await Promise.all(providers.map(async provider => {
		try {
			const list = await Promise.resolve(provider.provideCodeLenses(model, token));
			if (!list) return;
			if (!Array.isArray(list.lenses)) {
				list.dispose?.();
				throw new TypeError('CodeLens provider must return a CodeLensList');
			}
			try {
				for (const lens of list.lenses) validateCodeLens(model, lens);
			} catch (error) {
				list.dispose?.();
				throw error;
			}
			result.add(list, provider);
		} catch (error) {
			onUnexpectedExternalError(error);
		}
	}));

	if (token.isCancellationRequested) {
		result.dispose();
		return CodeLensModel.Empty;
	}

	result.lenses.sort((left, right) => {
		const line = left.symbol.range.startLineNumber - right.symbol.range.startLineNumber;
		if (line !== 0) return line;
		const rank = ranks.get(left.provider)! - ranks.get(right.provider)!;
		if (rank !== 0) return rank;
		return left.symbol.range.startColumn - right.symbol.range.startColumn;
	});
	return result;
}

function validateCodeLens(model: ITextModel, lens: CodeLens): void {
	if (!lens || typeof lens !== 'object' || !Range.isIRange(lens.range)) throw new TypeError('CodeLens must provide a range');
	model.validateRange(lens.range);
	if (lens.command && !Command.is(lens.command)) throw new TypeError('CodeLens command must provide an ID and title');
}
