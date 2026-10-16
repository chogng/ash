((diff) @injection.content
  (#set! injection.language "diff"))

((rebase_command) @injection.content
  (#set! injection.language "git_rebase"))

; Verbose commit buffers can contain a patch without a scissors marker.
; Only an explicit diff header begins this embedded region.
(message
  (message_line) @_header @injection.content
  (message_line)* @injection.content
  (#match? @_header "^diff --git ")
  (#set! injection.language "diff"))
