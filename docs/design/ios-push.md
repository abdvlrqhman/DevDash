# iPhone app notifications while it's closed (APNs)

> **Status (2026-10-23):** dormant. The team has no paid Apple developer account and installs the iPhone app with a
> sideloading service, which re-signs it with that service's account — so Apple push can't reach it. The admin page
> for the Apple key (Account → iPhone app notifications, `ApnsSetup.tsx`) was removed; restore it from git history
> (commit a272511) with a paid account. Meanwhile iPhones get notifications while DevDash is closed through ntfy
> (apps/server/src/modules/notifications/ntfy.ts).

**Status:** built, not yet run on a device (needs a paid Apple account and a signed build; see "Untested").
The native iPhone app gets DevDash's notifications in real time while it's closed or suspended, through Apple's push
service (APNs), the only way iOS lets an app be woken for that. Before this it only showed them while it ran (local
notifications from the page, through the shell bridge). Browsers keep Web Push; Android keeps its own stream.

## The constraint: a paid Apple Developer Program account

- APNs needs the `aps-environment` entitlement, granted by a provisioning profile for an App ID with Push
  Notifications. Apple's capability table lists Push notifications for Apple Developer Program and Enterprise members
  only, not for the free "Apple Developer" (Apple ID) tier, which also "can't distribute apps"
  ([supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)).
  The program is 99 USD a year ([what's included](https://developer.apple.com/programs/whats-included/)).
- AltStore and SideStore sign with the user's own Apple ID and use the entitlements of the profile they get, not the
  app's ([AltSign `ALTSigner.mm`](https://github.com/rileytestut/AltSign/blob/master/AltSign/Signing/ALTSigner.mm)
  signs with `profile.entitlements`); they also rename the bundle ID per team
  ([AltStore `ResignAppOperation.swift`](https://github.com/altstoreio/AltStore/blob/develop/AltStore/Operations/ResignAppOperation.swift)).
  With a free Apple ID that profile has no push, so a sideloaded copy can't get a token. Even a paid account through
  AltStore doesn't help: it only enables app groups and inter-app audio on the App IDs it makes
  ([`ALTCapabilities.m`](https://github.com/rileytestut/AltSign/blob/master/AltSign/Capabilities/ALTCapabilities.m)).
  So the signed build must be installed directly, not through AltStore or SideStore.
- There is no way to get real pushes *from this app* on a free account. The free options:
  - **DevDash on the Home Screen** (Safari → Share → Add to Home Screen): Web Push, real time, already built
    (`apps/web/src/lib/push.ts`, iOS 16.4+). The best free route.
  - Background App Refresh (`BGAppRefreshTask`) to poll the server: not real time. "The system decides the best time to
    launch your background task" and gives it up to 30 seconds
    ([choosing background strategies](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app));
    it can be hours, and never after the user swipes the app away. Not built.
  - A push app from the App Store as a relay (e.g. ntfy): real time, free, but the notification comes from that app.
    Not built.

## Distribution routes that keep push

| Route | Profile | APNs | Install | Limits |
| --- | --- | --- | --- | --- |
| Ad hoc | Ad Hoc (Distribution certificate + registered device UDIDs) | production | Apple Configurator or Xcode on a Mac, or an `itms-services://` link to a manifest on HTTPS | 100 devices per product family per membership year ([devices](https://developer.apple.com/help/account/devices/devices-overview)); profile and certificate renewed yearly |
| TestFlight | App Store (Distribution certificate) | production | TestFlight app, from an invite | builds expire after 90 days ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)); internal testers (up to 100 team members) need no review, external ones do ([TestFlight](https://developer.apple.com/testflight/)) |
| Development | Development (Development certificate + UDIDs) | sandbox | Xcode / Device Hub / Apple Configurator; Developer Mode on the phone ([Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)) | for testing |

Without a Mac, TestFlight is the easiest: CI uploads the build and the phone installs and updates it from the
TestFlight app.

## Shape

```
DevDash server ── notify() ──► Web Push (browsers)        hub: skipped while the member is using DevDash, except Test
      │                    ├─► stream (Android app)
      │                    └─► apns.deliver ── HTTP/2, JWT (ES256, .p8) ──► api(.sandbox).push.apple.com ──► iPhone
      │                                                                                                   │
      └◄── POST /api/notifications/apns {token, environment} ◄── page (signed in) ◄── shell ◄── plugin ◄──┘ token
                                                                                     tap ──► open the page's URL
```

- **Server** (`apps/server/src/modules/notifications/apns.ts`): Apple's provider API with `node:http2` and
  `node:crypto`, no dependency. One HTTP/2 connection per environment, reused (Apple: "reuse a connection as long as
  possible"), reopened after GOAWAY, errors, or an idle hour. Token auth: a JWT `{alg: ES256, kid}.{iss: team, iat}`
  signed with the .p8 key, renewed every 50 minutes (Apple: refresh no more than once every 20 minutes and no less than
  once every 60; older than an hour is `ExpiredProviderToken`)
  ([token-based connection](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)).
  Requests: `POST /3/device/<token>`, `apns-topic` = bundle ID, `apns-push-type: alert`, `apns-priority: 10`,
  `apns-expiration` = an hour (like Web Push's TTL), `apns-collapse-id` = the notification's tag (64 bytes max, like
  Web Push's tag); payload `{aps: {alert: {title, body}, sound, thread-id}, url, id}` under 4 KB
  ([sending requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
  [payload](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification)).
- **Answers** ([responses](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns)):
  200 marks the device OK. 410 `Unregistered`/`ExpiredToken` deletes the token, unless the phone registered it again
  after Apple's `timestamp`. 400 `BadDeviceToken` ("…matches the environment") is tried once in the other environment:
  it moves there if that works, and is deleted if neither knows it. Key and topic errors (`InvalidProviderToken`,
  `BadEnvironmentKeyIdInToken`, `DeviceTokenNotForTopic`, …) never delete devices; they're kept as `last_error` for the
  admin section and cleared by the next success. 429 and 5xx are logged and dropped, like a Web Push that fails.
- **Tables** (`migrations/041_apns.sql`): `apns_config` (one row: team, key ID, sealed .p8, bundle ID, last error) and
  `apns_devices` (token, environment, member). A token moves to whoever signs in on that phone; signing out or turning
  it off forgets it; removing a member cascades.
- **App** (`apps/shell/plugins/devdash-push`): a local Tauri plugin whose Swift package (`ios/`) the plugin's build
  script compiles and links, like Tauri's own mobile plugins, so it survives `tauri ios init` as any dependency does.
  - Registers at every launch (Apple: "register your app and receive your device token each time your app launches";
    never cache tokens) ([registering](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)).
  - Tauri's (tao's) app delegate has no remote-notification callbacks; the plugin adds them to its class at runtime
    (`class_addMethod`, chained to any existing implementation), as the community push plugins do.
  - Takes the `UNUserNotificationCenter` delegate when the plugin is created, before launch finishes (Apple: assign it
    "before your app finishes launching" or taps that launch the app are missed)
    ([delegate](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate)). DevDash's
    pushes show in the foreground too; a tap reports the payload's `url`. Local notifications are forwarded to the
    previous delegate (tauri-plugin-notification).
  - The environment comes from the app's own `embedded.mobileprovision` (`aps-environment` development → sandbox,
    production → production; no profile = TestFlight/App Store = production). A profile without it means a build
    signed without push: the app reports `no-entitlement` instead of asking Apple.
- **Shell** (`apps/shell/src-tauri/src/ios_push.rs`): the space's page still has no IPC. On every space page load,
  and whenever the token changes, the shell sets `window.__devdashPushState` and fires a `devdash-push` event;
  `devdashShell.registerPush()` asks Apple again. A tap opens its page at once if that space is loaded, or once it
  has loaded after a cold start (https, same host, within two minutes).
- **Page** (`apps/web/src/lib/ios-push.ts`, `features/notifications`): registers the token for the signed-in member
  at each start and on change, unless notifications are off on this device. Account → Notifications says what reaches
  the phone while closed, and why not. While Apple push is on, the page doesn't post its own system notification
  (`deliver`), so nothing shows twice. Admins get **Account → iPhone app notifications** (`ApnsSetup.tsx`).
- **CI** (`.github/workflows/app-release.yml`, `apps/shell/ios/prepare.sh`): with the signing secrets, a signed IPA;
  without them, the unsigned IPA as before. `prepare.sh` reads the provisioning profile after `tauri ios init`, checks
  its App ID and Push Notifications, writes `aps-environment` into the generated entitlements exactly as the profile
  allows, and picks the export method from it (development → `debugging`, ad hoc → `release-testing`, App Store →
  `app-store-connect`). Tauri signs manually with `IOS_CERTIFICATE`, `IOS_CERTIFICATE_PASSWORD` and
  `IOS_MOBILE_PROVISION` ([Tauri iOS signing](https://v2.tauri.app/distribute/sign/ios/)). The job fails if the
  shipped app lacks `aps-environment`. `src-tauri/Info.ios.plist` (merged by `tauri ios build`) declares
  `ITSAppUsesNonExemptEncryption = false` (HTTPS only) so TestFlight doesn't ask each time.

## Setup

1. **Apple Developer Program** membership for the team that signs the app.
2. **App ID**: in [Identifiers](https://developer.apple.com/account/resources/identifiers/list), register
   `io.github.abdvlrqhman.devdash` (the `identifier` in `apps/shell/src-tauri/tauri.conf.json`; change both if you
   use your own) with **Push Notifications** on.
3. **APNs key**: in [Keys](https://developer.apple.com/account/resources/authkeys/list), add a key with Apple Push
   Notifications service, configured Team Scoped and for Sandbox & Production (at least Production: ad hoc and
   TestFlight builds use it). Download `AuthKey_<Key ID>.p8` (only once). Team ID: Membership details.
4. **In DevDash**, as an admin: Account → **iPhone app notifications** → choose the .p8 file (the Key ID fills in from
   its name), enter the Team ID, keep the bundle ID, Save.
5. **Distribution certificate** (`.p12`): in [Certificates](https://developer.apple.com/account/resources/certificates/list)
   add an Apple Distribution certificate. Without a Mac, make the request with openssl:
   ```
   openssl genrsa -out dist.key 2048
   openssl req -new -key dist.key -out dist.csr -subj "/emailAddress=you@example.com/CN=Your Name/C=US"
   # upload dist.csr, download distribution.cer, then:
   openssl x509 -inform DER -in distribution.cer -out dist.pem
   openssl pkcs12 -export -legacy -inkey dist.key -in dist.pem -out dist.p12   # -legacy: macOS's keychain imports it
   ```
6. **Provisioning profile** in [Profiles](https://developer.apple.com/account/resources/profiles/list), for the App ID
   above with that certificate:
   - **Ad Hoc** for direct installs: register each iPhone's UDID first (Devices), include them in the profile.
   - **App Store** for TestFlight: also create the app in [App Store Connect](https://appstoreconnect.apple.com/apps)
     with this bundle ID, and an App Store Connect API key (Users and Access → Integrations, role App Manager or
     Admin; a different key from the APNs one).
7. **GitHub secrets** (repository → Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `IOS_CERTIFICATE` | `base64 -w0 dist.p12` (macOS: `base64 -i dist.p12`) |
   | `IOS_CERTIFICATE_PASSWORD` | the .p12 export password |
   | `IOS_MOBILE_PROVISION` | `base64 -w0 profile.mobileprovision` |
   | `APP_STORE_CONNECT_KEY` | optional, TestFlight: `base64 -w0 AuthKey_<id>.p8` of the App Store Connect API key |
   | `APP_STORE_CONNECT_KEY_ID` | optional, TestFlight: that key's ID |
   | `APP_STORE_CONNECT_ISSUER_ID` | optional, TestFlight: the Issuer ID shown above the keys |

8. **Release** as usual (tag `app-vX.Y.Z` or run App release). The release gets `DevDash-X.Y.Z.ipa` instead of the
   unsigned one; with an App Store profile and the API key it also goes to TestFlight (add yourself as an internal
   tester; builds expire after 90 days, so each release renews it).
9. **Install** without AltStore or SideStore (they re-sign it without push): TestFlight; or for ad hoc, Apple
   Configurator / Xcode on a Mac, or an `itms-services://?action=download-manifest&url=https://…/manifest.plist` link.
   Open the app, sign in, Account → Notifications on this device → on. It should say "Arrive even when the app is
   closed"; Send a test notification, close the app, and try a real one.

## Limits and untested

- Not yet run on a device or built in CI: the Swift plugin, the Rust bridge, and the signed CI path were written
  against Tauri 2.12's sources and checked by review only (no Swift, Xcode or Rust toolchain on the server). The
  server side is unit-tested with a fake transport, the HTTP/2 transport against a local h2c server, and was checked
  once against Apple (a throwaway key gets `403 InvalidProviderToken` from both hosts).
- One APNs key per space. A key limited to one environment can't reach builds of the other; the admin section says so
  (`BadEnvironmentKeyIdInToken`). Use a Sandbox & Production key, or a Production one with ad hoc/TestFlight builds.
- The TestFlight step uses `xcrun altool --upload-app`, which Apple marks deprecated in favour of `--upload-package`
  but still accepts.
- iPad: WKWebView may present itself as a Mac, so the page's iPhone-only wording may not show there; Apple push
  itself doesn't depend on it (the app reports whether it supports it).
