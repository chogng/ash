((list_lit . (sym_lit name: (sym_name) @_form) . (sym_lit name: (sym_name) @name)) @definition.function (#any-of? @_form "defn" "defn-" "defmacro"))
((list_lit . (sym_lit name: (sym_name) @_form) . (sym_lit name: (sym_name) @name)) @definition.module (#eq? @_form "ns"))
