; Ash-authored: an exec operation contains a Shell command, bounded to its own line.
((operation
  (command) @_command
  (message) @injection.content)
 (#match? @_command "^(exec|x)$")
 (#set! injection.language "shell"))
