import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, serverTimestamp, getDoc, getDocs } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
const app=getApps().find(a=>a.name==="[DEFAULT]")||(getApps().length?getApps()[0]:initializeApp(firebaseConfig)),auth=getAuth(app),firestore=getFirestore(app);
/* Keep student anonymous sessions separate from Admin email/password sessions. This prevents Start Exam from signing out an Admin or using the Admin UID as a student UID. */
const studentApp=getApps().find(a=>a.name==="bcsmStudentRequests")||initializeApp(firebaseConfig,"bcsmStudentRequests"),studentAuth=getAuth(studentApp),studentFirestore=getFirestore(studentApp);
const coll=collection(firestore,"monthlyExamRequests"),studentRequests=collection(studentFirestore,"monthlyExamRequests"),settingsColl=collection(firestore,"monthlyExamSettings"),studentSettings=collection(studentFirestore,"monthlyExamSettings");
const ADMIN_EMAILS=["bcsmcomputer.iteducation+admin@gmail.com","bcsmcomputer.iteducation+institute@gmail.com"];
const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const courseKey=v=>String(v??"").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"").trim();
function isMainAdmin(){const u=auth.currentUser;return !!u&&(ADMIN_EMAILS.includes(String(u.email||"").toLowerCase())||["n9XlY6yAR7b7vkVjiXkvOXv50O33","YCtq6PUlGKN7hnojQexb8Y3j1qE2"].includes(String(u.uid||"")));}
function friendlyAuthError(e){
 if(["auth/operation-not-allowed","auth/admin-restricted-operation"].includes(e?.code))return "Firebase Console → Authentication → Sign-in method → Anonymous ko Enable karke Save karein; phir page reload karein.";
 if(e?.code==="permission-denied")return "Firestore ne request rok di. Firebase Console → Firestore Database → Rules mein ZIP ki firestore.rules publish karein; Rules publish hue bina cross-device approval kaam nahi karega.";
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
   const data={...p,courseKey:key,studentUid:user.uid,status:"pending",requestToken:id,requestedAt:new Date().toISOString(),createdAt:serverTimestamp()};
   await setDoc(doc(studentFirestore,"monthlyExamRequests",id),data);return {id,...data};
 },
 watchRequest(id,callback){return onSnapshot(doc(studentFirestore,"monthlyExamRequests",id),s=>callback(s.exists()?{id:s.id,...s.data()}:null),e=>{
   console.error("Exam request listener:",e);const status=document.getElementById("meRequestStatus");
   if(status)status.innerHTML='<div class="error">Approval status load nahi hua: '+esc(friendlyAuthError(e))+'</div>';
 });},
 async saveCourseExamSettings(x){
   if(!isMainAdmin())throw new Error("Main Admin Firebase login verify nahi hua. Official Main Admin account se dobara login karein.");
   const code=String(x.courseCode||x.code||"").trim(),name=String(x.courseName||x.name||"").trim(),id=String(x.courseId||"").trim();
   const key=courseKey(code||name||id);if(!key)throw new Error("Course code/ID nahi mila. Course select karke dobara save karein.");
   const questionCount=Number(x.questionCount),duration=Number(x.duration),totalMarks=Number(x.totalMarks),passMarks=Number(x.passMarks),examPassword=String(x.examPassword||"").trim();
   if(!Number.isFinite(questionCount)||questionCount<1||!Number.isFinite(duration)||duration<1||!Number.isFinite(totalMarks)||totalMarks<1||!Number.isFinite(passMarks)||passMarks<0)throw new Error("Questions, duration aur marks ki settings check karein.");
   if(examPassword.length<4||examPassword.length>64)throw new Error("Monthly Main Exam password 4 se 64 characters ka hona chahiye.");
   const data={courseKey:key,courseId:id,courseCode:code,courseName:name,title:String(x.title||"Monthly Main Exam"),type:"Monthly Main Exam",questionCount,duration,totalMarks,passMarks,passPercent:Number.isFinite(Number(x.passPercent))?Number(x.passPercent):Math.round(passMarks/totalMarks*100),examPasswordHash:await hashExamPassword(examPassword),published:true,updatedBy:auth.currentUser.email||auth.currentUser.uid,updatedAt:serverTimestamp()};
   // Write canonical code key and compatibility aliases so old requests using course ID/name resolve too.
   const aliases=[...new Set([key,courseKey(id),courseKey(code),courseKey(name)].filter(Boolean))];
   await Promise.all(aliases.map(alias=>setDoc(doc(settingsColl,alias),{...data,courseKey:alias},{merge:true})));
   // Verify the canonical record from Firestore, not merely the local form state.
   const verify=await getDoc(doc(settingsColl,key));if(!verify.exists()||verify.data().published!==true||verify.data().type!=="Monthly Main Exam")throw new Error("Firestore ne settings save confirm nahi ki. Firebase Console ke Rules aur Main Admin login ko check karein.");
   return {id:key,...verify.data()};
 },
 async getCourseExamSettings(identity){
   const wanted=new Set(identityValues(identity).map(courseKey).filter(Boolean));if(!wanted.size)return null;
   // Check deterministic course-key candidates concurrently. Serial reads could stall
   // the student start flow on slow connections even when the saved setting exists.
   const candidateKeys=[...new Set(identityValues(identity).map(courseKey).filter(Boolean))];
   const candidateSnaps=await Promise.all(candidateKeys.map(key=>getDoc(doc(studentSettings,key))));
   for(const snap of candidateSnaps){
     if(!snap.exists())continue;
     const d={id:snap.id,...snap.data()};
     const values=[d.courseKey,d.courseId,d.courseCode,d.courseName,d.id].map(courseKey);
     if(d.published===true&&d.type==="Monthly Main Exam"&&values.some(v=>wanted.has(v)))return d;
   }
   // Compatibility fallback: older settings may be keyed by ID, code, or full display name.
   const all=await getDocs(studentSettings);
   const matches=all.docs.map(s=>({id:s.id,...s.data()})).filter(d=>{
     if(d.published!==true||d.type!=="Monthly Main Exam")return false;
     return [d.courseKey,d.courseId,d.courseCode,d.courseName,d.id].map(courseKey).some(v=>wanted.has(v));
   });
   if(!matches.length)return null;
   const exact=matches.find(d=>wanted.has(courseKey(d.courseCode)))||matches.find(d=>wanted.has(courseKey(d.courseId)))||matches[0];
   return exact;
 },
 async setRequestStatus(id,status){
   if(!isMainAdmin())throw new Error("Sirf Main Admin official login se approval de sakta hai.");
   if(!["approved","denied"].includes(status))throw new Error("Invalid status");
   const ref=doc(firestore,"monthlyExamRequests",String(id));
   const current=await getDoc(ref);
   if(!current.exists())throw new Error("Yeh request Cloud mein nahi mili. Student se nayi request bhejwayein.");
   const old=current.data();
   if(!["pending","approved","denied"].includes(old.status))throw new Error("Is request ka status pehle hi "+String(old.status||"update")+" ho chuka hai. List refresh karein.");
   if(old.status!==status){
     await updateDoc(ref,{status,approvedAt:new Date().toISOString(),approvedBy:auth.currentUser.email||auth.currentUser.uid});
   }
   /* A student may submit the same exam request more than once (for example after refreshing or pressing the request button again). Resolve sibling pending requests for the exact same student + course + semester + batch, so one approval does not leave a duplicate pending row on the next refresh. */
   if(old.studentUid&&old.courseId&&old.semester){
     const all=await getDocs(coll);
     const siblings=all.docs.filter(s=>{
       if(s.id===String(id))return false;
       const d=s.data()||{};
       return d.status==="pending" && String(d.studentUid||"")===String(old.studentUid) &&
         String(d.courseId||"")===String(old.courseId) &&
         String(d.semester||"").trim().toLowerCase()===String(old.semester||"").trim().toLowerCase() &&
         String(d.batch||"")===String(old.batch||"");
     });
     await Promise.all(siblings.map(s=>updateDoc(s.ref,{status,approvedAt:new Date().toISOString(),approvedBy:auth.currentUser.email||auth.currentUser.uid})));
   }
   const verified=await getDoc(ref);
   if(!verified.exists()||verified.data().status!==status)throw new Error("Approval Cloud par confirm nahi hua. Rules aur internet check karein.");
   // Refresh the visible list immediately; the Firestore listener will also deliver the canonical snapshot.
   latestRows=latestRows.map(r=>r.id===String(id)||(
     old.studentUid && String(r.studentUid||"")===String(old.studentUid) &&
     String(r.courseId||"")===String(old.courseId||"") &&
     String(r.semester||"").trim().toLowerCase()===String(old.semester||"").trim().toLowerCase() &&
     String(r.batch||"")===String(old.batch||"") && r.status==="pending"
   )?{...r,status}:r);
   renderApproval();
   return {id:verified.id,...verified.data()};
 },
 async getExamQuestions(courseId,semester){
   await ensureStudentSession();
   const wantedCourse=String(courseId||"");
   const wantedSemester=String(semester||"").normalize("NFKC").trim().toLowerCase();
   if(!wantedCourse||!wantedSemester)return [];
   const snap=await getDocs(collection(studentFirestore,"examQuestions"));
   const rows=snap.docs.map(d=>{const data=d.data()||{};return data.value&&typeof data.value==="object"?{...data.value,id:data.value.id||d.id}:{...data,id:data.id||d.id};}).filter(q=>String(q.courseId||q.courseID||q.course||"")===wantedCourse&&String(q.semester||q.semesterName||"").normalize("NFKC").trim().toLowerCase()===wantedSemester&&q.autoGenerated!==true);
   const pick=(...xs)=>xs.map(v=>String(v??"").trim()).find(Boolean)||"";
   const seen=new Set();
   return rows.filter(q=>{const text=pick(q.questionHindi,q.hindiQuestion,q.question_hi,q.questionHi,q.questionEnglish,q.englishQuestion,q.question_en,q.questionEn,q.question,q.questionText,q.hindi,q.english).normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim();if(!text||seen.has(text))return false;seen.add(text);return true;});
 },
 async hasExamResult(studentUid,examId){
   if(!studentUid||!examId)return false;
   await ensureStudentSession();
   const q=query(collection(studentFirestore,"monthlyExamResults"),where("studentUid","==",String(studentUid)),where("examId","==",String(examId)));
   const snap=await getDocs(q);return !snap.empty;
 },
 async deleteExamResult(resultId){
   if(!isMainAdmin())throw new Error("Sirf Main Admin online exam result delete kar sakta hai.");
   await deleteDoc(doc(firestore,"monthlyExamResults",String(resultId)));
 },
 async saveExamResult(result){
   const user=await ensureStudentSession();
   if(!user)throw new Error("Student Firebase session nahi mila. Dobara request karke exam submit karein.");
   const id=String(result?.id||"");if(!id)throw new Error("Result ID missing.");
   const payload={...result,id,studentUid:user.uid,submittedAt:serverTimestamp(),source:"web-exam"};
   await setDoc(doc(studentFirestore,"monthlyExamResults",id),payload);
   return payload;
 },
 watchAdminRequests(callback){
   if(!isMainAdmin()){callback([]);return ()=>{};}
   return onSnapshot(coll,snap=>callback(snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.requestedAt||"").localeCompare(String(a.requestedAt||"")))),e=>{
     console.error("Admin request feed:",e);callback([]);const feed=document.getElementById("cloudApprovalFeed");
     if(feed)feed.innerHTML='<p class="error">Approval list load nahi hui: '+esc(friendlyAuthError(e))+'</p>';
   });
 }
};
window.BCSMExamCloud=api;
let adminUnsub=null,latestRows=[];
function renderRows(rows){const pending=rows.filter(r=>r.status==="pending");return `<p class="muted">Sirf Monthly Main Exam ki online pending approvals yahan dikhengi. Main Admin hi approve/deny kar sakta hai.</p><div class="tablewrap"><table><thead><tr><th>Student</th><th>Course / Semester</th><th>Batch</th><th>Requested</th><th>Action</th></tr></thead><tbody>${pending.map(r=>`<tr><td>${esc(r.studentName)}<br>${esc(r.studentPhone||"")}</td><td>${esc(r.courseName||r.courseId)} / ${esc(r.semester)}</td><td>${esc(r.batch)}</td><td>${esc(r.requestedAt||"")}</td><td><button class="small primary" onclick="approveExamRequest('${r.id}')">Approve</button> <button class="small danger" onclick="denyExamRequest('${r.id}')">Deny</button></td></tr>`).join("")||'<tr><td colspan="5">Koi pending Main Exam approval nahi hai.</td></tr>'}</tbody></table></div>`;}
function renderApproval(){const mount=document.getElementById("cloudApprovalMount"),adminContent=document.getElementById("adminContent");if(!mount||!adminContent||!document.getElementById("eCourse"))return;let feed=mount.querySelector("#cloudApprovalFeed");if(!feed){mount.innerHTML='<div class="card" style="margin:18px 0"><h3>🔐 Pending Monthly Main Exam Approvals</h3><div id="cloudApprovalFeed"></div></div>';feed=mount.querySelector("#cloudApprovalFeed");}if(feed)feed.innerHTML=renderRows(latestRows);}
function attachAdminFeed(){if(adminUnsub){adminUnsub();adminUnsub=null;}latestRows=[];}

window.approveExamRequest=async id=>{try{await api.setRequestStatus(id,"approved");}catch(e){alert("Approval failed: "+(e.message||e));}};
window.denyExamRequest=async id=>{try{await api.setRequestStatus(id,"denied");}catch(e){alert("Deny failed: "+(e.message||e));}};
// Approval request listener intentionally removed: Monthly Main Exam uses the shared password setting.

let resultUnsub=null;
function attachResultFeed(){
 if(resultUnsub){resultUnsub();resultUnsub=null;}
 if(!isMainAdmin())return;
 resultUnsub=onSnapshot(collection(firestore,"monthlyExamResults"),snap=>{
   const cloud=snap.docs.map(d=>({id:d.id,...d.data()}));
   window.dispatchEvent(new CustomEvent("bcsm-monthly-cloud-results",{detail:{results:cloud}}));
 },e=>console.error("Monthly result feed failed",e));
}

onAuthStateChanged(auth,()=>{setTimeout(attachAdminFeed,200);setTimeout(attachResultFeed,300)});window.addEventListener("bcsm-firebase-ready",()=>setTimeout(attachAdminFeed,200));window.addEventListener("bcsm-firebase-auth-ready",()=>setTimeout(attachAdminFeed,250));
