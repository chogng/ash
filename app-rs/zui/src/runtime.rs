//! Cross-frame coordination that remains independent from presentation composition.

mod animation;
mod deadline;
mod frame_scheduler;
mod interaction;
mod retained;
mod retained_runtime;
#[cfg(feature = "native")]
mod task;
#[cfg(feature = "native")]
pub(crate) mod timer;

pub use animation::AnimationAdvance;
pub use animation::AnimationAdvanceReport;
pub use animation::AnimationRegistry;
pub use animation::ScalarAnimation;
pub use deadline::FrameDeadlineSet;
pub use frame_scheduler::FrameSchedule;
pub use frame_scheduler::FrameScheduler;
pub use interaction::AccessibilityExpansion;
pub use interaction::AccessibilityNode;
pub use interaction::AccessibilityRole;
pub use interaction::AccessibilitySelection;
pub use interaction::CursorFeedback;
pub use interaction::DispatchInvalidation;
pub use interaction::DispatchOutcome;
pub use interaction::FocusBehavior;
pub use interaction::FocusDirection;
pub use interaction::InteractionFrame;
pub use interaction::InteractionFrameCheckpoint;
pub use interaction::NavigationAxis;
pub use interaction::NavigationGroupId;
pub use interaction::NodeAction;
pub use interaction::UiDispatch;
pub use interaction::UiIntent;
pub use interaction::UiNode;
pub use retained::RetainedFragmentAdvanceReport;
pub use retained::RetainedFragmentError;
pub use retained::RetainedFragmentExit;
pub use retained::RetainedFragmentMount;
pub use retained::RetainedFragmentRegistry;
pub use retained::RetainedFragmentState;
pub use retained_runtime::RetainedRuntime;
pub use retained_runtime::RetainedRuntimeAdvanceReport;
#[cfg(feature = "native")]
pub use task::BackgroundExecutor;
#[cfg(feature = "native")]
pub use task::Task;
#[cfg(feature = "native")]
pub use task::TaskScope;
#[cfg(feature = "native")]
pub use timer::Timer;
#[cfg(feature = "native")]
pub use timer::TimerId;
#[cfg(feature = "native")]
pub(crate) use timer::TimerRegistry;
#[cfg(feature = "native")]
pub use timer::TimerScheduleError;
#[cfg(feature = "native")]
pub use timer::TimerScheduler;
