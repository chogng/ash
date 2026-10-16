; Ash-authored highlights for shunsambongi/tree-sitter-gitignore.
; Upstream ships a grammar but no queries. Specific captures follow the whole pattern.
(pattern) @string
(comment) @comment
(negation) @keyword.operator.negation.ignore
[
  (wildcard_char_single)
  (wildcard_chars)
  (wildcard_chars_allow_slash)
  (bracket_negation)
] @keyword.operator.wildcard.ignore
[
  (directory_separator)
  (directory_separator_escaped)
  "["
  "]"
] @punctuation.delimiter
(bracket_char_class) @type

; Preserve useful theme distinctions for character classes and escaped literals.
(bracket_expr) @constant.other.character-class.ignore
[(pattern_char_escaped) (bracket_char_escaped)] @constant.character.escape.ignore
