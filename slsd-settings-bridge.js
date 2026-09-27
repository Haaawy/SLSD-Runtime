/*
 * SLSD Shadowrocket settings bridge.
 * Uses plain HTTP only as a local interception trigger; no request needs to reach a server.
 * Example:
 * http://slsd.local/settings?lat=24.4686&lon=39.6142&accuracy=39&enabled=1
 */
(function () {
  "use strict";
  var KEY = "slsd.location.settings.v1";

  function param(url, name) {
    var m = String(url || "").match(new RegExp("[?&]" + name + "=([^&#]*)"));
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }
  function reply(code, body) {
    $done({response:{status:code,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"},body:body}});
  }

  try {
    var url = ($request && $request.url) || "";
    var action = param(url, "action") || "set";

    if (action === "query") {
      var current = $persistentStore.read(KEY);
      reply(200, current || "{\"enabled\":false}");
      return;
    }
    if (action === "clear") {
      $persistentStore.write("", KEY);
      reply(200, "SLSD settings cleared");
      return;
    }

    var lat = Number(param(url, "lat"));
    var lon = Number(param(url, "lon"));
    var accuracy = Number(param(url, "accuracy"));
    var enabledRaw = param(url, "enabled");
    var enabled = enabledRaw !== "0" && enabledRaw !== "false";

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lon) || lon < -180 || lon > 180) {
      reply(400, "Invalid SLSD coordinates");
      return;
    }
    if (!Number.isFinite(accuracy) || accuracy <= 0) accuracy = 39;

    var value = JSON.stringify({
      enabled: enabled,
      latitude: lat,
      longitude: lon,
      accuracy: accuracy,
      source: "slsd-shadowrocket-bridge",
      updatedAt: new Date().toISOString()
    });

    if (!$persistentStore.write(value, KEY)) {
      reply(500, "Failed to save SLSD settings");
      return;
    }
    reply(200, "SLSD settings saved: " + lat.toFixed(8) + "," + lon.toFixed(8));
  } catch (e) {
    reply(500, "SLSD bridge error: " + e.message);
  }
}());
