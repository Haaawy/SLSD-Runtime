'use strict';
// Dependency-free contract tests. No app build, network access, or GitHub Actions.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(dir, 'slsd-settings-bridge.js'), 'utf8');
const mod = fs.readFileSync(path.join(dir, 'ios-location-spoofer-dynamic.sgmodule'), 'utf8');
const compiled = new vm.Script(script, {filename: 'slsd-settings-bridge.js'});
const PRIMARY = 'locationSpoofer.settings.v1';
const LEGACY = 'slsd.location.settings.v1';
const VERSION = 'slsd-runtime-bridge-v3';
const BASE = 'https://gs-loc.apple.com/wloc-settings/save';
const initial = (lat=1, lon=2, enabled=true) => JSON.stringify({enabled, latitude:lat, longitude:lon, accuracy:39});
function run(url, store={}, opts={}) {
  const calls = [], writes = [];
  const context = {console:{log(){}},$request:{url,method:opts.method || 'GET'},
    $done(value){calls.push(value);},
    $persistentStore:{read(key){return store[key] || null;},write(value,key){
      writes.push({key,value});
      if (opts.failWrite) return false;
      if (!opts.dropWrite) store[key] = value;
      return true;
    }}};
  if (opts.missingStore) delete context.$persistentStore;
  compiled.runInNewContext(context, {timeout:500});
  assert.equal(calls.length,1,'exactly one $done call');
  const result = JSON.parse(JSON.stringify(calls[0]));
  const response = result.response || result;
  return {result,response,body:response.body ? JSON.parse(response.body) : null,store,writes};
}
const rules = mod.split('\n').filter(x=>x.includes('type=http-request')).map(x=>new RegExp(x.match(/pattern=(.*?),requires-body=/)[1]));
const matches = url => rules.filter(r=>r.test(url)).length;
const tests = [];
function test(name, fn){tests.push({name,fn});}
function expectReject(url){const r=run(url);assert.equal(r.response.status,400);assert.equal(r.body.success,false);assert.equal(r.writes.length,0);}
for (const host of ['gs-loc.apple.com','gs-loc-cn.apple.com']) {
  for (const scheme of ['http','https']) {
    for (const p of ['save?action=query','version']) {
      const url=`${scheme}://${host}/wloc-settings/${p}`;
      test('one request rule matches '+url,()=>assert.equal(matches(url),1));
    }
  }
}
test('legacy HTTP alias preserved',()=>assert.equal(matches('http://slsd.local/settings?action=query'),1));
for (const url of ['https://gs-loc.apple.com.evil.test/wloc-settings/save','https://other.test/wloc-settings/save','https://gs-loc.apple.com/clls/wloc','https://gs-loc.apple.com/wloc-settings/savemore']) {
  test('no control rule overmatch '+url,()=>assert.equal(matches(url),0));
}
test('synthetic response uses response envelope',()=>assert.ok(run(BASE+'?action=query').result.response));
test('version contract',()=>{const r=run('https://gs-loc.apple.com/wloc-settings/version');assert.equal(r.response.status,200);assert.equal(r.body.success,true);assert.equal(r.body.moduleVersion,VERSION);assert.equal(r.body.systemLocationVerified,false);assert.equal(r.writes.length,0);});
test('no-store response',()=>assert.equal(run(BASE+'?action=query').response.headers['Cache-Control'],'no-store'));
test('query empty matches native inactive contract',()=>{const r=run(BASE+'?action=query');assert.equal(r.body.success,false);assert.ok(r.body.error.includes('无已保存'));assert.equal(r.writes.length,0);});
test('save writes the primary patcher store',()=>{const r=run(BASE+'?lat=12.5&lon=-45.25&acc=39.0');assert.equal(r.body.success,true);assert.equal(JSON.parse(r.store[PRIMARY]).latitude,12.5);assert.equal(JSON.parse(r.store[PRIMARY]).longitude,-45.25);});
test('query returns top-level coordinates and integer accuracy',()=>{const r=run(BASE+'?action=query',{[PRIMARY]:initial(12.5,-45.25)});assert.equal(r.body.success,true);assert.equal(r.body.latitude,12.5);assert.equal(r.body.longitude,-45.25);assert.equal(r.body.accuracy,39);assert.equal(r.body.settings,undefined);});
test('saved target replaces old canonical target',()=>{const r=run(BASE+'?lat=12.5&lon=-45.25',{[PRIMARY]:initial(1,2)});assert.equal(JSON.parse(r.store[PRIMARY]).latitude,12.5);});
test('canonical inactive marker overrides legacy target',()=>{const r=run(BASE+'?action=query',{[PRIMARY]:initial(0,0,false),[LEGACY]:initial(10,20)});assert.equal(r.body.enabled,false);assert.equal(r.body.success,false);});
test('legacy-only state is readable',()=>{const r=run(BASE+'?action=query',{[LEGACY]:initial(10,20)});assert.equal(r.body.latitude,10);});
test('clear stops both primary and fallback paths',()=>{const r=run(BASE+'?action=clear',{[PRIMARY]:initial(1,2),[LEGACY]:initial(10,20)});assert.equal(r.body.success,true);assert.equal(JSON.parse(r.store[PRIMARY]).enabled,false);assert.equal(run(BASE+'?action=query',r.store).body.enabled,false);});
test('clear write failure is not reported successful',()=>{const r=run(BASE+'?action=clear',{}, {failWrite:true});assert.equal(r.body.success,false);assert.equal(r.response.status,500);});
test('save write failure is not reported successful',()=>{const r=run(BASE+'?lat=12.5&lon=45.25',{}, {failWrite:true});assert.equal(r.body.success,false);assert.equal(r.response.status,500);});
test('save read-back failure is detected',()=>{const r=run(BASE+'?lat=12.5&lon=45.25',{}, {dropWrite:true});assert.equal(r.body.success,false);assert.equal(r.response.status,500);});
for (const query of ['', '?lon=45', '?lat=12', '?lat=&lon=45', '?lat=null&lon=45','?lat=91&lon=0','?lat=0&lon=181','?lat=Infinity&lon=0','?lat=0x10&lon=0','?lat=1&lon=2&lat=3','?lat=%GG&lon=0','?lat=1&lon=2&action=typo']) {
  test('invalid input does not write '+query,()=>expectReject(BASE+query));
}
test('zero coordinates are valid',()=>{const r=run(BASE+'?lat=0&lon=0');assert.equal(r.body.success,true);assert.equal(r.body.latitude,0);assert.equal(r.body.longitude,0);});
test('coordinate limits are valid',()=>assert.equal(run(BASE+'?lat=-90&lon=180').body.success,true));
test('accuracy alias',()=>assert.equal(run(BASE+'?lat=1&lon=2&accuracy=25').body.accuracy,25));
test('positive fractional accuracy becomes native Int',()=>assert.equal(run(BASE+'?lat=1&lon=2&acc=25.6').body.accuracy,26));
for (const query of ['&acc=-1','&acc=0','&acc=no','&acc=1000001','&acc=25&accuracy=30','&enabled=maybe','&randomRadius=5']) {
  test('invalid option does not write '+query,()=>expectReject(BASE+'?lat=1&lon=2'+query));
}
test('native randomRadius=0 remains supported',()=>assert.equal(run(BASE+'?lat=1&lon=2&randomRadius=0').body.success,true));
test('enabled=0 safely clears without coordinates',()=>{const r=run(BASE+'?enabled=0',{[PRIMARY]:initial()});assert.equal(r.body.success,true);assert.equal(JSON.parse(r.store[PRIMARY]).enabled,false);});
test('non-GET request is rejected',()=>{const r=run(BASE+'?lat=1&lon=2',{}, {method:'POST'});assert.equal(r.response.status,405);assert.equal(r.writes.length,0);});
test('corrupt storage is explicit failure',()=>{const r=run(BASE+'?action=query',{[PRIMARY]:'bad-json'});assert.equal(r.body.success,false);assert.equal(r.response.status,500);});
test('missing store is explicit failure',()=>assert.equal(run(BASE+'?action=query',{}, {missingStore:true}).response.status,500));
test('off-scope invocation passes through',()=>assert.deepEqual(run('https://other.test/').result,{}));
let passed=0;
const failures=[];
for (const {name,fn} of tests) {
  try {fn();passed++;console.log('PASS '+name);}
  catch(e){failures.push({name,error:e.message});console.log('FAIL '+name+': '+e.message);}
}
console.log(JSON.stringify({total:tests.length,passed,failed:failures.length,failures},null,2));
process.exitCode=failures.length?1:0;
