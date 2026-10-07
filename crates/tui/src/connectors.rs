mod picker;
mod request;

/// A completed connector operation delivered to the TUI state owner.
pub(crate) enum Event {
    PickerOpened(ConnectorChoices),
    PickerUpdated(ConnectorChoices),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    ConnectDeviceOAuth {
        connector_id: String,
        connection_generation: u64,
    },
    Disconnect {
        connector_id: String,
    },
}

pub(crate) use picker::ConnectorChoices;
pub(crate) use picker::ConnectorSelectionAction;
pub(crate) use picker::connector_choices;
pub(crate) use request::execute;
pub(crate) use request::load_selection;
