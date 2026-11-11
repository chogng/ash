use super::ColorScheme;
use super::MAX_SOURCE_BYTES;
use super::render_svg;

#[test]
fn renders_common_diagrams_and_preserves_unicode_labels() {
    for source in [
        "flowchart LR\nA[输入] --> B[输出]",
        "sequenceDiagram\nClient->>Server: 输入\nServer-->>Client: 输出",
        "stateDiagram-v2\nIdle --> Running: 输入\nRunning --> Idle: 输出",
    ] {
        let light = render_svg(source, ColorScheme::Light).unwrap();
        let dark = render_svg(source, ColorScheme::Dark).unwrap();
        assert!(light.starts_with("<svg"));
        assert!(light.contains("输入") && light.contains("输出"));
        assert_ne!(light, dark);
    }
}

#[test]
fn keeps_invalid_and_over_budget_diagrams_as_source() {
    assert!(render_svg("not a diagram", ColorScheme::Light).is_none());
    assert!(render_svg(&"x".repeat(MAX_SOURCE_BYTES + 1), ColorScheme::Light).is_none());
    let many = format!("flowchart LR\n{}", "A-->B;".repeat(129));
    assert!(render_svg(&many, ColorScheme::Light).is_none());
}
