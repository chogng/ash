use super::*;

fn edit(
    store: &ChannelStore,
    actor: &ChannelCredential,
    snapshot: &ChannelSnapshot,
    change: ChannelChange,
) -> Result<ChannelSnapshot, ChannelError> {
    store.edit(
        actor,
        ChannelEditParams {
            space_id: snapshot.id.clone(),
            revision: snapshot.revision,
            change,
        },
    )
}

#[test]
fn persistent_tree_membership_permissions_and_revocation_across_hosts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("collab.sqlite");
    let host_a = ChannelStore::open(&path).unwrap();
    let owner = ChannelCredential::generate().unwrap();
    let editor = ChannelCredential::generate().unwrap();
    let viewer = ChannelCredential::generate().unwrap();
    let mut state = host_a.create(&owner, "Ash", "Lance").unwrap();
    assert_eq!(state, host_a.create(&owner, "Ash", "Lance").unwrap());
    for (token, role, name) in [
        (&editor, ChannelRole::Editor, "Editor"),
        (&viewer, ChannelRole::Viewer, "Visitor"),
    ] {
        state = host_a
            .invite(
                &owner,
                ChannelInvite {
                    params: ChannelInviteParams {
                        space_id: state.id.clone(),
                        revision: state.revision,
                        name: name.into(),
                        role,
                    },
                    credential: token.expose().into(),
                },
            )
            .unwrap();
    }
    let host_b = ChannelStore::open(&path).unwrap();
    let create = || ChannelChange::Create {
        name: "rooms".into(),
        parent_id: None,
    };
    assert_eq!(
        edit(&host_b, &viewer, &state, create()),
        Err(ChannelError::Denied)
    );
    let stale = state.clone();
    state = edit(&host_b, &editor, &state, create()).unwrap();
    assert_eq!(
        edit(&host_a, &owner, &stale, create()),
        Err(ChannelError::Conflict)
    );
    let parent = state.channels[0].id.clone();
    state = edit(
        &host_a,
        &owner,
        &state,
        ChannelChange::Create {
            name: "design".into(),
            parent_id: Some(parent.clone()),
        },
    )
    .unwrap();
    assert_eq!(host_b.read(&viewer).unwrap().channels, state.channels);
    let viewer_id = host_b.read(&viewer).unwrap().member_id;
    let set_role = || ChannelChange::SetRole {
        member_id: viewer_id.clone(),
        role: ChannelRole::Editor,
    };
    assert_eq!(
        edit(&host_b, &editor, &state, set_role()),
        Err(ChannelError::Denied)
    );
    state = edit(&host_a, &owner, &state, set_role()).unwrap();
    state = edit(
        &host_b,
        &viewer,
        &state,
        ChannelChange::Rename {
            channel_id: parent.clone(),
            name: "meetings".into(),
        },
    )
    .unwrap();
    state = edit(
        &host_a,
        &owner,
        &state,
        ChannelChange::RemoveMember {
            member_id: viewer_id,
        },
    )
    .unwrap();
    assert_eq!(host_b.read(&viewer), Err(ChannelError::Denied));
    assert_eq!(
        edit(&host_b, &viewer, &state, create()),
        Err(ChannelError::Denied)
    );
    state = edit(
        &host_b,
        &editor,
        &state,
        ChannelChange::Remove { channel_id: parent },
    )
    .unwrap();
    assert!(state.channels.is_empty());
    let owner_id = host_a.read(&owner).unwrap().member_id;
    assert_eq!(
        edit(
            &host_a,
            &owner,
            &state,
            ChannelChange::SetRole {
                member_id: owner_id,
                role: ChannelRole::Viewer
            }
        ),
        Err(ChannelError::Invalid)
    );
    let stranger = ChannelCredential::generate().unwrap();
    let other = host_a.create(&stranger, "Private", "Someone").unwrap();
    assert_eq!(
        edit(&host_b, &editor, &other, create()),
        Err(ChannelError::Conflict)
    );
    drop(host_a);
    drop(host_b);
    let restarted = ChannelStore::open(&path).unwrap();
    assert_eq!(restarted.read(&owner).unwrap().members.len(), 2);
    assert!(restarted.read(&editor).unwrap().channels.is_empty());
    assert_eq!(restarted.read(&viewer), Err(ChannelError::Denied));
    let connection = Connection::open(path).unwrap();
    let hashes = connection
        .prepare("SELECT credential FROM collaboration_channel_members")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(!hashes.contains(&owner.expose().to_string()));
}

#[test]
fn validates_hierarchy_names_and_concurrent_writers() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("collab.sqlite");
    let store = ChannelStore::open(&path).unwrap();
    let owner = ChannelCredential::generate().unwrap();
    let state = store.create(&owner, "Workspace", "Owner").unwrap();
    for name in ["", "invalid/name", "control\nname", &"x".repeat(81)] {
        assert_eq!(
            edit(
                &store,
                &owner,
                &state,
                ChannelChange::Create {
                    name: name.into(),
                    parent_id: None
                }
            ),
            Err(ChannelError::Invalid)
        );
    }
    assert_eq!(
        edit(
            &store,
            &owner,
            &state,
            ChannelChange::Create {
                name: "child".into(),
                parent_id: Some("missing".into())
            }
        ),
        Err(ChannelError::Invalid)
    );
    let state = edit(
        &store,
        &owner,
        &state,
        ChannelChange::Create {
            name: "General".into(),
            parent_id: None,
        },
    )
    .unwrap();
    assert_eq!(
        edit(
            &store,
            &owner,
            &state,
            ChannelChange::Create {
                name: "general".into(),
                parent_id: None
            }
        ),
        Err(ChannelError::Conflict)
    );
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|index| {
            let store = ChannelStore::open(&path).unwrap();
            let owner = ChannelCredential::parse(owner.expose().into()).unwrap();
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                edit(
                    &store,
                    &owner,
                    &state,
                    ChannelChange::Create {
                        name: format!("new-{index}"),
                        parent_id: None,
                    },
                )
            })
        })
        .collect();
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| **r == Err(ChannelError::Conflict))
            .count(),
        1
    );
}
