use super::*;
use crate::federated_identity::FederatedIdentity;
use serde_json::Value;

pub(super) fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
        && value.len() == 36
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn tag<'a>(event: &'a EventTemplate, index: usize, name: &str) -> Option<&'a str> {
    let t = event.tags.get(index)?;
    match t.as_slice() {
        [key, value] if key == name => Some(value.as_str()),
        _ => None,
    }
}
fn common(event: &EventTemplate) -> bool {
    event.content.is_empty() && event.created_at <= i64::MAX as u64
}
fn details(event: &EventTemplate) -> bool {
    if event.kind != 9002 || !common(event) || !(3..=14).contains(&event.tags.len()) {
        return false;
    }
    let (Some(id), Some(name), Some(about)) = (
        tag(event, 0, "h"),
        tag(event, 1, "name"),
        tag(event, 2, "about"),
    ) else {
        return false;
    };
    let mut index = 3;
    if let Some(visibility) = tag(event, index, "visibility") {
        if !matches!(visibility, "private" | "open") {
            return false;
        }
        index += 1;
    }
    if let Some(ttl) = tag(event, index, "ttl") {
        if !ttl.is_empty()
            && (ttl.starts_with('0')
                || !ttl.bytes().all(|b| b.is_ascii_digit())
                || !ttl.parse::<i32>().is_ok_and(|n| n > 0))
        {
            return false;
        }
        index += 1;
    }
    // NIP-CL: trailing `t` tags replace the label set; one `["t", ""]` clears it.
    if let Some(role) = tag(event, index, "join_role") {
        if !matches!(role, "member" | "guest") {
            return false;
        }
        index += 1;
    }
    let labels = &event.tags[index..];
    let labels_valid = details_labels(labels);
    uuid(id)
        && labels_valid
        && !name.is_empty()
        && name.chars().count() <= 120
        && name
            .trim_start_matches(|c: char| c == '#' || c.is_whitespace())
            .trim_end_matches(char::is_whitespace)
            == name
        && about.chars().count() <= 1000
        && !about.contains("Buzz Huddle (")
}

fn details_labels(labels: &[Vec<String>]) -> bool {
    match labels {
        [] => true,
        [only] if only.len() == 2 && only[0] == "t" && only[1].is_empty() => true,
        _ => {
            labels.len() <= 8
                && labels.iter().enumerate().all(|(n, t)| {
                    t.len() == 2
                        && t[0] == "t"
                        && channel_label(&t[1])
                        && labels[..n].iter().all(|prior| prior[1] != t[1])
                })
        }
    }
}
fn lifecycle(event: &EventTemplate) -> bool {
    if !matches!(event.kind, 9002 | 9008 | 9021 | 9022 | 41012)
        || !common(event)
        || event.tags.len() != if event.kind == 9002 { 2 } else { 1 }
    {
        return false;
    }
    // The narrow 9002 flips one relay-enforced flag: archive, or auto-join
    // for community owners/admins. Generic metadata edits take the details route.
    tag(event, 0, "h").is_some_and(uuid)
        && (event.kind != 9002
            || matches!(
                tag(event, 1, "archived").or_else(|| tag(event, 1, "auto_join")),
                Some("true" | "false")
            ))
}
fn archive(event: &EventTemplate) -> bool {
    if !matches!(event.kind, 9035 | 9036)
        || !common(event)
        || !(2..=3).contains(&event.tags.len())
        || event.tags[0] != ["-"]
    {
        return false;
    }
    let Some(target) = tag(event, 1, "p") else {
        return false;
    };
    if !super::hex_key(target) {
        return false;
    }
    if event.tags.len() == 2 {
        return true;
    }
    let auth = &event.tags[2];
    auth.len() == 4
        && auth[0] == "auth"
        && super::hex_key(&auth[1])
        && auth[1] != target
        && auth[3].len() == 128
        && auth[3]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn member_administration(event: &EventTemplate) -> bool {
    matches!(event.kind, 9000 | 9001)
        && event.content.is_empty()
        && event.created_at <= 9_007_199_254_740_991
        && event.tags.len() == if event.kind == 9000 { 3 } else { 2 }
        && tag(event, 0, "h").is_some_and(uuid)
        && tag(event, 1, "p").is_some_and(super::hex_key)
        && (event.kind == 9001
            || matches!(tag(event, 2, "role"), Some("admin" | "member" | "guest")))
}
fn valid(route: &str, event: &EventTemplate) -> bool {
    match route {
        "channel-details" => details(event),
        "channel-lifecycle" => lifecycle(event),
        "identity-archive" => archive(event),
        "member-administration" => member_administration(event),
        _ => false,
    }
}
fn template(event: &Value) -> Result<EventTemplate> {
    super::template(event, "Invalid channel lifecycle command")
}
fn validate(route: &str, event: &Value, viewer: Option<&str>) -> Result<EventTemplate> {
    let parsed = template(event)?;
    if !valid(route, &parsed)
        || viewer.is_some_and(|v| event.get("pubkey").and_then(Value::as_str) != Some(v))
        || (route == "member-administration"
            && viewer.is_some_and(|v| tag(&parsed, 1, "p") == Some(v)))
    {
        return Err("Invalid channel lifecycle command".into());
    }
    if viewer.is_some() {
        super::verify_signature(event)?;
    }
    Ok(parsed)
}

#[tauri::command]
pub(crate) async fn relay_channel_sign(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    route: String,
    event: Value,
) -> Result<Value> {
    origin(&community)?;
    let parsed = validate(&route, &event, None)?;
    if route == "member-administration"
        && tag(&parsed, 1, "p") == Some(host.viewer().await?.as_str())
    {
        return Err("Invalid member administration command".into());
    }
    host.sign(parsed).await
}

#[tauri::command]
pub(crate) async fn relay_channel_publish(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    route: String,
    event: Value,
) -> Result<RelayResponse> {
    let url = request_url(&community, "/events", "POST")?;
    let viewer = host.viewer().await?;
    validate(&route, &event, Some(&viewer))?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid channel lifecycle command")?;
    if body.len() > MAX_BODY {
        return Err("Invalid relay request body".into());
    }
    send(
        host.inner(),
        Some(fi.inner()),
        url,
        "POST",
        Some(body),
        true,
        MAX_RESPONSE,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn purpose_bound_templates() {
        let mut event = EventTemplate {
            kind: 9002,
            created_at: 12,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::nil().to_string()],
                vec!["archived".into(), "true".into()],
            ],
        };
        assert!(valid("channel-lifecycle", &event));
        assert!(!valid("channel-details", &event));
        event.tags.push(vec!["name".into(), "injected".into()]);
        assert!(!valid("channel-lifecycle", &event));
        event.kind = 9035;
        assert!(!valid("identity-archive", &event));
        event.kind = 9002;
        event.tags = vec![
            vec!["h".into(), uuid::Uuid::nil().to_string()],
            vec!["name".into(), "C#".into()],
            vec!["about".into(), "".into()],
        ];
        assert!(valid("channel-details", &event));
        event.tags[1][1] = "#C".into();
        assert!(!valid("channel-details", &event));
    }
}

#[tauri::command]
pub(crate) async fn relay_kit_prepare(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    record: Value,
) -> Result<String> {
    origin(&community)?;
    super::kit::prepare(&record, &community)?;
    let text = serde_json::to_string(&record).map_err(|_| "Invalid channel recipe")?;
    host.kit_cipher(text, true).await
}

#[tauri::command]
pub(crate) async fn relay_kit_decode(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    events: Vec<Value>,
) -> Result<Vec<Value>> {
    origin(&community)?;
    if events.len() > 16
        || serde_json::to_vec(&events)
            .map_err(|_| "Invalid channel recipe")?
            .len()
            > 1024 * 1024
    {
        return Err("Invalid channel recipe".into());
    }
    let viewer = host.viewer().await?;
    let mut decoded = Vec::with_capacity(events.len());
    for event in events {
        let raw: nostr::event::Event =
            serde_json::from_value(event.clone()).map_err(|_| "Invalid channel recipe")?;
        raw.verify().map_err(|_| "Invalid channel recipe")?;
        if event.get("pubkey").and_then(Value::as_str) != Some(&viewer)
            || event.get("kind") != Some(&serde_json::json!(30078))
        {
            return Err("Invalid channel recipe".into());
        }
        let record = super::kit::validate_ciphertext(host.inner(), &event, &community).await?;
        decoded.push(serde_json::json!({"eventId": event["id"], "record": record}));
    }
    Ok(decoded)
}

#[tauri::command]
pub(crate) async fn relay_direct_message(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    pubkeys: Vec<String>,
) -> Result<String> {
    let url = request_url(&community, "/events", "POST")?;
    let viewer = host.viewer().await?;
    let unique: std::collections::HashSet<_> = pubkeys.iter().collect();
    if pubkeys.is_empty()
        || pubkeys.len() > 8
        || unique.len() != pubkeys.len()
        || pubkeys.iter().any(|p| !super::hex_key(p) || p == &viewer)
    {
        return Err("Choose between one and eight other people.".into());
    }
    let event = host
        .sign(EventTemplate {
            kind: 41010,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs(),
            content: String::new(),
            tags: pubkeys
                .into_iter()
                .map(|p| vec!["p".into(), p])
                .chain(std::iter::once(vec![
                    "client".into(),
                    uuid::Uuid::new_v4().to_string(),
                ]))
                .collect(),
        })
        .await?;
    let body = serde_json::to_string(&event).map_err(|_| "Invalid channel lifecycle command")?;
    let response = send(
        host.inner(),
        Some(fi.inner()),
        url,
        "POST",
        Some(body),
        true,
        MAX_RESPONSE,
    )
    .await?;
    if response.status != 200 {
        return Err("The direct message could not be opened. Try again.".into());
    }
    let receipt: Value = serde_json::from_str(&response.body)
        .map_err(|_| "The direct message could not be opened. Try again.")?;
    if receipt.get("event_id") != event.get("id")
        || receipt.get("accepted") != Some(&Value::Bool(true))
    {
        return Err("The direct message could not be opened. Try again.".into());
    }
    let payload = receipt
        .get("message")
        .and_then(Value::as_str)
        .and_then(|m| m.strip_prefix("response:"))
        .ok_or("The direct message could not be opened. Try again.")?;
    let result: Value = serde_json::from_str(payload)
        .map_err(|_| "The relay returned an invalid direct message.")?;
    let id = result
        .get("channel_id")
        .and_then(Value::as_str)
        .ok_or("The relay returned an invalid direct message.")?;
    if !uuid(id) {
        return Err("The relay returned an invalid direct message.".into());
    }
    Ok(id.into())
}

pub(super) fn creation(event: &EventTemplate) -> bool {
    if event.kind != 9007 || !event.content.is_empty() || !(4..=47).contains(&event.tags.len()) {
        return false;
    }
    let (Some(id), Some(name), Some(visibility), Some(channel_type)) = (
        tag(event, 0, "h"),
        tag(event, 1, "name"),
        tag(event, 2, "visibility"),
        tag(event, 3, "channel_type"),
    ) else {
        return false;
    };
    if !uuid(id)
        || name.trim().is_empty()
        || name.chars().count() > 120
        || !matches!(visibility, "open" | "private")
        || !matches!(channel_type, "stream" | "system")
    {
        return false;
    }
    let mut index = 4;
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "about"))
    {
        let Some(about) = tag(event, index, "about") else {
            return false;
        };
        if about.chars().count() > 1000 {
            return false;
        }
        index += 1;
    }
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "ttl"))
    {
        let Some(ttl) = tag(event, index, "ttl") else {
            return false;
        };
        if ttl.starts_with('0')
            || !ttl.bytes().all(|b| b.is_ascii_digit())
            || !ttl.parse::<i32>().is_ok_and(|n| n > 0)
        {
            return false;
        }
        index += 1;
    }
    // NIP-CL labels: up to 8 distinct `t` tags after `about`/`ttl`.
    let first_label = index;
    while event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "t"))
    {
        let Some(label) = tag(event, index, "t") else {
            return false;
        };
        if index - first_label >= 8
            || !channel_label(label)
            || event.tags[first_label..index].iter().any(|t| t[1] == label)
        {
            return false;
        }
        index += 1;
    }
    // block/buzz#8421: up to 32 distinct `p` tags name the first members.
    let first_member = index;
    while event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "p"))
    {
        let Some(member) = tag(event, index, "p") else {
            return false;
        };
        if index - first_member >= 32
            || !super::hex_key(member)
            || event.tags[first_member..index]
                .iter()
                .any(|t| t[1] == member)
        {
            return false;
        }
        index += 1;
    }
    if event
        .tags
        .get(index)
        .is_some_and(|t| t.first().is_some_and(|s| s == "client-id"))
    {
        let Some(client) = tag(event, index, "client-id") else {
            return false;
        };
        if !uuid(client) {
            return false;
        }
        index += 1;
    }
    index == event.tags.len()
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    #[test]
    fn lifecycle_accepts_a_join_request_for_one_channel_only() {
        let channel = uuid::Uuid::nil().to_string();
        let join = serde_json::json!({
            "kind": 9021,
            "created_at": 1700000010,
            "content": "",
            "tags": [["h", channel]]
        });
        assert!(validate("channel-lifecycle", &join, None).is_ok());
        assert!(validate("channel-details", &join, None).is_err());
        for tags in [
            serde_json::json!([]),
            serde_json::json!([["h", "open"]]),
            serde_json::json!([["h", channel], ["h", channel]]),
            serde_json::json!([["h", channel], ["p", "00".repeat(32)]]),
        ] {
            let mut command = join.clone();
            command["tags"] = tags;
            assert!(validate("channel-lifecycle", &command, None).is_err());
        }
    }
    #[test]
    fn lifecycle_accepts_only_exact_archive_and_auto_join_values() {
        for flag in ["archived", "auto_join"] {
            lifecycle_accepts_only_exact_flag_values(flag);
        }
    }
    fn lifecycle_accepts_only_exact_flag_values(flag: &str) {
        let event = serde_json::json!({
            "kind": 9002,
            "created_at": 1700000010,
            "content": "",
            "tags": [["h", uuid::Uuid::nil().to_string()], [flag, "false"]]
        });
        for value in ["true", "false"] {
            let mut command = event.clone();
            command["tags"][1][1] = serde_json::json!(value);
            assert!(validate("channel-lifecycle", &command, None).is_ok());
            assert!(validate("channel-details", &command, None).is_err());
        }
        for value in [
            serde_json::json!(""),
            serde_json::json!("False"),
            serde_json::json!("TRUE"),
            serde_json::json!("false "),
            serde_json::json!("0"),
            serde_json::json!("anything"),
            serde_json::json!(false),
            serde_json::json!(0),
            Value::Null,
        ] {
            let mut command = event.clone();
            command["tags"][1][1] = value;
            assert!(validate("channel-lifecycle", &command, None).is_err());
        }
        for tags in [
            serde_json::json!([["h", uuid::Uuid::nil().to_string()]]),
            serde_json::json!([["h", uuid::Uuid::nil().to_string()], [flag]]),
            serde_json::json!([
                ["h", uuid::Uuid::nil().to_string()],
                [flag, "false", "extra"]
            ]),
            serde_json::json!([
                ["h", uuid::Uuid::nil().to_string()],
                [flag, "false"],
                [flag, "true"]
            ]),
            serde_json::json!([
                ["h", uuid::Uuid::nil().to_string()],
                ["archived", "false"],
                ["auto_join", "true"]
            ]),
            serde_json::json!([
                ["h", uuid::Uuid::nil().to_string()],
                [flag, "false"],
                ["name", "injected"]
            ]),
            serde_json::json!([[flag, "false"], ["h", uuid::Uuid::nil().to_string()]]),
            serde_json::json!([["h", "not-a-channel"], [flag, "false"]]),
            serde_json::json!([["h", uuid::Uuid::nil().to_string()], ["autojoin", "true"]]),
            serde_json::json!([["h", uuid::Uuid::nil().to_string()], ["auto-join", "true"]]),
        ] {
            let mut command = event.clone();
            command["tags"] = tags;
            assert!(validate("channel-lifecycle", &command, None).is_err());
        }
    }

    #[test]
    fn commands_reject_cross_route_and_foreign_signatures() {
        let host = IdentityHost::fixture();
        for (flag, value, tampered) in [
            ("archived", "true", "false"),
            ("archived", "false", "true"),
            ("auto_join", "true", "false"),
            ("auto_join", "false", "true"),
        ] {
            let template = EventTemplate {
                kind: 9002,
                created_at: 1700000010,
                content: String::new(),
                tags: vec![
                    vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                    vec![flag.into(), value.into()],
                ],
            };
            let event = tauri::async_runtime::block_on(host.sign(template)).unwrap();
            assert!(validate("channel-lifecycle", &event, event["pubkey"].as_str()).is_ok());
            assert!(validate("channel-details", &event, event["pubkey"].as_str()).is_err());
            assert!(validate("channel-lifecycle", &event, Some(&"f".repeat(64))).is_err());
            let mut altered = event.clone();
            altered["tags"][1][1] = Value::String(tampered.into());
            assert!(validate("channel-lifecycle", &altered, event["pubkey"].as_str()).is_err());
        }
    }
    fn details_event(extra: Vec<Vec<String>>) -> EventTemplate {
        EventTemplate {
            kind: 9002,
            created_at: 1700000010,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::nil().to_string()],
                vec!["name".into(), "Team".into()],
                vec!["about".into(), "Description".into()],
            ]
            .into_iter()
            .chain(extra)
            .collect(),
        }
    }

    #[test]
    fn details_admit_visibility_and_duration_at_sign_and_publish_boundaries() {
        let host = IdentityHost::fixture();
        for visibility in [None, Some("private"), Some("open")] {
            for ttl in [None, Some(""), Some("1"), Some("86400"), Some("2147483647")] {
                let extra = [("visibility", visibility), ("ttl", ttl)]
                    .into_iter()
                    .filter_map(|(key, value)| value.map(|value| vec![key.into(), value.into()]))
                    .collect();
                let event = serde_json::to_value(details_event(extra)).unwrap();
                let parsed = validate("channel-details", &event, None)
                    .unwrap_or_else(|error| panic!("{visibility:?}/{ttl:?}: {error}"));
                assert!(validate("channel-lifecycle", &event, None).is_err());
                let signed = tauri::async_runtime::block_on(host.sign(parsed)).unwrap();
                assert!(validate("channel-details", &signed, signed["pubkey"].as_str()).is_ok());
                assert!(validate("channel-details", &signed, Some(&"f".repeat(64))).is_err());
                let mut altered = signed;
                altered["tags"][1][1] = Value::String("Tampered".into());
                assert!(validate("channel-details", &altered, altered["pubkey"].as_str()).is_err());
            }
        }
    }

    #[test]
    fn details_admit_only_member_and_guest_admission_defaults() {
        let host = IdentityHost::fixture();
        for role in ["member", "guest"] {
            let event =
                serde_json::to_value(details_event(vec![vec!["join_role".into(), role.into()]]))
                    .unwrap();
            let parsed = validate("channel-details", &event, None).unwrap();
            assert!(validate("channel-lifecycle", &event, None).is_err());
            let signed = tauri::async_runtime::block_on(host.sign(parsed)).unwrap();
            assert!(validate("channel-details", &signed, signed["pubkey"].as_str()).is_ok());
        }
        for extra in [
            vec![vec!["join_role", "owner"]],
            vec![vec!["join_role", "admin"]],
            vec![vec!["join_role", "bot"]],
            vec![vec!["join_role", ""]],
            vec![vec!["join_role"]],
            vec![vec!["join_role", "guest", "extra"]],
            vec![vec!["join_role", "member"], vec!["join_role", "guest"]],
            vec![vec!["join_role", "guest"], vec!["ttl", "60"]],
        ] {
            let template = details_event(
                extra
                    .iter()
                    .map(|tag| tag.iter().map(|s| (*s).into()).collect())
                    .collect(),
            );
            let event = serde_json::to_value(&template).unwrap();
            assert!(validate("channel-details", &event, None).is_err());
            let signed = tauri::async_runtime::block_on(host.sign(template)).unwrap();
            assert!(validate("channel-details", &signed, signed["pubkey"].as_str()).is_err());
        }
    }

    #[test]
    fn details_reject_huddle_markers_at_sign_and_publish_boundaries() {
        let mut event = details_event(vec![]);
        event.tags[2][1] =
            "Buzz Huddle (buzz.huddles/v1)\nparent:11111111-1111-4111-8111-111111111111".into();
        let value = serde_json::to_value(&event).unwrap();
        assert!(validate("channel-details", &value, None).is_err());
        let host = IdentityHost::fixture();
        let signed = tauri::async_runtime::block_on(host.sign(event)).unwrap();
        assert!(validate("channel-details", &signed, signed["pubkey"].as_str()).is_err());
    }

    #[test]
    fn details_reject_malformed_optional_tags() {
        for extra in [
            vec![vec![]],
            vec![vec!["ttl"]],
            vec![vec!["ttl", "1", "extra"]],
            vec![vec!["visibility"]],
            vec![vec!["visibility", "open", "extra"]],
            vec![vec!["visibility", "public"]],
            vec![vec!["visibility", ""]],
            vec![vec!["archived", "true"]],
            vec![vec!["p", "injected"]],
            vec![vec!["ttl", "0"]],
            vec![vec!["ttl", "01"]],
            vec![vec!["ttl", "-1"]],
            vec![vec!["ttl", "+1"]],
            vec![vec!["ttl", " 1"]],
            vec![vec!["ttl", "1\n"]],
            vec![vec!["ttl", "1.5"]],
            vec![vec!["ttl", "1e3"]],
            vec![vec!["ttl", "2147483648"]],
            vec![vec!["ttl", "18446744073709551616"]],
            vec![vec!["ttl", "86400"], vec!["visibility", "open"]],
            vec![vec!["visibility", "private"], vec!["visibility", "open"]],
            vec![vec!["ttl", "1"], vec!["ttl", ""]],
            vec![vec!["visibility", "open"], vec!["ttl", "0"]],
            vec![
                vec!["visibility", "open"],
                vec!["ttl", "1"],
                vec!["ttl", ""],
            ],
        ] {
            let event = details_event(
                extra
                    .iter()
                    .map(|tag| tag.iter().map(|s| (*s).into()).collect())
                    .collect(),
            );
            assert!(!valid("channel-details", &event), "{extra:?}");
        }
    }

    #[test]
    fn creation_lifetime_is_canonical_and_follows_the_description() {
        let host = IdentityHost::fixture();
        let base = EventTemplate {
            kind: 9007,
            created_at: 12,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::nil().to_string()],
                vec!["name".into(), "Work".into()],
                vec!["visibility".into(), "private".into()],
                vec!["channel_type".into(), "stream".into()],
                vec!["about".into(), "Notes".into()],
            ],
        };
        for ttl in ["1", "600", "2147483647"] {
            let mut event = template(&serde_json::to_value(&base).unwrap()).unwrap();
            event.tags.push(vec!["ttl".into(), ttl.into()]);
            assert!(creation(&event));
            let signed = tauri::async_runtime::block_on(
                host.sign(template(&serde_json::to_value(&event).unwrap()).unwrap()),
            )
            .unwrap();
            super::super::verify_signature(&signed).unwrap();
            assert!(creation(&super::template(&signed).unwrap()));
            event.tags.swap(4, 5);
            assert!(!creation(&event));
        }
        for ttl in [
            "",
            "0",
            "01",
            "+1",
            "-1",
            " 1",
            "1\n",
            "1.5",
            "1e3",
            "2147483648",
        ] {
            let mut invalid = template(&serde_json::to_value(&base).unwrap()).unwrap();
            invalid.tags.push(vec!["ttl".into(), ttl.into()]);
            assert!(!creation(&invalid), "{ttl:?}");
            let signed = tauri::async_runtime::block_on(host.sign(invalid)).unwrap();
            assert!(!creation(&super::template(&signed).unwrap()));
        }
        for extra in [
            vec![vec!["ttl", "1"], vec!["ttl", "2"]],
            vec![vec!["ttl", "1", "extra"]],
            vec![vec!["unknown", "1"]],
        ] {
            let mut invalid = template(&serde_json::to_value(&base).unwrap()).unwrap();
            invalid.tags.extend(
                extra
                    .iter()
                    .map(|tag| tag.iter().map(|v| (*v).to_string()).collect::<Vec<_>>()),
            );
            assert!(!creation(&invalid));
        }
    }
    #[test]
    fn creation_requires_the_exact_stream_command() {
        let mut event = EventTemplate {
            kind: 9007,
            created_at: 1700000010,
            content: String::new(),
            tags: vec![
                vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                vec!["name".into(), "Team".into()],
                vec!["visibility".into(), "private".into()],
                vec!["channel_type".into(), "stream".into()],
            ],
        };
        assert!(creation(&event));
        for malformed in [
            vec![],
            vec!["h".into()],
            vec!["h".into(), "x".into(), "extra".into()],
        ] {
            event.tags[0] = malformed;
            assert!(!creation(&event));
        }
        event.tags[0] = vec!["h".into(), uuid::Uuid::new_v4().to_string()];
        event.tags.swap(0, 1);
        assert!(!creation(&event));
        event.tags.swap(0, 1);
        event.tags[1] = event.tags[0].clone();
        assert!(!creation(&event));
        event.tags[1] = vec!["name".into(), "Team".into()];
        event.tags.push(vec!["p".into(), "attacker".into()]);
        assert!(!creation(&event));
        event.tags.pop();
        let member = |n: usize| vec!["p".to_string(), format!("{n:064x}")];
        event.tags.extend((1..=32).map(member));
        assert!(creation(&event));
        event.tags.push(member(33));
        assert!(!creation(&event));
        event.tags.truncate(4);
        event.tags.extend([member(1), member(1)]);
        assert!(!creation(&event));
        event.tags.truncate(4);
        event.tags.push(vec!["p".into(), "A".repeat(64)]);
        assert!(!creation(&event));
        event.tags.truncate(4);
        event
            .tags
            .extend([member(1), vec!["t".into(), "buzz.solo".into()]]);
        assert!(!creation(&event));
        event.tags.truncate(4);
        event.tags[3][1] = "system".into();
        assert!(creation(&event));
        for other in ["dm", "forum", "session", "System", ""] {
            event.tags[3][1] = other.into();
            assert!(!creation(&event), "{other:?}");
        }
    }

    #[test]
    fn creation_and_details_admit_only_valid_label_tails() {
        let t = |label: &str| vec!["t".to_string(), label.to_string()];
        let create = |labels: Vec<Vec<String>>| EventTemplate {
            kind: 9007,
            created_at: 1700000010,
            content: String::new(),
            tags: [
                vec![
                    vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                    vec!["name".into(), "Records".into()],
                    vec!["visibility".into(), "private".into()],
                    vec!["channel_type".into(), "stream".into()],
                    vec!["about".into(), "For You records".into()],
                    vec!["ttl".into(), "60".into()],
                ],
                labels,
                vec![vec!["client-id".into(), uuid::Uuid::new_v4().to_string()]],
            ]
            .concat(),
        };
        let edit = |labels: Vec<Vec<String>>| EventTemplate {
            kind: 9002,
            created_at: 1700000010,
            content: String::new(),
            tags: [
                vec![
                    vec!["h".into(), uuid::Uuid::new_v4().to_string()],
                    vec!["name".into(), "Records".into()],
                    vec!["about".into(), String::new()],
                    vec!["visibility".into(), "open".into()],
                ],
                labels,
            ]
            .concat(),
        };
        let eight: Vec<_> = (0..8).map(|n| t(&format!("l{n}"))).collect();
        let nine: Vec<_> = (0..9).map(|n| t(&format!("l{n}"))).collect();
        for labels in [vec![], vec![t("for-you"), t("app:records")], eight.clone()] {
            assert!(creation(&create(labels.clone())));
            assert!(details(&edit(labels)));
        }
        // An empty `t` clears labels on an edit; a creation has nothing to clear.
        assert!(details(&edit(vec![t("")])));
        assert!(!creation(&create(vec![t("")])));
        for labels in [
            vec![t("system")],
            vec![t("Upper")],
            vec![t(&"x".repeat(65))],
            vec![t("a"), t("a")],
            vec![t(""), t("a")],
            vec![vec!["t".into(), "a".into(), "extra".into()]],
            nine,
        ] {
            assert!(!creation(&create(labels.clone())));
            assert!(!details(&edit(labels)));
        }
        let mut late = edit(vec![t("a")]);
        late.tags.push(vec!["ttl".into(), String::new()]);
        assert!(!details(&late));
    }
}

/// NIP-CL label: 1–64 of `[a-z0-9.:-]`, never a channel type name.
pub(super) fn channel_label(label: &str) -> bool {
    (1..=64).contains(&label.len())
        && label
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b':' | b'-'))
        && !matches!(label, "stream" | "forum" | "dm" | "workflow" | "system")
}

#[cfg(test)]
mod member_administration_tests {
    use super::*;
    use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};

    #[test]
    fn member_commands_match_js_and_sign_through_production_ipc_and_acl() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../src/features/channel-members/administration-contract.json"
        ))
        .unwrap();
        let app = mock_builder()
            .manage(IdentityHost::fixture())
            .manage(FederatedIdentity::new().unwrap())
            .invoke_handler(crate::commands())
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let invoke = |command: &str, event: Value| {
            get_ipc_response(
                &view,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: view.url().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                        "community": "https://relay.test", "route": "member-administration", "event": event
                    })),
                    headers: Default::default(),
                    invoke_key: INVOKE_KEY.into(),
                },
            )
        };
        for case in cases["accepted"].as_array().unwrap() {
            let template = case["event"].clone();
            let event: Value = invoke("relay_channel_sign", template.clone())
                .unwrap()
                .deserialize()
                .unwrap();
            super::super::verify_signature(&event).unwrap();
            assert_eq!(event["tags"], template["tags"]);
            assert_eq!(event["kind"], template["kind"]);
            assert_eq!(event["created_at"], template["created_at"]);
            assert_eq!(event["content"], template["content"]);
            let viewer = event["pubkey"].as_str().unwrap();
            assert!(validate("member-administration", &event, Some(viewer)).is_ok());
            for route in ["channel-details", "channel-lifecycle", "identity-archive"] {
                assert!(validate(route, &event, Some(viewer)).is_err());
            }
            assert!(validate("member-administration", &event, Some(&"f".repeat(64))).is_err());
            let mut tampered = event.clone();
            tampered["tags"][1][1] = Value::String("d".repeat(64));
            assert!(validate("member-administration", &tampered, Some(viewer)).is_err());
            // Publish reaches the registered handler/ACL and rejects before networking.
            let error = invoke("relay_channel_publish", tampered).unwrap_err();
            assert!(error.to_string().contains("signature"), "{error}");
            let mut self_target = template;
            self_target["tags"][1][1] = Value::String(viewer.into());
            let error = invoke("relay_channel_sign", self_target).unwrap_err();
            assert!(
                error.to_string().contains("Invalid member administration"),
                "{error}"
            );
        }
        for case in cases["rejected"].as_array().unwrap() {
            let event = case["event"].clone();
            assert!(
                validate("member-administration", &event, None).is_err(),
                "{}",
                case["name"]
            );
            let error = invoke("relay_channel_sign", event).unwrap_err();
            assert!(!error.to_string().contains("not allowed"), "{error}");
        }
    }
}
