/*
 * SLSD Shadowrocket settings bridge v3 (runtime-only).
 * Implements the installed SLSD and Location Spoofer settings contracts.
 * HTTPS requests reach this script ONLY after the client's TLS checks succeed.
 * No network calls, certificate overrides, or device-location success claims.
 */
(function () {
  "use strict";
  var VERSION = "slsd-runtime-bridge-v3";
  // This is the FIRST key read by the unchanged WLOC response patcher.
  var KEY = "locationSpoofer.settings.v1";
  var LEGACY_KEY = "slsd.location.settings.v1";
  var finished = false;

  function reply(status, value) {
    if (finished) return;
    finished = true;
    // http-request synthetic responses require the response envelope.
    $done({response:{status:status,headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
      "X-SLSD-Bridge":VERSION,
      "X-Content-Type-Options":"nosniff"
    },body:JSON.stringify(value)}});
  }
  function reject(message) {
    reply(400, {success:false,error:message,moduleVersion:VERSION});
  }
  function queryParams(url) {
    var result = Object.create(null);
    var q = url.indexOf("?");
    var parts = q < 0 ? [] : url.slice(q + 1).split("&");
    for (var i = 0; i < parts.length; i += 1) {
      if (!parts[i]) continue;
      var pos = parts[i].indexOf("=");
      var key = decodeURIComponent((pos < 0 ? parts[i] : parts[i].slice(0,pos)).replace(/\+/g," "));
      var val = decodeURIComponent((pos < 0 ? "" : parts[i].slice(pos+1)).replace(/\+/g," "));
      if (Object.prototype.hasOwnProperty.call(result,key)) throw new Error("Duplicate parameter: " + key);
      result[key] = val;
    }
    return result;
  }
  function numberValue(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string" || !value.trim()) return NaN;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return NaN;
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  function readSettings() {
    var raw = $persistentStore.read(KEY);
    if (!raw) raw = $persistentStore.read(LEGACY_KEY);
    if (!raw) return null;
    var saved = JSON.parse(raw);
    if (!saved || saved.enabled !== true) return null;
    var lat = numberValue(saved.latitude), lon = numberValue(saved.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      throw new Error("Stored coordinates are invalid; clear or save a valid target");
    }
    var acc = numberValue(saved.accuracy);
    return {success:true,enabled:true,latitude:lat,longitude:lon,
      accuracy:Number.isFinite(acc) && acc > 0 ? Math.max(1,Math.round(acc)) : 39,
      updatedAt:saved.updatedAt || null,moduleVersion:VERSION};
  }
  function saveVerified(value) {
    var raw = JSON.stringify(value);
    if (!$persistentStore.write(raw,KEY)) throw new Error("Settings write failed");
    if ($persistentStore.read(KEY) !== raw) throw new Error("Settings read-back failed");
  }

  try {
    var request = typeof $request === "undefined" ? {} : $request;
    var url = String(request.url || "");
    var apple = /^https?:\/\/gs-loc(?:-cn)?\.apple\.com\/wloc-settings\/(save|version)(?:\?[^#]*)?$/.exec(url);
    var alias = /^http:\/\/slsd\.local\/settings(?:\?[^#]*)?$/.test(url);
    if (!apple && !alias) { finished = true; $done({}); return; }
    if (String(request.method || "GET").toUpperCase() !== "GET") {
      reply(405,{success:false,error:"Only GET is supported",moduleVersion:VERSION}); return;
    }
    var params;
    try { params = queryParams(url); } catch (e) { reject("Invalid query: " + e.message); return; }
    if (apple && apple[1] === "version") {
      reply(200,{success:true,moduleVersion:VERSION,bridgeReady:true,systemLocationVerified:false}); return;
    }
    if (typeof $persistentStore === "undefined" || !$persistentStore.read || !$persistentStore.write) {
      reply(500,{success:false,error:"Shadowrocket persistent store is unavailable",moduleVersion:VERSION}); return;
    }
    var action = params.action === undefined ? "save" : params.action;
    if (action === "query") {
      var current = readSettings();
      // Location Spoofer's native decoder requires top-level coordinates.
      // Its inactive-state check explicitly recognises this upstream message.
      reply(200,current || {success:false,enabled:false,error:"无已保存的坐标",moduleVersion:VERSION}); return;
    }
    if (["save","set","clear"].indexOf(action) < 0) { reject("Unsupported action"); return; }
    if (params.enabled !== undefined && ["1","0","true","false"].indexOf(params.enabled) < 0) {
      reject("Invalid enabled flag"); return;
    }
    if (action === "clear" || params.enabled === "0" || params.enabled === "false") {
      // A nonempty disabled value prevents the patcher's legacy fallback from
      // resurrecting an older target. Do not report success without read-back.
      saveVerified({enabled:false,source:"slsd-shadowrocket-bridge",updatedAt:new Date().toISOString()});
      reply(200,{success:true,enabled:false,action:"clear",moduleVersion:VERSION}); return;
    }
    var lat = numberValue(params.lat), lon = numberValue(params.lon);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
      reject("lat and lon are required and must be valid coordinates"); return;
    }
    var accuracy = 39;
    if (params.acc !== undefined || params.accuracy !== undefined) {
      accuracy = numberValue(params.acc !== undefined ? params.acc : params.accuracy);
      if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 1000000) {
        reject("Accuracy must be greater than zero and at most 1000000 metres"); return;
      }
      if (params.acc !== undefined && params.accuracy !== undefined && numberValue(params.accuracy) !== accuracy) {
        reject("Conflicting acc and accuracy values"); return;
      }
      accuracy = Math.max(1,Math.round(accuracy));
    }
    if (params.randomRadius !== undefined && numberValue(params.randomRadius) !== 0) {
      reject("The unchanged SLSD patcher supports fixed coordinates only; randomRadius must be 0"); return;
    }
    saveVerified({enabled:true,latitude:lat,longitude:lon,accuracy:accuracy,
      source:"slsd-shadowrocket-bridge",updatedAt:new Date().toISOString()});
    reply(200,readSettings());
  } catch (e) {
    reply(500,{success:false,error:"SLSD bridge: " + e.message,moduleVersion:VERSION});
  }
}());
