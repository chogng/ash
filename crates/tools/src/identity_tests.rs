use super::{ToolBindingId, ToolIdentityError, ToolRuntimeKey};

#[test]
fn opaque_tool_identities_reject_empty_values() {
    assert_eq!(
        ToolBindingId::new(" ").expect_err("empty binding ID must be rejected"),
        ToolIdentityError::Empty {
            kind: "tool binding ID"
        }
    );
}

#[test]
fn opaque_tool_identities_preserve_the_host_value() {
    let runtime = ToolRuntimeKey::new("mcp:docs:search").expect("valid runtime key");

    assert_eq!(runtime.as_str(), "mcp:docs:search");
}
