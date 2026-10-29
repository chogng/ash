import '../../../browser/media/style.css';
import '../../../../base/browser/ui/contextview/contextview.css';
import '../../../../base/browser/ui/dropdown/dropdown.css';
import '../../../../base/browser/ui/selectbox/selectbox.css';
import '../../../../base/browser/ui/menu/menu.css';
import '../../../../base/browser/ui/tree/tree.css';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Menu } from '../../../../base/browser/ui/menu/menu.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { ObjectTree } from '../../../../base/browser/ui/tree/objectTree.js';
import {
	defaultButtonStyles,
	defaultInputBoxStyles,
	defaultListStyles,
	defaultMenuStyles,
	defaultSelectBoxStyles,
} from '../../../../platform/theme/browser/defaultStyles.js';
import { defineComponentFixture, defineThemedFixtureGroup } from './fixtureUtils.js';

export default defineThemedFixtureGroup(
	{ path: 'shared/' },
	{
		ButtonsAndMenu: defineComponentFixture({
			labels: ['blocks-ci'],
			render: ({ container, disposableStore }) => {
				for (const presentation of ['primary', 'secondary', 'quiet'] as const) {
					disposableStore.add(
						new Button(container, {
							label: `${presentation} action`,
							presentation,
							...defaultButtonStyles,
						}),
					);
				}
				disposableStore.add(
					new Menu(
						container,
						{
							actions: [
								{ id: 'fixture.open', label: 'Open item', tooltip: '', enabled: true, run() {} },
								{
									id: 'fixture.disabled',
									label: 'Unavailable action',
									tooltip: '',
									enabled: false,
									run() {},
								},
							],
							buttonStyles: defaultButtonStyles,
						},
						defaultMenuStyles,
					),
				);
				return [container];
			},
		}),
		SelectAndList: defineComponentFixture({
			labels: ['blocks-ci'],
			render: ({ container, disposableStore }) => {
				const select = disposableStore.add(
					new SelectBox(
						container,
						{
							ariaLabel: 'Fixture choice',
							presentation: 'field',
							options: [
								{ label: 'First choice', value: 'first' },
								{ label: 'Unavailable choice', value: 'disabled', disabled: true },
								{ label: 'Last choice', value: 'last' },
							],
						},
						defaultSelectBoxStyles,
					),
				);
				const list = disposableStore.add(
					new List<string>(container, {
						ariaLabel: 'Fixture list',
						domFocusable: true,
						styles: defaultListStyles,
						renderItem: value => {
							const label = document.createElement('span');
							label.textContent = value;
							return label;
						},
					}),
				);
				list.splice(0, 0, ['Selected item', 'Other item']);
				list.setSelection([0]);
				select.show();
				const popup = document
					.querySelector<HTMLElement>('.ash-select-box-list')!
					.closest<HTMLElement>('.ash-context-view')!;
				return [container, popup];
			},
		}),
		TreeAndInput: defineComponentFixture({
			labels: ['blocks-ci'],
			render: ({ container, disposableStore }) => {
				disposableStore.add(
					new InputBox(container, {
						ariaLabel: 'Fixture input',
						presentation: 'field',
						inputBoxStyles: defaultInputBoxStyles,
					}),
				);
				const host = document.createElement('div');
				host.style.height = '180px';
				container.append(host);
				const tree = disposableStore.add(
					new ObjectTree<string>(host, {
						modelOptions: { identityProvider: { getId: value => value } },
						styles: defaultListStyles,
						keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: value => value },
						renderElement: value => {
							const label = document.createElement('span');
							label.textContent = value;
							return label;
						},
					}),
				);
				tree.setChildren([{ element: 'First tree item' }, { element: 'Second tree item' }]);
				tree.setSelection(['First tree item']);
				tree.setFocus('First tree item');
				tree.openFind();
				return [container];
			},
		}),
	},
);
