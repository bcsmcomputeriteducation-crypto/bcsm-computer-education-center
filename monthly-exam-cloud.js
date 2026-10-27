import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, getDocs } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getDatabase, ref as dbRef, set as dbSet, update as dbUpdate, get as dbGet, onValue, query as dbQuery, limitToLast, orderByChild, equalTo } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";
const app=getApps().find(a=>a.name==="[DEFAULT]")||(getApps().length?getApps()[0]:initializeApp(firebaseConfig)),auth=getAuth(app),firestore=getFirestore(app);
/* Keep student anonymous sessions separate from Admin email/password sessions. This prevents Start Exam from signing out an Admin or using the Admin UID as a student UID. */
const studentApp=getApps().find(a=>a.name==="bcsmStudentRequests")||initializeApp(firebaseConfig,"bcsmStudentRequests"),studentAuth=getAuth(studentApp),studentFirestore=getFirestore(studentApp);
const RTDB_URL="https://bcsm-computer-education-center-default-rtdb.firebaseio.com",rtdb=getDatabase(app,RTDB_URL),studentRtdb=getDatabase(studentApp,RTDB_URL);
const settingsColl=collection(firestore,"monthlyExamSettings"),studentSettings=collection(studentFirestore,"monthlyExamSettings");
const ADMIN_EMAILS=["bcsmcomputer.iteducation+admin@gmail.com","bcsmcomputer.iteducation+institute@gmail.com"];
const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const courseKey=v=>String(v??"").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"").trim();
function studentExamIdentity(identity){const x=identity&&typeof identity==="object"?identity:{};const name=String(x.studentName||x.name||"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();const phone=String(x.studentPhone||x.phone||"").replace(/\D/g,"");const course=String(x.courseId||x.courseCode||x.courseKey||"").trim().toLowerCase();const semester=String(x.semester||"").normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();return [name,phone,course,semester].join("|");}
function isMainAdmin(){const u=auth.currentUser;return !!u&&(ADMIN_EMAILS.includes(String(u.email||"").toLowerCase())||["n9XlY6yAR7b7vkVjiXkvOXv50O33","YCtq6PUlGKN7hnojQexb8Y3j1qE2"].includes(String(u.uid||"")));}
function friendlyAuthError(e){
 if(["auth/operation-not-allowed","auth/admin-restricted-operation"].includes(e?.code))return "Firebase Console → Authentication → Sign-in method → Anonymous ko Enable karke Save karein; phir page reload karein.";
 if(e?.code==="PERMISSION_DENIED"||e?.code==="permission-denied"||String(e?.message||"").includes("Permission denied"))return "Firebase Rules ne request rok di. Is ZIP ki database.rules.json ko Realtime Database → Rules mein publish karein; Firestore Rules ki usage limit se yeh alag hai.";
 if(e?.code==="resource-exhausted")return "Firestore quota/resource limit response mila. Console → Usage check karein.";
 if(e?.code==="unavailable"||e?.code==="deadline-exceeded")return "Firebase server se connection nahi ho raha. Internet check karke dobara try karein.";
 return e?.message||String(e);
}
async function ensureStudentSession(){
 if(studentAuth.currentUser)return studentAuth.currentUser;
 try{return (await signInAnonymously(studentAuth)).user;}catch(e){throw new Error(friendlyAuthError(e));}
}
function identityValues(identity){
 const raw=identity&&typeof identity==="object"?[
   identity.courseKey,identity.courseCode,identity.courseName,identity.courseId,identity.course,
   identity.courseCode&&identity.courseName?`${identity.courseCode} ${identity.courseName}`:""
 ]:[identity];
 return [...new Set(raw.filter(v=>v!==undefined&&v!==null&&String(v).trim()).flatMap(v=>[String(v).trim(),courseKey(v)]).filter(Boolean))];
}
async function hashExamPassword(password){const bytes=new TextEncoder().encode(String(password));const digest=await crypto.subtle.digest("SHA-256",bytes);return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");}
function matchesIdentity(settings,identity){
 const wanted=new Set(identityValues(identity).map(courseKey));
 const values=[settings.courseKey,settings.courseId,settings.courseCode,settings.courseName,settings.id];
 return values.some(v=>v!==undefined&&v!==null&&wanted.has(courseKey(v)));
}
const api={
 async ensurePasswordExamSession(){return await ensureStudentSession();},
 async verifyExamPassword(identity,password){const settings=await api.getCourseExamSettings(identity);if(!settings||!settings.examPasswordHash)return false;return (await hashExamPassword(password))===String(settings.examPasswordHash);},
 async createRequest(p){
   const user=await ensureStudentSession(),key=courseKey(p.courseCode||p.courseName||p.courseId);
   if(!key)throw new Error("Course ki pehchan nahi mili. Course dobara select karein.");
   const id=(globalThis.crypto&&typeof globalThis.crypto.randomUUID==="function")?globalThis.crypto.randomUUID():"req-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,12);
   const data={...p,courseKey:key,studentUid:user.uid,status:"pending",requestToken:id,requestedAt:new Date().toISOString()};
   await dbSet(dbRef(studentRtdb,"monthlyExamRequests/"+id),data);
   return {id,...data};
 },
 watchRequest(id,callback){return onValue(dbRef(studentRtdb,"monthlyExamRequests/"+String(id)),snap=>callback(snap.exists()?{id:snap.key,...snap.val()}:null),e=>{
   console.error("Exam request listener:",e);const status=document.getElementById("meRequestStatus");
   if(status)status.innerHTML='<div class="error">Approval status load nahi hua: '+esc(friendlyAuthError(e))+'</div>';
 });},
 async saveCourseExamSettings(x){
   if(!auth.currentUser){
     await new Promise((resolve,reject)=>{
       let finished=false,unsub=()=>{};
       const timer=setTimeout(()=>{if(!finished){finished=true;unsub();reject(new Error("Firebase Admin login load nahi hua. Admin se logout karke dobara login karein."));}},8000);
       unsub=onAuthStateChanged(auth,user=>{if(user&&!finished){finished=true;clearTimeout(timer);unsub();resolve();}},err=>{if(!finished){finished=true;clearTimeout(timer);unsub();reject(err);}});
     });
   }
   if(!isMainAdmin())throw new Error("Sirf Main Admin exam settings save kar sakta hai.");
   const code=String(x.courseCode||x.code||"").trim(),name=String(x.courseName||x.name||"").trim(),id=String(x.courseId||"").trim();
   const key=courseKey(code||name||id);if(!key)throw new Error("Course code/ID nahi mila. Course select karke dobara save karein.");
   const questionCount=Number(x.questionCount),duration=Number(x.duration),totalMarks=Number(x.totalMarks),passMarks=Number(x.passMarks);
   if(!Number.isFinite(questionCount)||questionCount<1||!Number.isFinite(duration)||duration<1||!Number.isFinite(totalMarks)||totalMarks<1||!Number.isFinite(passMarks)||passMarks<0)throw new Error("Questions, duration aur marks ki settings check karein.");
   const data={courseKey:key,courseId:id,courseCode:code,courseName:name,title:String(x.title||"Monthly Main Exam"),type:"Monthly Main Exam",questionCount,duration,totalMarks,passMarks,passPercent:Number.isFinite(Number(x.passPercent))?Number(x.passPercent):Math.round(passMarks/totalMarks*100),published:true,updatedBy:auth.currentUser.email||auth.currentUser.uid,updatedAt:new Date().toISOString()};
   await dbSet(dbRef(rtdb,"monthlyExamSettings/"+key),data);
   const verify=await dbGet(dbRef(rtdb,"monthlyExamSettings/"+key));
   if(!verify.exists()||verify.val().published!==true||verify.val().type!=="Monthly Main Exam")throw new Error("Realtime Database ne settings save confirm nahi ki. database.rules.json publish karein aur Admin login check karein.");
   return {id:key,...verify.val()};
 },
 async getAllCourseExamSettings(){
   await ensureStudentSession();
   const snap=await dbGet(dbRef(studentRtdb,"monthlyExamSettings"));
   return snap.exists()?(snap.val()||{}):{};
 },
 async getCourseExamSettings(identity){
   const keys=[...new Set(identityValues(identity).map(courseKey).filter(Boolean))];
   for(const key of keys){const snap=await dbGet(dbRef(studentRtdb,"monthlyExamSettings/"+key));if(snap.exists()){const d={id:snap.key,...snap.val()};if(d.published===true&&d.type==="Monthly Main Exam")return d;}}
   return null;
 },
 async setRequestStatus(id,status){
   if(!isMainAdmin())throw new Error("Sirf Main Admin official login se approval de sakta hai.");
   if(!["approved","denied"].includes(status))throw new Error("Invalid status");
   const path="monthlyExamRequests/"+String(id),snap=await dbGet(dbRef(rtdb,path));
   if(!snap.exists())throw new Error("Yeh request Realtime Database mein nahi mili. Student se nayi request bhejwayein.");
   const old=snap.val()||{};
   if(!["pending","approved","denied"].includes(old.status))throw new Error("Is request ka status pehle hi update ho chuka hai. List refresh karein.");
   if(old.status!==status)await dbUpdate(dbRef(rtdb,path),{status,approvedAt:new Date().toISOString(),approvedBy:auth.currentUser.email||auth.currentUser.uid});
   const verified=await dbGet(dbRef(rtdb,path));
   if(!verified.exists()||verified.val().status!==status)throw new Error("Approval Realtime Database par confirm nahi hua. Database Rules aur internet check karein.");
   latestRows=latestRows.map(r=>r.id===String(id)?{...r,status}:r);renderApproval();
   return {id:verified.key,...verified.val()};
 },
 async getExamQuestions(courseId,semester){
   await ensureStudentSession();
   const wantedCourse=String(courseId||"");
   const wantedSemester=String(semester||"").normalize("NFKC").trim().toLowerCase();
   if(!wantedCourse||!wantedSemester)return [];
   const cacheKey="bcsmMonthlyQuestionCache_v1:"+wantedCourse+":"+wantedSemester;
   const parseRows=(rows)=>rows.filter(q=>String(q.courseId||q.courseID||q.course||"")===wantedCourse&&String(q.semester||q.semesterName||"").normalize("NFKC").trim().toLowerCase()===wantedSemester&&q.autoGenerated!==true);
   let snap, rows;
   try {
     snap=await getDocs(collection(studentFirestore,"examQuestions"));
     const allRows=snap.docs.map(d=>{const data=d.data()||{};return data.value&&typeof data.value==="object"?{...data.value,id:data.value.id||d.id}:{...data,id:data.id||d.id};});
     rows=parseRows(allRows);
     try{localStorage.setItem(cacheKey,JSON.stringify({savedAt:Date.now(),rows}));}catch(cacheError){console.warn("Question cache could not be saved",cacheError);}
   }
   catch(e){
     console.error("MONTHLY_EXAM_STAGE=questions_read",e);
     try{const cached=JSON.parse(localStorage.getItem(cacheKey)||"null");if(cached&&Array.isArray(cached.rows)&&cached.rows.length){console.warn("Using cached Monthly Exam questions because Firestore is unavailable/quota exceeded.");rows=cached.rows;}}
     catch(cacheError){console.warn("Question cache could not be read",cacheError);}
     if(!rows)throw new Error("STAGE=QUESTIONS_READ: Firestore quota/access problem aur is course/semester ka saved question cache bhi nahi mila. Firestore quota reset hone ya Question Bank ko static/RTDB source mein migrate karne ki zarurat hai. Details: "+friendlyAuthError(e));
   }
   const pick=(...xs)=>xs.map(v=>String(v??"").trim()).find(Boolean)||"";
   const seen=new Set();
   return rows.filter(q=>{const text=pick(q.questionHindi,q.hindiQuestion,q.question_hi,q.questionHi,q.questionEnglish,q.englishQuestion,q.question_en,q.questionEn,q.question,q.questionText,q.hindi,q.english).normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();if(!text||seen.has(text))return false;seen.add(text);return true;});
 },
 async hasExamResult(identity,examId){
   if(!identity||!examId)return false;
   const user=await ensureStudentSession();
   const studentKey=studentExamIdentity(identity);
   if(!studentKey.replace(/\|/g,""))return false;
   try{
     // Results are now in RTDB under the authenticated student's UID; no Firestore result read is required.
     const snap=await dbGet(dbRef(studentRtdb,"monthlyExamResults/"+user.uid));
     if(!snap.exists())return false;
     let found=false;snap.forEach(child=>{const r=child.val()||{};if(r.deleted!==true&&r.studentKey===studentKey&&r.examId===String(examId))found=true;});
     return found; // Deleted tombstones remain as a lock until the admin explicitly clears them.
   }catch(e){console.error("MONTHLY_EXAM_STAGE=result_lock_rtdb",e);throw new Error("STAGE=RESULT_LOCK_RTDB: Realtime Database mein previous-result check fail hua. "+friendlyAuthError(e));}
 },
 async deleteExamResult(resultId){
   if(!isMainAdmin())throw new Error("Sirf Main Admin online exam result delete kar sakta hai.");
   const id=String(resultId),rootSnap=await dbGet(dbRef(rtdb,"monthlyExamResults"));let found=null;
   if(rootSnap.exists())rootSnap.forEach(uidSnap=>{if(uidSnap.hasChild(id))found={uid:uidSnap.key,data:uidSnap.child(id).val()||{}};});
   if(!found)throw new Error("Result RTDB mein nahi mila; page refresh karke result list dobara kholen.");
   const resultRef=dbRef(rtdb,"monthlyExamResults/"+found.uid+"/"+id);
   await dbUpdate(resultRef,{deleted:true,deletedAt:new Date().toISOString(),deletedBy:auth.currentUser?.email||auth.currentUser?.uid||"admin"});
   const verify=await dbGet(resultRef);if(!verify.exists()||verify.val()?.deleted!==true)throw new Error("Result deletion RTDB par confirm nahi hui.");
   const deleted=JSON.parse(localStorage.getItem("bcsmDeletedMonthlyResults_v1")||"[]");if(!deleted.includes(id)){deleted.push(id);localStorage.setItem("bcsmDeletedMonthlyResults_v1",JSON.stringify(deleted.slice(-5000)));}
   window.dispatchEvent(new CustomEvent("bcsm-monthly-result-deleted",{detail:{id}}));
 },
 async saveExamResult(result){
   const user=await ensureStudentSession();
   if(!user)throw new Error("Student Firebase session nahi mila. Dobara request karke exam submit karein.");
   const id=String(result?.id||"");if(!id)throw new Error("Result ID missing.");
   const deleted=JSON.parse(localStorage.getItem("bcsmDeletedMonthlyResults_v1")||"[]");
   if(deleted.includes(id))throw new Error("Yeh result ID delete list mein hai. Submit dobara karein; naya result ID banega.");
   const studentKey=studentExamIdentity(result);
   if(!studentKey.replace(/\|/g,""))throw new Error("Student ka naam, course aur semester result mein nahi mila.");
   // Keep only RTDB-safe, serializable result fields and force identity fields from the active anonymous session.
   const payload=JSON.parse(JSON.stringify({...result,id,studentUid:user.uid,studentKey,submittedAt:new Date().toISOString(),source:"web-exam",deleted:false}));
   const resultRef=dbRef(studentRtdb,"monthlyExamResults/"+user.uid+"/"+id);
   try{
     await dbSet(resultRef,payload);
     const verify=await dbGet(resultRef);
     if(!verify.exists()||String(verify.val()?.id)!==id||String(verify.val()?.studentUid)!==String(user.uid)||String(verify.val()?.studentKey)!==studentKey)throw new Error("Firebase ne save ke baad wahi result verify nahi kiya.");
     window.dispatchEvent(new CustomEvent("bcsm-monthly-result-saved",{detail:{id,result:verify.val()}}));
     return verify.val();
   }catch(e){
     console.error("MONTHLY_EXAM_STAGE=result_save_rtdb",e);
     const detail=friendlyAuthError(e);
     throw new Error("STAGE=RESULT_SAVE_RTDB: Firebase Realtime Database mein result save/verify nahi hua. Firebase Console → Realtime Database → Rules mein project ki database.rules.json rules publish karein. Error: "+detail);
   }
 },
 async createCommonExamToken(){
   if(!isMainAdmin())throw new Error("Sirf Main Admin Exam Token bana sakta hai.");
   const token=String(Math.floor(100000+Math.random()*900000));
   const data={token,active:true,updatedAt:new Date().toISOString(),updatedBy:auth.currentUser.email||auth.currentUser.uid};
   await dbSet(dbRef(rtdb,"monthlyExamToken/current"),data);
   const verify=await dbGet(dbRef(rtdb,"monthlyExamToken/current"));
   if(!verify.exists()||String(verify.val().token)!==token)throw new Error("Token Firebase par save confirm nahi hua. Realtime Database Rules check karein.");
   return token;
 },
 async verifyCommonExamToken(value){
   const token=String(value||"").trim();
   if(!/^\d{6}$/.test(token))return false;
   await ensureStudentSession();
   const snap=await dbGet(dbRef(studentRtdb,"monthlyExamToken/current"));
   return !!(snap.exists()&&snap.val().active===true&&String(snap.val().token)===token);
 },
 watchAdminRequests(callback){
   if(!isMainAdmin()){callback([]);return ()=>{};}
   const feedQuery=dbQuery(dbRef(rtdb,"monthlyExamRequests"),limitToLast(100));
   return onValue(feedQuery,snap=>{
     const rows=[];snap.forEach(child=>rows.push({id:child.key,...child.val()}));
     latestRows=rows.sort((a,b)=>String(b.requestedAt||"").localeCompare(String(a.requestedAt||"")));
     callback(latestRows);renderApproval();
   },e=>{console.error("Admin request feed:",e);callback([]);const feed=document.getElementById("cloudApprovalFeed");if(feed)feed.innerHTML='<p class="error">Approval list load nahi hui: '+esc(friendlyAuthError(e))+'</p>';});
 }
};
window.BCSMExamCloud=api;
let adminUnsub=null,latestRows=[];
function renderRows(rows){const pending=rows.filter(r=>r.status==="pending");return `<p class="muted">Sirf Monthly Main Exam ki online pending approvals yahan dikhengi. Main Admin hi approve/deny kar sakta hai.</p><div class="tablewrap"><table><thead><tr><th>Student</th><th>Course / Semester</th><th>Batch</th><th>Requested</th><th>Action</th></tr></thead><tbody>${pending.map(r=>`<tr><td>${esc(r.studentName)}<br>${esc(r.studentPhone||"")}</td><td>${esc(r.courseName||r.courseId)} / ${esc(r.semester)}</td><td>${esc(r.batch)}</td><td>${esc(r.requestedAt||"")}</td><td><button class="small primary" onclick="approveExamRequest('${r.id}')">Approve</button> <button class="small danger" onclick="denyExamRequest('${r.id}')">Deny</button></td></tr>`).join("")||'<tr><td colspan="5">Koi pending Main Exam approval nahi hai.</td></tr>'}</tbody></table></div>`;}
function renderApproval(){let mount=document.getElementById("cloudApprovalMount"),adminContent=document.getElementById("adminContent");if(!adminContent)return;if(!mount){mount=document.createElement("div");mount.id="cloudApprovalMount";const anchor=adminContent.querySelector("#eCourse")?.closest(".card")||adminContent.lastElementChild; if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(mount,anchor.nextSibling);else adminContent.appendChild(mount);}let feed=mount.querySelector("#cloudApprovalFeed");if(!feed){mount.innerHTML='<div class="card" style="margin:18px 0"><h3>📋 Pending Monthly Main Exam Approvals</h3><p class="muted">Requests Realtime Database se load hoti hain; admin approve/deny kar sakta hai.</p><div id="cloudApprovalFeed"></div></div>';feed=mount.querySelector("#cloudApprovalFeed");}if(feed)feed.innerHTML=renderRows(latestRows);}
window.createBCSMCommonExamToken=async()=>{const el=document.getElementById("commonExamTokenStatus");try{const t=await api.createCommonExamToken();const v=document.getElementById("commonExamTokenValue");if(v)v.textContent=t;if(el)el.textContent="Token online save ho gaya. Sabhi students ko ye token dein.";}catch(e){if(el)el.textContent="Token save nahi hua: "+(e.message||e);}};
window.loadBCSMCommonExamToken=async()=>{const el=document.getElementById("commonExamTokenStatus");const v=document.getElementById("commonExamTokenValue");try{if(el)el.textContent="Admin login aur Firebase connection check ho raha hai…";if(!isMainAdmin())throw new Error("Admin login zaroori hai. Logout karke Admin account se dobara login karein.");const snap=await Promise.race([dbGet(dbRef(rtdb,"monthlyExamToken/current")),new Promise((_,reject)=>setTimeout(()=>reject(new Error("Realtime Database se 10 second mein jawab nahi aaya. Database URL aur Rules check karein.")),10000))]);if(v)v.textContent=snap.exists()&&snap.val().active?snap.val().token:"Not created";if(el)el.textContent=snap.exists()&&snap.val().active?"Current online token load ho gaya.":"Abhi token nahi bana hai. Generate / Change Token dabayein.";}catch(e){if(v&&v.textContent==="Loading…")v.textContent="—";if(el)el.textContent="Token load nahi hua: "+friendlyAuthError(e);}};
window.BCSMExamCloud.refreshApprovalUI=renderApproval;
function attachAdminFeed(){if(adminUnsub){adminUnsub();adminUnsub=null;}latestRows=[];if(isMainAdmin())adminUnsub=api.watchAdminRequests(rows=>{latestRows=rows;renderApproval();});}

window.approveExamRequest=async id=>{try{await api.setRequestStatus(id,"approved");}catch(e){alert("Approval failed: "+(e.message||e));}};
window.denyExamRequest=async id=>{try{await api.setRequestStatus(id,"denied");}catch(e){alert("Deny failed: "+(e.message||e));}};
// Monthly Main Exam requests and approvals are stored in Realtime Database.

let resultUnsub=null;
function attachResultFeed(){
 if(resultUnsub){resultUnsub();resultUnsub=null;}
 if(!isMainAdmin())return;
 resultUnsub=onValue(dbRef(rtdb,"monthlyExamResults"),snap=>{
   const cloud=[];snap.forEach(uidSnap=>uidSnap.forEach(resultSnap=>cloud.push({id:resultSnap.key,...(resultSnap.val()||{}),studentUid:(resultSnap.val()||{}).studentUid||uidSnap.key})));
   const deleted=cloud.filter(r=>r.deleted===true).map(r=>String(r.id));
   if(deleted.length){const old=JSON.parse(localStorage.getItem("bcsmDeletedMonthlyResults_v1")||"[]");localStorage.setItem("bcsmDeletedMonthlyResults_v1",JSON.stringify([...new Set([...old,...deleted])].slice(-5000)));}
   window.dispatchEvent(new CustomEvent("bcsm-monthly-cloud-results",{detail:{results:cloud.filter(r=>r.deleted!==true),deletedIds:deleted}}));
  },e=>{console.error("MONTHLY_EXAM_STAGE=admin_result_feed_rtdb",e);const status=document.getElementById("bcsmCloudSyncStatus");if(status)status.textContent="Monthly results RTDB load error: "+friendlyAuthError(e);});
}

onAuthStateChanged(auth,()=>{
  setTimeout(attachAdminFeed,200);
  setTimeout(attachResultFeed,300);
  // Admin page may render before this module finishes loading. Retry token read after auth settles.
  setTimeout(()=>{if(document.getElementById("commonExamTokenStatus") && typeof window.loadBCSMCommonExamToken==="function") window.loadBCSMCommonExamToken();},500);
});
window.addEventListener("bcsm-firebase-ready",()=>setTimeout(attachAdminFeed,200));
window.addEventListener("bcsm-firebase-auth-ready",()=>setTimeout(attachAdminFeed,250));
window.addEventListener("bcsm-admin-page-rendered",()=>setTimeout(()=>{if(document.getElementById("commonExamTokenStatus")&&typeof window.loadBCSMCommonExamToken==="function")window.loadBCSMCommonExamToken();},100));
