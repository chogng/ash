use ash_app_server_protocol::protocol::secrets::SecretStorageMode;
use clap::Subcommand;
use clap::ValueEnum;

use crate::CliError;
use crate::management;
use crate::nls;
use crate::print_json;

#[derive(Subcommand)]
pub(super) enum Command {
    #[command(about = nls::text(nls::Message::SecretsStatusHelp))]
    Status,
    #[command(about = nls::text(nls::Message::SecretsAuthorizeHelp))]
    Authorize,
    #[command(about = nls::text(nls::Message::SecretsModeHelp))]
    Mode {
        #[arg(value_enum)]
        mode: Mode,
    },
}

#[derive(Clone, Copy, ValueEnum)]
pub(super) enum Mode {
    Encrypted,
    File,
}

pub(super) fn run(command: Command) -> Result<(), CliError> {
    let session = management::connect()?;
    let mut client = session.client();
    let state = match command {
        Command::Status => client.read_secret_storage_status(),
        Command::Authorize => client.authorize_secret_storage(),
        Command::Mode { mode } => client.set_secret_storage_mode(match mode {
            Mode::Encrypted => SecretStorageMode::Encrypted,
            Mode::File => SecretStorageMode::File,
        }),
    }
    .map_err(CliError::failure)?;
    print_json(&state)
}
