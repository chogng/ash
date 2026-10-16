; MIT-licensed tree-sitter-javascript 0.25.0, queries/highlights-jsx.scm.
; https://github.com/tree-sitter/tree-sitter-javascript
; Capture names adapted to the editor syntax-theme vocabulary; patterns retain upstream semantics.
(jsx_opening_element (identifier) @entity.name.tag (#match? @entity.name.tag "^[a-z][^.]*$"))
(jsx_closing_element (identifier) @entity.name.tag (#match? @entity.name.tag "^[a-z][^.]*$"))
(jsx_self_closing_element (identifier) @entity.name.tag (#match? @entity.name.tag "^[a-z][^.]*$"))

(jsx_attribute (property_identifier) @entity.other.attribute-name)
(jsx_opening_element (["<" ">"]) @punctuation.bracket)
(jsx_closing_element (["</" ">"]) @punctuation.bracket)
(jsx_self_closing_element (["<" "/>"]) @punctuation.bracket)
