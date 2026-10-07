use super::*;

#[test]
fn catalog_generations_are_monotonic() {
    assert_eq!(SkillCatalogGeneration::INITIAL.get(), 1);
    assert_eq!(SkillCatalogGeneration::INITIAL.next().get(), 2);
}
