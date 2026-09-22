use crate::AgentRoleCatalogSnapshot;
use crate::AgentRoleSource;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::LazyLock;

/// Returns the immutable Agent roles packaged with Ash.
pub fn built_in_roles() -> Arc<AgentRoleCatalogSnapshot> {
    static ROLES: LazyLock<Arc<AgentRoleCatalogSnapshot>> = LazyLock::new(|| {
        let assets = [
            ("advisor.md", include_str!("../assets/advisor.md")),
            (
                "develop/acceptance.md",
                include_str!("../assets/develop/acceptance.md"),
            ),
            (
                "develop/conflict-reviewer.md",
                include_str!("../assets/develop/conflict-reviewer.md"),
            ),
            (
                "develop/implementer.md",
                include_str!("../assets/develop/implementer.md"),
            ),
            (
                "develop/intent.md",
                include_str!("../assets/develop/intent.md"),
            ),
            (
                "develop/investigator.md",
                include_str!("../assets/develop/investigator.md"),
            ),
            ("develop/plan.md", include_str!("../assets/develop/plan.md")),
            (
                "develop/researcher.md",
                include_str!("../assets/develop/researcher.md"),
            ),
            ("develop/spec.md", include_str!("../assets/develop/spec.md")),
            ("issue.md", include_str!("../assets/issue.md")),
            ("reviewer.md", include_str!("../assets/reviewer.md")),
            (
                "team/coordinator.md",
                include_str!("../assets/team/coordinator.md"),
            ),
            (
                "team/implementer.md",
                include_str!("../assets/team/implementer.md"),
            ),
            (
                "team/reviewer.md",
                include_str!("../assets/team/reviewer.md"),
            ),
        ];
        let entries = assets
            .into_iter()
            .map(|(path, text)| {
                crate::definition::parse(&AgentRoleSource::BuiltIn, Path::new(path), text)
                    .unwrap_or_else(|error| {
                        panic!("invalid packaged Agent role {path}: {}", error.message())
                    })
            })
            .collect::<Vec<_>>();
        let names = entries
            .iter()
            .map(|role| role.name())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            names.len(),
            entries.len(),
            "packaged role IDs must be unique"
        );
        for role in &entries {
            for target in role
                .callers()
                .iter()
                .chain(role.delegates().into_iter().flatten())
            {
                assert!(
                    names.contains(target.as_str()),
                    "unknown role reference {target} in {}",
                    role.name()
                );
            }
        }
        Arc::new(AgentRoleCatalogSnapshot::new(1, entries, Vec::new()))
    });
    Arc::clone(&ROLES)
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
