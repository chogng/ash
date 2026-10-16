; Ash syntax outline definitions. No semantic or cross-file inference.
(function_definition name: (identifier) @name) @definition.function
(assignment left: (identifier) @name) @definition.variable
((call arguments: (argument_list (keyword_argument name: (identifier) @_key value: (string (string_content) @name)))) @definition.module (#eq? @_key "name"))
