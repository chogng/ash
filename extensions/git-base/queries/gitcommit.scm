(comment) @comment

(generated_comment) @comment

(title) @markup.heading

; (text) @none
(branch) @markup.link

(change) @keyword

(filepath) @string.special.url

(arrow) @punctuation.delimiter

(subject) @markup.heading @spell

(subject
  (subject_prefix) @function @nospell)

(prefix
  (type) @keyword @nospell)

(prefix
  (scope) @variable.parameter @nospell)

(prefix
  [
   "("
   ")"
   ":"
   ] @punctuation.delimiter)

(prefix
  "!" @punctuation.special)

(message) @spell

(trailer
  (token) @label)

; (trailer (value) @none)
(breaking_change
  (token) @comment.error)

(breaking_change
  (value) @none @spell)

(scissor) @comment

; The upstream grammar can split an unterminated final comment into a prefix
; comment and message_line. Retain comment styling while that line is edited.
(message
  (comment) @_comment
  .
  (message_line) @comment
  (#not-match? @_comment "[\r\n]$"))
