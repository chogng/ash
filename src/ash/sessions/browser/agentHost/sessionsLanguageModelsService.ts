import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import type { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';

/** Window model commands follow selection; each retained conversation borrows its own host catalog. */
export class SessionsLanguageModelsService extends Disposable implements ILanguageModelsService {
	private readonly listeners = this._register(new DisposableStore());
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeModels = this.changed.event;
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {
		super();
		this._register(scopes.onDidChange(() => this.changed.fire()));
		this._register(scopes.onDidChangeScopes(() => this.bind()));
		this.bind();
	}
	private bind(): void {
		this.listeners.clear();
		for (const scope of this.scopes.getScopes()) this.listeners.add(scope.services.models.onDidChangeModels(() => this.changed.fire()));
	}
	readApprovalReviewModel(...args: Parameters<ILanguageModelsService['readApprovalReviewModel']>): ReturnType<ILanguageModelsService['readApprovalReviewModel']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.readApprovalReviewModel(...args);
	}
	setApprovalReviewModel(...args: Parameters<ILanguageModelsService['setApprovalReviewModel']>): ReturnType<ILanguageModelsService['setApprovalReviewModel']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.setApprovalReviewModel(...args);
	}
	setModelPreferences(...args: Parameters<ILanguageModelsService['setModelPreferences']>): ReturnType<ILanguageModelsService['setModelPreferences']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.setModelPreferences(...args);
	}
	listModels(...args: Parameters<ILanguageModelsService['listModels']>): ReturnType<ILanguageModelsService['listModels']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.listModels(...args);
	}
	getDefaultNewChatModel(...args: Parameters<ILanguageModelsService['getDefaultNewChatModel']>): ReturnType<ILanguageModelsService['getDefaultNewChatModel']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.getDefaultNewChatModel(...args);
	}
	readModelDefaults(...args: Parameters<ILanguageModelsService['readModelDefaults']>): ReturnType<ILanguageModelsService['readModelDefaults']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.readModelDefaults(...args);
	}
	rememberSelectedModel(...args: Parameters<ILanguageModelsService['rememberSelectedModel']>): ReturnType<ILanguageModelsService['rememberSelectedModel']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.rememberSelectedModel(...args);
	}
	saveReasoningEffort(...args: Parameters<ILanguageModelsService['saveReasoningEffort']>): ReturnType<ILanguageModelsService['saveReasoningEffort']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.saveReasoningEffort(...args);
	}
	listModelCatalog(...args: Parameters<ILanguageModelsService['listModelCatalog']>): ReturnType<ILanguageModelsService['listModelCatalog']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.listModelCatalog(...args);
	}
	listCustomModelProviders(...args: Parameters<ILanguageModelsService['listCustomModelProviders']>): ReturnType<ILanguageModelsService['listCustomModelProviders']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.listCustomModelProviders(...args);
	}
	saveCustomModelProvider(...args: Parameters<ILanguageModelsService['saveCustomModelProvider']>): ReturnType<ILanguageModelsService['saveCustomModelProvider']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.saveCustomModelProvider(...args);
	}
	testProviderModel(...args: Parameters<ILanguageModelsService['testProviderModel']>): ReturnType<ILanguageModelsService['testProviderModel']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.testProviderModel(...args);
	}
	listModelProviders(...args: Parameters<ILanguageModelsService['listModelProviders']>): ReturnType<ILanguageModelsService['listModelProviders']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.listModelProviders(...args);
	}
	setModelProviderApiKey(...args: Parameters<ILanguageModelsService['setModelProviderApiKey']>): ReturnType<ILanguageModelsService['setModelProviderApiKey']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.setModelProviderApiKey(...args);
	}
	removeModelProviderApiKey(...args: Parameters<ILanguageModelsService['removeModelProviderApiKey']>): ReturnType<ILanguageModelsService['removeModelProviderApiKey']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.removeModelProviderApiKey(...args);
	}
	listAdvisorModels(...args: Parameters<ILanguageModelsService['listAdvisorModels']>): ReturnType<ILanguageModelsService['listAdvisorModels']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.listAdvisorModels(...args);
	}
	refreshModels(...args: Parameters<ILanguageModelsService['refreshModels']>): ReturnType<ILanguageModelsService['refreshModels']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.refreshModels(...args);
	}
	isModelVisible(...args: Parameters<ILanguageModelsService['isModelVisible']>): ReturnType<ILanguageModelsService['isModelVisible']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.isModelVisible(...args);
	}
	setModelVisible(...args: Parameters<ILanguageModelsService['setModelVisible']>): ReturnType<ILanguageModelsService['setModelVisible']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.setModelVisible(...args);
	}
	discoverProviderModels(...args: Parameters<ILanguageModelsService['discoverProviderModels']>): ReturnType<ILanguageModelsService['discoverProviderModels']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.discoverProviderModels(...args);
	}
	removeCustomModelProvider(...args: Parameters<ILanguageModelsService['removeCustomModelProvider']>): ReturnType<ILanguageModelsService['removeCustomModelProvider']> {
		const scope = this.scopes.getScope(); scope.assertCurrent();
		return scope.services.models.removeCustomModelProvider(...args);
	}

}
