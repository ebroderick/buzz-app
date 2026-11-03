//! One create-only human identity. Never consult legacy, agent, file or environment keys.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use bech32::{primitives::decode::CheckedHrpstring, Bech32, Hrp};
use buzz_credential_store as credentials;
use nostr::{
    event::Event,
    key::{Keys, SecretKey as NostrSecretKey},
    nips::nip44,
};
use secp256k1::{Keypair, PublicKey, Secp256k1, SecretKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, OnceLock};
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, String>;
const INVALID: &str = "Enter a valid nsec private key";
const MALFORMED: &str = "Saved identity is malformed; nothing was changed. Keep your key backup and contact support before changing secure storage.";

// Batch-local conversation keys avoid repeating ECDH for every self-encrypted slot.
// Callers enforce their encoded-payload budget before reaching this helper.
fn decrypt_with_conversation(
    conversation: &nip44::v2::ConversationKey,
    content: &str,
) -> Result<String> {
    let payload = STANDARD
        .decode(content)
        .map_err(|_| "Invalid encrypted record")?;
    // The low-level v2 decoder does not validate the version byte itself.
    if payload.first() != Some(&2) {
        return Err("Invalid encrypted record".into());
    }
    let bytes = nip44::v2::decrypt_to_bytes(conversation, &payload)
        .map_err(|_| "Invalid encrypted record")?;
    String::from_utf8(bytes).map_err(|_| "Invalid encrypted record".into())
}

// No Debug/Serialize: only deliberate export may return the secret to the main UI.
/// The secret, and its public key derived once: socket frames and HTTP
/// requests read it.
struct Key(Zeroizing<[u8; 32]>, OnceLock<String>);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EventTemplate {
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
}

impl Key {
    fn sign(&self, event: EventTemplate) -> Result<serde_json::Value> {
        self.sign_bounded(event, 64 * 1024)
    }

    fn sign_bounded(
        &self,
        event: EventTemplate,
        max_event_bytes: usize,
    ) -> Result<serde_json::Value> {
        let pubkey = self.viewer()?;
        let serialized = serde_json::to_vec(&serde_json::json!([
            0,
            pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]))
        .map_err(|_| "Could not encode relay event")?;
        if serialized.len() > max_event_bytes {
            return Err("Relay event is too large".into());
        }
        let hash = Sha256::digest(serialized);
        let signature = self.schnorr(&hash).ok_or("Could not sign relay event")?;
        Ok(serde_json::json!({
            "id": format!("{hash:x}"), "pubkey": pubkey,
            "created_at": event.created_at, "kind": event.kind,
            "tags": event.tags, "content": event.content, "sig": signature
        }))
    }
    /// Unconditional NIP-OA owner attestation for exactly this agent key.
    fn authorize(&self, agent: &str) -> Result<Vec<String>> {
        let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
        let signature = self
            .schnorr(&digest)
            .ok_or("Could not authorize the agent")?;
        Ok(vec![
            "auth".into(),
            self.viewer()?,
            String::new(),
            signature,
        ])
    }
    fn schnorr(&self, digest: &[u8]) -> Option<String> {
        let secp = Secp256k1::signing_only();
        let mut secret = SecretKey::from_byte_array(*self.0).ok()?;
        let mut pair = Keypair::from_secret_key(&secp, &secret);
        secret.non_secure_erase();
        let mut random = Zeroizing::new([0; 32]);
        if getrandom::fill(random.as_mut()).is_err() {
            pair.non_secure_erase();
            return None;
        }
        let signature = secp.sign_schnorr_with_aux_rand(digest, &pair, &random);
        pair.non_secure_erase();
        Some(signature.to_string())
    }
    fn parse(text: &str) -> Result<Self> {
        let text = text.trim();
        if text.len() != 63 || !(text.starts_with("nsec1") || text.starts_with("NSEC1")) {
            return Err(INVALID.into());
        }
        let checked = CheckedHrpstring::new::<Bech32>(text).map_err(|_| INVALID)?;
        let mut bytes = Zeroizing::new([0; 32]);
        let mut values = checked.byte_iter();
        for byte in bytes.iter_mut() {
            *byte = values.next().ok_or(INVALID)?;
        }
        if values.next().is_some() {
            return Err(INVALID.into());
        }
        let key = Self::new(bytes);
        key.viewer()?;
        Ok(key)
    }
    fn generate() -> Result<Self> {
        loop {
            let mut bytes = Zeroizing::new([0; 32]);
            getrandom::fill(bytes.as_mut()).map_err(|_| "Could not create an identity")?;
            let key = Self::new(bytes);
            if key.viewer().is_ok() {
                return Ok(key);
            }
        }
    }
    fn new(secret: Zeroizing<[u8; 32]>) -> Self {
        Self(secret, OnceLock::new())
    }
    fn viewer(&self) -> Result<String> {
        if let Some(public) = self.1.get() {
            return Ok(public.clone());
        }
        let mut key = SecretKey::from_byte_array(*self.0).map_err(|_| INVALID)?;
        let public = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
            .x_only_public_key()
            .0
            .to_string();
        key.non_secure_erase();
        Ok(self.1.get_or_init(|| public).clone())
    }
    fn nsec(&self) -> Result<String> {
        bech32::encode::<Bech32>(Hrp::parse("nsec").map_err(|_| INVALID)?, self.0.as_ref())
            .map_err(|_| "Could not encode your private key".into())
    }
}

trait Store: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn add(&self, value: &[u8]) -> Result<()>;
    /// The key installed old Buzz saved, read-only, after the person asks for it.
    fn legacy(&self) -> Result<Zeroizing<String>>;
    /// Only Sign out may call this, from the next launch; an absent item is success.
    fn delete(&self) -> Result<()>;
    /// The key saved under its service from before 1.0, which reads copy.
    fn previous(&self) -> Result<Option<Zeroizing<Vec<u8>>>>;
    /// Sign out removes the key under both services; an absent item is success.
    fn delete_previous(&self) -> Result<()>;
}
struct OsStore;
#[cfg(not(test))]
fn read_saved(
    read: fn() -> std::result::Result<Zeroizing<Vec<u8>>, credentials::Error>,
) -> Result<Option<Zeroizing<Vec<u8>>>> {
    match read() {
        Ok(value) => Ok(Some(value)),
        Err(credentials::Error::Absent) => Ok(None),
        Err(credentials::Error::Denied) => Err("Secure storage access was denied. Allow access and retry; no identity was created.".into()),
        Err(credentials::Error::Busy) => Err("Another Buzz app is accessing secure storage. Retry shortly.".into()),
        Err(credentials::Error::Corrupt) => Err(MALFORMED.into()),
        Err(_) => Err("Your identity could not be accessed in secure storage. Unlock your credential store and retry without changing keys.".into()),
    }
}
#[cfg(not(test))]
fn read_legacy() -> Result<Zeroizing<String>> {
    buzz_agent_controller::PlatformCredentials::default()
        .read_legacy_human(buzz_agent_controller::LegacySource::Installed)
}
#[cfg(all(target_os = "macos", not(test)))]
mod platform {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;
    fn error(error: security_framework::base::Error) -> String {
        match error.code() {
            -25299 => {
                "An identity is already saved; nothing was overwritten. Restart to restore it."
            }
            -128 | -25293 | -25308 => {
                "Keychain access was denied. Allow access and retry; no identity was created."
            }
            _ => "Your identity could not be accessed in Keychain. Retry without changing keys.",
        }
        .into()
    }
    impl Store for OsStore {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            read_saved(credentials::read_human)
        }
        fn previous(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            read_saved(credentials::read_previous_human)
        }
        fn legacy(&self) -> Result<Zeroizing<String>> {
            read_legacy()
        }
        fn add(&self, value: &[u8]) -> Result<()> {
            SecKeychain::default()
                .map_err(error)?
                .add_generic_password(
                    credentials::HUMAN_SERVICE,
                    credentials::HUMAN_ACCOUNT,
                    value,
                )
                .map_err(error)
        }
        fn delete(&self) -> Result<()> {
            delete(credentials::HUMAN_SERVICE)
        }
        fn delete_previous(&self) -> Result<()> {
            delete(credentials::PREVIOUS_HUMAN_SERVICE)
        }
    }
    // Under the lock reads copy under, confirmed gone.
    fn delete(service: &str) -> Result<()> {
        match credentials::delete(service, credentials::HUMAN_ACCOUNT) {
            Ok(()) | Err(credentials::Error::Absent) => Ok(()),
            Err(credentials::Error::Busy) => {
                Err("Another Buzz app is accessing secure storage. Retry shortly.".into())
            }
            Err(credentials::Error::Denied) => Err(
                "Keychain access was denied. Allow access and open Buzz again to finish signing out."
                    .into(),
            ),
            Err(_) => Err(
                "Your identity could not be accessed in Keychain. Retry without changing keys."
                    .into(),
            ),
        }
    }
}
#[cfg(all(any(target_os = "windows", target_os = "linux"), not(test)))]
mod keyring_platform {
    use super::*;
    use buzz_credential_store::Error;
    fn error(error: Error) -> String {
        match error {
            Error::Occupied => "An identity is already saved; nothing was overwritten. Restart to restore it.",
            Error::Denied => "Secure storage access was denied. Allow access and retry; no identity was created.",
            Error::Busy => "Another Buzz app is accessing secure storage. Retry shortly.",
            Error::Corrupt => MALFORMED,
            _ => "Your identity could not be accessed in secure storage. Unlock your credential store and retry without changing keys.",
        }.into()
    }
    impl Store for OsStore {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            read_saved(credentials::read_human)
        }
        fn previous(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            read_saved(credentials::read_previous_human)
        }
        fn legacy(&self) -> Result<Zeroizing<String>> {
            read_legacy()
        }
        fn add(&self, value: &[u8]) -> Result<()> {
            credentials::add(
                credentials::HUMAN_SERVICE,
                credentials::HUMAN_ACCOUNT,
                value,
            )
            .map_err(error)
        }
        fn delete(&self) -> Result<()> {
            delete(credentials::HUMAN_SERVICE)
        }
        fn delete_previous(&self) -> Result<()> {
            delete(credentials::PREVIOUS_HUMAN_SERVICE)
        }
    }
    fn delete(service: &str) -> Result<()> {
        match credentials::delete(service, credentials::HUMAN_ACCOUNT) {
            Ok(()) | Err(Error::Absent) => Ok(()),
            Err(e) => Err(error(e)),
        }
    }
}
// Native tests cannot touch an OS credential store, even via the default host.
#[cfg(any(
    not(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    test
))]
impl Store for OsStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn add(&self, _: &[u8]) -> Result<()> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn legacy(&self) -> Result<Zeroizing<String>> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn delete(&self) -> Result<()> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn previous(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
    fn delete_previous(&self) -> Result<()> {
        Err("Secure identity storage is not available on this platform yet".into())
    }
}

/// Delete the saved human key under both services and confirm fresh reads find
/// nothing. The previous item goes first: reads copy it while the current one is absent.
fn remove_key(store: &dyn Store) -> Result<()> {
    store.delete_previous()?;
    store.delete()?;
    match (store.read()?, store.previous()?) {
        (None, None) => Ok(()),
        _ => Err("Your key is still saved in secure storage".into()),
    }
}
/// Sign out's next-launch step; never reachable from the webview.
pub(crate) fn remove_saved_key() -> Result<()> {
    remove_key(&OsStore)
}
/// Delete only the current key, after an older build signed out of the previous one.
pub(crate) fn remove_current_key() -> Result<()> {
    OsStore.delete()
}

#[derive(Default)]
enum State {
    #[default]
    Unread,
    Missing,
    Ready(Key),
    /// Signing out: the key is dropped and nothing reads, saves or uses one
    /// again until Buzz restarts.
    Closed,
}
struct Identity {
    state: State,
    store: Box<dyn Store>,
}
impl Identity {
    fn restore(&mut self) -> Result<Option<String>> {
        if matches!(self.state, State::Closed) {
            return Err("Buzz is signing out".into());
        }
        if matches!(self.state, State::Unread) {
            self.state = match self.store.read()? {
                None => State::Missing,
                Some(bytes) => {
                    let text = std::str::from_utf8(&bytes).map_err(|_| MALFORMED)?;
                    State::Ready(Key::parse(text).map_err(|_| MALFORMED)?)
                }
            };
        }
        match &self.state {
            State::Ready(key) => key.viewer().map(Some),
            _ => Ok(None),
        }
    }
    fn save(&mut self, supplied: Option<&str>) -> Result<String> {
        if self.restore()?.is_some() {
            return Err("An identity is already saved; nothing was overwritten".into());
        }
        // Errors, denied reads and malformed stored keys never trigger generation.
        let key = match supplied {
            Some(text) => Key::parse(text)?,
            None => Key::generate()?,
        };
        let viewer = key.viewer()?;
        let nsec = Zeroizing::new(key.nsec()?);
        self.store.add(nsec.as_bytes())?;
        self.state = State::Ready(key); // Commit in memory only after secure persistence.
        Ok(viewer)
    }
    /// Adopts the key installed old Buzz saved, exactly as a pasted import would.
    fn import_legacy(&mut self) -> Result<String> {
        if self.restore()?.is_some() {
            return Err("An identity is already saved; nothing was overwritten".into());
        }
        let nsec = self.store.legacy()?;
        let nsec = nsec.trim();
        if Key::parse(nsec).is_err() {
            return Err("The earlier Buzz app's identity is malformed; nothing was changed".into());
        }
        self.save(Some(nsec))
    }
    fn require_missing(&mut self) -> Result<()> {
        if self.restore()?.is_some() || self.store.read()?.is_some() {
            return Err("An identity is already saved; nothing was overwritten".into());
        }
        Ok(())
    }
    fn install_recovered(&mut self, secret: Zeroizing<[u8; 32]>, expected: &str) -> Result<String> {
        self.require_missing()?;
        let key = Key::new(secret);
        let viewer = key.viewer()?;
        if viewer != expected {
            return Err("The recovered identity could not be verified".into());
        }
        let nsec = Zeroizing::new(key.nsec()?);
        self.store.add(nsec.as_bytes())?;
        self.state = State::Ready(key);
        Ok(viewer)
    }
    fn close(&mut self) {
        self.state = State::Closed;
    }
    fn export(&mut self) -> Result<String> {
        self.restore()?;
        match &self.state {
            State::Ready(key) => key.nsec(),
            _ => Err("Set up your identity first".into()),
        }
    }
}

// Reject renderer-supplied arbitrary ciphertext/plaintext at the purpose-bound signer.
fn validate_sidebar_payload(coordinate: &str, value: &serde_json::Value) -> Result<()> {
    let invalid = || "Invalid sidebar payload".to_owned();
    let data = value.as_object().ok_or_else(invalid)?;
    if data.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err(invalid());
    }
    let text = |v: &serde_json::Value, max: usize| {
        v.as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
    };
    match coordinate {
        "channel-sections" => {
            let sections = data
                .get("sections")
                .and_then(|v| v.as_array())
                .ok_or_else(invalid)?;
            let assignments = data
                .get("assignments")
                .and_then(|v| v.as_object())
                .ok_or_else(invalid)?;
            if sections.len() > 100 || assignments.len() > 1000 {
                return Err(invalid());
            }
            let mut ids = std::collections::HashSet::new();
            for section in sections {
                let entry = section.as_object().ok_or_else(invalid)?;
                let id = entry.get("id").ok_or_else(invalid)?;
                if !text(id, 256)
                    || !ids.insert(id.as_str().unwrap())
                    || !entry.get("name").is_some_and(|v| text(v, 256))
                    || !entry
                        .get("order")
                        .and_then(|v| v.as_f64())
                        .is_some_and(f64::is_finite)
                    || entry.get("icon").is_some_and(|v| !text(v, 128))
                {
                    return Err(invalid());
                }
            }
            if assignments.iter().any(|(id, section)| {
                id.trim().is_empty()
                    || id.encode_utf16().count() > 256
                    || !section
                        .as_str()
                        .is_some_and(|v| !v.trim().is_empty() && v.encode_utf16().count() <= 256)
            }) {
                return Err(invalid());
            }
        }
        "channel-stars" | "channel-mutes" => {
            let channels = data
                .get("channels")
                .and_then(|v| v.as_object())
                .ok_or_else(invalid)?;
            if channels.len() > 500 {
                return Err(invalid());
            }
            let field = if coordinate == "channel-stars" {
                "starred"
            } else {
                "muted"
            };
            for (id, entry) in channels {
                let entry = entry.as_object().ok_or_else(invalid)?;
                if id.trim().is_empty()
                    || id.encode_utf16().count() > 256
                    || !entry.get(field).is_some_and(|v| v.is_boolean())
                    || !entry
                        .get("updatedAt")
                        .and_then(|v| v.as_f64())
                        .is_some_and(|v| v.is_finite() && v >= 0.0)
                {
                    return Err(invalid());
                }
            }
        }
        "channel-sort" | "channel-filter" => {
            let groups = data
                .get("groups")
                .and_then(|v| v.as_object())
                .ok_or_else(invalid)?;
            if coordinate == "channel-filter" {
                if let Some(windows) = data.get("activeWindowSeconds") {
                    let windows = windows.as_object().ok_or_else(invalid)?;
                    if windows.len() > 104
                        || windows.iter().any(|(group, value)| {
                            group.trim().is_empty()
                                || group.encode_utf16().count() > 264
                                || !value.as_u64().is_some_and(|seconds| {
                                    (86400..=31536000).contains(&seconds) && seconds % 86400 == 0
                                })
                        })
                    {
                        return Err(invalid());
                    }
                }
            }
            if groups.len() > 104
                || groups.iter().any(|(group, mode)| {
                    group.encode_utf16().count() > 264
                        || !mode.is_string()
                        || (coordinate == "channel-filter"
                            && !matches!(mode.as_str(), Some("all" | "unreads" | "active")))
                })
            {
                return Err(invalid());
            }
        }

        "main-agent" => {
            let agent = data.get("agent").ok_or_else(invalid)?;
            if data.len() != 2
                || !(agent.is_null()
                    || agent.as_str().is_some_and(|v| {
                        v.len() == 64
                            && v.bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    }))
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    if let Some(meta) = data.get("meta") {
        if matches!(
            coordinate,
            "channel-sections" | "channel-sort" | "channel-filter"
        ) {
            validate_sidebar_meta(coordinate, meta, false)?;
            let projection = project_sidebar_meta(coordinate, meta);
            let projected = projection.as_object().ok_or_else(invalid)?;
            if projected
                .iter()
                .any(|(key, value)| data.get(key) != Some(value))
            {
                return Err("Sidebar projection disagrees with metadata".into());
            }
        }
    }
    if coordinate == "channel-sort" {
        if let Some(choices) = data.get("pluginSort") {
            if !choices
                .get("g")
                .and_then(|v| v.as_object())
                .is_some_and(|g| g.len() <= 104)
            {
                return Err(invalid());
            }
            validate_sidebar_meta(coordinate, choices, true)?;
        }
    }
    Ok(())
}

// The signer admits only the bounded Desktop register schema, not arbitrary
// renderer-controlled trees. Retained tombstones share the plaintext byte budget.
fn validate_sidebar_meta(
    coordinate: &str,
    value: &serde_json::Value,
    plugin_sort: bool,
) -> Result<()> {
    use serde_json::Value;
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    fn text(value: &Value, max: usize) -> bool {
        value
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= max)
    }
    fn reg(value: &Value, valid: impl Fn(&Value) -> bool) -> bool {
        value.as_array().is_some_and(|r| {
            r.len() == 3
                && r[0].as_u64().is_some_and(|v| v <= MAX_SAFE)
                && r[1].as_str().is_some_and(|s| {
                    s.len() == 16
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                && valid(&r[2])
        })
    }
    fn map(value: Option<&Value>, max: usize, valid: impl Fn(&Value) -> bool) -> bool {
        value.is_none_or(|value| {
            value.as_object().is_some_and(|entries| {
                entries.iter().all(|(key, value)| {
                    key != "__proto__"
                        && !key.trim().is_empty()
                        && key.encode_utf16().count() <= max
                        && valid(value)
                })
            })
        })
    }
    let invalid = || "Invalid sidebar metadata".to_owned();
    let meta = value.as_object().ok_or_else(invalid)?;
    let allowed: &[&str] = if coordinate == "channel-sections" {
        &["v", "s", "a"]
    } else {
        &["v", "g"]
    };
    if meta.get("v").and_then(Value::as_u64) != Some(1)
        || meta.keys().any(|key| !allowed.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    let valid = if matches!(coordinate, "channel-sort" | "channel-filter") {
        map(meta.get("g"), 264, |v| {
            reg(v, |v| {
                if plugin_sort {
                    v.as_str().is_some_and(valid_plugin_sidebar_sort_mode)
                } else {
                    v.is_null()
                        || if coordinate == "channel-filter" {
                            matches!(v.as_str(), Some("unreads" | "active"))
                        } else {
                            matches!(v.as_str(), Some("alpha" | "recent"))
                        }
                }
            })
        })
    } else {
        map(meta.get("a"), 256, |v| {
            reg(v, |v| v.is_null() || text(v, 256))
        }) && map(meta.get("s"), 256, |v| {
            v.as_object().is_some_and(|fields| {
                fields.iter().all(|(field, value)| {
                    reg(value, |v| match field.as_str() {
                        "name" => text(v, 256),
                        "icon" => v.is_null() || text(v, 128),
                        "live" => v.is_boolean(),
                        "order" => v.as_i64().is_some_and(|n| n.unsigned_abs() <= MAX_SAFE),
                        _ => false,
                    })
                })
            })
        })
    };
    if !valid {
        return Err(invalid());
    }
    Ok(())
}

fn valid_plugin_sidebar_sort_mode(value: &str) -> bool {
    let Some(value) = value.strip_prefix("plugin:").filter(|_| value.len() <= 512) else {
        return false;
    };
    let parts: Vec<_> = value.split('/').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            part.as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        })
}

// Called only after shape validation. Requiring these exact fields also binds
// metadata's live counts to the existing projection limits above.
fn project_sidebar_meta(coordinate: &str, meta: &serde_json::Value) -> serde_json::Value {
    use serde_json::{json, Value};
    if matches!(coordinate, "channel-sort" | "channel-filter") {
        let groups: serde_json::Map<_, _> = meta["g"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, reg)| !reg[2].is_null())
            .map(|(key, reg)| (key.clone(), reg[2].clone()))
            .collect();
        return json!({"groups": groups});
    }
    let mut sections: Vec<_> = meta["s"].as_object().into_iter().flatten()
        .filter(|(_, node)| node["live"][2] == true && node["name"][2].is_string())
        .map(|(id, node)| {
            let mut section = json!({"id": id, "name": node["name"][2], "order": node["order"][2].as_i64().unwrap_or(0)});
            if node["icon"][2].is_string() { section["icon"] = node["icon"][2].clone(); }
            section
        }).collect();
    sections.sort_by(|a, b| {
        a["order"].as_i64().cmp(&b["order"].as_i64()).then_with(|| {
            a["id"]
                .as_str()
                .unwrap_or("")
                .encode_utf16()
                .cmp(b["id"].as_str().unwrap_or("").encode_utf16())
        })
    });
    for (order, section) in sections.iter_mut().enumerate() {
        section["order"] = json!(order);
    }
    let ids: std::collections::HashSet<_> =
        sections.iter().filter_map(|s| s["id"].as_str()).collect();
    let assignments: serde_json::Map<_, _> = meta["a"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, reg)| reg[2].as_str().is_some_and(|id| ids.contains(id)))
        .map(|(key, reg)| (key.clone(), reg[2].clone()))
        .collect();
    let result: Value = json!({"sections": sections, "assignments": assignments});
    result
}

pub(crate) fn sidebar_coordinate(value: &str) -> bool {
    matches!(
        value,
        "channel-sections"
            | "channel-stars"
            | "channel-mutes"
            | "channel-sort"
            | "channel-filter"
            | "main-agent"
    )
}

fn valid_read_coordinate(value: &str) -> bool {
    value.strip_prefix("read-state:").is_some_and(|slot| {
        slot.len() == 32
            && slot
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn validate_read_blob(blob: &serde_json::Value) -> Result<()> {
    let contexts = blob["contexts"]
        .as_object()
        .ok_or("Unsupported read-state blob")?;
    let client = blob["client_id"]
        .as_str()
        .ok_or("Unsupported read-state blob")?;
    if blob["v"] != 1
        || client.is_empty()
        || client.chars().count() > 64
        || contexts.len() > 10_000
        || serde_json::to_vec(blob)
            .map_err(|_| "Unsupported read-state blob")?
            .len()
            > 128 * 1024
    {
        return Err("Unsupported read-state blob".into());
    }
    Ok(())
}

#[derive(Clone)]
pub struct IdentityHost(Arc<Mutex<Identity>>);
impl IdentityHost {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::fixture_in(State::Ready(Key::new(Zeroizing::new([1; 32]))))
    }
    /// No saved key, or a key that cannot be read (a signing-out host refuses every read).
    #[cfg(test)]
    pub(crate) fn fixture_without_key(readable: bool) -> Self {
        Self::fixture_in(if readable {
            State::Missing
        } else {
            State::Closed
        })
    }
    #[cfg(test)]
    fn fixture_in(state: State) -> Self {
        Self(Arc::new(Mutex::new(Identity {
            state,
            store: Box::new(OsStore),
        })))
    }

    /// The saved key's public key, or `None` when secure storage confirms none.
    pub(crate) async fn saved_viewer(&self) -> Result<Option<String>> {
        with_identity(self.clone(), Identity::restore).await
    }
    pub(crate) async fn viewer(&self) -> Result<String> {
        self.saved_viewer()
            .await?
            .ok_or_else(|| "Set up your identity first".into())
    }

    pub(crate) async fn require_missing(&self) -> Result<()> {
        with_identity(self.clone(), |identity| identity.require_missing()).await
    }

    pub(crate) async fn install_recovered(
        &self,
        secret: Zeroizing<[u8; 32]>,
        expected: String,
        admission: Arc<Mutex<bool>>,
    ) -> Result<String> {
        with_identity(self.clone(), move |identity| {
            // Keep cancellation serialized with the final create-only storage write.
            let admitted = admission.lock().map_err(|_| "Restore is unavailable")?;
            if !*admitted {
                return Err("Restore was canceled. Try again.".into());
            }
            identity.install_recovered(secret, &expected)
        })
        .await
    }

    /// Only verified, self-authored sidebar coordinates may cross the decrypt boundary.
    pub(crate) async fn decode_sidebar(
        &self,
        events: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            let State::Ready(key) = &identity.state else {
                return Err("Set up your identity first".into());
            };
            if events.len() > 5
                || serde_json::to_vec(&events)
                    .map_err(|_| "Invalid sidebar records")?
                    .len()
                    > 960 * 1024
            {
                return Err("Invalid sidebar records".into());
            }
            let secret = NostrSecretKey::from_slice(key.0.as_ref())
                .map_err(|_| "Invalid sidebar records")?;
            let public = Keys::new(secret.clone()).public_key();
            let conversation = nip44::v2::ConversationKey::derive(&secret, &public)
                .map_err(|_| "Invalid sidebar record")?;
            let mut decoded = serde_json::Map::new();
            for raw in events {
                let tags = raw["tags"].as_array().ok_or("Invalid sidebar record")?;
                let coordinates: Vec<_> = tags.iter().filter(|tag| tag[0] == "d").collect();
                let coordinate = coordinates
                    .first()
                    .and_then(|tag| tag[1].as_str())
                    .ok_or("Invalid sidebar record")?
                    .to_owned();
                let count = coordinates.len();
                let event: Event =
                    serde_json::from_value(raw).map_err(|_| "Invalid sidebar record")?;
                event.verify().map_err(|_| "Invalid sidebar record")?;
                if event.kind.as_u16() != 30078
                    || event.pubkey != public
                    || count != 1
                    || !sidebar_coordinate(&coordinate)
                    || decoded.contains_key(&coordinate)
                {
                    return Err("Invalid sidebar record".into());
                }
                let plaintext = decrypt_with_conversation(&conversation, &event.content)
                    .map_err(|_| "Invalid sidebar record")?;
                if plaintext.len() > 128 * 1024 {
                    return Err("Sidebar plaintext budget exceeded".into());
                }
                decoded.insert(
                    coordinate,
                    serde_json::from_str(&plaintext).map_err(|_| "Invalid sidebar record")?,
                );
            }
            Ok(serde_json::Value::Object(decoded))
        })
        .await
    }

    /// Admit for publication only a record shaped exactly like `sign_sidebar` output.
    pub(crate) async fn admit_sidebar(&self, event: serde_json::Value) -> Result<()> {
        let tags = event["tags"].clone();
        let decoded = self.decode_sidebar(vec![event]).await?;
        let (coordinate, payload) = decoded
            .as_object()
            .and_then(|records| records.iter().next())
            .ok_or("Invalid sidebar record")?;
        if tags != serde_json::json!([["d", coordinate], ["t", coordinate]]) {
            return Err("Invalid sidebar record".into());
        }
        validate_sidebar_payload(coordinate, payload)
    }

    /// Sign only self-encrypted kind-30078 sidebar data; never expose a general NIP-44 primitive.
    pub(crate) async fn sign_sidebar(
        &self,
        coordinate: String,
        payload: serde_json::Value,
        created_at: u64,
    ) -> Result<serde_json::Value> {
        if !sidebar_coordinate(&coordinate) {
            return Err("Invalid sidebar coordinate".into());
        }
        validate_sidebar_payload(&coordinate, &payload)?;
        let plaintext = serde_json::to_string(&payload).map_err(|_| "Invalid sidebar payload")?;
        // Match the broker's bounded extended-length NIP-44 records.
        if plaintext.len() > 128 * 1024 {
            return Err("Sidebar plaintext budget exceeded".into());
        }
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            let State::Ready(key) = &identity.state else {
                return Err("Set up your identity first".into());
            };
            let secret = NostrSecretKey::from_slice(key.0.as_ref())
                .map_err(|_| "Invalid sidebar payload")?;
            let public = Keys::new(secret.clone()).public_key();
            let content = nip44::encrypt(&secret, &public, &plaintext, nip44::Version::V2)
                .map_err(|_| "Could not encrypt sidebar preferences")?;
            key.sign_bounded(
                EventTemplate {
                    kind: 30078,
                    created_at,
                    content,
                    tags: vec![
                        vec!["d".into(), coordinate.clone()],
                        vec!["t".into(), coordinate],
                    ],
                },
                192 * 1024,
            )
        })
        .await
    }

    // Only host-owned purpose-bound operations may use this closure. Never expose the
    // secret, or a general decrypt/sign command, to the webview.
    pub(crate) async fn with_key<T: Send + 'static>(
        &self,
        action: impl FnOnce(&[u8; 32], &str) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            match &identity.state {
                State::Ready(key) => action(&key.0, &key.viewer()?),
                _ => Err("Set up your identity first".into()),
            }
        })
        .await
    }

    /// Decrypt only verified, self-authored NIP-RS slots.
    pub(crate) async fn decode_read_state(
        &self,
        events: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            let State::Ready(key) = &identity.state else {
                return Err("Set up your identity first".into());
            };
            if events.len() > 16
                || serde_json::to_vec(&events)
                    .map_err(|_| "Read-state decode capacity exceeded")?
                    .len()
                    > 512 * 1024
            {
                return Err("Read-state decode capacity exceeded".into());
            }
            let secret = NostrSecretKey::from_slice(key.0.as_ref())
                .map_err(|_| "Invalid read-state event")?;
            let public = Keys::new(secret.clone()).public_key();
            let conversation = nip44::v2::ConversationKey::derive(&secret, &public)
                .map_err(|_| "Invalid read-state event")?;
            let mut result = Vec::new();
            for raw in events {
                if serde_json::to_vec(&raw)
                    .map_err(|_| "Invalid read-state event")?
                    .len()
                    > 96 * 1024
                {
                    return Err("Invalid read-state event".into());
                }
                // Inspect raw tag arrays before deserialization; normalization must not discard duplicate selectors.
                let tags = raw["tags"].as_array().ok_or("Invalid read-state event")?;
                let ds: Vec<_> = tags.iter().filter(|tag| tag[0] == "d").collect();
                let ts: Vec<_> = tags
                    .iter()
                    .filter(|tag| tag[0] == "t" && tag[1] == "read-state")
                    .collect();
                if ds.len() != 1
                    || ts.len() != 1
                    || !ds[0][1].as_str().is_some_and(valid_read_coordinate)
                {
                    return Err("Invalid read-state event".into());
                }
                let event: Event =
                    serde_json::from_value(raw).map_err(|_| "Invalid read-state event")?;
                event.verify().map_err(|_| "Invalid read-state event")?;
                if event.kind.as_u16() != 30078 || event.pubkey != public {
                    return Err("Invalid read-state event".into());
                }
                let plaintext = decrypt_with_conversation(&conversation, &event.content)
                    .map_err(|_| "Invalid read-state event")?;
                if plaintext.len() > 128 * 1024 {
                    return Err("Read-state plaintext capacity exceeded".into());
                }
                let blob: serde_json::Value =
                    serde_json::from_str(&plaintext).map_err(|_| "Invalid read-state event")?;
                validate_read_blob(&blob)?;
                result.push(serde_json::json!({"eventId": event.id.to_hex(), "blob": blob}));
            }
            Ok(serde_json::Value::Array(result))
        })
        .await
    }

    /// Sign only bounded NIP-RS intent, never caller-supplied ciphertext.
    pub(crate) async fn sign_read_state(
        &self,
        slot: String,
        created_at: u64,
        blob: serde_json::Value,
    ) -> Result<serde_json::Value> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            let State::Ready(key) = &identity.state else {
                return Err("Set up your identity first".into());
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs();
            if !valid_read_coordinate(&format!("read-state:{slot}"))
                || created_at > u32::MAX as u64
                || now.abs_diff(created_at) > 60
            {
                return Err("Invalid read-state signing intent".into());
            }
            validate_read_blob(&blob)?;
            let plaintext =
                serde_json::to_string(&blob).map_err(|_| "Invalid read-state signing intent")?;
            if plaintext.len() > 40 * 1024 {
                return Err("Read-state publication capacity exceeded".into());
            }
            let secret = NostrSecretKey::from_slice(key.0.as_ref())
                .map_err(|_| "Invalid read-state signing intent")?;
            let public = Keys::new(secret.clone()).public_key();
            let content = nostr::nips::nip44::encrypt(
                &secret,
                &public,
                plaintext,
                nostr::nips::nip44::Version::V2,
            )
            .map_err(|_| "Read-state signing failed")?;
            key.sign(EventTemplate {
                created_at,
                kind: 30078,
                content,
                tags: vec![
                    vec!["d".into(), format!("read-state:{slot}")],
                    vec!["t".into(), "read-state".into()],
                ],
            })
        })
        .await
    }

    pub(crate) async fn sign(&self, event: EventTemplate) -> Result<serde_json::Value> {
        self.sign_bounded(event, 64 * 1024).await
    }

    /// Signs with a caller-validated serialized-event bound, e.g. NIP-AP catalogs.
    pub(crate) async fn sign_bounded(
        &self,
        event: EventTemplate,
        max_event_bytes: usize,
    ) -> Result<serde_json::Value> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            match &identity.state {
                State::Ready(key) => key.sign_bounded(event, max_event_bytes),
                _ => Err("Set up your identity first".into()),
            }
        })
        .await
    }

    /// Prepares a NIP-OA proof for one agent key; the owner must be this identity.
    pub(crate) async fn authorize_agent(
        &self,
        owner: String,
        agent: String,
    ) -> Result<Vec<String>> {
        with_identity(self.clone(), move |identity| {
            if agent.len() != 64
                || !agent
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("Agent pubkey must be 64 lowercase hex characters".into());
            }
            if agent == owner {
                return Err("Owner and agent pubkeys must differ".into());
            }
            if identity.restore()?.as_deref() != Some(owner.as_str()) {
                return Err("The agent owner is not your signed-in identity".into());
            }
            match &identity.state {
                State::Ready(key) => key.authorize(&agent),
                _ => Err("Set up your identity first".into()),
            }
        })
        .await
    }
}
impl IdentityHost {
    /// Close signing for the rest of this process. Taken under the same lock
    /// every operation holds while it runs, so jobs already queued refuse too.
    pub(crate) fn close(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).close();
    }
}
impl Default for IdentityHost {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Identity {
            state: State::Unread,
            store: Box::new(OsStore),
        })))
    }
}
async fn with_identity<T: Send + 'static>(
    host: IdentityHost,
    action: impl FnOnce(&mut Identity) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut identity = host
            .0
            .lock()
            .map_err(|_| "Identity is unavailable; restart the app")?;
        action(&mut identity)
    })
    .await
    .map_err(|_| "Identity operation could not complete")?
}
/// Prepares an unconditional NIP-OA proof; the caller submits it to the remote agent service.
#[tauri::command]
pub async fn identity_prepare_remote_agent_authorization(
    host: tauri::State<'_, IdentityHost>,
    owner: String,
    agent_pubkey: String,
) -> Result<Vec<String>> {
    host.authorize_agent(owner, agent_pubkey).await
}

/// Builderlab's production identity-binding origin.
const BUILDERLAB_ORIGIN: &str = "https://app.builderlab.xyz";

/// The challenge fields Builderlab returns for binding this identity.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderlabChallenge {
    challenge_id: String,
    nonce: String,
    verification_code: String,
    origin: String,
    expires_at: String,
}
impl BuilderlabChallenge {
    /// block/buzz's `nostr_bind` checks and kind 24243 tags, pinned to production
    /// Builderlab or the `BUZZ_BUILDERLAB_URL` build origin; never another origin.
    fn template(self, now: u64, configured: &str) -> Result<EventTemplate> {
        let nonce_ok = self.nonce.len() == 43
            && self
                .nonce
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let expires = chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map(|at| at.timestamp())
            .unwrap_or(i64::MIN);
        if self.challenge_id.len() != 36
            || uuid::Uuid::parse_str(&self.challenge_id).is_err()
            || !nonce_ok
            || self.verification_code.len() != 6
            || !self.verification_code.bytes().all(|b| b.is_ascii_digit())
            || (self.origin != BUILDERLAB_ORIGIN
                && (configured.is_empty() || self.origin != configured))
            || expires <= i64::try_from(now).unwrap_or(i64::MAX)
        {
            return Err("Invalid Nostr identity challenge".into());
        }
        let tag = |name: &str, value: String| vec![name.to_owned(), value];
        Ok(EventTemplate {
            created_at: now,
            kind: 24243,
            content: String::new(),
            tags: vec![
                tag("challenge_id", self.challenge_id),
                tag("nonce", self.nonce),
                tag("verification_code", self.verification_code),
                tag("audience", "buzz:nostr-identity".into()),
                tag("action", "bind_nostr_identity".into()),
                tag("protocol", "buzz-nostr-identity".into()),
                tag("version", "1".into()),
                tag("origin", self.origin),
                tag("expires_at", self.expires_at),
            ],
        })
    }
}
/// Signs only a valid Builderlab binding challenge; never a general event signer.
#[tauri::command]
pub async fn identity_sign_builderlab_binding(
    host: tauri::State<'_, IdentityHost>,
    challenge: BuilderlabChallenge,
) -> Result<serde_json::Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "System clock is before 1970")?
        .as_secs();
    host.sign(challenge.template(now, buzzodz_plugins::BUILDERLAB_ORIGIN)?)
        .await
}
#[tauri::command]
pub async fn identity_restore(host: tauri::State<'_, IdentityHost>) -> Result<Option<String>> {
    with_identity(host.inner().clone(), Identity::restore).await
}
#[tauri::command]
pub async fn identity_import(
    host: tauri::State<'_, IdentityHost>,
    backup: tauri::State<'_, crate::nsec_backup::NsecBackupHost>,
    nsec: String,
) -> Result<String> {
    let nsec = Zeroizing::new(nsec);
    let public = with_identity(host.inner().clone(), move |identity| {
        identity.save(Some(&nsec))
    })
    .await?;
    let backup = backup.inner().clone();
    let identity = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup.local_key_installed(identity));
    Ok(public)
}
/// Whether installed old Buzz left data here; never reads secure storage.
#[tauri::command]
pub fn identity_legacy_available<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    app.path().data_dir().is_ok_and(|dir| {
        dir.join(buzz_agent_controller::LegacySource::Installed.app_directory())
            .is_dir()
    })
}
#[tauri::command]
pub async fn identity_import_legacy(
    host: tauri::State<'_, IdentityHost>,
    backup: tauri::State<'_, crate::nsec_backup::NsecBackupHost>,
) -> Result<String> {
    let public = with_identity(host.inner().clone(), Identity::import_legacy).await?;
    let backup = backup.inner().clone();
    let identity = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup.local_key_installed(identity));
    Ok(public)
}
#[tauri::command]
pub async fn identity_create(
    host: tauri::State<'_, IdentityHost>,
    backup: tauri::State<'_, crate::nsec_backup::NsecBackupHost>,
) -> Result<String> {
    let public = with_identity(host.inner().clone(), |identity| identity.save(None)).await?;
    let backup = backup.inner().clone();
    let identity = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backup.local_key_installed(identity));
    Ok(public)
}
#[tauri::command]
pub async fn identity_export(host: tauri::State<'_, IdentityHost>) -> Result<String> {
    with_identity(host.inner().clone(), Identity::export).await
}

#[cfg(test)]
pub(crate) mod tests;

impl IdentityHost {
    /// Only recipe plaintext may cross this boundary. Never export arbitrary decrypt.
    pub(crate) async fn kit_cipher(&self, ciphertext: String, encrypt: bool) -> Result<String> {
        with_identity(self.clone(), move |identity| {
            identity.restore()?;
            let State::Ready(key) = &identity.state else {
                return Err("Set up your identity first".into());
            };
            let secret = NostrSecretKey::from_slice(key.0.as_ref()).map_err(|_| INVALID)?;
            let public = Keys::new(secret.clone()).public_key();
            if encrypt {
                nostr::nips::nip44::encrypt(
                    &secret,
                    &public,
                    &ciphertext,
                    nostr::nips::nip44::Version::V2,
                )
                .map_err(|_| "Invalid channel recipe".into())
            } else {
                nostr::nips::nip44::decrypt(&secret, &public, &ciphertext)
                    .map_err(|_| "Invalid channel recipe".into())
            }
        })
        .await
    }
}
