// Copied over the generated MainActivity by .github/workflows/app-release.yml after `tauri android init`.
// Android back goes back through the page history like a native app, and only leaves the app at the first screen.
// The space can turn background notifications on and off (NotifyService); tapping one opens its page.
package io.github.abdvlrqhman.devdash

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "DevDashAndroid")
  }

  /** window.DevDashAndroid in the space's pages (lib/shell.ts). */
  inner class Bridge {
    @JavascriptInterface
    fun enableBackgroundNotifications(origin: String): Boolean {
      if (!origin.startsWith("https://")) return false
      NotifyService.enable(this@MainActivity, origin)
      return true
    }

    @JavascriptInterface
    fun disableBackgroundNotifications() = NotifyService.disable(this@MainActivity)

    @JavascriptInterface
    fun backgroundNotifications(): Boolean = NotifyService.enabled(this@MainActivity)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
          wv.goBack()
        } else {
          isEnabled = false
          onBackPressedDispatcher.onBackPressed()
        }
      }
    })
    NotifyService.start(this)
    openFrom(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    openFrom(intent)
  }

  /** A tapped notification carries its page; once the space has loaded, go there. */
  private fun openFrom(intent: Intent?) {
    val target = intent?.data ?: return
    if (target.scheme != "https") return
    val main = Handler(Looper.getMainLooper())
    var tries = 0
    main.post(object : Runnable {
      override fun run() {
        val wv = webView
        val current = wv?.url?.let { Uri.parse(it).host }
        if (wv != null && current == target.host) wv.loadUrl(target.toString())
        else if (++tries < 60) main.postDelayed(this, 250)
      }
    })
  }
}
