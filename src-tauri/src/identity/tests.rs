use super::*;
#[derive(Default)]
struct Memory {
    saved: Mutex<Option<Vec<u8>>>,
    denied: Mutex<bool>,
    write_denied: Mutex<bool>,
    reads: Mutex<usize>,
    legacy: Mutex<Option<String>>,
    legacy_reads: Mutex<usize>,
    previous: Mutex<Option<Vec<u8>>>,
    deletes: Mutex<Vec<&'static str>>,
}
impl Store for Arc<Memory> {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        *self.reads.lock().unwrap() += 1;
        if *self.denied.lock().unwrap() {
            return Err("denied".into());
        }
        Ok(self.saved.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn add(&self, value: &[u8]) -> Result<()> {
        if *self.write_denied.lock().unwrap() {
            return Err("write denied".into());
        }
        let mut saved = self.saved.lock().unwrap();
        if saved.is_some() {
            return Err("occupied".into());
        }
        *saved = Some(value.to_vec());
        Ok(())
    }
    fn legacy(&self) -> Result<Zeroizing<String>> {
        *self.legacy_reads.lock().unwrap() += 1;
        self.legacy
            .lock()
            .unwrap()
            .clone()
            .map(Zeroizing::new)
            .ok_or_else(|| "No identity from the earlier Buzz app was found".into())
    }
    fn delete(&self) -> Result<()> {
        if *self.write_denied.lock().unwrap() {
            return Err("delete denied".into());
        }
        self.deletes.lock().unwrap().push("current");
        *self.saved.lock().unwrap() = None;
        Ok(())
    }
    fn previous(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        if *self.denied.lock().unwrap() {
            return Err("denied".into());
        }
        Ok(self.previous.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn delete_previous(&self) -> Result<()> {
        if *self.write_denied.lock().unwrap() {
            return Err("delete denied".into());
        }
        self.deletes.lock().unwrap().push("previous");
        *self.previous.lock().unwrap() = None;
        Ok(())
    }
}
fn identity(store: &Arc<Memory>) -> Identity {
    Identity {
        state: State::Unread,
        store: Box::new(store.clone()),
    }
}
fn fixture() -> Key {
    Key::new(Zeroizing::new([1; 32]))
}

#[test]
fn imports_exact_key_then_restores_and_exports_without_repeated_reads() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    let public = fixture().viewer().unwrap();
    assert_eq!(owner.save(Some(&nsec)).unwrap(), public);
    assert_eq!(owner.export().unwrap(), nsec);
    assert_eq!(owner.restore().unwrap(), Some(public.clone()));
    assert_eq!(*store.reads.lock().unwrap(), 1);
    let mut restarted = identity(&store);
    assert_eq!(restarted.restore().unwrap(), Some(public));
    assert_eq!(restarted.export().unwrap(), nsec);
    assert_eq!(*store.reads.lock().unwrap(), 2);
}
#[test]
fn legacy_import_adopts_only_a_valid_old_key_and_never_replaces_one() {
    let nsec = fixture().nsec().unwrap();
    let other = Key::new(Zeroizing::new([2; 32])).nsec().unwrap();
    // (saved, own store denied, legacy entry, imports, reads legacy)
    for (saved, denied, legacy, imports, reads_legacy) in [
        (None, false, Some(format!(" {nsec}\n")), true, true),
        (None, false, None, false, true),
        (None, false, Some("not-a-key".into()), false, true),
        (Some(other.clone()), false, Some(nsec.clone()), false, false),
        (None, true, Some(nsec.clone()), false, false),
    ] {
        let store = Arc::new(Memory::default());
        *store.saved.lock().unwrap() = saved.clone().map(String::into_bytes);
        *store.denied.lock().unwrap() = denied;
        *store.legacy.lock().unwrap() = legacy;
        let result = identity(&store).import_legacy();
        assert_eq!(result.is_ok(), imports, "{result:?}");
        assert_eq!(
            *store.legacy_reads.lock().unwrap(),
            usize::from(reads_legacy)
        );
        let expected = if imports { Some(nsec.clone()) } else { saved };
        assert_eq!(
            *store.saved.lock().unwrap(),
            expected.map(String::into_bytes)
        );
        if imports {
            assert_eq!(
                identity(&store).restore().unwrap(),
                Some(fixture().viewer().unwrap())
            );
        }
    }
}
#[test]
fn denied_and_corrupt_reads_cannot_create_or_overwrite() {
    for corrupt in [false, true] {
        let store = Arc::new(Memory::default());
        *store.denied.lock().unwrap() = !corrupt;
        if corrupt {
            *store.saved.lock().unwrap() = Some(b"corrupt".to_vec());
        }
        let before = store.saved.lock().unwrap().clone();
        let mut owner = identity(&store);
        assert!(owner.restore().is_err());
        assert!(owner.save(None).is_err());
        assert!(owner.save(Some(&fixture().nsec().unwrap())).is_err());
        assert_eq!(*store.saved.lock().unwrap(), before);
        assert!(matches!(owner.state, State::Unread));
    }
}
#[test]
fn failed_persistence_never_adopts_candidate_and_retry_uses_imported_key() {
    let store = Arc::new(Memory::default());
    *store.write_denied.lock().unwrap() = true;
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    assert!(owner.save(Some(&nsec)).is_err());
    assert!(owner.export().is_err());
    assert!(store.saved.lock().unwrap().is_none());
    *store.write_denied.lock().unwrap() = false;
    assert_eq!(
        owner.save(Some(&nsec)).unwrap(),
        fixture().viewer().unwrap()
    );
}
#[test]
fn cached_absence_cannot_overwrite_an_identity_created_by_another_process() {
    let store = Arc::new(Memory::default());
    let mut first = identity(&store);
    let mut second = identity(&store);
    assert!(first.restore().unwrap().is_none());
    let public = second.save(None).unwrap();
    assert!(first.save(None).is_err());
    assert_eq!(identity(&store).restore().unwrap(), Some(public));
}
#[test]
fn invalid_imports_do_not_create_keys_and_saved_identity_is_immutable() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    for text in [
        "",
        "ab",
        &"ab".repeat(32),
        &bech32::encode::<Bech32>(Hrp::parse("npub").unwrap(), &[1; 32]).unwrap(),
        &Key::new(Zeroizing::new([0; 32])).nsec().unwrap(),
    ] {
        assert!(owner.save(Some(text)).is_err());
        assert!(store.saved.lock().unwrap().is_none());
    }
    let public = owner.save(None).unwrap();
    assert!(owner.save(None).is_err());
    assert!(owner.save(Some(&fixture().nsec().unwrap())).is_err());
    assert_eq!(owner.restore().unwrap(), Some(public));
}
#[test]
fn default_test_host_cannot_access_real_credentials() {
    assert!(IdentityHost::default().0.lock().unwrap().restore().is_err());
}

#[tokio::test]
async fn authorize_agent_signs_for_agent_and_rejects_invalid_requests() {
    use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
    let host = IdentityHost::fixture();
    let owner = host.viewer().await.unwrap();
    let agent = Key::new(Zeroizing::new([2; 32])).viewer().unwrap();
    let tag = host
        .authorize_agent(owner.clone(), agent.clone())
        .await
        .unwrap();
    assert_eq!(&tag[..3], &["auth", owner.as_str(), ""]);
    let signature: Signature = tag[3].parse().unwrap();
    let pubkey: XOnlyPublicKey = owner.parse().unwrap();
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &digest, &pubkey)
        .unwrap();
    assert!(host
        .authorize_agent(agent.clone(), owner.clone())
        .await
        .unwrap_err()
        .contains("signed-in identity"));
    for invalid in ["invalid".into(), "A".repeat(64), owner.clone()] {
        assert!(host.authorize_agent(owner.clone(), invalid).await.is_err());
    }
    assert!(IdentityHost::default()
        .authorize_agent(owner, agent)
        .await
        .is_err());
}

#[test]
fn remote_agent_authorization_reaches_signer_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let owner = fixture().viewer().unwrap();
    let agent = Key::new(Zeroizing::new([2; 32])).viewer().unwrap();
    let response = get_ipc_response(
        &view,
        tauri::webview::InvokeRequest {
            cmd: "identity_prepare_remote_agent_authorization".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "owner": owner, "agentPubkey": agent
            })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize::<Vec<String>>()
    .unwrap();
    assert_eq!(&response[..3], &["auth", owner.as_str(), ""]);
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    secp256k1::Secp256k1::verification_only()
        .verify_schnorr(
            &response[3].parse().unwrap(),
            &digest,
            &owner.parse().unwrap(),
        )
        .unwrap();
}

#[test]
fn uppercase_import_keeps_the_exact_key_and_mixed_case_is_rejected() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    assert!(owner.save(Some(&nsec.replacen("nsec", "NSEC", 1))).is_err());
    assert!(store.saved.lock().unwrap().is_none());
    assert_eq!(
        owner.save(Some(&nsec.to_uppercase())).unwrap(),
        fixture().viewer().unwrap()
    );
    assert_eq!(identity(&store).export().unwrap(), nsec);
}

#[test]
fn development_and_release_items_are_separate() {
    assert_eq!(
        credentials::HUMAN_SERVICE,
        if cfg!(debug_assertions) {
            "xyz.block.buzz.desktop.identity.debug"
        } else {
            "xyz.block.buzz.desktop.identity"
        }
    );
    assert_eq!(credentials::HUMAN_ACCOUNT, "human");
    assert!(!credentials::HUMAN_SERVICE.starts_with("buzz-desktop"));
}

#[test]
fn sidebar_registers_bind_legacy_projection_and_preserve_tombstones() {
    use serde_json::json;
    let reg = |value| json!([100, "1234567890abcdef", value]);
    let tombstones: serde_json::Map<_, _> = (0..105)
        .map(|i| (format!("section:{i}"), reg(serde_json::Value::Null)))
        .collect();
    let sort = json!({"version": 1, "groups": {}, "meta": {"v": 1, "g": tombstones}});
    assert!(super::validate_sidebar_payload("channel-sort", &sort).is_ok());
    let mut mismatch = sort.clone();
    mismatch["meta"]["g"]["channels"] = reg(json!("recent"));
    assert!(super::validate_sidebar_payload("channel-sort", &mismatch).is_err());
    mismatch["groups"]["channels"] = json!("recent");
    assert!(super::validate_sidebar_payload("channel-sort", &mismatch).is_ok());
    let mut live = sort;
    for i in 0..105 {
        let key = format!("section:{i}");
        live["meta"]["g"][&key] = reg(json!("recent"));
        live["groups"][&key] = json!("recent");
    }
    assert!(super::validate_sidebar_payload("channel-sort", &live).is_err());
    let sections = json!({"version":1, "sections":[{"id":"work","name":"Work","order":0}], "assignments":{"c":"work"},
        "meta":{"v":1,"s":{"work":{"name":reg(json!("Work")),"order":reg(json!(40)),"live":reg(json!(true))},
            "dead":{"live":reg(json!(false))}},"a":{"c":reg(json!("work")),"old":reg(serde_json::Value::Null)}}});
    assert!(super::validate_sidebar_payload("channel-sections", &sections).is_ok());
    let mut mismatch = sections.clone();
    mismatch["sections"][0]["name"] = json!("Wrong");
    assert!(super::validate_sidebar_payload("channel-sections", &mismatch).is_err());
    for invalid in [
        json!(null),
        json!({"v":2}),
        json!({"v":1,"g":null}),
        json!({"v":1,"g":{"channels":[1,"bad","recent"]}}),
        json!({"v":1,"g":{"channels":[9007199254740992_u64,"1234567890abcdef","recent"]}}),
    ] {
        assert!(super::validate_sidebar_payload(
            "channel-sort",
            &json!({"version":1,"groups":{},"meta":invalid})
        )
        .is_err());
    }
}

#[test]
fn sidebar_section_caps_apply_to_live_projection_not_retained_registers() {
    use serde_json::{json, Value};
    let reg = |value| json!([100, "1234567890abcdef", value]);
    let dead_sections: serde_json::Map<_, _> = (0..101)
        .map(|i| {
            (
                format!("s{i}"),
                json!({"name": reg(json!("Old")), "live": reg(json!(false))}),
            )
        })
        .collect();
    let removed_assignments: serde_json::Map<_, _> = (0..1001)
        .map(|i| (format!("c{i}"), reg(Value::Null)))
        .collect();
    let mut record = json!({"version": 1, "sections": [], "assignments": {},
        "meta": {"v": 1, "s": dead_sections, "a": removed_assignments}});
    assert!(serde_json::to_vec(&record).unwrap().len() < 128 * 1024);
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_ok());
    for i in 0..101 {
        record["meta"]["s"][format!("s{i}")]["live"] = reg(json!(true));
    }
    // An under-cap legacy projection must not hide an over-cap live register tree.
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_err());
    record["sections"] =
        super::project_sidebar_meta("channel-sections", &record["meta"])["sections"].clone();
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_err());
    for i in 1..101 {
        record["meta"]["s"][format!("s{i}")]["live"] = reg(json!(false));
    }
    record["sections"] = json!([{"id": "s0", "name": "Old", "order": 0}]);
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_ok());
    for i in 0..1001 {
        record["meta"]["a"][format!("c{i}")] = reg(json!("s0"));
    }
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_err());
    record["assignments"] =
        super::project_sidebar_meta("channel-sections", &record["meta"])["assignments"].clone();
    assert!(super::validate_sidebar_payload("channel-sections", &record).is_err());
}

#[tokio::test]
async fn sidebar_signer_refuses_inconsistent_metadata() {
    use serde_json::json;
    let host = super::IdentityHost::fixture();
    let mut payload = json!({"version":1, "groups":{},
        "meta":{"v":1,"g":{"channels":[100,"1234567890abcdef","recent"]}}});
    assert!(host
        .sign_sidebar("channel-sort".into(), payload.clone(), 100)
        .await
        .is_err());
    payload["groups"]["channels"] = json!("recent");
    let event = host
        .sign_sidebar("channel-sort".into(), payload, 100)
        .await
        .unwrap();
    assert!(host.admit_sidebar(event).await.is_ok());
}

fn builderlab_challenge() -> serde_json::Value {
    serde_json::json!({
        "challenge_id": "550e8400-e29b-41d4-a716-446655440000",
        "nonce": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_-7",
        "verification_code": "123456",
        "origin": "https://app.builderlab.xyz",
        "expires_at": "2999-01-01T00:00:00Z"
    })
}
fn parse_challenge(value: serde_json::Value) -> BuilderlabChallenge {
    serde_json::from_value(value).unwrap()
}

#[test]
fn builderlab_binding_signs_the_reference_kind_24243_shape() {
    let template = parse_challenge(builderlab_challenge())
        .template(1_700_000_000, "")
        .unwrap();
    let event: Event = serde_json::from_value(fixture().sign(template).unwrap()).unwrap();
    event.verify().unwrap();
    assert_eq!(event.kind.as_u16(), 24243);
    assert_eq!(event.content, "");
    assert_eq!(event.created_at.as_secs(), 1_700_000_000);
    assert_eq!(event.pubkey.to_hex(), fixture().viewer().unwrap());
    let tags: Vec<Vec<String>> = event.tags.iter().map(|tag| tag.clone().to_vec()).collect();
    let expected = [
        ["challenge_id", "550e8400-e29b-41d4-a716-446655440000"],
        ["nonce", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_-7"],
        ["verification_code", "123456"],
        ["audience", "buzz:nostr-identity"],
        ["action", "bind_nostr_identity"],
        ["protocol", "buzz-nostr-identity"],
        ["version", "1"],
        ["origin", "https://app.builderlab.xyz"],
        ["expires_at", "2999-01-01T00:00:00Z"],
    ]
    .map(|tag| tag.map(str::to_owned).to_vec());
    assert_eq!(tags, expected);
}

#[test]
fn builderlab_binding_rejects_invalid_or_foreign_challenges() {
    let now = 1_700_000_000;
    for (field, value) in [
        ("challenge_id", "{550e8400-e29b-41d4-a716-446655440000}"),
        ("challenge_id", "550e8400e29b41d4a716446655440000"),
        ("nonce", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_-"),
        ("nonce", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234_+7"),
        ("verification_code", "12345a"),
        ("verification_code", "1234567"),
        ("origin", "https://example.com"),
        ("origin", "https://app.builderlab.xyz/"),
        ("expires_at", "2023-11-14T22:13:20Z"),
        ("expires_at", "not a time"),
    ] {
        let mut challenge = builderlab_challenge();
        challenge[field] = value.into();
        assert_eq!(
            parse_challenge(challenge)
                .template(now, "")
                .err()
                .as_deref(),
            Some("Invalid Nostr identity challenge"),
            "{field}={value}"
        );
    }
    let mut extra = builderlab_challenge();
    extra["kind"] = 1.into();
    assert!(serde_json::from_value::<BuilderlabChallenge>(extra).is_err());
}

#[test]
fn builderlab_binding_accepts_only_production_or_the_configured_origin() {
    let now = 1_700_000_000;
    let staging = "https://test.blockstaging.build";
    let with_origin = |origin: &str| {
        let mut challenge = builderlab_challenge();
        challenge["origin"] = origin.into();
        parse_challenge(challenge)
    };
    let template = with_origin(staging).template(now, staging).unwrap();
    assert!(template
        .tags
        .contains(&vec!["origin".to_owned(), staging.to_owned()]));
    assert!(with_origin("https://app.builderlab.xyz")
        .template(now, staging)
        .is_ok());
    for (origin, configured) in [
        (staging, ""),
        ("https://example.com", staging),
        ("https://test.blockstaging.build/", staging),
        ("https://test.blockstaging.build:8443", staging),
        ("", ""),
    ] {
        assert_eq!(
            with_origin(origin)
                .template(now, configured)
                .err()
                .as_deref(),
            Some("Invalid Nostr identity challenge"),
            "{origin} with {configured:?}"
        );
    }
}

#[test]
fn builderlab_binding_reaches_signer_through_production_ipc() {
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
    let app = mock_builder()
        .manage(IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |challenge: serde_json::Value| {
        get_ipc_response(
            &view,
            tauri::webview::InvokeRequest {
                cmd: "identity_sign_builderlab_binding".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({ "challenge": challenge })),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
    };
    let event: Event = invoke(builderlab_challenge())
        .unwrap()
        .deserialize()
        .unwrap();
    event.verify().unwrap();
    assert_eq!(event.kind.as_u16(), 24243);
    assert_eq!(event.pubkey.to_hex(), fixture().viewer().unwrap());
    let mut foreign = builderlab_challenge();
    foreign["origin"] = "https://example.com".into();
    assert!(invoke(foreign).is_err());
}

#[test]
fn remove_key_deletes_then_confirms_absence() {
    let store = Arc::new(Memory::default());
    identity(&store).save(None).unwrap();
    remove_key(&store).unwrap();
    assert_eq!(identity(&store).restore().unwrap(), None);
    // Absent is already signed out.
    remove_key(&store).unwrap();
    identity(&store).save(None).unwrap();
    *store.write_denied.lock().unwrap() = true;
    assert!(remove_key(&store).is_err());
    assert!(store.saved.lock().unwrap().is_some());
}

#[test]
fn remove_key_also_deletes_the_key_under_its_previous_service() {
    let store = Arc::new(Memory::default());
    identity(&store).save(None).unwrap();
    *store.previous.lock().unwrap() = store.saved.lock().unwrap().clone();
    remove_key(&store).unwrap();
    assert!(store.saved.lock().unwrap().is_none());
    assert!(store.previous.lock().unwrap().is_none());
    // The previous key first: reads copy it while the current one is absent.
    assert_eq!(*store.deletes.lock().unwrap(), ["previous", "current"]);
    // Only a previous key left is still a key to remove.
    *store.previous.lock().unwrap() = Some(b"previous".to_vec());
    remove_key(&store).unwrap();
    assert!(store.previous.lock().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_refuses_every_key_operation_including_a_sign_started_before_it() {
    let host = IdentityHost::fixture();
    let owner = host.viewer().await.unwrap();
    let agent = Key::new(Zeroizing::new([2; 32])).viewer().unwrap();
    let template = || {
        serde_json::from_value(serde_json::json!({
            "kind": 1, "content": "", "tags": [], "created_at": 0
        }))
        .unwrap()
    };
    // Started while another operation holds the identity, run after it closes.
    let started = {
        let mut running = host.0.lock().unwrap();
        let task = host.clone();
        let started = tokio::spawn(async move { task.sign(template()).await });
        // The test's handle, the task's, and the one `sign` clones once it starts.
        while Arc::strong_count(&host.0) < 3 {
            std::thread::yield_now();
        }
        running.close();
        started
    };
    assert!(started.await.unwrap().is_err());
    host.close();
    assert!(host.sign(template()).await.is_err());
    assert!(host.viewer().await.is_err());
    assert!(host.authorize_agent(owner, agent).await.is_err());
    assert!(host.with_key(|_, _| Ok(())).await.is_err());
    assert!(with_identity(host.clone(), |identity| identity.export())
        .await
        .is_err());
    assert!(with_identity(host, |identity| identity.save(None))
        .await
        .is_err());
}

#[tokio::test]
async fn sidebar_filter_signer_checks_projection_modes_and_coordinate() {
    use serde_json::json;
    let host = super::IdentityHost::fixture();
    let payload = json!({"version":1,"groups":{"channels":"unreads"}, "activeWindowSeconds":{"channels":604800},
        "meta":{"v":1,"g":{"channels":[100,"1234567890abcdef","unreads"]}}});
    let event = host
        .sign_sidebar("channel-filter".into(), payload.clone(), 100)
        .await
        .unwrap();
    host.admit_sidebar(event.clone()).await.unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["channel-filter"],
        payload
    );
    let reset = json!({"version":1,"groups":{},
        "meta":{"v":1,"g":{"channels":[101,"1234567890abcdef",null]}}});
    assert!(host
        .sign_sidebar("channel-filter".into(), reset, 101)
        .await
        .is_ok());
    for seconds in [
        json!(0),
        json!(-86400),
        json!(86401),
        json!(86400.5),
        json!(31622400),
        json!("604800"),
        json!(null),
    ] {
        let mut invalid = payload.clone();
        invalid["activeWindowSeconds"]["channels"] = seconds;
        assert!(host
            .sign_sidebar("channel-filter".into(), invalid, 100)
            .await
            .is_err());
    }
    for invalid in [
        json!({"version":1,"groups":{"channels":"recent"}}),
        json!({"version":1,"groups":{},"meta":payload["meta"]}),
        json!({"version":1,"groups":{},"meta":{"v":1,"g":{"channels":[1,"1234567890abcdef","recent"]}}}),
    ] {
        assert!(host
            .sign_sidebar("channel-filter".into(), invalid, 100)
            .await
            .is_err());
    }
    assert!(host
        .sign_sidebar("channel-sort".into(), payload, 100)
        .await
        .is_err());
}

#[test]
fn native_recovery_install_is_create_only_and_failed_writes_keep_candidates_unadopted() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let public = fixture().viewer().unwrap();
    *store.write_denied.lock().unwrap() = true;
    assert!(owner
        .install_recovered(Zeroizing::new([1; 32]), &public)
        .is_err());
    assert!(matches!(owner.state, State::Missing));
    assert!(store.saved.lock().unwrap().is_none());
    *store.write_denied.lock().unwrap() = false;
    assert_eq!(
        owner
            .install_recovered(Zeroizing::new([1; 32]), &public)
            .unwrap(),
        public
    );
    assert!(owner
        .install_recovered(Zeroizing::new([2; 32]), &public)
        .is_err());
    assert_eq!(identity(&store).restore().unwrap(), Some(public));
}

#[test]
fn native_recovery_rechecks_absence_and_never_adopts_mismatched_or_invalid_scalars() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let public = fixture().viewer().unwrap();
    owner.require_missing().unwrap();
    for secret in [[0; 32], [2; 32]] {
        assert!(owner
            .install_recovered(Zeroizing::new(secret), &public)
            .is_err());
        assert!(store.saved.lock().unwrap().is_none());
    }
    *store.denied.lock().unwrap() = true;
    assert!(owner.require_missing().is_err());
    assert!(owner
        .install_recovered(Zeroizing::new([1; 32]), &public)
        .is_err());
    *store.denied.lock().unwrap() = false;
    let winner = identity(&store).save(None).unwrap();
    assert!(owner.require_missing().is_err());
    assert!(owner
        .install_recovered(Zeroizing::new([1; 32]), &public)
        .is_err());
    assert_eq!(identity(&store).restore().unwrap(), Some(winner));
}

#[tokio::test]
async fn canceled_recovery_admission_cannot_commit_a_key_and_closed_identity_refuses_install() {
    let store = Arc::new(Memory::default());
    let host = IdentityHost(Arc::new(Mutex::new(identity(&store))));
    let public = fixture().viewer().unwrap();
    let admission = Arc::new(Mutex::new(false));
    assert!(host
        .install_recovered(Zeroizing::new([1; 32]), public.clone(), admission)
        .await
        .is_err());
    assert!(store.saved.lock().unwrap().is_none());
    host.close();
    assert!(host
        .install_recovered(Zeroizing::new([1; 32]), public, Arc::new(Mutex::new(true)))
        .await
        .is_err());
    assert!(store.saved.lock().unwrap().is_none());
}

// Shared synthetic secure storage for end-to-end native recovery orchestration tests.
pub(crate) fn missing_fixture() -> IdentityHost {
    let store = Arc::new(Memory::default());
    IdentityHost(Arc::new(Mutex::new(identity(&store))))
}
pub(crate) fn write_denied_fixture() -> (IdentityHost, impl Fn()) {
    let store = Arc::new(Memory::default());
    *store.write_denied.lock().unwrap() = true;
    let host = IdentityHost(Arc::new(Mutex::new(identity(&store))));
    (host, move || *store.write_denied.lock().unwrap() = false)
}

#[tokio::test]
async fn main_agent_signer_admits_one_agent_or_a_cleared_choice() {
    use serde_json::json;
    let host = super::IdentityHost::fixture();
    let payload = json!({"version": 1, "agent": "ab".repeat(32)});
    let event = host
        .sign_sidebar("main-agent".into(), payload.clone(), 100)
        .await
        .unwrap();
    host.admit_sidebar(event.clone()).await.unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["main-agent"],
        payload
    );
    let payload = json!({"version": 1, "agent": null});
    let event = host
        .sign_sidebar("main-agent".into(), payload.clone(), 101)
        .await
        .unwrap();
    host.admit_sidebar(event.clone()).await.unwrap();
    assert_eq!(
        host.decode_sidebar(vec![event]).await.unwrap()["main-agent"],
        payload
    );
    for invalid in [
        json!({"version": 1}),
        json!({"version": 2, "agent": "ab".repeat(32)}),
        json!({"version": 1, "agent": "AB".repeat(32)}),
        json!({"version": 1, "agent": "ab".repeat(31)}),
        json!({"version": 1, "agent": 7}),
        json!({"version": 1, "agent": "ab".repeat(32), "extra": true}),
    ] {
        assert!(host
            .sign_sidebar("main-agent".into(), invalid, 100)
            .await
            .is_err());
    }
}

#[test]
fn sidebar_plugin_sort_registers_are_bounded_and_namespaced() {
    use serde_json::json;
    for mode in [
        "plugin:example.plugin/rows/reverse",
        &format!("plugin:a/b/{}", "x".repeat(501)),
    ] {
        let record = json!({"version":1,"groups":{"dms":"recent"},"meta":{"v":1,"g":{"channels":[100,"1234567890abcdef",null],"dms":[99,"1234567890abcdef","recent"]}},"pluginSort":{"v":1,"g":{"channels":[100,"1234567890abcdef",mode]}}});
        assert!(super::validate_sidebar_payload("channel-sort", &record).is_ok());
    }
    for mode in [
        "plugin:x",
        "alpha",
        "recent",
        "plugin:a/b/",
        "plugin:a/b/c/d",
        "plugin:A/b/c",
        &format!("plugin:a/b/{}", "x".repeat(502)),
    ] {
        let record = json!({"version":1,"groups":{},"meta":{"v":1,"g":{"channels":[100,"1234567890abcdef",null]}},"pluginSort":{"v":1,"g":{"channels":[100,"1234567890abcdef",mode]}}});
        assert!(super::validate_sidebar_payload("channel-sort", &record).is_err());
    }
    for choices in [
        json!({"v":2,"g":{}}),
        json!({"v":1}),
        json!({"v":1,"g":{"channels":[100,"bad-device","plugin:a/b/c"]}}),
        json!({"v":1,"g":{"channels":[-1,"1234567890abcdef","plugin:a/b/c"]}}),
        json!({"v":1,"g":{"channels":[100,"1234567890abcdef",null]}}),
    ] {
        let record = json!({"version":1,"groups":{},"pluginSort":choices});
        assert!(super::validate_sidebar_payload("channel-sort", &record).is_err());
    }
}
