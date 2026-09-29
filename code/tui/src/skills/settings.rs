use crate::keymap::bindings;
use crate::nls::Text;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::skills::{
    SkillDiagnosticDto, SkillEnablementDto, SkillListResult,
};
use ash_protocol::SkillId;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SkillSelectionAction {
    SetEnablement {
        skill_id: SkillId,
        enablement: SkillEnablementDto,
    },
}

pub(crate) struct SkillChoices {
    pub(crate) model: ListSelectionModel,
    pub(crate) actions: BTreeMap<ListSelectionItemId, SkillSelectionAction>,
    pub(crate) diagnostics: Vec<SkillDiagnosticDto>,
}

pub(crate) fn skill_choices(catalog: &SkillListResult) -> SkillChoices {
    let mut actions = BTreeMap::new();
    let all = catalog
        .skills
        .iter()
        .enumerate()
        .map(|(index, skill)| {
            let item_id = ListSelectionItemId::new(format!("skill-{index}"));
            let enablement = match skill.enablement {
                SkillEnablementDto::Disabled => SkillEnablementDto::Enabled,
                SkillEnablementDto::Enabled => SkillEnablementDto::Disabled,
            };
            actions.insert(
                item_id.clone(),
                SkillSelectionAction::SetEnablement {
                    skill_id: skill.id.clone(),
                    enablement,
                },
            );
            ListSelectionItem::new(Text::literal(skill.id.name.as_str()))
                .with_id(item_id)
                .with_details(Text::literal(&skill.description))
                .with_columns(
                    skill.id.name.as_str(),
                    &skill.description,
                    enablement_label(skill.enablement),
                )
                .with_description(Text::literal(&skill.description))
        })
        .collect::<Vec<_>>();
    let enabled = all
        .iter()
        .zip(&catalog.skills)
        .filter(|(_, skill)| skill.enablement == SkillEnablementDto::Enabled)
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let disabled = all
        .iter()
        .zip(&catalog.skills)
        .filter(|(_, skill)| skill.enablement == SkillEnablementDto::Disabled)
        .map(|(item, _)| item.clone())
        .collect::<Vec<_>>();
    let enabled_count = enabled.len();
    let disabled_count = disabled.len();

    SkillChoices {
        model: ListSelectionModel::new(
            "Skills",
            vec![
                ListSelectionGroup::new(
                    Text::template("All ({0})", vec![Text::literal(all.len().to_string())]),
                    all,
                ),
                ListSelectionGroup::new(
                    Text::template("On ({0})", vec![Text::literal(enabled_count.to_string())]),
                    enabled,
                ),
                ListSelectionGroup::new(
                    Text::template("Off ({0})", vec![Text::literal(disabled_count.to_string())]),
                    disabled,
                ),
            ],
        )
        .with_expandable_descriptions()
        .with_activation(bindings::SKILL_TOGGLE)
        .with_search(SearchBoxModel::new("Search available skills"))
        .with_empty_message("No matching skills"),
        actions,
        diagnostics: catalog.diagnostics.clone(),
    }
}

fn enablement_label(enablement: SkillEnablementDto) -> &'static str {
    match enablement {
        SkillEnablementDto::Disabled => "off",
        SkillEnablementDto::Enabled => "on",
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
