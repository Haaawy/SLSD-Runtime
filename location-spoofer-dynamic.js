/*
 * Dynamic Shadowrocket Apple WLOC spoofer.
 * Core response patching logic derived from batqwq/shadowrocket-location-spoofer
 * and adapted to read xweiba Location Spoofer coordinates from Shadowrocket
 * $persistentStore key: locationSpoofer.settings.v1
 */
(function () {
  "use strict";

  var STORE_KEY = "locationSpoofer.settings.v1";
  var DEFAULTS = {
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 530,
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    failOpen: true,
    debug: true
  };

  var APPLE_WLOC_PREFIX = bytesFromArray([0x00,0x01,0x00,0x00,0x00,0x01,0x00,0x00]);
  var APPLE_WLOC_MARKER = bytesFromArray([0x00,0x00,0x00,0x01,0x00,0x00]);
  var ROOT_DROP_FIELDS = {3:true,4:true,33:true};
  var CELL_RESPONSE_FIELDS = {22:true,24:true};
  var LOCATION_REPLACED_FIELDS = {1:true,2:true,3:true,4:true,5:true,6:true,11:true,12:true};

  function bytesFromArray(v){ return new Uint8Array(v); }
  function concatBytes(parts){
    var total=0,i,offset=0;
    for(i=0;i<parts.length;i+=1) total+=parts[i].length;
    var out=new Uint8Array(total);
    for(i=0;i<parts.length;i+=1){ out.set(parts[i],offset); offset+=parts[i].length; }
    return out;
  }
  function findBytes(bytes, marker){
    if(!bytes||!marker||!marker.length) return -1;
    for(var i=0;i<=bytes.length-marker.length;i+=1){
      var ok=true;
      for(var j=0;j<marker.length;j+=1){ if(bytes[i+j]!==marker[j]){ok=false;break;} }
      if(ok) return i;
    }
    return -1;
  }
  function binaryStringToBytes(value){
    var out=new Uint8Array(value.length);
    for(var i=0;i<value.length;i+=1) out[i]=value.charCodeAt(i)&0xff;
    return out;
  }
  function bodyToBytes(body){
    if(body==null) return null;
    if(body instanceof Uint8Array) return body;
    if(typeof ArrayBuffer!=="undefined" && body instanceof ArrayBuffer) return new Uint8Array(body);
    if(typeof body==="string") return binaryStringToBytes(body);
    if(typeof body==="object" && typeof body.length==="number") return new Uint8Array(body);
    if(typeof body==="object" && body.bytes && typeof body.bytes.length==="number") return new Uint8Array(body.bytes);
    if(typeof body==="object" && body.data && typeof body.data.length==="number") return new Uint8Array(body.data);
    return null;
  }
  function messageBodyToBytes(message){
    if(!message) return null;
    return bodyToBytes(message.bodyBytes)||bodyToBytes(message.body)||bodyToBytes(message.rawBody)||bodyToBytes(message.binaryBody);
  }
  function readUInt16BE(bytes,off){ if(off+2>bytes.length) throw new Error("uint16 out of range"); return (bytes[off]<<8)|bytes[off+1]; }
  function readUInt32BE(bytes,off){
    if(off+4>bytes.length) throw new Error("uint32 out of range");
    return ((bytes[off]*0x1000000)+((bytes[off+1]<<16)|(bytes[off+2]<<8)|bytes[off+3]))>>>0;
  }
  function writeUInt16BE(v){ if(v<0||v>0xffff) throw new Error("uint16 out of range"); return bytesFromArray([(v>>8)&255,v&255]); }
  function writeUInt32BE(v){ return bytesFromArray([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]); }
  function asciiBytes(s){ var out=new Uint8Array(s.length); for(var i=0;i<s.length;i+=1) out[i]=s.charCodeAt(i)&0x7f; return out; }
  function encodeVarintUnsigned(value){
    var v=typeof value==="bigint"?value:BigInt(value), out=[];
    if(v<0n) throw new Error("negative unsigned varint");
    while(v>=0x80n){ out.push(Number((v&0x7fn)|0x80n)); v>>=7n; }
    out.push(Number(v)); return bytesFromArray(out);
  }
  function encodeVarintSignedInt64(value){
    var v=typeof value==="bigint"?value:BigInt(Math.trunc(value));
    if(v<0n) v=BigInt.asUintN(64,v);
    return encodeVarintUnsigned(v);
  }
  function decodeVarint(bytes,offset){
    var result=0n,shift=0n,current=offset;
    while(current<bytes.length){
      var b=bytes[current++]; result|=BigInt(b&0x7f)<<shift;
      if((b&0x80)===0) return {value:result,offset:current};
      shift+=7n; if(shift>70n) throw new Error("varint too long");
    }
    throw new Error("unterminated varint");
  }
  function makeKey(n,w){ return encodeVarintUnsigned((BigInt(n)<<3n)|BigInt(w)); }
  function makeVarintField(n,v){ return concatBytes([makeKey(n,0),encodeVarintSignedInt64(v)]); }
  function makeLengthDelimitedField(n,p){ return concatBytes([makeKey(n,2),encodeVarintUnsigned(p.length),p]); }

  function parseFields(bytes){
    var fields=[],offset=0;
    while(offset<bytes.length){
      var keyStart=offset,key=decodeVarint(bytes,offset); offset=key.offset;
      var fieldNumber=Number(key.value>>3n),wireType=Number(key.value&7n);
      if(fieldNumber===0) throw new Error("protobuf field number 0");
      var valueStart=offset,valueEnd;
      if(wireType===0) valueEnd=decodeVarint(bytes,offset).offset;
      else if(wireType===1) valueEnd=offset+8;
      else if(wireType===2){ var li=decodeVarint(bytes,offset),len=Number(li.value); valueStart=li.offset; valueEnd=valueStart+len; }
      else if(wireType===5) valueEnd=offset+4;
      else throw new Error("unsupported protobuf wire type: "+wireType);
      if(valueEnd>bytes.length) throw new Error("protobuf field exceeds buffer");
      fields.push({fieldNumber:fieldNumber,wireType:wireType,raw:bytes.slice(keyStart,valueEnd),valueBytes:bytes.slice(valueStart,valueEnd)});
      offset=valueEnd;
    }
    return fields;
  }
  function tryParseFields(bytes){ try{ if(!bytes||!bytes.length) return null; var f=parseFields(bytes); return f.length?f:null; }catch(e){ return null; } }
  function firstFieldByNumber(fields,n){ for(var i=0;i<fields.length;i+=1) if(fields[i].fieldNumber===n) return fields[i]; return null; }
  function signedVarintFieldValue(field){ if(!field||field.wireType!==0) return null; return BigInt.asIntN(64,decodeVarint(field.valueBytes,0).value); }
  function locationSummary(payload){
    try{
      var f=parseFields(payload),lat=signedVarintFieldValue(firstFieldByNumber(f,1)),lon=signedVarintFieldValue(firstFieldByNumber(f,2));
      if(lat==null||lon==null) return "<missing>";
      return (Number(lat)/1e8).toFixed(8)+","+(Number(lon)/1e8).toFixed(8);
    }catch(e){ return "<parse-failed>"; }
  }

  function coordToInt(v){ return Math.round(Number(v)*100000000); }
  function isCellResponseField(n){ return CELL_RESPONSE_FIELDS[n]===true; }
  function firstCellResponseField(fields){ for(var i=0;i<fields.length;i+=1) if(isCellResponseField(fields[i].fieldNumber)) return fields[i]; return null; }

  function patchLocation(payload,cfg){
    var parts=[],fields=payload.length?parseFields(payload):[];
    for(var i=0;i<fields.length;i+=1) if(!LOCATION_REPLACED_FIELDS[fields[i].fieldNumber]) parts.push(fields[i].raw);
    parts.push(makeVarintField(1,coordToInt(cfg.latitude)));
    parts.push(makeVarintField(2,coordToInt(cfg.longitude)));
    parts.push(makeVarintField(3,cfg.horizontalAccuracy));
    parts.push(makeVarintField(4,cfg.unknownValue4));
    parts.push(makeVarintField(5,cfg.altitude));
    parts.push(makeVarintField(6,cfg.verticalAccuracy));
    parts.push(makeVarintField(11,cfg.motionActivityType));
    parts.push(makeVarintField(12,cfg.motionActivityConfidence));
    return concatBytes(parts);
  }
  function patchWifiDevice(payload,cfg){
    var fields=parseFields(payload),parts=[],patched=false;
    for(var i=0;i<fields.length;i+=1){
      var f=fields[i];
      if(f.fieldNumber===2&&f.wireType===2){ parts.push(makeLengthDelimitedField(2,patchLocation(f.valueBytes,cfg))); patched=true; }
      else parts.push(f.raw);
    }
    if(!patched) parts.push(makeLengthDelimitedField(2,patchLocation(bytesFromArray([]),cfg)));
    return concatBytes(parts);
  }
  function patchCellTower(payload,cfg){
    var fields=parseFields(payload),parts=[],patched=false;
    for(var i=0;i<fields.length;i+=1){
      var f=fields[i];
      if(f.fieldNumber===5&&f.wireType===2){ parts.push(makeLengthDelimitedField(5,patchLocation(f.valueBytes,cfg))); patched=true; }
      else parts.push(f.raw);
    }
    if(!patched) parts.push(makeLengthDelimitedField(5,patchLocation(bytesFromArray([]),cfg)));
    return concatBytes(parts);
  }
  function patchAppleWLocPayload(payload,cfg){
    var fields=parseFields(payload),parts=[],wifiCount=0,cellCount=0;
    for(var i=0;i<fields.length;i+=1){
      var f=fields[i];
      if(f.fieldNumber===2&&f.wireType===2){ parts.push(makeLengthDelimitedField(2,patchWifiDevice(f.valueBytes,cfg))); wifiCount+=1; }
      else if(isCellResponseField(f.fieldNumber)&&f.wireType===2){ parts.push(makeLengthDelimitedField(f.fieldNumber,patchCellTower(f.valueBytes,cfg))); cellCount+=1; }
      else if(!ROOT_DROP_FIELDS[f.fieldNumber]) parts.push(f.raw);
    }
    return {payload:concatBytes(parts),wifiCount:wifiCount,cellCount:cellCount};
  }

  function readPascalString(bytes,state){
    var len=readUInt16BE(bytes,state.offset); state.offset+=2;
    if(state.offset+len>bytes.length) throw new Error("ARPC pascal string exceeds buffer");
    var chars=[]; for(var i=0;i<len;i+=1) chars.push(String.fromCharCode(bytes[state.offset+i]));
    state.offset+=len; return chars.join("");
  }
  function writePascalString(v){ var b=asciiBytes(v); return concatBytes([writeUInt16BE(b.length),b]); }
  function parseArpc(bytes){
    var s={offset:0},version=readUInt16BE(bytes,s.offset); s.offset+=2;
    var locale=readPascalString(bytes,s),appIdentifier=readPascalString(bytes,s),osVersion=readPascalString(bytes,s);
    var functionId=readUInt32BE(bytes,s.offset); s.offset+=4;
    var payloadLength=readUInt32BE(bytes,s.offset); s.offset+=4;
    if(s.offset+payloadLength>bytes.length) throw new Error("ARPC payload exceeds buffer");
    return {version:version,locale:locale,appIdentifier:appIdentifier,osVersion:osVersion,functionId:functionId,payload:bytes.slice(s.offset,s.offset+payloadLength)};
  }
  function serializeArpc(a){ return concatBytes([writeUInt16BE(a.version),writePascalString(a.locale),writePascalString(a.appIdentifier),writePascalString(a.osVersion),writeUInt32BE(a.functionId),writeUInt32BE(a.payload.length),a.payload]); }
  function buildAppleWLocResponse(payload,prefix){ return concatBytes([prefix||APPLE_WLOC_PREFIX,writeUInt16BE(payload.length),payload]); }

  function extractPrefixedAppleWLocPayload(bytes){
    if(!bytes||bytes.length<10||bytes[0]!==0||bytes[1]!==1||bytes[6]!==0||bytes[7]!==0) return null;
    var len=readUInt16BE(bytes,8),off=10;
    if(len<=0||off+len>bytes.length) return null;
    var payload=bytes.slice(off,off+len);
    if(tryParseFields(payload)===null) return null;
    return {kind:"synthetic",payload:payload,prefix:bytes.slice(0,8),suffix:bytes.slice(off+len)};
  }
  function looksLikeAppleWLocPayload(bytes){
    if(!bytes||!bytes.length) return false;
    var tag=bytes[0],fieldNumber=tag>>3,wireType=tag&7;
    return fieldNumber>0&&(wireType===0||wireType===2);
  }
  function extractAppleWLocPayload(bytes){
    if(!bytes||bytes.length<2) throw new Error("Apple WLoc response too short");
    var prefixed=extractPrefixedAppleWLocPayload(bytes); if(prefixed) return prefixed;
    try{
      var arpc=parseArpc(bytes);
      if(arpc.payload.length>0&&tryParseFields(arpc.payload)!==null) return {kind:"arpc",payload:arpc.payload,arpc:arpc};
    }catch(e){}
    var idx=findBytes(bytes,APPLE_WLOC_MARKER);
    if(idx>=0){
      var lenOff=idx+APPLE_WLOC_MARKER.length;
      if(lenOff+2<=bytes.length){
        var realLen=readUInt16BE(bytes,lenOff),payloadOff=lenOff+2;
        if(realLen>0&&payloadOff+realLen<=bytes.length){
          var candidate=bytes.slice(payloadOff,payloadOff+realLen);
          if(tryParseFields(candidate)!==null) return {kind:"marker",payload:candidate,prefix:bytes.slice(0,idx),markerAndLen:bytes.slice(idx,payloadOff),suffix:bytes.slice(payloadOff+realLen)};
        }
      }
    }
    if(looksLikeAppleWLocPayload(bytes)) return {kind:"bare",payload:bytes};
    throw new Error("missing Apple WLoc response prefix");
  }

  function spoofAppleResponse(responseBytes,cfg){
    var ex=extractAppleWLocPayload(responseBytes),patched=patchAppleWLocPayload(ex.payload,cfg),response;
    if(ex.kind==="arpc"){
      response=serializeArpc({version:ex.arpc.version,locale:ex.arpc.locale,appIdentifier:ex.arpc.appIdentifier,osVersion:ex.arpc.osVersion,functionId:ex.arpc.functionId,payload:patched.payload});
    }else if(ex.kind==="marker"){
      response=concatBytes([ex.prefix,ex.markerAndLen.slice(0,APPLE_WLOC_MARKER.length),writeUInt16BE(patched.payload.length),patched.payload,ex.suffix]);
    }else{
      response=buildAppleWLocResponse(patched.payload,ex.prefix);
    }
    return {response:response,payload:patched.payload,wifiCount:patched.wifiCount,cellCount:patched.cellCount,kind:ex.kind};
  }

  function headerValue(headers,name){
    if(!headers) return undefined;
    var lower=name.toLowerCase();
    for(var k in headers) if(Object.prototype.hasOwnProperty.call(headers,k)&&k.toLowerCase()===lower) return headers[k];
    return undefined;
  }
  function headersWithBinaryBody(sourceHeaders,length){
    var headers={},k; sourceHeaders=sourceHeaders||{};
    for(k in sourceHeaders) if(Object.prototype.hasOwnProperty.call(sourceHeaders,k)){
      var lower=k.toLowerCase();
      if(lower!=="content-length"&&lower!=="content-encoding"&&lower!=="transfer-encoding") headers[k]=sourceHeaders[k];
    }
    headers["Content-Type"]="application/octet-stream";
    headers["Content-Length"]=String(length);
    return headers;
  }
  function decompressBody(body,contentEncoding){
    if(!body||!contentEncoding) return body;
    var enc=String(contentEncoding).toLowerCase();
    if(enc==="identity"||enc==="") return body;
    try{
      if(enc.indexOf("gzip")>=0&&typeof $utils!=="undefined"&&$utils.ungzip) return $utils.ungzip(body);
      if(enc.indexOf("deflate")>=0&&typeof $utils!=="undefined"&&$utils.inflate) return $utils.inflate(body);
      if(enc.indexOf("br")>=0&&typeof $utils!=="undefined"&&$utils.brotliDecompress) return $utils.brotliDecompress(body);
    }catch(e){}
    return body;
  }

  function loadDynamicConfig(){
    if(typeof $persistentStore==="undefined"||!$persistentStore.read) return null;
    var raw=$persistentStore.read(STORE_KEY);
    if(!raw) return null;
    var saved;
    try{ saved=JSON.parse(raw); }catch(e){ return null; }
    if(!saved||saved.enabled!==true) return null;
    var lat=Number(saved.latitude),lon=Number(saved.longitude),acc=Number(saved.accuracy);
    if(!Number.isFinite(lat)||lat<-90||lat>90||!Number.isFinite(lon)||lon<-180||lon>180) return null;
    if(!Number.isFinite(acc)||acc<=0) acc=DEFAULTS.horizontalAccuracy;
    return {
      latitude:lat,
      longitude:lon,
      horizontalAccuracy:Math.trunc(acc),
      verticalAccuracy:DEFAULTS.verticalAccuracy,
      altitude:DEFAULTS.altitude,
      unknownValue4:DEFAULTS.unknownValue4,
      motionActivityType:DEFAULTS.motionActivityType,
      motionActivityConfidence:DEFAULTS.motionActivityConfidence,
      failOpen:DEFAULTS.failOpen,
      debug:DEFAULTS.debug
    };
  }

  function patchedPayloadSummary(payload){
    try{
      var fields=parseFields(payload),parts=[],wifi=firstFieldByNumber(fields,2),cell=firstCellResponseField(fields);
      if(wifi&&wifi.wireType===2){ var wl=firstFieldByNumber(parseFields(wifi.valueBytes),2); parts.push("firstWifi="+(wl?locationSummary(wl.valueBytes):"<missing>")); }
      if(cell&&cell.wireType===2){ var cl=firstFieldByNumber(parseFields(cell.valueBytes),5); parts.push("firstCell="+(cl?locationSummary(cl.valueBytes):"<missing>")); }
      return parts.join(", ");
    }catch(e){ return "<summary-failed>"; }
  }

  try{
    var cfg=loadDynamicConfig();
    if(!cfg){
      console.log("Dynamic location spoofer: no enabled Location Spoofer coordinates; pass through");
      $done({});
      return;
    }

    var respHeaders=($response&&$response.headers)||{};
    var contentEncoding=headerValue(respHeaders,"Content-Encoding");
    var raw=$response&&($response.body!=null?$response.body:$response.bodyBytes);
    if(raw!=null&&contentEncoding){
      var decoded=decompressBody(raw,contentEncoding);
      if(decoded!==raw) $response.body=decoded;
    }
    var body=messageBodyToBytes($response);
    if(!body||body.length<2){ $done({}); return; }

    var result=spoofAppleResponse(body,cfg);
    console.log("Dynamic location spoofer patched "+result.wifiCount+" wifi devices, "+result.cellCount+" cell towers, kind="+result.kind);
    console.log("Dynamic location spoofer target="+cfg.latitude.toFixed(8)+","+cfg.longitude.toFixed(8)+" | "+patchedPayloadSummary(result.payload));

    $done({headers:headersWithBinaryBody(respHeaders,result.response.length),body:result.response});
  }catch(err){
    console.log("Dynamic location spoofer failed: "+err.message);
    $done({});
  }
}());
