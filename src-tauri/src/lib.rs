mod archive;
#[cfg(test)]
mod build_resources;
mod federated_identity;
use archive::relay_archive;
mod browser;
#[cfg(target_os = "macos")]
mod close_menu;
mod oauth_callback;
use oauth_callback::{
    oauth_callback_begin, oauth_callback_cancel, oauth_callback_complete, oauth_callback_wait,
    OAuthCallbackHost,
};
#[cfg(test)]
mod browser_permissions_tests;
mod pairing;
use browser::{
    browser_action, browser_attach, browser_detach, browser_navigate, browser_set_bounds,
    browser_status,
};
mod agent_state;
mod app_agents;
mod decisions;
mod deep_links;
mod dock;
mod huddle_window;
use huddle_window::{
    huddle_window_action, huddle_window_open, huddle_window_reset_incoming, huddle_window_update,
    huddle_window_watch, HuddleWindow,
};
#[cfg(test)]
#[path = "enterprise_adapter_url.rs"]
mod enterprise_adapter_url;
#[cfg(test)]
#[path = "enterprise_auth_build.rs"]
mod enterprise_auth_build;
#[cfg(test)]
mod enterprise_relay_url;
mod host_command;
mod host_files;
mod host_mcp;
mod host_process;
mod host_request;
mod identity;
mod native_mcp;
mod nsec_backup;
mod nsec_backup_choice;
mod nsec_backup_config;
use nsec_backup::{
    nsec_backup_available, nsec_backup_retry, nsec_backup_session, nsec_backup_state,
    nsec_backup_watch, nsec_restore_begin, nsec_restore_cancel, nsec_restore_install,
    nsec_restore_wait, NsecBackupHost,
};
use nsec_backup_choice::{nsec_backup_choice, nsec_backup_set_choice};
mod clipboard;
mod jev;
mod keep_awake;
#[cfg(target_os = "macos")]
mod legacy_cli_shortcut;
mod legacy_communities;
#[cfg(target_os = "macos")]
mod media_context_menu;
#[cfg(any(not(target_os = "macos"), test))]
mod microphone;
#[cfg(target_os = "macos")]
mod mouse_nav;

mod notifications;
mod os_idle;
mod repositories_folder;
mod window_controls;
mod window_state;
mod workspace_folder;
use legacy_communities::legacy_communities;
use os_idle::get_os_idle_seconds;
use repositories_folder::repositories_folder_validate;
mod relaunch;
mod relay;
mod relay_admin;
mod sign_out;
use identity::{
    identity_create, identity_export, identity_import, identity_import_legacy,
    identity_legacy_available, identity_prepare_remote_agent_authorization, identity_restore,
    identity_sign_builderlab_binding, IdentityHost,
};
use relay::{
    file_download, media_copy_image, media_download, media_stream_base, relay_agent_library,
    relay_agent_log_proof, relay_agent_memories_read, relay_agent_observer, relay_agent_resolve,
    relay_channel_publish, relay_channel_sign, relay_decode_read_state, relay_decode_reminders,
    relay_decode_sidebar, relay_direct_message, relay_git_authorization, relay_http,
    relay_http_cancel, relay_kit_decode, relay_kit_prepare, relay_kit_sign, relay_project_git,
    relay_project_git_cancel, relay_publish_read_state, relay_sign, relay_sign_read_state,
    relay_sign_reminder, relay_sign_sidebar, relay_upload, relay_upload_begin, relay_upload_cancel,
    relay_upload_chunk, relay_verify_signatures, relay_workflow_runs,
};
use relay::{huddle_close, huddle_open, huddle_pcm, huddle_touch, Huddles};
mod terminal;
#[cfg(all(test, unix))]
mod test_executable;
use buzzodz_plugins::{
    imports::{
        check_saved_folder, prepare_folder, prepare_saved_folder, prepare_upload, FolderUpload,
        PreparedImport, Preview,
    },
    Catalog, InstallationResult, Manager,
};
use deep_links::{deep_link_take, deep_link_watch, DeepLinks};
use dock::{dock_permission, unread_indicator_set};
use host_command::plugin_host_run_command;
use host_files::{
    plugin_host_delete_managed_file, plugin_host_read_file, plugin_host_resolve_directory,
    plugin_host_save_bytes,
};
use host_mcp::{
    plugin_host_mcp_authorize, plugin_host_mcp_close, plugin_host_mcp_reply, plugin_host_mcp_serve,
    HostMcpServers,
};
use host_process::{
    plugin_host_process_kill, plugin_host_process_spawn, plugin_host_process_write, HostProcesses,
};
use host_request::{
    plugin_host_call_context, plugin_host_request, plugin_host_request_bytes, plugin_host_upload,
    plugin_host_upload_bytes_once, HostCalls,
};
use notifications::{notification_show, Notifications};
#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;
use terminal::{
    terminal_close, terminal_close_owner, terminal_create_owner, terminal_read, terminal_resize,
    terminal_spawn, terminal_write, Terminals,
};

#[derive(Clone, Default)]
struct Imports(Arc<Mutex<Option<PreparedImport>>>);

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
enum TitleBarDoubleClickAction {
    Fill,
    Zoom,
    Minimize,
    None,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct TitleBarFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(any(target_os = "macos", test))]
impl TitleBarFrame {
    fn approximately_equals(self, other: Self) -> bool {
        const TOLERANCE: f64 = 0.5;
        (self.x - other.x).abs() <= TOLERANCE
            && (self.y - other.y).abs() <= TOLERANCE
            && (self.width - other.width).abs() <= TOLERANCE
            && (self.height - other.height).abs() <= TOLERANCE
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
struct TitleBarFillFrame {
    restore: TitleBarFrame,
    filled: TitleBarFrame,
}

#[cfg(target_os = "macos")]
#[derive(Default)]
struct TitleBarFillFrames(Mutex<HashMap<String, TitleBarFillFrame>>);

#[cfg(any(target_os = "macos", test))]
fn title_bar_fill_target(
    current: TitleBarFrame,
    visible: TitleBarFrame,
    saved: Option<TitleBarFillFrame>,
) -> (TitleBarFrame, Option<TitleBarFillFrame>) {
    if let Some(saved) = saved.filter(|saved| current.approximately_equals(saved.filled)) {
        (saved.restore, None)
    } else {
        (
            visible,
            Some(TitleBarFillFrame {
                restore: current,
                filled: visible,
            }),
        )
    }
}

#[cfg(any(target_os = "macos", test))]
fn title_bar_double_click_action(preference: Option<&str>) -> TitleBarDoubleClickAction {
    match preference {
        Some("Maximize" | "Fill") => TitleBarDoubleClickAction::Fill,
        Some("Zoom") => TitleBarDoubleClickAction::Zoom,
        Some("Minimize") => TitleBarDoubleClickAction::Minimize,
        _ => TitleBarDoubleClickAction::None,
    }
}

#[cfg(target_os = "macos")]
fn title_bar_frame(rect: objc2_foundation::NSRect) -> TitleBarFrame {
    TitleBarFrame {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

#[cfg(target_os = "macos")]
fn ns_rect(frame: TitleBarFrame) -> objc2_foundation::NSRect {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    )
}

#[cfg(target_os = "macos")]
fn toggle_title_bar_fill<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    frames: &TitleBarFillFrames,
) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
    let current = title_bar_frame(ns_window.frame());
    let visible = title_bar_frame(
        ns_window
            .screen()
            .ok_or("Could not resolve the window's current screen")?
            .visibleFrame(),
    );
    let mut frames = frames
        .0
        .lock()
        .map_err(|_| "Title-bar Fill state is unavailable")?;
    let (target, saved) = title_bar_fill_target(current, visible, frames.remove(window.label()));
    if let Some(saved) = saved {
        frames.insert(window.label().to_owned(), saved);
    }
    drop(frames);
    ns_window.setFrame_display_animate(ns_rect(target), true, true);
    Ok(())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn title_bar_double_click<R: tauri::Runtime>(
    window: tauri::Window<R>,
    fill_frames: tauri::State<'_, TitleBarFillFrames>,
) -> Result<(), String> {
    use objc2_foundation::{ns_string, NSUserDefaults};

    let preference = NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleActionOnDoubleClick"))
        .map(|value| value.to_string());
    match title_bar_double_click_action(preference.as_deref()) {
        TitleBarDoubleClickAction::Fill => toggle_title_bar_fill(&window, &fill_frames)?,
        TitleBarDoubleClickAction::Zoom => {
            let ns_window = window.ns_window().map_err(|error| error.to_string())?;
            let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window.cast() };
            ns_window.performZoom(None);
        }
        TitleBarDoubleClickAction::Minimize => {
            window.minimize().map_err(|error| error.to_string())?;
        }
        TitleBarDoubleClickAction::None => {}
    }

    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn title_bar_double_click<R: tauri::Runtime>(_window: tauri::Window<R>) {}

async fn prepare_import(
    imports: Imports,
    operation: impl FnOnce() -> Result<Option<PreparedImport>, String> + Send + 'static,
) -> Result<Option<Preview>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        *pending = None;
        *pending = operation()?;
        Ok(pending.as_ref().map(|p| p.preview.clone()))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn workspace_pick_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    title: Option<String>,
    start: Option<String>,
) -> Result<Option<String>, String> {
    // Open at the current choice, or its nearest existing parent ("~" is home).
    let home = app.path().home_dir().ok();
    let start = start.and_then(|path| {
        let path = workspace_folder::expand(&path, home.as_deref());
        path.ancestors()
            .find(|dir| dir.is_dir())
            .map(|dir| dir.to_path_buf())
    });
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_title(title.as_deref().unwrap_or("Choose a folder"));
        match start {
            Some(dir) => dialog.set_directory(dir),
            None => dialog,
        }
        .blocking_pick_folder()
        .map(|folder| {
            let path = folder.into_path().map_err(|error| error.to_string())?;
            workspace_folder::display(&path, home.as_deref())
        })
        .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn plugin_import_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    imports: tauri::State<'_, Imports>,
    upload: Option<FolderUpload>,
) -> Result<Option<Preview>, String> {
    prepare_import(imports.inner().clone(), move || {
        if let Some(upload) = upload {
            return prepare_upload(upload).map(Some);
        }
        app.dialog()
            .file()
            .set_title("Choose a plugin folder")
            .blocking_pick_folder()
            .map(|folder| prepare_folder(&folder.into_path().map_err(|e| e.to_string())?))
            .transpose()
    })
    .await
}
#[tauri::command]
async fn plugin_update_check(
    manager: tauri::State<'_, PluginManager>,
    id: String,
) -> Result<String, String> {
    with_manager(manager, move |manager| check_saved_folder(&manager, &id)).await
}
#[tauri::command]
async fn plugin_update_preview(
    manager: tauri::State<'_, PluginManager>,
    imports: tauri::State<'_, Imports>,
    id: String,
) -> Result<Option<Preview>, String> {
    let manager = manager.0.clone()?;
    prepare_import(imports.inner().clone(), move || {
        prepare_saved_folder(&manager, &id).map(Some)
    })
    .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn plugin_import_git(
    identity: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, federated_identity::FederatedIdentity>,
    imports: tauri::State<'_, Imports>,
    manager: tauri::State<'_, PluginManager>,
    repository: String,
    reference: String,
    authorization: Option<String>,
    check_only: Option<bool>,
    commit: Option<String>,
) -> Result<Option<Preview>, String> {
    if let Some(commit) = &commit {
        buzzodz_plugins::imports::RequiredCommit::parse(commit)?;
    }
    let repository = buzzodz_plugins::imports::repository_url(&repository)?;
    let url = url::Url::parse(&repository).map_err(|_| "Invalid repository")?;
    let community = url.origin().ascii_serialization();
    let is_community = relay::git_repository(&community, &repository).is_ok();
    if authorization.is_some() && !is_community {
        return Err("Not a repository in this community".into());
    }
    let assertion = if is_community {
        Some(fi.assertion_for_relay(identity.inner(), &url).await?)
    } else {
        None
    };
    let authorization = if is_community {
        Some(relay::git_authorization(identity.inner(), &url).await?)
    } else {
        authorization
    };
    if let Some(assertion) = &assertion {
        fi.admit_authorization(identity.inner(), assertion).await?;
    }
    let host = fi.inner().clone();
    let viewer = identity.inner().clone();
    let admitted = assertion.clone();
    let access = repository_access(&manager.0);
    let result = if check_only == Some(true) {
        // Checks own only their clone; they must never lock or replace Add's preview.
        tauri::async_runtime::spawn_blocking(move || {
            let required = commit
                .as_deref()
                .map(buzzodz_plugins::imports::RequiredCommit::parse)
                .transpose()?;
            buzzodz_plugins::imports::prepare_git_authorized(
                &repository,
                &reference,
                required,
                authorization.as_deref(),
                assertion
                    .as_ref()
                    .and_then(|authorization| authorization.header()),
                None,
                &access,
            )
            .map(|prepared| Some(prepared.preview))
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    } else {
        prepare_import(imports.inner().clone(), move || {
            let captured = assertion.clone();
            let guard = host.clone();
            let retired: Option<Box<dyn Fn() -> bool + Send>> = captured.map(|authorization| {
                Box::new(move || !guard.authorization_session_current(&authorization))
                    as Box<dyn Fn() -> bool + Send>
            });
            let required = commit
                .as_deref()
                .map(buzzodz_plugins::imports::RequiredCommit::parse)
                .transpose()?;
            buzzodz_plugins::imports::prepare_git_authorized(
                &repository,
                &reference,
                required,
                authorization.as_deref(),
                assertion
                    .as_ref()
                    .and_then(|authorization| authorization.header()),
                retired,
                &access,
            )
            .map(Some)
        })
        .await
    };
    admit_git_result(
        fi.inner(),
        &viewer,
        admitted.as_ref(),
        imports.inner(),
        check_only,
        result,
    )
    .await
}

/// Admits a Git import's response; only a refused Add clears the preview it stored.
async fn admit_git_result(
    fi: &federated_identity::FederatedIdentity,
    viewer: &IdentityHost,
    admitted: Option<&federated_identity::assertion::Authorization>,
    imports: &Imports,
    check_only: Option<bool>,
    result: Result<Option<Preview>, String>,
) -> Result<Option<Preview>, String> {
    if let Some(assertion) = admitted {
        if let Err(error) = fi.admit_response(viewer, assertion, false).await {
            // Checks own only their clone; they must never lock Add's import slot.
            if check_only != Some(true) {
                if let Ok(Some(preview)) = &result {
                    let mut pending = imports.0.lock().map_err(|_| "Import state unavailable")?;
                    if pending
                        .as_ref()
                        .is_some_and(|current| current.preview.token == preview.token)
                    {
                        *pending = None;
                    }
                }
            }
            return Err(error);
        }
    }
    result
}
#[tauri::command]
async fn plugin_import_discard(
    imports: tauri::State<'_, Imports>,
    token: String,
) -> Result<(), String> {
    let mut pending = imports
        .0
        .try_lock()
        .map_err(|_| "Another import is in progress")?;
    if pending.as_ref().is_some_and(|p| p.preview.token == token) {
        *pending = None;
    }
    Ok(())
}
#[tauri::command]
async fn plugin_import_install(
    manager: tauri::State<'_, PluginManager>,
    imports: tauri::State<'_, Imports>,
    token: String,
    path: String,
) -> Result<InstallationResult, String> {
    let imports = imports.inner().clone();
    with_manager(manager, move |m| {
        let pending = imports
            .0
            .try_lock()
            .map_err(|_| "Another import is in progress")?;
        pending
            .as_ref()
            .ok_or("This import preview expired. Choose the source again.")?
            .install(&m, &token, &path)
            .map(|catalog| ready(&m, catalog))
    })
    .await
}

fn ready(manager: &Manager, catalog: Catalog) -> InstallationResult {
    InstallationResult::Ready {
        managed: manager.managed(&catalog),
        catalog,
        external_plugins_paused: manager.external_plugins_paused(),
    }
}

// Invalid environment configuration must not prevent the recovery shell from opening.
struct PluginManager(Result<Manager, String>);

/// Read per import so an edited rules file applies without restarting Buzz.
fn repository_access(manager: &Result<Manager, String>) -> buzzodz_plugins::access::AccessRules {
    use buzzodz_plugins::access::{built_in, Status};
    let Ok(manager) = manager else {
        return built_in();
    };
    let access = manager.repository_access();
    let path = access
        .path
        .as_ref()
        .map_or(String::new(), |path| path.display().to_string());
    if let Status::Invalid { reason } = &access.status {
        eprintln!("Ignoring repository access file {path}: {reason}");
    }
    for problem in &access.problems {
        eprintln!("Repository access file {path}: {problem}");
    }
    access
}
async fn with_manager<T: Send + 'static>(
    state: tauri::State<'_, PluginManager>,
    operation: impl FnOnce(Manager) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let manager = state.0.clone()?;
    tauri::async_runtime::spawn_blocking(move || operation(manager))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn plugin_catalog(
    manager: tauri::State<'_, PluginManager>,
) -> Result<InstallationResult, String> {
    with_manager(manager, |m| {
        Ok(match m.catalog() {
            Ok(catalog) => ready(&m, catalog),
            Err(reason) => InstallationResult::Recovery {
                reason,
                can_reset: true,
            },
        })
    })
    .await
}
#[tauri::command]
async fn plugin_change(
    manager: tauri::State<'_, PluginManager>,
    registrations: tauri::State<'_, federated_identity::access::Registrations>,
    action: String,
    id: String,
) -> Result<InstallationResult, String> {
    registrations.retire(&id);
    let plugin = id.clone();
    let result = with_manager(manager, move |m| {
        m.change(&action, &plugin).map(|catalog| ready(&m, catalog))
    })
    .await;
    registrations.retire(&id);
    result
}
#[tauri::command]
async fn plugin_reload(
    manager: tauri::State<'_, PluginManager>,
    registrations: tauri::State<'_, federated_identity::access::Registrations>,
    id: String,
) -> Result<InstallationResult, String> {
    registrations.retire(&id);
    let plugin = id.clone();
    let result = with_manager(manager, move |m| {
        m.reload(&plugin).map(|catalog| ready(&m, catalog))
    })
    .await;
    registrations.retire(&id);
    result
}
#[tauri::command]
async fn plugin_module(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<String, String> {
    with_manager(manager, move |m| m.module(&id, &revision)).await
}
#[tauri::command]
async fn plugin_recover(
    manager: tauri::State<'_, PluginManager>,
    registrations: tauri::State<'_, federated_identity::access::Registrations>,
) -> Result<InstallationResult, String> {
    registrations.clear();
    let result = with_manager(manager, |m| m.recover().map(|catalog| ready(&m, catalog))).await;
    registrations.clear();
    result
}
#[tauri::command]
async fn update_restart<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    relaunch::request(&app);
    Ok(())
}
fn commands<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        window_state::onboarding_preserve_window,
        huddle_window_reset_incoming,
        huddle_window_open,
        huddle_window_update,
        huddle_window_watch,
        huddle_window_action,
        huddle_open,
        huddle_close,
        huddle_pcm,
        huddle_touch,
        pairing::pairing_account,
        pairing::pairing_start,
        pairing::pairing_status,
        pairing::pairing_confirm,
        pairing::pairing_deny,
        pairing::pairing_cancel,
        identity_restore,
        identity_import,
        identity_legacy_available,
        identity_import_legacy,
        identity_create,
        identity_export,
        nsec_backup_choice,
        nsec_backup_set_choice,
        identity_prepare_remote_agent_authorization,
        identity_sign_builderlab_binding,
        federated_identity::federated_identity_snapshot,
        federated_identity::federated_identity_sign_in,
        federated_identity::federated_identity_cancel_sign_in,
        federated_identity::federated_identity_sign_out,
        federated_identity::access::federated_identity_register,
        federated_identity::access::federated_identity_unregister,
        federated_identity::access::federated_identity_request,
        federated_identity::socket::relay_socket_connect,
        federated_identity::socket::relay_socket_start,
        federated_identity::socket::relay_socket_send,
        federated_identity::socket::relay_socket_close,
        relay_sign,
        relay_decode_read_state,
        relay_sign_read_state,
        relay_publish_read_state,
        relay_http,
        relay_http_cancel,
        relay_verify_signatures,
        relay_workflow_runs,
        relay_admin::relay_admin_discover,
        relay_admin::relay_admin_request,
        relay_admin::attachment::relay_admin_attachment,
        relay_admin::attachment::relay_admin_save_attachment,
        relay_project_git,
        relay_project_git_cancel,
        relay_git_authorization,
        relay_channel_sign,
        relay_channel_publish,
        relay_kit_sign,
        relay_kit_prepare,
        relay_kit_decode,
        relay_direct_message,
        relay_decode_sidebar,
        relay_sign_sidebar,
        relay_decode_reminders,
        relay_sign_reminder,
        relay_agent_resolve,
        relay_agent_log_proof,
        relay_archive,
        relay_agent_observer,
        relay_agent_memories_read,
        relay_agent_library,
        relay_upload_begin,
        relay_upload_chunk,
        relay_upload,
        relay_upload_cancel,
        file_download,
        media_download,
        media_copy_image,
        clipboard::clipboard_write_text,
        media_stream_base,
        get_os_idle_seconds,
        workspace_pick_folder,
        repositories_folder_validate,
        legacy_communities,
        plugin_import_folder,
        plugin_update_check,
        plugin_update_preview,
        plugin_import_git,
        plugin_import_install,
        plugin_import_discard,
        plugin_catalog,
        plugin_change,
        plugin_reload,
        plugin_module,
        plugin_recover,
        plugin_host_run_command,
        plugin_host_call_context,
        plugin_host_request,
        plugin_host_request_bytes,
        plugin_host_upload_bytes_once,
        plugin_host_save_bytes,
        plugin_host_delete_managed_file,
        plugin_host_upload,
        plugin_host_process_spawn,
        plugin_host_process_write,
        plugin_host_process_kill,
        plugin_host_mcp_serve,
        plugin_host_mcp_authorize,
        plugin_host_mcp_reply,
        plugin_host_mcp_close,
        plugin_host_read_file,
        plugin_host_resolve_directory,
        oauth_callback_begin,
        oauth_callback_wait,
        oauth_callback_cancel,
        oauth_callback_complete,
        nsec_backup_available,
        nsec_backup_session,
        nsec_backup_retry,
        nsec_backup_state,
        nsec_backup_watch,
        nsec_restore_begin,
        nsec_restore_wait,
        nsec_restore_install,
        nsec_restore_cancel,
        app_agents::app_agent_list,
        app_agents::app_agent_create,
        app_agents::app_agent_set_protection,
        app_agents::app_agent_protection_defaults,
        app_agents::app_agent_set_protection_defaults,
        app_agents::app_agent_portable,
        app_agents::app_agent_port,
        app_agents::app_agent_rename,
        app_agents::app_agent_set_picture,
        app_agents::app_agent_set_type,
        app_agents::app_agent_delete,
        app_agents::app_agent_begin_delete,
        app_agents::app_agent_begin_leave,
        app_agents::app_agent_hold_removal,
        app_agents::app_agent_release_removal,
        app_agents::app_agent_join,
        app_agents::app_agent_forget,
        app_agents::app_agent_publish,
        app_agents::app_agent_publish_profile,
        app_agents::app_agent_query,
        app_agents::app_agent_search_profiles,
        app_agents::app_agent_upload,
        app_agents::app_agent_media,
        app_agents::app_agent_git_auth,
        app_agents::app_agent_remember,
        app_agents::app_agent_claim,
        app_agents::app_agent_release,
        jev::jev_classifier_status,
        jev::jev_classifier_set_key,
        jev::jev_classifier_clear_key,
        agent_state::app_agent_state_load,
        agent_state::app_agent_state_set,
        decisions::decide,
        title_bar_double_click,
        notification_show,
        #[cfg(target_os = "macos")]
        notifications::macos::notification_permission_state,
        #[cfg(target_os = "macos")]
        notifications::macos::request_notification_access,
        deep_link_take,
        deep_link_watch,
        dock_permission,
        unread_indicator_set,
        keep_awake::keep_awake_set,
        terminal_create_owner,
        terminal_spawn,
        terminal_read,
        terminal_write,
        terminal_resize,
        terminal_close,
        terminal_close_owner,
        update_restart,
        sign_out::sign_out,
        sign_out::sign_out_wipe_refusal
    ]
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = app_context();
    // Reject unsafe test launch settings before any identity or pending erase work.
    let native_mcp = native_mcp::plugin(
        context.config(),
        std::env::var_os("BUZZ_NATIVE_MCP_PORT"),
        std::env::var_os("BUZZ_DEV_VIEWER"),
    )
    .unwrap_or_else(|message| {
        eprintln!("Cannot enable native MCP: {message}");
        std::process::exit(1);
    });
    // A pending Sign out finishes before any window, webview storage, service or
    // identity read; if it can't, Buzz explains and exits without opening.
    let instance = sign_out::Paths::resolve(&context.config().identifier).map(|paths| {
        sign_out::boot(
            &paths,
            |app_data| {
                let credentials = buzz_agent_controller::PlatformCredentials::default();
                let old = app_data.join(sign_out::OLD_AGENTS);
                if old
                    .try_exists()
                    .map_err(|error| format!("check agent registry: {error}"))?
                {
                    buzz_agent_controller::delete_local_agent_keys(old, &credentials)?;
                }
                // The pending erase runs before the temporary startup migration.
                for folder in [sign_out::AGENTS, sign_out::migrate_agents::LEGACY] {
                    buzz_agent_controller::AppAgents::open(
                        app_data.join(folder).join("identities.json"),
                    )
                    .delete_keys(&credentials)?;
                }
                Ok(())
            },
            || {
                federated_identity::store::remove_all(federated_identity::store::root()?)?;
                identity::remove_saved_key()
            },
        )
        .and_then(|instance| {
            sign_out::forget_signed_out_key(&instance, identity::remove_current_key)
                .map(|()| instance)
        })
        .unwrap_or_else(|message| sign_out::exit_with(&message))
    });
    let federated_identity = federated_identity::FederatedIdentity::new()
        .unwrap_or_else(|message| sign_out::exit_with(&message));
    let identity = IdentityHost::default();
    let identifier = context.config().identifier.clone();
    let builder = tauri::Builder::default();
    let builder = if !tauri::is_dev() {
        // Single instance comes first, as its documentation requires. Its deep-link
        // feature forwards deep-link argv on Windows/Linux. macOS OS URLs reach
        // the registered bundle directly; cross-copy URL handoff is unsupported.
        // This callback only foregrounds the running window. Development launches
        // skip this so parallel worktrees can run side by side.
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            deep_links::focus_main(app);
        }))
    } else {
        builder
    };
    let builder = if let Some(plugin) = native_mcp {
        builder.plugin(plugin)
    } else {
        builder
    };
    let builder = builder
        .plugin(window_controls::init())
        .plugin(window_state::builder().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(federated_identity.clone())
        .manage(federated_identity::access::Registrations::default())
        .manage(federated_identity::socket::Sockets::default())
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::GtkSettingsExt;

                // Avoid medium/full hinting distorting Linux WebKit font spacing.
                // Process-local only; preserve the user's hinting on/off preference.
                if let Some(settings) = gtk::Settings::default() {
                    settings.set_gtk_xft_hintstyle(Some("hintslight"));
                }
                // WebKitGTK hides `navigator.mediaDevices` unless media streams are on.
                if let Some(main) = app.get_webview_window("main") {
                    main.with_webview(|webview| {
                        use webkit2gtk::{SettingsExt, WebViewExt};
                        if let Some(settings) = webview.inner().settings() {
                            settings.set_enable_media_stream(true);
                        }
                    })?;
                }
            }
            relay::set_user_agent(&app.package_info().version);
            app.state::<federated_identity::FederatedIdentity>()
                .watch(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window_state::restore(&window.as_ref().window()) {
                    eprintln!("Could not restore Buzz window: {error}");
                }
            }
            #[cfg(target_os = "macos")]
            notifications::macos::init();
            #[cfg(target_os = "macos")]
            mouse_nav::install(app.handle());
            #[cfg(target_os = "macos")]
            if let Some(home) = dirs::home_dir() {
                if let Err(error) = legacy_cli_shortcut::remove_stale(&home.join(".local/bin")) {
                    eprintln!("Could not remove old Buzz's CLI shortcut: {error}");
                }
            }
            tauri::async_runtime::spawn(host_command::load_login_shell_path());
            deep_links::setup(app.handle());
            app.manage(relay::Spools::new(
                app.path()
                    .app_cache_dir()
                    .map(|path| path.join("upload-spools"))
                    .map_err(|_| "Media preparation could not access temporary storage".to_owned()),
            ));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
                loop {
                    interval.tick().await;
                    handle
                        .state::<relay::Spools>()
                        .reap(&handle.state::<relay::Uploads>());
                }
            });
            // Relay `<video>` and `<audio>` load from this listener; without it
            // they show as unavailable.
            match relay::MediaStream::start(
                app.state::<IdentityHost>().inner().clone(),
                app.state::<federated_identity::FederatedIdentity>()
                    .inner()
                    .clone(),
            ) {
                Ok(stream) => {
                    app.manage(stream);
                }
                Err(error) => eprintln!("Could not start the media listener: {error}"),
            }
            #[cfg(target_os = "macos")]
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let directory = app.path().download_dir().ok();
                let stream = app
                    .try_state::<relay::MediaStream>()
                    .map(|stream| stream.base().to_owned());
                // Packaged builds keep `devUrl` in their config but never load it.
                let dev = app
                    .config()
                    .build
                    .dev_url
                    .clone()
                    .filter(|_| tauri::is_dev());
                if let Err(error) = main.with_webview(move |webview| {
                    media_context_menu::install(&webview, handle, directory, stream, dev)
                }) {
                    eprintln!("Could not prepare the media menu: {error}");
                }
            }
            // Only app-owned storage is created; a development build keeps its agents
            // in the installed app's (`legacy_identifier::agents`). Preview uses the
            // OS-resolved legacy parent, never a browser-supplied path or a
            // different environment source.
            let paths = (|| {
                let app_data = app
                    .path()
                    .app_data_dir()
                    .map_err(|_| "Could not resolve local agent storage")?;
                let agents =
                    sign_out::legacy_identifier::agents(&app.config().identifier, &app_data);
                let legacy = app
                    .path()
                    .data_dir()
                    .map_err(|_| "Could not resolve legacy library directory")?;
                Ok((app_data.join("agent-controller"), agents, legacy))
            })();
            app.manage(agent_state::AgentState::new(
                paths
                    .as_ref()
                    .map(|(_, agents, _)| agents.join("state"))
                    .map_err(Clone::clone),
            ));
            // Organization sign-out retires agent grants through this owner.
            let tokens = federated_identity::agent::AgentTokens::new(
                app.state::<federated_identity::FederatedIdentity>()
                    .inner()
                    .clone(),
            );
            app.manage(tokens.clone());
            app.manage(app_agents::AppAgentHost::new(
                paths
                    .as_ref()
                    .map(|(_, agents, _)| agents.join("identities.json"))
                    .map_err(Clone::clone),
                paths
                    .as_ref()
                    .map(|(root, _, legacy)| buzz_agent_controller::OldStores {
                        harness: root.join("agents.json"),
                        data_dir: legacy.clone(),
                    })
                    .map_err(Clone::clone),
                // `just desktop` builds and debug bundles step aside for the
                // installed app.
                !tauri::is_dev() && app.config().identifier == sign_out::legacy_identifier::CURRENT,
                tokens,
            ));
            Ok(())
        });
    #[cfg(not(target_os = "macos"))]
    let builder = builder.on_permission_request(|webview, kind| {
        microphone::decide(
            webview.label(),
            webview.url().ok().as_ref(),
            // Packaged builds keep `devUrl` in their config but never load it.
            webview
                .config()
                .build
                .dev_url
                .as_ref()
                .filter(|_| tauri::is_dev()),
            kind,
        )
    });
    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(TitleBarFillFrames::default())
        .menu(close_menu::menu)
        .on_menu_event(close_menu::handle);
    // Register the updater only in configured release builds; omit it locally.
    #[cfg(buzz_updater_enabled)]
    let builder = if tauri::is_dev() {
        builder
    } else {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    };
    let builder = match instance {
        Some(instance) => builder.manage(instance),
        None => builder,
    };
    builder
        .manage(clipboard::Clipboard::default())
        .manage(keep_awake::KeepAwake::default())
        .manage(identity)
        .manage(archive::ArchiveHost::default())
        .manage(jev::JevHost::new())
        .manage(decisions::DecisionsHost::new())
        .manage(pairing::Pairing::default())
        .manage(Huddles::default())
        .manage(HuddleWindow::default())
        .manage(relay::Uploads::default())
        .register_asynchronous_uri_scheme_protocol("buzz-media", relay::media_protocol)
        .manage(Imports::default())
        .manage(Terminals::default())
        .manage(HostCalls::default())
        .manage(HostProcesses::default())
        .manage(HostMcpServers::default())
        .manage(OAuthCallbackHost::default())
        .manage(NsecBackupHost::default().with_federated_identity(federated_identity))
        .manage(Notifications::default())
        .manage(DeepLinks::default())
        // Plugin storage lives in this identifier's app data, so development
        // builds keep theirs apart from the installed app.
        .manage(PluginManager(Manager::from_env(
            dirs::data_dir().map(|dir| dir.join(&identifier)),
        )))
        .invoke_handler({
            let application_commands = commands::<tauri::Wry>();
            let browser_commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                browser_attach,
                browser_set_bounds,
                browser_detach,
                browser_navigate,
                browser_action,
                browser_status
            ];
            // Browser embeds a real native view; existing commands also support MockRuntime.
            move |request: tauri::ipc::Invoke<tauri::Wry>| {
                if request.message.command().starts_with("browser_") {
                    browser_commands(request)
                } else {
                    application_commands(request)
                }
            }
        })
        .on_page_load(|webview, payload| {
            if let Err(error) = webview
                .state::<OAuthCallbackHost>()
                .document_load(webview.label(), payload.event())
            {
                eprintln!("OAuth callback cleanup failed: {error}");
            }
            if webview.label() == "main" && matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview.state::<HostCalls>().page_load();
                webview.state::<pairing::Pairing>().cancel_all();
                webview.state::<NsecBackupHost>().document_load();
                webview.state::<relay::Spools>().cancel_all(&webview.state::<relay::Uploads>());
                // Processes belong to the page that started them.
                webview.state::<Huddles>().stop_all();
                webview.state::<federated_identity::access::Registrations>().clear();
                webview.state::<federated_identity::socket::Sockets>().clear();
                webview.state::<federated_identity::FederatedIdentity>().clear_discoveries();
                webview.state::<HostProcesses>().stop_all();
                webview.state::<HostMcpServers>().stop_all();
                webview.state::<app_agents::AppAgentHost>().page_load();
            }
            browser::page_load(webview, payload);
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }) { window.state::<pairing::Pairing>().cancel_all(); }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) { window.state::<relay::Spools>().cancel_all(&window.state::<relay::Uploads>()); }
            #[cfg(target_os = "macos")]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Keep the webview and running agents alive until explicit Quit.
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("Could not close Buzz window: {error}");
                    }
                    return;
                }
            }
            browser::window_event(window, event);
        })
        .build(context)
        .expect("failed to build Buzz Foundation")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                deep_links::focus_main(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                shut_down(app);
                #[cfg(target_os = "macos")]
                relaunch::on_exit(app);
            }
        });
}

/// Best-effort native teardown when Buzz exits, from Quit or a fenced sign-out.
pub(crate) fn shut_down<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    app.state::<NsecBackupHost>().close();
    app.state::<federated_identity::FederatedIdentity>().close();
    app.state::<federated_identity::access::Registrations>()
        .clear();
    app.state::<federated_identity::socket::Sockets>().clear();
    app.state::<relay::Spools>()
        .cancel_all(&app.state::<relay::Uploads>());
    #[cfg(target_os = "macos")]
    media_context_menu::discard_pending();
    app.state::<clipboard::Clipboard>().release();
    app.state::<HostProcesses>().shutdown();
    host_command::stop_login_shell_probe();
    app.state::<HostMcpServers>().stop_all();
    browser::shutdown();
    if let Err(error) = app.state::<Terminals>().shutdown() {
        eprintln!("Terminal shutdown failed: {error}");
    }
}

fn app_context<R: tauri::Runtime>() -> tauri::Context<R> {
    tauri::generate_context!()
}

#[cfg(test)]
mod tests {
    use super::{
        title_bar_double_click_action, title_bar_fill_target, TitleBarDoubleClickAction,
        TitleBarFillFrame, TitleBarFrame,
    };

    #[test]
    fn git_checks_never_acquire_or_replace_the_import_slot() {
        use tauri::Manager as _;
        let app = tauri::test::mock_builder()
            .manage(super::Imports::default())
            .manage(super::IdentityHost::default())
            .manage(super::federated_identity::FederatedIdentity::new().unwrap())
            .manage(super::PluginManager(Err("No plugin storage".into())))
            .build(super::app_context())
            .unwrap();
        let imports = app.state::<super::Imports>();
        let folder = tempfile::tempdir().unwrap();
        let prepared = super::prepare_folder(folder.path()).unwrap();
        let token = prepared.preview.token.clone();
        let mut pending = imports.0.lock().unwrap();
        *pending = Some(prepared);
        // Invalid references fail before network access, after reaching Git validation.
        let check = |check_only| {
            tauri::async_runtime::block_on(super::plugin_import_git(
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                "https://example.invalid/plugins".into(),
                "--invalid".into(),
                None,
                Some(check_only),
                None,
            ))
            .err()
            .unwrap()
        };
        assert_eq!(check(false), "Another import is in progress");
        assert!(check(true).contains("branch or tag"));
        drop(pending);
        assert!(check(true).contains("branch or tag"));
        let pinned = |commit: &str, check_only| {
            tauri::async_runtime::block_on(super::plugin_import_git(
                app.state(),
                app.state(),
                app.state(),
                app.state(),
                "https://example.invalid/plugins".into(),
                "main".into(),
                None,
                Some(check_only),
                Some(commit.into()),
            ))
            .err()
            .unwrap()
        };
        for commit in ["main", "abc123", &"a".repeat(41), &"g".repeat(40)] {
            for check_only in [false, true] {
                assert!(
                    pinned(commit, check_only).contains("Required commit"),
                    "{commit}"
                );
            }
        }
        assert_eq!(
            imports.0.lock().unwrap().as_ref().unwrap().preview.token,
            token
        );
    }

    // Holding the import mutex across the check is the scenario under test.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refused_git_checks_never_wait_on_or_clear_the_import_slot() {
        use crate::federated_identity::assertion::test_live_authorization;
        let identity = super::IdentityHost::fixture();
        let (fi, authorization) = test_live_authorization(
            &identity,
            "wss://relay.example",
            std::time::Duration::from_secs(60),
        )
        .await;
        fi.close();
        let imports = super::Imports::default();
        let folder = tempfile::tempdir().unwrap();
        let prepared = super::prepare_folder(folder.path()).unwrap();
        let preview = prepared.preview.clone();
        let slot = imports.clone();
        let admit = move |check_only| {
            let (fi, identity, authorization, imports, preview) = (
                fi.clone(),
                identity.clone(),
                authorization.clone(),
                slot.clone(),
                preview.clone(),
            );
            // Spawned so a check that blocks on the slot stalls a worker, not the timeout.
            tokio::spawn(async move {
                super::admit_git_result(
                    &fi,
                    &identity,
                    Some(&authorization),
                    &imports,
                    Some(check_only),
                    Ok(Some(preview)),
                )
                .await
            })
        };
        let pending = imports.0.lock().unwrap();
        let check = tokio::time::timeout(std::time::Duration::from_secs(5), admit(true))
            .await
            .expect("a refused check waited on the import slot")
            .unwrap();
        assert_eq!(
            check.err().as_deref(),
            Some("Federated authorization changed")
        );
        drop(pending);
        *imports.0.lock().unwrap() = Some(prepared);
        assert_eq!(
            admit(true).await.unwrap().err().as_deref(),
            Some("Federated authorization changed")
        );
        assert!(
            imports.0.lock().unwrap().is_some(),
            "a check cleared Add's preview"
        );
        assert_eq!(
            admit(false).await.unwrap().err().as_deref(),
            Some("Federated authorization changed")
        );
        assert!(
            imports.0.lock().unwrap().is_none(),
            "a refused Add kept its preview"
        );
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> TitleBarFrame {
        TitleBarFrame {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn title_bar_double_click_preferences_map_to_native_actions() {
        assert_eq!(
            title_bar_double_click_action(Some("Maximize")),
            TitleBarDoubleClickAction::Fill
        );
        assert_eq!(
            title_bar_double_click_action(Some("Fill")),
            TitleBarDoubleClickAction::Fill
        );
        assert_eq!(
            title_bar_double_click_action(Some("Zoom")),
            TitleBarDoubleClickAction::Zoom
        );
        assert_eq!(
            title_bar_double_click_action(Some("Minimize")),
            TitleBarDoubleClickAction::Minimize
        );
        assert_eq!(
            title_bar_double_click_action(Some("None")),
            TitleBarDoubleClickAction::None
        );
        assert_eq!(
            title_bar_double_click_action(None),
            TitleBarDoubleClickAction::None
        );
    }

    #[test]
    fn title_bar_fill_restores_only_an_unchanged_filled_window() {
        let original = frame(100.0, 100.0, 900.0, 700.0);
        let visible = frame(0.0, 25.0, 1512.0, 920.0);
        let saved = TitleBarFillFrame {
            restore: original,
            filled: visible,
        };

        assert_eq!(
            title_bar_fill_target(visible, visible, Some(saved)),
            (original, None)
        );

        let moved = frame(20.0, 25.0, 1492.0, 920.0);
        assert_eq!(
            title_bar_fill_target(moved, visible, Some(saved)),
            (
                visible,
                Some(TitleBarFillFrame {
                    restore: moved,
                    filled: visible,
                })
            )
        );
    }
}
