use tauri::{command, AppHandle, Manager};

#[command]
pub fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[command]
pub fn request_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[command]
pub fn set_ignore_cursor_events(app: AppHandle, ignore: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("No main window found")?;
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}
