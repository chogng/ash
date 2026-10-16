;; Literals

(num_lit) @number

[
  (char_lit)
  (str_lit)
] @string

[
 (bool_lit)
 (nil_lit)
] @constant.builtin

(kwd_lit) @constant

;; Comments

(comment) @comment

;; Treat quasiquotation as operators for the purpose of highlighting.

[
 "'"
 "`"
 "~"
 "@"
 "~@"
] @operator

(sym_lit) @variable
(regex_lit) @string.regexp
((list_lit . (sym_lit name: (sym_name) @keyword)) (#any-of? @keyword "def" "defn" "defn-" "defmacro" "ns" "if" "when" "let" "fn" "do" "loop" "recur" "try" "catch" "throw" "require"))
