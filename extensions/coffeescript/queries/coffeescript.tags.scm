(function_definition . (identifier) @name) @definition.function
(class_definition . (identifier) @name) @definition.class
(method_definition . (identifier) @name) @definition.method
(class_property_method . (identifier) @name) @definition.method
(assignment_statement . (pattern (identifier) @name) (expression (function_expression))) @definition.function
