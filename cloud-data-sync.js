import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, setDoc, deleteDoc, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
const app=getApps().length?getApps()[0]:initializeApp(firebaseConfig),auth=getAuth(app),store=getFirestore(app);
const ROOT="appData",ADMIN_EMAILS={admin:"bcsmcomputer.iteducation+admin@gmail.com",instituteAdmin:"bcsmcomputer.iteducation+institute@gmail.com"};
const ARRAY_KEYS=["teachers","playlists","examRequests","finalRegistrations","students","lessons","questions","exams","results","payments","courses"];
let isPrivileged=false,loaded=false,applyingRemote=false,writing=false,unsub=null,cache=new Map(),timer=null,lastCloudSignature="";
const errText=e=>e?.code==="permission-denied"?"Firestore permission denied. Firestore Rules publish karein aur official Admin/Institute Admin login verify karein.":e?.code==="resource-exhausted"?"Cloud data document limit hit hua. Photos/images ko database mein base64 ke roop mein na rakhein.":(e?.message||String(e));
function roleFor(user){if(!user)return false;return Object.values(ADMIN_EMAILS).includes(String(user.email||"").toLowerCase())||!!window.__bcsmFirebaseRole&&["admin","instituteAdmin"].includes(window.__bcsmFirebaseRole)}
function idFor(kind,id){return `${kind}__${encodeURIComponent(String(id))}`.slice(0,1400)}
function normalizeDB(d){if(!d||typeof d!=="object")return null;const out={...d};for(const k of ARRAY_KEYS)if(!Array.isArray(out[k]))out[k]=[];if(!out.settings||typeof out.settings!=="object")return null;if(typeof out.examNotices!=="string")out.examNotices="";return out}
function signature(v){try{return JSON.stringify(v)}catch{return ""}}
function docsToDB(snap){const local=window.BCSMDataBridge?.getDB?.();if(!local)return null;const next={...local};for(const k of ARRAY_KEYS)next[k]=[];let settingsFound=false;
 for(const s of snap.docs){const d=s.data();if(d.kind==="settings"){next.settings=d.value||{};settingsFound=true}else if(d.kind==="examNotices"){next.examNotices=String(d.value||"")}else if(ARRAY_KEYS.includes(d.kind)&&d.value&&typeof d.value==="object"){next[d.kind].push(d.value)}}
 if(!settingsFound)return null;return normalizeDB(next)}
function mergeFirstTimeLocal(remote,local){
 if(!remote)return normalizeDB(local);
 const merged={...remote};
 // Preserve local-only records from each computer once during its first cloud migration.
 for(const k of ARRAY_KEYS){const byId=new Map((remote[k]||[]).filter(x=>x&&x.id!=null).map(x=>[String(x.id),x]));for(const item of (local?.[k]||[])){if(item&&item.id!=null&&!byId.has(String(item.id)))byId.set(String(item.id),item)}merged[k]=[...byId.values()]}
 return normalizeDB(merged);
}
function cloudDocsFromDB(db){const out=[];out.push({id:"meta_settings",kind:"settings",value:db.settings||{}});out.push({id:"meta_examNotices",kind:"examNotices",value:db.examNotices||""});for(const k of ARRAY_KEYS){for(const item of db[k]||[]){if(item&&item.id!==undefined&&item.id!==null)out.push({id:idFor(k,item.id),kind:k,itemId:String(item.id),value:item})}}return out}
async function replaceCloudFromLocal(db){const docs=cloudDocsFromDB(db);const largest=Math.max(0,...docs.map(d=>JSON.stringify(d).length));if(largest>850000){throw new Error("Cloud sync रोक दिया गया: एक रिकॉर्ड बहुत बड़ा है। विद्यार्थी/शिक्षक की फोटो छोटी रखें और वीडियो URL इस्तेमाल करें; वीडियो/फोटो को base64 में सेव न करें.")}
 const desired=new Map(docs.map(d=>[d.id,d]));const deletes=[...cache.keys()].filter(id=>!desired.has(id));
 for(let i=0;i<docs.length;i+=400){const batch=writeBatch(store);for(const d of docs.slice(i,i+400)){const old=cache.get(d.id);if(old&&signature(old.value)===signature(d.value)&&old.kind===d.kind&&old.itemId===d.itemId)continue;batch.set(doc(store,ROOT,d.id),{kind:d.kind,itemId:d.itemId||null,value:d.value,updatedAt:serverTimestamp(),updatedBy:auth.currentUser?.uid||""})}await batch.commit()}
 for(let i=0;i<deletes.length;i+=400){const batch=writeBatch(store);for(const id of deletes.slice(i,i+400))batch.delete(doc(store,ROOT,id));await batch.commit()}
 cache=desired;lastCloudSignature=signature(docs.map(d=>({id:d.id,kind:d.kind,itemId:d.itemId,value:d.value})));}
function scheduleSave(db){if(!isPrivileged||!loaded||applyingRemote||writing)return;clearTimeout(timer);timer=setTimeout(async()=>{try{writing=true;await replaceCloudFromLocal(normalizeDB(db));setStatus("Online sync: saved",true)}catch(e){console.error("BCSM cloud data sync failed",e);setStatus("Cloud sync error: "+errText(e),false)}finally{writing=false}},700)}
function setStatus(msg,ok){let el=document.getElementById("bcsmCloudSyncStatus");if(!el){el=document.createElement("div");el.id="bcsmCloudSyncStatus";el.style.cssText="position:fixed;bottom:10px;right:10px;z-index:99999;max-width:min(92vw,420px);padding:8px 12px;border-radius:9px;background:#17253a;color:white;font:12px/1.4 Arial,sans-serif;box-shadow:0 3px 15px #0002";document.body.appendChild(el)}el.textContent=msg;el.style.background=ok?"#17623a":"#8b2c20";}
function start(user){isPrivileged=roleFor(user);loaded=false;if(unsub){unsub();unsub=null}cache.clear();if(!isPrivileged){setStatus("Cloud sync: admin login required",false);return}
 setStatus("Cloud sync: connecting…",true);unsub=onSnapshot(collection(store,ROOT),async snap=>{
   try{
    const remote=docsToDB(snap);
    if(!loaded){
      if(remote){
      const local=normalizeDB(window.BCSMDataBridge?.getDB?.());
      const migrationKey="bcsmCloudLocalMerge_v1";
      if(!localStorage.getItem(migrationKey)){
        const merged=mergeFirstTimeLocal(remote,local);
        cache=new Map(snap.docs.map(s=>[s.id,{kind:s.data().kind,itemId:s.data().itemId||undefined,value:s.data().value}]));
        applyingRemote=true;window.BCSMDataBridge?.applyCloudData(merged);applyingRemote=false;loaded=true;
        await replaceCloudFromLocal(merged);localStorage.setItem(migrationKey,"1");setStatus("Online sync: local records merged",true);return;
      }
      cache=new Map(snap.docs.map(s=>[s.id,{kind:s.data().kind,itemId:s.data().itemId||undefined,value:s.data().value}]));lastCloudSignature=signature(snap.docs.map(s=>({id:s.id,kind:s.data().kind,itemId:s.data().itemId,value:s.data().value})));applyingRemote=true;window.BCSMDataBridge?.applyCloudData(remote);applyingRemote=false;loaded=true;setStatus("Online sync: cloud data loaded",true);return}
      // Empty cloud: seed it exactly once from the first official admin's local database.
      const local=normalizeDB(window.BCSMDataBridge?.getDB?.());if(!local)throw new Error("Local app data unavailable");loaded=true;cache=new Map();await replaceCloudFromLocal(local);localStorage.setItem("bcsmCloudLocalMerge_v1","1");setStatus("Online sync: initial data uploaded",true);return;
    }
    if(writing)return;
    const sig=signature(snap.docs.map(s=>({id:s.id,kind:s.data().kind,itemId:s.data().itemId,value:s.data().value})));
    if(sig===lastCloudSignature)return;
    if(remote){cache=new Map(snap.docs.map(s=>[s.id,{kind:s.data().kind,itemId:s.data().itemId||undefined,value:s.data().value}]));lastCloudSignature=sig;applyingRemote=true;window.BCSMDataBridge?.applyCloudData(remote);applyingRemote=false;setStatus("Online sync: updates received",true)}
   }catch(e){applyingRemote=false;console.error(e);setStatus("Cloud sync error: "+errText(e),false)}
 },e=>{console.error("appData listener failed",e);setStatus("Cloud sync error: "+errText(e),false)});
}
window.addEventListener("bcsm-local-db-saved",e=>scheduleSave(e.detail?.db));
window.addEventListener("bcsm-monthly-cloud-results",e=>{if(!isPrivileged||!loaded)return;const db=window.BCSMDataBridge?.getDB?.();if(!db)return;const existing=new Map((db.results||[]).map(r=>[String(r.id),r]));for(const r of (e.detail?.results||[])){existing.set(String(r.id),r)}db.results=[...existing.values()];applyingRemote=true;window.BCSMDataBridge?.applyCloudData(db);applyingRemote=false;scheduleSave(db)});
onAuthStateChanged(auth,user=>{start(user)});
