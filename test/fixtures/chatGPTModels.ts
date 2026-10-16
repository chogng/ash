/** Public picker structure observed on ChatGPT Web; raw routing models are deliberately more numerous. */
export function chatGPTModelCatalog(locale = 'en') {
	const labels = locale === 'en' ? ['Instant', 'Medium', 'High', 'Extra High', 'Pro'] : ['即时', '中', '高', '极高', 'Pro'];
	const families = [
		{ id: 'latest', title: 'GPT-6', slug: 'gpt-6' },
		{ id: '5.6', title: 'GPT-5.6 Sol', slug: 'gpt-5-6' },
	];
	return {
		default_model_slug: 'gpt-6',
		models: [
			...families.flatMap(family => [
				{ slug: family.slug, title: family.title, configurable_thinking_effort: false, thinking_efforts: [] },
				{ slug: `${family.slug}-instant`, title: family.title, configurable_thinking_effort: false, thinking_efforts: [] },
				{ slug: `${family.slug}-thinking`, title: family.title, configurable_thinking_effort: true, thinking_efforts: ['min', 'standard', 'extended', 'max'].map(thinking_effort => ({ thinking_effort, short_label: thinking_effort })) },
				{ slug: `${family.slug}-pro`, title: `${family.title} Pro`, configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'standard', short_label: 'Standard' }] },
			]),
			{ slug: 'gpt-6-mini', title: 'Internal mini', configurable_thinking_effort: false, thinking_efforts: [] },
			{ slug: 'gpt-6-sol-wm', title: 'Work model', is_work_mode_model: true, configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'ultra', short_label: 'Ultra' }] },
		],
		versions: families.map(family => ({
			id: family.id, enabled: true, display_text_for_intelligence: family.title,
			slugs: [family.slug, `${family.slug}-instant`, `${family.slug}-thinking`, `${family.slug}-pro`],
			intelligence_presets: [
				{ id: 0, title: labels[0]!, selected_display_title: labels[0]!, model_slug: `${family.slug}-instant`, lane: 'instant', preset_type: 'available' },
				{ id: 1, title: labels[1]!, selected_display_title: labels[1]!, model_slug: `${family.slug}-thinking`, lane: 'thinking', thinking_effort: 'standard', preset_type: 'available' },
				{ id: 2, title: labels[2]!, selected_display_title: labels[2]!, model_slug: `${family.slug}-thinking`, lane: 'thinking', thinking_effort: 'extended', preset_type: 'available' },
				{ id: 6, title: labels[3]!, selected_display_title: labels[3]!, model_slug: `${family.slug}-thinking`, lane: 'thinking', thinking_effort: 'max', preset_type: 'available' },
				{ id: 3, title: labels[4]!, selected_display_title: labels[4]!, model_slug: `${family.slug}-pro`, lane: 'pro', preset_type: 'available' },
			],
		})),
	};
}

/** A single preset per family keeps unrelated composer fixtures compact. */
export function simpleChatGPTModelCatalog(models: readonly { slug: string; title: string; }[], defaultModel = models[0]!.slug) {
	return {
		models, default_model_slug: defaultModel,
		versions: models.map(model => ({
			id: model.slug, display_text_for_intelligence: model.title, slugs: [model.slug],
			intelligence_presets: [{ id: 0, title: model.title, model_slug: model.slug, preset_type: 'available' }],
		})),
	};
}
