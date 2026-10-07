use ash_app_server_protocol::GENERATED_TYPESCRIPT_HEADER;
use ash_app_server_protocol::JSON_SCHEMA_FIXTURE;
use ash_app_server_protocol::METADATA_FIXTURE;
use ash_app_server_protocol::TYPESCRIPT_FIXTURE_DIRECTORY;
use ash_app_server_protocol::json_schema;
use ash_app_server_protocol::protocol_metadata;
use ash_app_server_protocol::typescript_files;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

const USAGE: &str = "usage: generate_protocol <json|typescript|metadata> --out <directory>\n       generate_protocol fixtures";

enum Artifact {
    JsonSchema,
    TypeScript,
    Metadata,
}

impl Artifact {
    fn parse(argument: &str) -> Result<Self, String> {
        match argument {
            "json" => Ok(Self::JsonSchema),
            "typescript" => Ok(Self::TypeScript),
            "metadata" => Ok(Self::Metadata),
            _ => Err(USAGE.into()),
        }
    }
}

enum Command {
    Generate {
        artifact: Artifact,
        output_directory: PathBuf,
    },
    WriteFixtures,
}

impl Command {
    fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut arguments = arguments.into_iter();
        let operation = arguments.next().ok_or_else(|| USAGE.to_owned())?;
        if operation == "fixtures" {
            return if arguments.next().is_none() {
                Ok(Self::WriteFixtures)
            } else {
                Err(USAGE.into())
            };
        }

        let artifact = Artifact::parse(&operation)?;
        if arguments.next().as_deref() != Some("--out") {
            return Err(USAGE.into());
        }
        let output_directory = arguments
            .next()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| USAGE.to_owned())?;
        if arguments.next().is_some() {
            return Err(USAGE.into());
        }

        Ok(Self::Generate {
            artifact,
            output_directory,
        })
    }

    fn write(self) -> std::io::Result<()> {
        match self {
            Self::Generate {
                artifact,
                output_directory,
            } => match artifact {
                Artifact::JsonSchema => {
                    write_artifact(&output_directory, "schema.json", json_schema())
                }
                Artifact::TypeScript => write_typescript_files(&output_directory),
                Artifact::Metadata => {
                    write_artifact(&output_directory, "metadata.json", protocol_metadata())
                }
            },
            Self::WriteFixtures => write_fixtures(),
        }
    }
}

fn main() {
    let command = match Command::parse(std::env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };

    if let Err(error) = command.write() {
        eprintln!("generate_protocol: {error}");
        std::process::exit(1);
    }
}

fn write_artifact(
    directory: &Path,
    file_name: impl AsRef<Path>,
    contents: String,
) -> std::io::Result<()> {
    write_fixture(directory.join(file_name), contents)
}

fn write_fixtures() -> std::io::Result<()> {
    let crate_directory = Path::new(env!("CARGO_MANIFEST_DIR"));
    write_fixture(crate_directory.join(JSON_SCHEMA_FIXTURE), json_schema())?;
    write_fixture(crate_directory.join(METADATA_FIXTURE), protocol_metadata())?;
    write_typescript_files(&crate_directory.join(TYPESCRIPT_FIXTURE_DIRECTORY))
}

fn write_typescript_files(directory: &Path) -> std::io::Result<()> {
    let files = typescript_files();
    let expected_paths = files
        .iter()
        .map(|(path, _)| path.clone())
        .collect::<BTreeSet<_>>();
    for relative_path in generated_typescript_paths(directory)? {
        if !expected_paths.contains(&relative_path) {
            std::fs::remove_file(directory.join(relative_path))?;
        }
    }
    for (file_name, contents) in files {
        write_artifact(directory, file_name, contents)?;
    }
    Ok(())
}

fn generated_typescript_paths(directory: &Path) -> std::io::Result<Vec<PathBuf>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut generated = Vec::new();
    let mut pending_directories = vec![directory.to_path_buf()];
    while let Some(current_directory) = pending_directories.pop() {
        for entry in std::fs::read_dir(current_directory)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                pending_directories.push(path);
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "ts") {
                continue;
            }
            let contents = std::fs::read_to_string(&path)?;
            if contents.starts_with(GENERATED_TYPESCRIPT_HEADER) {
                generated.push(
                    path.strip_prefix(directory)
                        .expect("generated file must be below its output directory")
                        .to_path_buf(),
                );
            }
        }
    }
    Ok(generated)
}

fn write_fixture(path: PathBuf, contents: String) -> std::io::Result<()> {
    match std::fs::read_to_string(&path) {
        Ok(current) if current == contents => return Ok(()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    std::fs::write(path, contents)
}

#[cfg(test)]
#[path = "generate_protocol/tests.rs"]
mod tests;
