use super::parse_query_into_tokens;

#[test]
fn sentence_parser_matches_the_classifier_token_contract() {
    assert_eq!(
        parse_query_into_tokens("This is a question?"),
        ["This", "is", "a", "question"]
    );
    assert_eq!(
        parse_query_into_tokens("A quote \"Inside 'something' quote\""),
        ["A", "quote", "\"Inside 'something' quote\""]
    );
    assert_eq!(
        parse_query_into_tokens("Empty quote \"\"!?!"),
        ["Empty", "quote"]
    );
    assert_eq!(
        parse_query_into_tokens("www.google.com"),
        ["www.google.com"]
    );
    assert_eq!(
        parse_query_into_tokens("Command `mockery --name example_interface`"),
        ["Command", "`mockery --name example_interface`"]
    );
}
