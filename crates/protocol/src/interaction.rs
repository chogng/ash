//! User input, approval, questions, and client-hosted tool exchanges for Agent Turns.
//! Durable interaction state is separate from App Server connection selection and delivery.

mod approval;
mod dynamic_tool;
mod request_user_input;
mod turn_interaction;
mod user_input;

pub use approval::ActionApprovalCapability;
pub use approval::ActionApprovalCapabilityKind;
pub use approval::ActionApprovalDecision;
pub use approval::ActionApprovalRequest;
pub use approval::ActionApprovalResponse;
pub use dynamic_tool::DynamicToolCall;
pub use dynamic_tool::DynamicToolOutput;
pub use dynamic_tool::DynamicToolResponse;
pub use dynamic_tool::DynamicToolSpec;
pub use request_user_input::RequestUserInput;
pub use request_user_input::RequestUserInputResponse;
pub use request_user_input::UserInputAnswer;
pub use request_user_input::UserInputOption;
pub use request_user_input::UserInputQuestion;
pub use turn_interaction::AgentInteractionKind;
pub use turn_interaction::AgentRequest;
pub use turn_interaction::AgentRequestEnvelope;
pub use turn_interaction::AgentResponse;
pub use turn_interaction::AgentResponseEnvelope;
pub use turn_interaction::InteractionCancelReason;
pub use turn_interaction::InteractionDeadline;
pub use turn_interaction::PendingInteraction;
pub use turn_interaction::TurnInteraction;
pub use user_input::UserInput;
