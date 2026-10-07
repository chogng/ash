/// How line text whitespace participates in matching.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WhitespacePolicy {
    #[default]
    Exact,
    TrimEdges,
    CollapseRuns,
}

/// How line text case participates in matching.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CaseSensitivity {
    #[default]
    Sensitive,
    Insensitive,
}

/// Whether the exact LF/CRLF/CR/EOF terminator participates in line matching.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LineEndingPolicy {
    #[default]
    Sensitive,
    Ignore,
}

/// Whether modified rows include Unicode-grapheme inline changed ranges.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InlineDiffMode {
    Disabled,
    #[default]
    Grapheme,
}

/// Explicit resource limits for one diff computation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffLimits {
    max_input_bytes_per_side: usize,
    max_lines_per_side: usize,
    max_edit_distance: usize,
    max_trace_cells: usize,
}

const DEFAULT_LIMITS: DiffLimits = DiffLimits {
    max_input_bytes_per_side: 8 * 1024 * 1024,
    max_lines_per_side: 200_000,
    max_edit_distance: 20_000,
    max_trace_cells: 8_000_000,
};

impl Default for DiffLimits {
    fn default() -> Self {
        DEFAULT_LIMITS
    }
}

impl DiffLimits {
    pub const fn with_max_input_bytes_per_side(mut self, maximum: usize) -> Self {
        self.max_input_bytes_per_side = maximum;
        self
    }

    pub const fn with_max_lines_per_side(mut self, maximum: usize) -> Self {
        self.max_lines_per_side = maximum;
        self
    }

    pub const fn with_max_edit_distance(mut self, maximum: usize) -> Self {
        self.max_edit_distance = maximum;
        self
    }

    pub const fn with_max_trace_cells(mut self, maximum: usize) -> Self {
        self.max_trace_cells = maximum;
        self
    }

    pub const fn max_input_bytes_per_side(self) -> usize {
        self.max_input_bytes_per_side
    }

    pub const fn max_lines_per_side(self) -> usize {
        self.max_lines_per_side
    }

    pub const fn max_edit_distance(self) -> usize {
        self.max_edit_distance
    }

    pub const fn max_trace_cells(self) -> usize {
        self.max_trace_cells
    }
}

/// Comparison, presentation-data, context, and resource policy for one diff.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffOptions {
    context_lines: usize,
    whitespace: WhitespacePolicy,
    case_sensitivity: CaseSensitivity,
    line_endings: LineEndingPolicy,
    inline: InlineDiffMode,
    limits: DiffLimits,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context_lines: 3,
            whitespace: WhitespacePolicy::Exact,
            case_sensitivity: CaseSensitivity::Sensitive,
            line_endings: LineEndingPolicy::Sensitive,
            inline: InlineDiffMode::Grapheme,
            limits: DiffLimits::default(),
        }
    }
}

impl DiffOptions {
    pub const fn new(context_lines: usize) -> Self {
        Self {
            context_lines,
            whitespace: WhitespacePolicy::Exact,
            case_sensitivity: CaseSensitivity::Sensitive,
            line_endings: LineEndingPolicy::Sensitive,
            inline: InlineDiffMode::Grapheme,
            limits: DEFAULT_LIMITS,
        }
    }

    pub const fn with_whitespace(mut self, whitespace: WhitespacePolicy) -> Self {
        self.whitespace = whitespace;
        self
    }

    pub const fn with_case_sensitivity(mut self, sensitivity: CaseSensitivity) -> Self {
        self.case_sensitivity = sensitivity;
        self
    }

    pub const fn with_line_endings(mut self, line_endings: LineEndingPolicy) -> Self {
        self.line_endings = line_endings;
        self
    }

    pub const fn with_inline(mut self, inline: InlineDiffMode) -> Self {
        self.inline = inline;
        self
    }

    pub const fn with_limits(mut self, limits: DiffLimits) -> Self {
        self.limits = limits;
        self
    }

    pub const fn context_lines(self) -> usize {
        self.context_lines
    }

    pub const fn whitespace(self) -> WhitespacePolicy {
        self.whitespace
    }

    pub const fn case_sensitivity(self) -> CaseSensitivity {
        self.case_sensitivity
    }

    pub const fn line_endings(self) -> LineEndingPolicy {
        self.line_endings
    }

    pub const fn inline(self) -> InlineDiffMode {
        self.inline
    }

    pub const fn limits(self) -> DiffLimits {
        self.limits
    }
}
