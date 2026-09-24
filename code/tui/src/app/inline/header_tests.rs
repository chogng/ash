use super::WelcomeModel;
use super::draw;
use crate::models::ModelSummary;
use crate::render::test_context;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use ratatui::style::Color;
use ratatui::style::Modifier;
use std::path::Path;

#[test]
fn wide_header_keeps_pet_and_identity_information_together() {
    let mut model = WelcomeModel::for_workspace(Path::new("/work/ash"));
    let catalog = ash_app_server_protocol::protocol::model::ModelListResult {
        models: vec![
            ash_app_server_protocol::protocol::model::ModelCatalogEntry {
                model: ash_protocol::ModelRef::new(
                    ash_protocol::ProviderId::new("openai-chatgpt").unwrap(),
                    ash_protocol::ModelId::new("gpt-5.6").unwrap(),
                ),
                display_name: "gpt-5.6".into(),
                access: ash_protocol::ModelAccess::Subscription,
                output_transport: ash_protocol::ModelOutputTransport::Unary,
                context_window: None,
                auto_compact_token_limit: None,
                available_context_window: None,
                capabilities: ash_protocol::ModelCapabilities::UNKNOWN,
                supported_reasoning_efforts: Vec::new(),
                model_reasoning_effort: None,
                default_personality: None,
            },
        ],
    };
    model.apply_model_summary(&ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "openai-chatgpt".into(),
            model: "gpt-5.6".into(),
        }),
        None,
        Some(&catalog),
    ));

    let buffer = render(80, 10, &model);
    let rendered = buffer_text(&buffer, 80, 10);

    assert!(rendered.contains(concat!("Ash Code v", env!("CARGO_PKG_VERSION"))));
    assert!(rendered.contains("openai-chatgpt/gpt-5.6 · Subscription"));
    assert!(rendered.contains("/work/ash"));
    assert_eq!(
        (super::pet::sprite().width(), super::pet::sprite().height()),
        (8, 4)
    );
    assert_eq!(super::desired_height(80), 5);
    assert_eq!(buffer[(4, 2)].symbol(), "▛");
    assert_eq!(buffer[(4, 2)].fg, Color::Rgb(0x40, 0x85, 0xac));
    assert_eq!(buffer[(4, 2)].bg, Color::Rgb(0, 0, 0));
    assert_eq!(buffer[(13, 1)].symbol(), "A");
    assert!(buffer[(13, 1)].modifier.contains(Modifier::BOLD));
    crate::tui_assert_snapshot!("welcome_pet_identity_header", rendered);
}

#[test]
fn narrow_header_keeps_the_text_alternative_when_the_pet_does_not_fit() {
    let model = WelcomeModel::for_workspace(Path::new("/ash"));
    let buffer = render(20, 5, &model);
    let rendered = buffer_text(&buffer, 20, 5);

    assert!(rendered.contains("Ash Code"));
    assert!(rendered.contains("Automatic model"));
    assert!(rendered.contains("/ash"));
    assert!(!rendered.contains("██"));
}

fn render(width: u16, height: u16, model: &WelcomeModel) -> Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| draw(frame, frame.area(), model, test_context()))
        .unwrap();
    terminal.backend().buffer().clone()
}

fn buffer_text(buffer: &Buffer, width: u16, height: u16) -> String {
    (0..height)
        .map(|row| {
            (0..width)
                .map(|column| buffer[(column, row)].symbol())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}
