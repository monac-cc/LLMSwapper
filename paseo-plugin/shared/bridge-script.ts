// Device-side program for the terminal bridge. Plain ES5 + CommonJS so any Node >= 8 runs it.
// It is a STRING: never imported or transpiled. __CFG__ is replaced by JSON built in shared/bridge.ts.
// clip/red/prim/pick mirror shared/pick.ts exactly (parity is integration-tested).
// Output protocol (each marker on its own line, nonce known only inside the payload):
//   __SWP_S_<n>__                      first line: the script is running (nothing sent to LLMswapper yet)
//   __SWP_D_<n>__                      a run with this nonce already happened on this device: did nothing
//   __SWP_B_<n>__ / base64 lines / __SWP_E_<n>_<len>__   result block, written with ONE write()
// Run-once lock <dir>/<nonce> (wx). POSIX: tmpdir/llmswapper-bridge-<uid>, else ~/.llmswapper-bridge, used only
// if lstat shows a real directory owned by this uid and not group/world writable (448 = 0700, 18 = 0022).
// Windows: tmpdir/llmswapper-bridge (tmpdir is per user there). No lock and C.g (the plan has a non-GET
// request) => fatal "lock_unavailable <why>" BEFORE the S marker, nothing sent. Reads run unguarded.
export const SCRIPT_TEMPLATE = String.raw`(function(){
var C=__CFG__;
var M='__SWP_',done=false;
function out(s){try{process.stdout.write(s);}catch(e){}}
process.noDeprecation=true;
try{process.removeAllListeners('warning');}catch(e){}
out('\u001b]0;LLMswapper\u0007');
var fs=require('fs'),os=require('os'),path=require('path');
function emit(o){
 if(done)return;done=true;
 var b=Buffer.from(JSON.stringify(o),'utf8').toString('base64'),s=M+'B_'+C.n+'__\n';
 for(var i=0;i<b.length;i+=C.w)s+=b.slice(i,i+C.w)+'\n';
 out(s+M+'E_'+C.n+'_'+b.length+'__\n');
 setTimeout(function(){process.exit(0);},C.l);
}
var U=process.getuid?process.getuid():null,H=false,Y;
function own(d){
 try{fs.mkdirSync(d,448);}catch(e){if(e.code!=='EEXIST')throw e;}
 var s=fs.lstatSync(d);
 if(U!==null&&(!s.isDirectory()||s.uid!==U||s.mode&18))throw{code:'insecure'};
 return d;
}
try{
 var LD;try{LD=own(path.join(os.tmpdir(),'llmswapper-bridge'+(U===null?'':'-'+U)));}
 catch(e){if(U===null)throw e;LD=own(path.join(os.homedir(),'.llmswapper-bridge'));}
 try{var now=Date.now();fs.readdirSync(LD).forEach(function(f){
  if(!/^[0-9a-f]{16}$/.test(f))return;var p=path.join(LD,f);
  try{if(now-fs.statSync(p).mtime.getTime()>3600000)fs.unlinkSync(p);}catch(e){}});}catch(e){}
 fs.writeFileSync(path.join(LD,C.n),'',{flag:'wx',mode:384});H=true;
}catch(e){
 if(e&&e.code==='EEXIST'){out(M+'D_'+C.n+'__\n');setTimeout(function(){process.exit(0);},C.l);return;}
 Y=String(e&&e.code||e).slice(0,80);
}
if(!H&&C.g){emit({v:1,fatal:'lock_unavailable '+Y});return;}
out(M+'S_'+C.n+'__\n');
var http=require('http');
var SR=/sk-ant-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,KR=/^[A-Za-z0-9_.:-]{1,80}$/;
function clip(s){if(s.length<=1500)return s;return s.slice(0,500)+' … '+s.slice(s.length-997);}
function red(s){return clip(s.replace(SR,'[oculto]'));}
function prim(v){
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='number')return isFinite(v)?v:null;
 if(typeof v==='string')return red(v);
 if(Array.isArray(v))return v.slice(0,200).map(function(x){return x!==null&&typeof x==='object'?null:prim(x);});
 return null;
}
function pick(v,s){
 if(v===undefined)return undefined;
 if(s===1)return prim(v);
 if(Array.isArray(s))return Array.isArray(v)?v.slice(0,200).map(function(x){var p=pick(x,s[0]);return p===undefined?null:p;}):null;
 if(v===null||typeof v!=='object'||Array.isArray(v))return null;
 var o={},k,p,n=0;
 if(s['*']!==undefined){
  for(k in v){if(!Object.prototype.hasOwnProperty.call(v,k))continue;if(n++>=200)break;
   if(KR.test(k)&&k.slice(0,2)!=='__'){p=pick(v[k],s['*']);o[k]=p===undefined?null:p;}}
  return o;
 }
 for(k in s){if(Object.prototype.hasOwnProperty.call(v,k)){p=pick(v[k],s[k]);if(p!==undefined)o[k]=p;}}
 return o;
}
function req(r,cb){
 var fin=false,tm;
 function end(x){if(fin)return;fin=true;clearTimeout(tm);cb(x);}
 var data=r.b?JSON.stringify(r.b):null,h={'X-Swapper':'1'};
 if(data){h['Content-Type']='application/json';h['Content-Length']=Buffer.byteLength(data);}
 var q=http.request({host:'127.0.0.1',port:C.p,path:r.u,method:r.m,headers:h},function(rs){
  var d='',n=0;rs.setEncoding('utf8');
  rs.on('data',function(c){n+=c.length;if(n>4194304){end({s:rs.statusCode||0,j:null,e:'too_large'});q.destroy();return;}d+=c;});
  rs.on('end',function(){var j=null,st=rs.statusCode||0;try{j=JSON.parse(d);}catch(e){}
   end(j===null?{s:st,j:null,e:'bad_json'}:{s:st,j:pick(j,st===200?r.k:C.x),e:null});});
  rs.on('error',function(e){end({s:0,j:null,e:String(e&&e.code||'network')});});
 });
 tm=setTimeout(function(){end({s:0,j:null,e:'timeout'});q.destroy();},r.t);
 q.on('error',function(e){end({s:0,j:null,e:String(e&&e.code||'network')});});
 if(data)q.write(data);
 q.end();
}
setTimeout(function(){emit({v:1,fatal:'script_timeout'});},C.t);
setTimeout(function(){process.exit(0);},C.t+C.l+5000);
try{
 var res={},left=C.r.length;
 C.r.forEach(function(r){req(r,function(x){res[r.key]=x;if(--left===0)emit({v:1,node:process.version,results:res});});});
}catch(e){emit({v:1,fatal:red(String(e&&e.message||e))});}
})();`;
