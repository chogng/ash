/// Catalog projection of free-text Agent Skills compatibility metadata.
///
/// Free text is never treated as an executable grant or proof that dependencies are present.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillCompatibility {
    Compatible,
    Unknown { note: String },
}
