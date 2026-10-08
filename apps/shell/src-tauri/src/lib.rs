// DevDash shell: a thin native window around a DevDash space.
// The bundled connect screen (../ui) asks for a space domain, checks /.well-known/devdash.json,
// then loads the space. The space gets no native permissions (no IPC capabilities); it can only ask the shell,
// through navigations to devdash-shell://, to open a link in the system browser or go back to the connect screen.
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// URL of the bundled connect screen, so "Switch space" can return to it from the space.
struct Home(Url);

const BRIDGE: &str = r#"
  window.devdashShell = {
    switchSpace() { location.href = 'devdash-shell://switch' },
    openExternal(url) { location.href = 'devdash-shell://open?u=' + encodeURIComponent(url) },
  };
"#;

fn is_external(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            app.manage(Home(window.url()?));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DevDash");
}
