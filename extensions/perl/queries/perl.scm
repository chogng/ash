; Ash captures for the pinned Perl grammar.
(identifier) @variable
[(comments) (pod_statement)] @comment
[(integer) (floating_point) (hexadecimal) (octal) (scientific_notation)] @number
[(string_double_quoted) (string_single_quoted) (string_q_quoted) (string_qq_quoted) (word_list_qw) (heredoc_body_statement)] @string
[(regex_pattern_content) (regex_pattern_qr)] @string.regexp
(escape_sequence) @string.escape
[(scalar_variable) (array_variable) (hash_variable) (special_scalar_variable)] @variable
(function_definition name: (identifier) @function)
(package_name) @module
(module_name) @module
["sub" "my" "our" "local" "state" "package" "use" "no" "require" "return" "if" "else" "elsif" "unless" "for" "foreach" "while" "until" "continue" "last" "next" "redo" "goto"] @keyword
["and" "or" "not" "xor" "eq" "ne" "lt" "gt" "le" "ge" "cmp"] @operator
