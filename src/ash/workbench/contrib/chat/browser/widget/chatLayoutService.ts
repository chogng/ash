import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { observableConfigValue } from '../../../../../platform/observable/common/platformObservableUtils.js';
import { ChatConfiguration } from '../../common/constants.js';
import { IChatLayoutService } from '../../common/widget/chatLayoutService.js';

/** Shares configuration projections without retaining a second copy of the settings. */
export class ChatLayoutService extends Disposable implements IChatLayoutService {
	readonly _serviceBrand = undefined;
	readonly fontFamily: IChatLayoutService['fontFamily'];
	readonly fontSize: IChatLayoutService['fontSize'];

	constructor(@IConfigurationService configuration: IConfigurationService) {
		super();
		this.fontFamily = observableConfigValue(ChatConfiguration.FontFamily, 'default', configuration)
			.map(value => value === 'default' || !value.trim() ? null : value);
		this.fontSize = observableConfigValue(ChatConfiguration.FontSize, 13, configuration);
	}
}
