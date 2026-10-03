pub(super) struct PatchSummary {
    pub(super) updated: Vec<String>,
    pub(super) added: Vec<String>,
    pub(super) deleted: Vec<String>,
    pub(super) moved: Vec<(String, String)>,
}
