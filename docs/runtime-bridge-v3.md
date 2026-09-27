# Runtime bridge v3 — scope and verification

## Proven runtime defects

The previous module matched only `http://slsd.local/settings` for requests. It did not match the installed clients' `/wloc-settings/save` and `/wloc-settings/version` URLs on `gs-loc.apple.com`.

The previous bridge returned top-level response fields rather than an `http-request` synthetic-response envelope. It wrote only `slsd.location.settings.v1`, even though the unchanged patcher first reads `locationSpoofer.settings.v1`; an existing canonical target could therefore win. Missing coordinates were coerced by `Number(null)` to zero, clear did not check write success, and query nested the coordinates although the native client expects top-level fields.

## Changes

- Restore narrowly scoped save/version request interception on `gs-loc.apple.com` and `gs-loc-cn.apple.com`; retain the old HTTP alias only for compatibility.
- Return `$done({response:{status,headers,body}})` and JSON contracts for version, save, query and clear.
- Write and read back the patcher's primary key. Store a disabled marker on clear so an older fallback target cannot reactivate.
- Reject missing/invalid coordinates, duplicate parameters, invalid accuracy, unknown actions and unsupported nonzero randomRadius. Preserve zero coordinates. Return integer accuracy for the native decoder.
- Add a version marker and a script URL revision to distinguish cached older scripts.

`location-spoofer-dynamic.js`, its binary response handling, the `/clls/wloc` response rule and the MITM hostname list are unchanged. No application code, IPA, certificate, routing policy or trust check is changed. No remote fetch occurs in the bridge itself.

## Local tests — not an iPhone result

Run `node tests/runtime-bridge.test.cjs` from the repository root. No install, build or CI workflow is required.

55 contract tests passed locally under Node.js v22.16.0. The same target-contract suite against the previous module/bridge passed 16 and failed 39; some expectations describe the v3 contract rather than previously promised features. Test doubles cover the JavaScript API shape, URL rules and persistent store, not Shadowrocket's actual interpreter or Apple's TLS implementation.

## Device acceptance

After `Config > Modules > Update Modules`, reconnect Shadowrocket and keep the existing trusted CA and HTTPS Decryption enabled. In Safari, request the following read-only endpoint without bypassing a certificate warning:

`https://gs-loc.apple.com/wloc-settings/version`

The expected JSON identifies `slsd-runtime-bridge-v3`, with `success:true` and `systemLocationVerified:false`. This proves request interception in that client only. Then `/wloc-settings/save?lat=<latitude>&lon=<longitude>&acc=39` saves an explicitly selected target, `?action=query` reads it back, and `?action=clear` disables rewriting. Disable Random Radius when using this fixed-coordinate patcher.

TLS must succeed before a request script can run. Restoring these rules does not fix or bypass an app's certificate-validation failure. The inspected upstream native client already uses URLSession without a custom delegate in its ThirdPartyProxyManager; replacing Dart with URLSession is not a proven solution. A Safari success is not proof that another app or the system location service accepts the same certificate. Actual `/clls/wloc` rewriting and device-location change still require on-device evidence. Do not reinstall certificates repeatedly based on a missing module response.

The legacy `.local` alias has not been proven to work on the device; use the established Apple-host endpoint for the read-only test above. No TLS error is treated as a successful command.
