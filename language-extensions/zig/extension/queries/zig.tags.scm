(function_declaration
  name: (identifier) @name) @definition.function

(variable_declaration
  "const" . (identifier) @name "=" (struct_declaration)) @definition.struct

(variable_declaration
  "const" . (identifier) @name "=" (enum_declaration)) @definition.enum

(variable_declaration
  "const" . (identifier) @name "=" [(union_declaration) (opaque_declaration)]) @definition.type

(test_declaration
  [(string) (identifier)] @name) @definition.function
