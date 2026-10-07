use extensions::Command;
use extensions::Extension;
use extensions::ExtensionContext;
use extensions::ExtensionError;
use extensions::HostErrorCode;
use extensions::RuntimeError;
use extensions::languages::Hover;
use extensions::languages::MarkedString;
use extensions::languages::Position;
use extensions::languages::Range;
use extensions::run_stdio;
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
