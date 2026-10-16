[
  "@at-root"
  "@debug"
  "@error"
  "@extend"
  "@forward"
  "@mixin"
  "@use"
  "@warn"
] @keyword

"@function" @keyword.function

"@return" @keyword.return

"@include" @keyword.import

[
  "@while"
  "@each"
  "@for"
  "from"
  "through"
  "in"
] @keyword.repeat

(js_comment) @comment @spell

(function_name) @function

[
  ">="
  "<="
] @operator

(mixin_statement
  name: (identifier) @function)

(mixin_statement
  (parameters
    (parameter) @parameter))

(function_statement
  name: (identifier) @function)

(function_statement
  (parameters
    (parameter) @parameter))

(plain_value) @string

(keyword_query) @function

(identifier) @variable

(variable) @variable

(argument) @parameter

(arguments
  (variable) @parameter)

[
  "["
  "]"
] @punctuation.bracket

(include_statement
  (identifier) @function)
