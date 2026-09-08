# Enigma2 integration hardening

Changes are local. No receiver communication, Homey installation, app run, commit,
push, release, or version change was performed.

## Changes and compatibility

- `app.js` registers Flow listeners once. Device cards dispatch via `args.device`;
  deprecated app-wide cards continue using the existing `enigma2_*` settings.
  All existing driver, capability, Flow, argument, token and paired-device IDs remain.
- `drivers/enigma2/device.js` serializes polling and control, cancels old connections
  on settings changes/deletion/uninitialization, restores programme fields after
  standby and compares actual capability values instead of stale caches. Availability
  is evaluated once per whole poll, with no synthetic startup transition.
- `lib/enigma2.js` shares bounded transport, protocol selection, input/response
  validation, entity decoding and idempotent mute handling. Requests have a 10-second
  deadline and 2 MiB response/image limit; images await stream completion. Redirects
  are rejected so a login redirect cannot masquerade as a working receiver.
- `lib/encoding.js` retains the previous UTF-8, central-European and ISO-6937 behavior.
- Pairing now holds settings per session, validates them in the backend, stores
  numeric settings as numbers, awaits the save acknowledgment and logs no passwords.
- Device Compose settings add `Protocol` and `AllowSelfSigned`. Missing values retain
  old behavior: port 443 uses HTTPS, other ports use HTTP, and untrusted HTTPS
  certificates remain allowed. Users can select HTTPS on any port and enable strict
  certificate verification. Existing device data and capabilities need no migration.
- `settings/settings.js`, `settings/index.html`, `api.js` and the Compose API routes
  move legacy connection testing to Homey, removing browser CORS/mixed-content and
  CDN dependencies. API routes retain Homey's default authentication. Readiness is
  immediate; DOM initialization is deferred safely. Validated saves apply to legacy
  Flows without restarting. Existing legacy connections default to HTTP as before.
- English, German and Dutch labels cover the new settings. Existing message-card
  arguments remain `type|timeout|text`; `&`, `#`, Unicode and additional pipes survive.
- `package.json` and its lockfile upgrade Axios 1.6.5 to 1.20.0 and update vulnerable
  transitive dependencies within compatible ranges. The unused production
  `node-fetch` dependency is removed. ESLint 8.56.0 and Homey types 0.3.5 are retained;
  ESLint recommended rules and executable regression tests are enabled. There is no
  new direct production dependency. An obsolete Axios declaration was removed from
  the Homey Compose manifest; npm dependencies are defined by `package.json`.
- Some dependency files are tracked by this repository. Their npm-generated updates
  are part of the local diff; they were checked against lockfile-integrity-verified
  published archives. Run `npm ci` when recreating the checkout's dependency tree.

## Local verification

- `npm run check`: Node syntax checks of application, test and helper JavaScript;
  embedded pairing scripts and all relevant JSON are also parsed.
- `npm run lint`: ESLint recommended rules, including undefined and unused variables.
- `npm test`: 30 passing isolated Node tests for routing, legacy compatibility, rejection paths,
  mute serialization, request deadlines/cancellation, image stream errors/limits,
  polling lifecycle, stale-update prevention, pairing isolation, encoding, settings
  lifecycle and translations. All HTTP and Homey interactions are mocked.
- `npm audit --omit=dev` and `npm audit`: zero reported vulnerabilities after updates.
- `homey app validate` and `homey app validate --level publish`: package validation;
  Compose regenerates `app.json` and `.homeybuild`. No files there are hand-edited.
- `git diff --check -- . ':!node_modules'`: application changes pass whitespace checks.
  The unrestricted check reports only upstream trailing spaces in the npm-published
  `node_modules/axios/MIGRATION_GUIDE.md`. This third-party file was deliberately
  preserved byte-for-byte rather than hand-edited.
- Node 12.22.12 imports of the shared CommonJS client and Axios 1.20.0 pass. The main
  test suite runs on local Node 24.15.0; these checks do not simulate a Homey runtime.
- No separate compilation/build is configured: this is a JavaScript Homey SDK v3 app.
  No physical integration test or deployment was authorized, so those were skipped.

## Manual Homey smoke test — not yet performed

1. Run the app on a test Homey when ready. Confirm startup has no SDK/export errors
   and existing paired devices initialize without re-pairing. Confirm the first poll
   does not spuriously fire an availability Flow.
2. With two receivers A and B, run each device Flow against A, then B. Start with
   harmless remote keys and standby/wake. Verify only the selected receiver changes.
   Exercise reboot/deep-standby/restart cards only when it is acceptable to interrupt
   the selected receiver. Check both forms of the device standby condition.
3. Run pre-existing deprecated volume/standby/message Flows. Verify they still target
   the app-wide receiver, including when it differs from both paired receivers.
4. Repeatedly request mute, then unmute, through capabilities and existing Flows.
   Repeat requests concurrently. Confirm the requested final state, volume up/down
   and absolute volume, including after changing volume on the physical remote.
5. Check channel up/down, next/previous, play/pause and wake-for-play. Put a receiver
   in standby and immediately wake into the same show: its labels and playing state
   must recover. Check Czech/Slovak titles, empty EPG and zero-duration events.
6. Send `1|10|A&B # č | tail` and confirm the entire text appears. Send `1|0|Test`
   and verify the receiver's zero-timeout behavior. Invalid formats must fail clearly.
7. Pair with HTTP, normal HTTPS and HTTPS on a custom port. Check strict certificate
   verification with a trusted certificate, rejection of an untrusted certificate,
   and compatibility mode with the receiver's self-signed certificate. Invalid
   addresses/ports/poll intervals, wrong credentials and HTML login responses must
   fail. Pair two sessions with different settings without cross-contamination.
8. Temporarily make the test receiver unreachable. Confirm actions report an error
   within the request deadline once dispatched, polling remains bounded and a single
   unavailable transition fires. Restore it and confirm one available transition.
   Repeated failed polls must not alternate available/unavailable.
9. Change connection settings and poll interval while a poll is pending. Confirm old
   replies do not overwrite the new receiver state. Restart the app, then delete a
   test device: no duplicate polling, orphaned downloads or unhandled errors should
   remain. Test a missing/interrupted picon image; the app must stay responsive.
10. Open app settings, including from the remote Homey UI. Verify readiness, loading,
    backend connection test, validated save, and legacy Flow operation immediately
    after saving. Confirm logs/browser console do not contain passwords or full
    credential-bearing request objects.

Runtime behavior remains unverified until these relevant physical scenarios pass.
