(comment) @comment
[(string) (multiline_string) (character)] @string
(escape_sequence) @string.escape
[(integer) (float)] @number
[(boolean) "null" "undefined" "unreachable"] @constant.builtin

(builtin_type) @type.builtin
(builtin_identifier) @function.builtin
(parameter name: (identifier) @variable.parameter)
(parameter type: (identifier) @type)
(container_field name: (identifier) @property)
(field_expression member: (identifier) @property)
(field_initializer (identifier) @property)
(function_declaration name: (identifier) @function)
(call_expression function: (identifier) @function.call)
(call_expression function: (field_expression member: (identifier) @function.call))
(variable_declaration
  (identifier) @type
  "="
  [(struct_declaration) (enum_declaration) (union_declaration) (opaque_declaration)])

[
  "addrspace" "align" "allowzero" "anyframe" "asm" "async" "await"
  "break" "callconv" "catch" "comptime" "const" "continue" "defer"
  "else" "enum" "errdefer" "error" "export" "extern" "fn" "for"
  "if" "inline" "linksection" "noalias" "noinline" "nosuspend"
  "opaque" "orelse" "packed" "pub" "resume" "return" "struct"
  "suspend" "switch" "test" "threadlocal" "try" "union" "usingnamespace"
  "var" "volatile" "while"
] @keyword
["and" "or" "=" "==" "!=" "!" "<" "<=" ">" ">=" "+" "-" "*" "/" "%" "&" "|" "^" "<<" ">>" "~"] @operator
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
[";" "," "." ":" "=>" "->"] @punctuation.delimiter
