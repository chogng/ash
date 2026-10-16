; Echo off/on
(echo_off) @keyword

; Comments
(comment) @comment

; Labels
(label) @label

; Variable assignment
(set_keyword) @keyword
(variable_name) @variable
(set_option) @constant
(assignment_literal) @string
(arithmetic_expression) @string

; IF/FOR/GOTO/CALL statements
(if_stmt) @keyword
(for_stmt) @keyword
(goto_stmt) @keyword
(call_stmt) @keyword
(setlocal_stmt) @keyword
(endlocal_stmt) @keyword
(exit_stmt) @keyword

; Operators
(comparison_op) @operator
(redirect_op) @operator
(fd_redirect) @operator

; Commands
(command_name) @function

; CMD pseudo/dynamic environment variables
((variable_reference) @variable.builtin
  (#match? @variable.builtin "^[%!]([Cc][Dd]|[Ee][Rr][Rr][Oo][Rr][Ll][Ee][Vv][Ee][Ll]|[Dd][Aa][Tt][Ee]|[Tt][Ii][Mm][Ee]|[Rr][Aa][Nn][Dd][Oo][Mm]|[Cc][Mm][Dd][Cc][Mm][Dd][Ll][Ii][Nn][Ee]|[Cc][Mm][Dd][Ee][Xx][Tt][Vv][Ee][Rr][Ss][Ii][Oo][Nn]|[Hh][Ii][Gg][Hh][Ee][Ss][Tt][Nn][Uu][Mm][Aa][Nn][Oo][Dd][Ee][Nn][Uu][Mm][Bb][Ee][Rr]|__[Aa][Pp][Pp][Dd][Ii][Rr]__|__[Cc][Dd]__)[%!]$"))

; Variables
(variable_reference) @variable

; FOR set literal content
(for_set_literal) @string

; FOR loop variables
(for_variable) @parameter

; FOR options
(for_options) @constant

; Strings
(string) @string

; Numbers
(integer) @number

; Command options/flags
(command_option) @constant

; Argument values
(argument_value) @string

; Redirect targets
(redirect_target) @string.special
