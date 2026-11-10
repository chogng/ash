#[derive(Default)]
pub(super) struct Association {
    pub prog_id: Option<String>,
    pub app_id: Option<String>,
    pub target: Option<String>,
}

impl Association {
    pub fn default_index<'a>(
        &self,
        handlers: impl Iterator<Item = &'a Self> + Clone,
    ) -> Option<usize> {
        let matches_id = |id: Option<&str>, explicit: Option<&str>, target: Option<&str>| {
            same_identity(id, explicit) || same_identity(id, target)
        };
        handlers
            .clone()
            .position(|handler| {
                matches_id(
                    self.prog_id.as_deref(),
                    handler.prog_id.as_deref(),
                    handler.target.as_deref(),
                )
            })
            .or_else(|| {
                handlers.clone().position(|handler| {
                    matches_id(
                        self.app_id.as_deref(),
                        handler.app_id.as_deref(),
                        handler.target.as_deref(),
                    )
                })
            })
            .or_else(|| {
                // Packaged handlers may use a shared executable. Only use an unambiguous
                // executable match when the Shell did not report a default AppUserModelID.
                if self.app_id.is_some() {
                    return None;
                }
                let mut matches = handlers.enumerate().filter(|(_, handler)| {
                    same_identity(self.target.as_deref(), handler.target.as_deref())
                });
                let (index, _) = matches.next()?;
                matches.next().is_none().then_some(index)
            })
    }
}

fn same_identity(left: Option<&str>, right: Option<&str>) -> bool {
    left.zip(right)
        .is_some_and(|(left, right)| left.to_lowercase() == right.to_lowercase())
}

#[cfg(test)]
#[path = "association_tests.rs"]
mod tests;
