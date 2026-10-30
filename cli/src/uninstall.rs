use crate::CliError;
use crate::nls;
use crate::nls::Message;
use clap::Args;

#[derive(Args)]
pub(crate) struct Options {
    #[arg(long, help = nls::text(Message::UninstallPurge))]
    purge: bool,
}

pub(crate) fn run(options: Options) -> Result<(), CliError> {
    let mode = if options.purge {
        ash_installation::RemovalMode::Purge
    } else {
        ash_installation::RemovalMode::KeepData
    };
    let result = crate::update::managed_root()
        .and_then(|root| {
            ash_installation::schedule_cli_removal(&root, mode).map_err(|error| error.to_string())
        })
        .map_err(|error| CliError::failure(nls::format(Message::UninstallFailed, error)))?;
    println!(
        "{}",
        nls::format(Message::UninstallScheduled, result.display().to_string())
    );
    Ok(())
}
