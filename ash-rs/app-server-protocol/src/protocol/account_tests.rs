use super::*;
use serde_json::json;

#[test]
fn independent_chatgpt_login_uses_camel_case_account_identity() {
    for account_id in [None, Some("ash-registration".to_owned())] {
        let method = AccountLoginMethodDto::ChatGptPlanBrowser {
            account_id: account_id.clone(),
        };
        let wire = json!({"type":"chatGptPlanBrowser", "accountId":account_id});
        assert_eq!(serde_json::to_value(&method).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<AccountLoginMethodDto>(wire).unwrap(),
            method
        );
    }
}
