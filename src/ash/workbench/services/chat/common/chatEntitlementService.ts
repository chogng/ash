import type { Event } from '../../../../base/common/event.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export namespace ChatEntitlementContextKeys {
	export const Setup = {
		hidden: new RawContextKey<boolean>('chatSetupHidden', false),
	};
}

export interface IChatSentiment {
	/** Hides AI entry points according to this window's configuration. */
	readonly hidden?: boolean;
}

export interface IChatEntitlementService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSentiment: Event<void>;
	readonly sentiment: IChatSentiment;
}

export const IChatEntitlementService = createDecorator<IChatEntitlementService>('chatEntitlementService');

/** Projects the existing preference; account access and model readiness remain provider-owned. */
export class ChatEntitlementService implements IChatEntitlementService {
	public readonly _serviceBrand = undefined;
	public readonly onDidChangeSentiment: Event<void>;

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
		this.onDidChangeSentiment = (listener, thisArgs, disposables) => configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatAIDisabledSettingId)) { listener.call(thisArgs, undefined); }
		}, undefined, disposables);
	}

	public get sentiment(): IChatSentiment {
		return { hidden: this.configurationService.getValue<boolean>(ChatAIDisabledSettingId) === true };
	}
}
