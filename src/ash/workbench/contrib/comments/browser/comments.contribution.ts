import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING, type CommentThreadStyle } from '../common/commentsConfiguration.js';

const inlineLabel = localize('comments.thread.experimental.style.inline', 'Inline');
const floatingLabel = localize('comments.thread.experimental.style.floating', 'Floating');
const description = localize('comments.thread.experimental.style', 'Choose where review comments open in Changes and GitHub pull request diffs.');

Registry.as<IConfigurationRegistry>(Extensions.Configuration).deltaConfiguration({
	addedConfigurations: [{
		id: 'comments',
		title: localize('comments.configurationTitle', 'Comments'),
		properties: {
			[COMMENTS_THREAD_EXPERIMENTAL_STYLE_SETTING]: {
				type: 'string',
				enum: ['inline', 'floating'] satisfies CommentThreadStyle[],
				default: 'inline',
				description,
				scope: ConfigurationScope.WINDOW,
				tags: ['experimental'],
				ashSetting: {
					valueType: 'select',
					title: localize('comments.thread.styleTitle', 'Review comment style'),
					description,
					options: [{ value: 'inline', label: inlineLabel }, { value: 'floating', label: floatingLabel }],
				},
			},
		},
	}]
});
