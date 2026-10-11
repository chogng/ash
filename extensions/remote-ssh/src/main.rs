use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::workspace::SavedConnection;

struct RemoteSsh;

impl Extension for RemoteSsh {
    fn id(&self) -> &str {
        "ash.remote-ssh"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        context
            .workspace
            .register_connection_resolver("ssh", |invocation, token| {
                token.check_cancelled()?;
                Ok(SavedConnection {
                    connection_name: invocation.authority[4..].into(),
                })
            })
    }
}

fn main() {
    if external_ext_sdk::run_stdio(RemoteSsh).is_err() {
        eprintln!("Remote SSH extension stopped");
        std::process::exit(1);
    }
}
