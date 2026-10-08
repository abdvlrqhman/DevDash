// DevDash shell: a thin native window around a DevDash space.
// The bundled connect screen (../ui) asks for a space domain, checks /.well-known/devdash.json,
// then loads the space. The space gets no native permissions (no IPC capabilities); it can only ask the shell,
// through navigations to devdash-shell://, to open a link in the system browser, go back to the connect screen,
// or show a system notification.
use tauri::{plugin::PermissionState, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

/// URL of the bundled connect screen, so "Switch space" can return to it from the space.
struct Home(Url);

/// Where Tauri serves the bundled UI when the WebView can't say yet (on Android it has no URL until it has loaded).
#[cfg(any(windows, target_os = "android"))]
const BUNDLED_HOME: &str = "http://tauri.localhost/index.html";
#[cfg(not(any(windows, target_os = "android")))]
const BUNDLED_HOME: &str = "tauri://localhost/index.html";

const BRIDGE: &str = r#"
  window.devdashShell = {
    switchSpace() { location.href = 'devdash-shell://switch' },
    openExternal(url) { location.href = 'devdash-shell://open?u=' + encodeURIComponent(url) },
    notify(title, body) {
      location.href = 'devdash-shell://notify?t=' + encodeURIComponent(title) + '&b=' + encodeURIComponent(body || '')
    },
    notificationPermission(ask) {
      return new Promise((resolve) => {
        window.__devdashPermission = resolve;
        location.href = 'devdash-shell://notification-permission?ask=' + (ask ? 1 : 0);
      });
    },
  };
"#;

fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn param(url: &Url, key: &str) -> String {
    url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.chars().take(300).collect()).unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let nav_app = app.handle().clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(BRIDGE)
                .on_navigation(move |url| {
                    if url.scheme() != "devdash-shell" {
                        return true;
                    }
                    let app = nav_app.clone();
                    match url.host_str() {
                        Some("open") => {
                            if let Some((_, target)) = url.query_pairs().find(|(k, _)| k == "u") {
                                if let Ok(target) = Url::parse(&target) {
                                    if is_external(&target) {
                                        let _ = app.opener().open_url(target.as_str(), None::<&str>);
                                    }
                                }
                            }
                        }
                        Some("notify") => {
                            let _ = app.notification().builder().title(param(&url, "t")).body(param(&url, "b")).show();
                        }
                        Some("notification-permission") => {
                            let ask = param(&url, "ask") == "1";
                            // Asking shows a system prompt on phones; answer the page once it is decided.
                            std::thread::spawn(move || {
                                let n = app.notification();
                                let mut state = n.permission_state().unwrap_or(PermissionState::Denied);
                                if ask && state != PermissionState::Granted && state != PermissionState::Denied {
                                    state = n.request_permission().unwrap_or(PermissionState::Denied);
                                }
                                let s = match state {
                                    PermissionState::Granted => "granted",
                                    PermissionState::Denied => "denied",
                                    _ => "prompt",
                                };
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.eval(&format!("window.__devdashPermission && window.__devdashPermission('{s}')"));
                                }
                            });
                        }
                        Some("switch") => {
                            // Navigate after this callback returns.
                            std::thread::spawn(move || {
                                let mut home = app.state::<Home>().0.clone();
                                home.set_query(Some("switch=1"));
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.navigate(home);
                                }
                            });
                        }
                        _ => {}
                    }
                    false
                });

            #[cfg(desktop)]
            let builder = {
                let new_win_app = app.handle().clone();
                builder
                    .title("DevDash")
                    .inner_size(1200.0, 800.0)
                    .min_inner_size(360.0, 560.0)
                    // window.open(): links go to the system browser instead of a stray in-app window.
                    .on_new_window(move |url, _features| {
                        if is_external(&url) {
                            let _ = new_win_app.opener().open_url(url.as_str(), None::<&str>);
                        }
                        tauri::webview::NewWindowResponse::Deny
                    })
            };

            let window = builder.build()?;
            // Match the page background to light/dark mode, so loading never flashes white in dark mode.
            let bg = match window.theme().unwrap_or(tauri::Theme::Light) {
                tauri::Theme::Dark => tauri::webview::Color(10, 10, 10, 255),
                _ => tauri::webview::Color(250, 250, 250, 255),
            };
            let _ = window.set_background_color(Some(bg));
            let home = window.url().ok().filter(|u| u.scheme() != "about").unwrap_or_else(|| Url::parse(BUNDLED_HOME).expect("valid URL"));
            app.manage(Home(home));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DevDash");
}
