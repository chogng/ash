; MIT-licensed tree-sitter-rust 0.24.2, queries/highlights.scm.
; https://github.com/tree-sitter/tree-sitter-rust
; Capture names adapted to the editor syntax-theme vocabulary; patterns retain upstream semantics.
; Identifiers

(type_identifier) @entity.name.type
(primitive_type) @entity.name.type.builtin
(field_identifier) @variable.other.property

; Identifier conventions

; Assume all-caps names are constants
((identifier) @constant.language
 (#match? @constant.language "^[A-Z][A-Z\\d_]+$'"))

; Assume uppercase names are enum constructors
((identifier) @entity.name.type
 (#match? @entity.name.type "^[A-Z]"))

; Assume that uppercase names in paths are types
((scoped_identifier
  path: (identifier) @entity.name.type)
 (#match? @entity.name.type "^[A-Z]"))
((scoped_identifier
  path: (scoped_identifier
    name: (identifier) @entity.name.type))
 (#match? @entity.name.type "^[A-Z]"))
((scoped_type_identifier
  path: (identifier) @entity.name.type)
 (#match? @entity.name.type "^[A-Z]"))
((scoped_type_identifier
  path: (scoped_identifier
    name: (identifier) @entity.name.type))
 (#match? @entity.name.type "^[A-Z]"))

; Assume all qualified names in struct patterns are enum constructors. (They're
; either that, or struct names; highlighting both as constructors seems to be
; the less glaring choice of error, visually.)
(struct_pattern
  type: (scoped_type_identifier
    name: (type_identifier) @entity.name.type))

; Function calls

(call_expression
  function: (identifier) @entity.name.function)
(call_expression
  function: (field_expression
    field: (field_identifier) @entity.name.function.method))
(call_expression
  function: (scoped_identifier
    "::"
    name: (identifier) @entity.name.function))

(generic_function
  function: (identifier) @entity.name.function)
(generic_function
  function: (scoped_identifier
    name: (identifier) @entity.name.function))
(generic_function
  function: (field_expression
    field: (field_identifier) @entity.name.function.method))

(macro_invocation
  macro: (identifier) @entity.name.function.macro
  "!" @entity.name.function.macro)

; Function definitions

(function_item (identifier) @entity.name.function)
(function_signature_item (identifier) @entity.name.function)

(line_comment) @comment
(block_comment) @comment

(line_comment (doc_comment)) @comment.documentation
(block_comment (doc_comment)) @comment.documentation

"(" @punctuation.bracket
")" @punctuation.bracket
"[" @punctuation.bracket
"]" @punctuation.bracket
"{" @punctuation.bracket
"}" @punctuation.bracket

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)
(type_parameters
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

"::" @punctuation.delimiter
":" @punctuation.delimiter
"." @punctuation.delimiter
"," @punctuation.delimiter
";" @punctuation.delimiter

(parameter (identifier) @variable.parameter)

(lifetime (identifier) @label)

"as" @keyword
"async" @keyword
"await" @keyword
"break" @keyword
"const" @keyword
"continue" @keyword
"default" @keyword
"dyn" @keyword
"else" @keyword
"enum" @keyword
"extern" @keyword
"fn" @keyword
"for" @keyword
"gen" @keyword
"if" @keyword
"impl" @keyword
"in" @keyword
"let" @keyword
"loop" @keyword
"macro_rules!" @keyword
"match" @keyword
"mod" @keyword
"move" @keyword
"pub" @keyword
"raw" @keyword
"ref" @keyword
"return" @keyword
"static" @keyword
"struct" @keyword
"trait" @keyword
"type" @keyword
"union" @keyword
"unsafe" @keyword
"use" @keyword
"where" @keyword
"while" @keyword
"yield" @keyword
(crate) @keyword
(mutable_specifier) @keyword
(use_list (self) @keyword)
(scoped_use_list (self) @keyword)
(scoped_identifier (self) @keyword)
(super) @keyword

(self) @variable.builtin

(char_literal) @string
(string_literal) @string
(raw_string_literal) @string

(boolean_literal) @constant.language.builtin
(integer_literal) @constant.language.builtin
(float_literal) @constant.language.builtin

(escape_sequence) @escape

(attribute_item) @entity.other.attribute-name
(inner_attribute_item) @entity.other.attribute-name

"*" @keyword.operator
"&" @keyword.operator
"'" @keyword.operator
