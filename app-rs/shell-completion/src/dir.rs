use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

const MAX_DIR_SOURCE_BYTES: u64 = 1024 * 1024;
const MAX_CANDIDATES_PER_SOURCE: usize = 4096;

#[derive(Clone, Debug, Default)]
pub(crate) struct DirCatalog {
    candidates: BTreeMap<Vec<String>, BTreeMap<String, String>>,
}

impl DirCatalog {
    pub(crate) fn discover(working_directory: &Path) -> Self {
        let mut catalog = Self::default();
        for directory in working_directory.ancestors() {
            catalog.load_package_scripts(&directory.join("package.json"));
            catalog.load_recipes(&directory.join("Justfile"), RecipeFormat::Just);
            catalog.load_recipes(&directory.join("justfile"), RecipeFormat::Just);
            catalog.load_recipes(&directory.join(".justfile"), RecipeFormat::Just);
            catalog.load_recipes(&directory.join("Makefile"), RecipeFormat::Make);
            catalog.load_recipes(&directory.join("makefile"), RecipeFormat::Make);
            catalog.load_recipes(&directory.join("GNUmakefile"), RecipeFormat::Make);
        }
        catalog
    }

    pub(crate) fn description(&self, command_path: &[String], value: &str) -> Option<&str> {
        self.candidates
            .get(command_path)
            .and_then(|values| values.get(value))
            .map(String::as_str)
    }

    pub(crate) fn candidates(&self, command_path: &[String]) -> impl Iterator<Item = (&str, &str)> {
        self.candidates
            .get(command_path)
            .into_iter()
            .flat_map(|values| values.iter())
            .map(|(value, description)| (value.as_str(), description.as_str()))
    }

    fn load_package_scripts(&mut self, path: &Path) {
        let Some(contents) = read_bounded_utf8(path) else {
            return;
        };
        let Ok(document) = serde_json::from_str::<serde_json::Value>(&contents) else {
            return;
        };
        let Some(scripts) = document
            .get("scripts")
            .and_then(serde_json::Value::as_object)
        else {
            return;
        };
        for (script, command) in scripts.iter().take(MAX_CANDIDATES_PER_SOURCE) {
            let description = command
                .as_str()
                .map(|command| format!("Run package script: {command}"))
                .unwrap_or_else(|| "Run package script".to_owned());
            for path in [
                &["npm", "run"][..],
                &["pnpm", "run"][..],
                &["yarn", "run"][..],
                &["bun", "run"][..],
                &["pnpm"][..],
                &["yarn"][..],
                &["bun"][..],
            ] {
                self.insert(path, script, &description);
            }
        }
    }

    fn load_recipes(&mut self, path: &Path, format: RecipeFormat) {
        let Some(contents) = read_bounded_utf8(path) else {
            return;
        };
        for line in contents.lines().take(MAX_CANDIDATES_PER_SOURCE) {
            let Some(recipe) = recipe_name(line, format) else {
                continue;
            };
            let (command, description) = match format {
                RecipeFormat::Just => ("just", "Run just recipe"),
                RecipeFormat::Make => ("make", "Build Makefile target"),
            };
            self.insert(&[command], recipe, description);
        }
    }

    fn insert(&mut self, command_path: &[&str], value: &str, description: &str) {
        self.candidates
            .entry(command_path.iter().map(|part| (*part).to_owned()).collect())
            .or_default()
            .entry(value.to_owned())
            .or_insert_with(|| description.to_owned());
    }
}

fn read_bounded_utf8(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut contents = String::new();
    file.take(MAX_DIR_SOURCE_BYTES + 1)
        .read_to_string(&mut contents)
        .ok()?;
    (contents.len() as u64 <= MAX_DIR_SOURCE_BYTES).then_some(contents)
}

#[derive(Clone, Copy)]
enum RecipeFormat {
    Just,
    Make,
}

fn recipe_name(line: &str, format: RecipeFormat) -> Option<&str> {
    if line.is_empty()
        || line.starts_with(char::is_whitespace)
        || line.starts_with('#')
        || line.starts_with('.')
    {
        return None;
    }
    let (head, _) = line.split_once(':')?;
    let name = head.split_whitespace().next()?;
    if name.is_empty()
        || name.contains(['=', '%', '$'])
        || (matches!(format, RecipeFormat::Just) && name.starts_with('_'))
    {
        return None;
    }
    Some(name)
}

#[cfg(test)]
#[path = "dir_tests.rs"]
mod tests;
