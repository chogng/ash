use super::*;

#[test]
fn account_rules_deny_both_address_families_and_allow_only_the_managed_endpoint() {
    let accounts = [
        NetworkMode::Denied,
        NetworkMode::Managed,
        NetworkMode::Allowed,
    ]
    .map(|mode| super::super::account::plan(mode, 3128).unwrap());
    let rules = Rules::plan(&accounts).unwrap();
    for (index, expected) in [(0, 6), (1, 7), (2, 0)] {
        let filters = rules
            .filters
            .iter()
            .filter(|filter| filter.account == index)
            .collect::<Vec<_>>();
        assert_eq!(filters.len(), expected);
        if expected == 0 {
            continue;
        }
        for layer in [
            Layer::ConnectV4,
            Layer::ConnectV6,
            Layer::ListenV4,
            Layer::ListenV6,
            Layer::AcceptV4,
            Layer::AcceptV6,
        ] {
            assert!(
                filters
                    .iter()
                    .any(|filter| same_guid(&filter.layer.key(), &layer.key())
                        && matches!(filter.action, Action::Block))
            );
        }
        assert_eq!(
            filters
                .iter()
                .filter(|filter| matches!(filter.action, Action::Proxy))
                .count(),
            usize::from(index == 1)
        );
    }
}

#[test]
fn installed_policy_verification_rejects_broader_network_access() {
    let mut account = super::super::account::plan(NetworkMode::Managed, 3128).unwrap();
    account.sid = "S-1-5-21-1-2-3-1001".into();
    let rules = Rules::plan(std::slice::from_ref(&account)).unwrap();
    let plan = rules
        .filters
        .iter()
        .find(|filter| matches!(filter.action, Action::Proxy))
        .unwrap();
    let user = win::descriptor(&format!("D:(A;;CC;;;{})", account.sid)).unwrap();
    let mut blob = FWP_BYTE_BLOB {
        size: unsafe { GetSecurityDescriptorLength(user.0) },
        data: user.0.cast(),
    };
    let mut conditions = conditions(&account, Action::Proxy, &mut blob);
    let mut provider = guid(rules.provider);
    let mut filter = FWPM_FILTER0 {
        filterKey: guid(plan.key),
        flags: FWPM_FILTER_FLAG_PERSISTENT,
        providerKey: &mut provider,
        subLayerKey: guid(rules.sublayer),
        layerKey: plan.layer.key(),
        action: FWPM_ACTION0 {
            r#type: FWP_ACTION_PERMIT,
            Anonymous: unsafe { std::mem::zeroed() },
        },
        weight: FWP_VALUE0 {
            r#type: FWP_UINT8,
            Anonymous: FWP_VALUE0_0 {
                uint8: Action::Proxy.weight(),
            },
        },
        numFilterConditions: conditions.len() as u32,
        filterCondition: conditions.as_mut_ptr(),
        ..unsafe { std::mem::zeroed() }
    };
    assert!(unsafe { rules.matches(&filter, plan, &account) });
    conditions[3].conditionValue.Anonymous.uint16 = 3129;
    assert!(!unsafe { rules.matches(&filter, plan, &account) });
    conditions[3].conditionValue.Anonymous.uint16 = 3128;
    conditions[1].matchType = FWP_MATCH_NOT_EQUAL;
    assert!(!unsafe { rules.matches(&filter, plan, &account) });
    conditions[1].matchType = FWP_MATCH_EQUAL;
    filter.layerKey = FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4;
    assert!(!unsafe { rules.matches(&filter, plan, &account) });
    filter.layerKey = plan.layer.key();
    let broad_user = win::descriptor("D:(A;;CC;;;WD)").unwrap();
    let mut broad_blob = FWP_BYTE_BLOB {
        size: unsafe { GetSecurityDescriptorLength(broad_user.0) },
        data: broad_user.0.cast(),
    };
    conditions[0].conditionValue.Anonymous.sd = &mut broad_blob;
    assert!(!unsafe { rules.matches(&filter, plan, &account) });
}
