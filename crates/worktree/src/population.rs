//! Bounded inclusion of explicitly selected ignored files into a newly created checkout.
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use ignore::gitignore::Gitignore;
use ignore::gitignore::GitignoreBuilder;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

/// Optional setup resources. Patterns use gitignore syntax and select ignored paths only.
#[derive(Clone, Debug, Default)]
pub struct WorktreePopulationOptions {
    pub include_files: Vec<String>,
    pub symlink_folders: Vec<String>,
}
enum Entry {
    File {
        source: PathBuf,
        relative: PathBuf,
        size: u64,
        modified: std::time::SystemTime,
    },
    Link {
        source: PathBuf,
        relative: PathBuf,
    },
}
pub(crate) struct Population {
    entries: Vec<Entry>,
}
impl Population {
    pub(crate) fn prepare(
        root: &Path,
        ignored: &[PathBuf],
        options: &WorktreePopulationOptions,
    ) -> Result<Self> {
        let includes = patterns(root, &options.include_files)?;
        let links = patterns(root, &options.symlink_folders)?;
        let mut queue = ignored.to_vec();
        let mut entries = Vec::new();
        let mut inspected = 0;
        let mut total = 0u64;
        let root = dunce::canonicalize(root)?;
        while let Some(relative) = queue.pop() {
            inspected += 1;
            if inspected > 100000 {
                bail!("worktree population exceeds its path limit");
            }
            if entries.len() >= 10000 {
                bail!("worktree population exceeds its file limit");
            }
            let source = root.join(&relative);
            let metadata = std::fs::symlink_metadata(&source)?;
            if metadata.file_type().is_symlink()
                && !includes
                    .matched_path_or_any_parents(&source, false)
                    .is_ignore()
                && !links.matched_path_or_any_parents(&source, true).is_ignore()
            {
                continue;
            }
            let canonical = dunce::canonicalize(&source)?;
            if !canonical.starts_with(&root) {
                bail!("worktree population cannot read outside its source checkout");
            }
            if metadata.is_dir() && links.matched_path_or_any_parents(&source, true).is_ignore() {
                entries.push(Entry::Link {
                    source: canonical,
                    relative,
                });
                continue;
            }
            if metadata.file_type().is_symlink() {
                bail!("copying ignored symlinks requires an explicit folder symlink selection");
            }
            if metadata.is_dir() {
                for child in std::fs::read_dir(&source)? {
                    let child = child?;
                    if child.file_name() == ".git" {
                        continue;
                    }
                    queue.push(relative.join(child.file_name()));
                }
            } else if metadata.is_file()
                && includes
                    .matched_path_or_any_parents(&source, false)
                    .is_ignore()
            {
                total = total
                    .checked_add(metadata.len())
                    .context("worktree population size overflow")?;
                if total > 256 * 1024 * 1024 {
                    bail!("worktree population exceeds 256 MiB");
                }
                entries.push(Entry::File {
                    source: canonical,
                    relative,
                    size: metadata.len(),
                    modified: metadata.modified()?,
                });
            }
        }
        Ok(Self { entries })
    }
    pub(crate) fn apply(&self, checkout: &Path) -> Result<()> {
        let checkout = dunce::canonicalize(checkout)?;
        // Validate every destination before the first write. Existing tracked files and links
        // always win; setup preferences cannot overwrite the new checkout's committed tree.
        for entry in &self.entries {
            let relative = match entry {
                Entry::File { relative, .. } | Entry::Link { relative, .. } => relative,
            };
            if std::fs::symlink_metadata(checkout.join(relative)).is_ok() {
                bail!(
                    "worktree setup destination already exists: {}",
                    relative.display()
                );
            }
            let mut parent = checkout.clone();
            for component in relative.parent().into_iter().flat_map(Path::components) {
                parent.push(component);
                match std::fs::symlink_metadata(&parent) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    Ok(_) => bail!("worktree setup parent is not an ordinary directory"),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        for entry in &self.entries {
            match entry {
                Entry::Link { source, relative } => {
                    let destination = checkout.join(relative);
                    std::fs::create_dir_all(destination.parent().context("missing link parent")?)?;
                    if !dunce::canonicalize(destination.parent().context("missing link parent")?)?
                        .starts_with(&checkout)
                    {
                        bail!("worktree setup parent escaped its checkout");
                    }
                    super::manager::copy_symlink(source, source, &destination)?;
                }
                Entry::File {
                    source,
                    relative,
                    size,
                    modified,
                } => {
                    let destination = checkout.join(relative);
                    std::fs::create_dir_all(destination.parent().context("missing file parent")?)?;
                    if !dunce::canonicalize(destination.parent().context("missing file parent")?)?
                        .starts_with(&checkout)
                    {
                        bail!("worktree setup parent escaped its checkout");
                    }
                    let mut input = std::fs::File::open(source)?;
                    let metadata = input.metadata()?;
                    if metadata.len() != *size || metadata.modified()? != *modified {
                        bail!("worktree setup source changed before copying");
                    }
                    let mut output = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(destination)?;
                    let copied = std::io::copy(
                        &mut std::io::Read::by_ref(&mut input).take(size + 1),
                        &mut output,
                    )?;
                    if copied != *size || input.metadata()?.modified()? != *modified {
                        bail!("worktree setup source changed while copying");
                    }
                    output.flush()?;
                    output.sync_all()?;
                    output.set_permissions(metadata.permissions())?;
                }
            }
        }
        Ok(())
    }
}
fn patterns(root: &Path, patterns: &[String]) -> Result<Gitignore> {
    if patterns.len() > 256
        || patterns
            .iter()
            .any(|pattern| pattern.len() > 8192 || pattern.contains('\0'))
    {
        bail!("invalid worktree population patterns");
    }
    let mut builder = GitignoreBuilder::new(root);
    for pattern in patterns {
        builder.add_line(None, pattern)?;
    }
    Ok(builder.build()?)
}
