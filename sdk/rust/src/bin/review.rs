use external_ext_sdk::Command;
use external_ext_sdk::Extension;
use external_ext_sdk::ExtensionContext;
use external_ext_sdk::ExtensionError;
use external_ext_sdk::HostErrorCode;
use external_ext_sdk::RuntimeError;
use external_ext_sdk::languages::Hover;
use external_ext_sdk::languages::MarkedString;
use external_ext_sdk::languages::Position;
use external_ext_sdk::languages::Range;
use external_ext_sdk::run_stdio;
use serde_json::json;

struct ReviewExtension;

impl Extension for ReviewExtension {
    fn id(&self) -> &str {
        "example.review"
    }

    fn activate(&mut self, context: &mut ExtensionContext) -> Result<(), ExtensionError> {
        let output = context
            .window
            .create_output_channel("review", "Review extension")?;
        let echo_output = output.clone();
        context.commands.register_command(
            Command::new("review.echo", "Review: Echo arguments"),
            move |invocation, token| {
                token.check_cancelled()?;
                echo_output.append_line("echo")?;
                Ok(json!(invocation.arguments))
            },
        )?;
        context.commands.register_command(
            Command::new("review.wait", "Review: Wait for cancellation"),
            move |_, token| {
                output.append_line("waiting")?;
                Err(token.wait_for_cancellation())
            },
        )?;
        context.commands.register_command(
            Command::new("review.fail", "Review: Return an error"),
            |_, _| {
                Err(ExtensionError::new(
                    HostErrorCode::OperationNotSupported,
                    "example failure",
                ))
            },
        )?;
        context.languages.register_hover_provider(
            "review.hover",
            vec!["rust".into()],
            |document, position, token| {
                token.check_cancelled()?;
                Ok(Some(Hover {
                    contents: vec![MarkedString::Markdown(format!(
                        "version {} at {}:{}",
                        document.version, position.line, position.character
                    ))],
                    range: Some(Range::new(position, Position::new(position.line, 0))),
                }))
            },
        )
    }
}

fn main() -> Result<(), RuntimeError> {
    run_stdio(ReviewExtension)
}
