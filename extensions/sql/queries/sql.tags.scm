; Ash syntax outline definitions. Capture declared names, not referenced tables or return types.
(create_table (object_reference name: (identifier) @name)) @definition.struct
(create_view (object_reference name: (identifier) @name)) @definition.module
(create_materialized_view (object_reference name: (identifier) @name)) @definition.module
(create_index column: [(identifier) (literal)] @name) @definition.constant
(create_function (keyword_function) . (object_reference name: (identifier) @name)) @definition.function
(create_schema (keyword_schema) . (identifier) @name) @definition.module
(create_schema (keyword_exists) . (identifier) @name) @definition.module
(create_database (keyword_database) . (identifier) @name) @definition.module
(create_database (keyword_exists) . (identifier) @name) @definition.module
(create_type (keyword_type) . (object_reference name: (identifier) @name)) @definition.type
(create_sequence (keyword_sequence) . (object_reference name: (identifier) @name)) @definition.variable
(create_sequence (keyword_exists) . (object_reference name: (identifier) @name)) @definition.variable
(create_trigger (object_reference name: (identifier) @name) . [(keyword_before) (keyword_after) (keyword_instead)]) @definition.function
(create_schema (keyword_schema) . (keyword_authorization) . (identifier) @name) @definition.module
