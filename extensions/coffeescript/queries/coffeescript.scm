;; Comments
(comment) @comment

;; Literals
(number) @number
(string) @string
(regex) @string.regexp
(boolean) @constant.builtin
(null_literal) @constant.builtin
(undefined_literal) @constant.builtin

;; Variables
(instance_variable (identifier) @variable.member)

;; Functions and methods
(function_definition
  (identifier) @function)

(method_definition
  (identifier) @function.method)

(class_property_method
  (identifier) @function.method)

;; Parameters (covers identifiers and instance variables)
(parameters
  (parameter
    (pattern
      (identifier) @parameter)))

(parameters
  (parameter
    (pattern
      (instance_variable (identifier) @parameter))))

(function_expression
  (pattern
    (identifier) @parameter))

(function_expression
  (pattern
    (instance_variable (identifier) @parameter)))

(function_call
  (expression
    (identifier) @function.call))

(function_call
  (expression
    (member_expression
      (expression) @variable
      (identifier) @function.method)))

;; Classes and properties
(class_definition
  (identifier) @type)

(class_definition
  "extends"
  (identifier) @type.builtin)

(class_property_block
  (identifier) @property)

(class_property_assignment
  (identifier) @property)

(pair
  (identifier) @property)

;; Control flow keywords
"class" @keyword
"extends" @keyword
"if" @keyword
"else" @keyword
"unless" @keyword
"when" @keyword
"switch" @keyword
"for" @keyword
"while" @keyword
"until" @keyword
"then" @keyword
"do" @keyword
"by" @keyword
"try" @keyword
"catch" @keyword
"finally" @keyword
"loop" @keyword
(break_statement) @keyword
(continue_statement) @keyword
(return_statement) @keyword
(throw_statement) @keyword

;; Imports / exports
"import" @keyword.import
"export" @keyword.import
"from" @keyword.import
"as" @keyword.import
"default" @keyword.import

;; Operators and miscellaneous keywords
"and" @operator
"or" @operator
"not" @operator
"is" @operator
"isnt" @operator
"in" @operator
"of" @operator
"instanceof" @operator
"new" @operator
"typeof" @operator
"delete" @operator
"await" @operator
"async" @operator
"yield" @operator

;; Fallback variable highlight
(identifier) @variable

; Named arrow-function assignments also contribute function tokens.
(assignment_statement . (pattern (identifier) @function) (expression (function_expression)))
