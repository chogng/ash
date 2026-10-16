; MIT-licensed tree-sitter-typescript 0.23.2, queries/highlights.scm.
; https://github.com/tree-sitter/tree-sitter-typescript
; Capture names adapted to the editor syntax-theme vocabulary; patterns retain upstream semantics.
; Types

(type_identifier) @type
(predefined_type) @type.builtin

((identifier) @type
 (#match? @type "^[A-Z]"))

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

; Variables

(required_parameter (identifier) @parameter)
(optional_parameter (identifier) @parameter)

; Keywords

[ "abstract"
  "declare"
  "enum"
  "export"
  "implements"
  "interface"
  "keyof"
  "namespace"
  "private"
  "protected"
  "public"
  "type"
  "readonly"
  "override"
  "satisfies"
] @keyword
