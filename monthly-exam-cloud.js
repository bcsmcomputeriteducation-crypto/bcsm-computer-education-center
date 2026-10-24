import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, updateDoc, onSnapshot, query, orderBy, serverTimestamp, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
const app=getApps().length?getApps()[0]:initializeApp(firebaseConfig),auth=getAuth(app),firestore=getFirestore(app);
const coll=collection(firestore,"monthlyExamRequests"),settingsColl=collection(firestore,"monthlyExamSettings");
const MAIN_ADMIN_EMAIL="bcsmcomputer.iteducation+admin@gmail.com";
const esc=v=>String(v??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const courseKey=v=>String(v??"").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g,"").trim();
function isMainAdmin(){return !!auth.currentUser&&auth.currentUser.email===MAIN_ADMIN_EMAIL&&window.__bcsmFirebaseRole==="admin";}
function friendlyAuthError(e){
 if(["auth/operation-not-allowed","auth/admin-restricted-operation"].includes(e?.code))return "Student login ki zaroorat nahi hai, lekin Firebase Console → Authentication → Sign-in method → Anonymous ko Enable karke Save karein. Phir page reload karein.";
 if(e?.code==="permission-denied")return "Firebase Firestore Rules Publish nahi hue ya monthlyExamRequests/monthlyExamSettings ke rules match nahi kar rahe. ZIP ki firestore.rules Publish karein.";
 return e?.message||String(e);
}
async function ensureStudentSession(){
 if(auth.currentUser) {
   // If the current session is an Admin account, do not use it to create a student request.
   if(auth.currentUser.email===MAIN_ADMIN_EMAIL)await signOut(auth);
   else return auth.currentUser;
 }
 try{const cred=await signInAnonymously(auth);return cred.user}
 catch(e){throw new Error(friendlyAuthError(e))}
}
const api={
 async createRequest(p){
   const user=await ensureStudentSession(),key=courseKey(p.courseCode||p.courseName||p.courseId);
   if(!key)throw new Error("Course ki pehchan nahi mili. Course dobara select karein.");
   const id=crypto.randomUUID();
   const data={...p,courseKey:key,studentUid:user.uid,status:"pending",requestToken:id,requestedAt:new Date().toISOString(),createdAt:serverTimestamp()};
   await setDoc(doc(firestore,"monthlyExamRequests",id),data);
   return {id,...data};
 },
 watchRequest(id,callback){
   return onSnapshot(doc(firestore,"monthlyExamRequests",id),s=>callback(s.exists()?{id:s.id,...s.data()}:null),e=>{
     console.error("Exam request listener:",e);
     const status=document.getElementById("meRequestStatus");
     if(status)status.innerHTML='<div class="error">Approval status load nahi hua: '+esc(friendlyAuthError(e))+'</div>';
   });
 },
 async saveCourseExamSettings(x){
   if(!isMainAdmin())throw new Error("Course settings online save karne ke liye Main Admin ke official Admin Login se login karein. Institute Admin allowed nahi hai.");
   const key=courseKey(x.courseCode||x.courseName||x.title||x.courseId);
   if(!key)throw new Error("Course code nahi mila. Course select karke dobara save karein.");
   const data={courseKey:key,courseId:String(x.courseId||""),courseCode:String(x.courseCode||x.courseName||""),courseName:String(x.courseName||""),title:String(x.title||"Monthly Main Exam"),type:"Monthly Main Exam",questionCount:Number(x.questionCount),duration:Number(x.duration),totalMarks:Number(x.totalMarks),passMarks:Number(x.passMarks),passPercent:Number(x.passPercent),published:true,updatedBy:auth.currentUser.email,updatedAt:serverTimestamp()};
   await setDoc(doc(settingsColl,key),data,{merge:true});
   return data;
 },
 async getCourseExamSettings(courseIdentity){
   const key=courseKey(courseIdentity);
   if(!key) return null;
   const snap=await getDoc(doc(settingsColl,key));
   return snap.exists()?{id:snap.id,...snap.data()}:null;
 },
 async setRequestStatus(id,status){
   if(!isMainAdmin())throw new Error("Sirf Main Admin ke official Admin Login ko approval ka adhikar hai; Institute Admin nahi.");
   if(!["approved","denied"].includes(status))throw new Error("Invalid status");
   await updateDoc(doc(firestore,"monthlyExamRequests",id),{status,approvedAt:new Date().toISOString(),approvedBy:auth.currentUser.email});
 },
 watchAdminRequests(callback){
   if(!isMainAdmin()){callback([]);return ()=>{};}
   return onSnapshot(query(coll,orderBy("requestedAt","desc")),snap=>callback(snap.docs.map(d=>({id:d.id,...d.data()}))),e=>{
     console.error("Admin request feed:",e);
     callback([]);
     const feed=document.getElementById("cloudApprovalFeed");
     if(feed)feed.innerHTML='<p class="error">Approval list load nahi hui: '+esc(friendlyAuthError(e))+'</p>';
   });
 }
};
window.BCSMExamCloud=api;
let adminUnsub=null,latestRows=[];
function renderRows(rows){const pending=rows.filter(r=>r.status==="pending");return `<p class="muted">Sirf Monthly Main Exam ki online pending approvals yahan dikhengi. Main Admin hi approve/deny kar sakta hai.</p><div class="tablewrap"><table><thead><tr><th>Student</th><th>Course / Semester</th><th>Batch</th><th>Requested</th><th>Action</th></tr></thead><tbody>${pending.map(r=>`<tr><td>${esc(r.studentName)}<br>${esc(r.studentPhone||"")}</td><td>${esc(r.courseName||r.courseId)} / ${esc(r.semester)}</td><td>${esc(r.batch)}</td><td>${esc(r.requestedAt||"")}</td><td><button class="small primary" onclick="approveExamRequest('${r.id}')">Approve</button> <button class="small danger" onclick="denyExamRequest('${r.id}')">Deny</button></td></tr>`).join("")||'<tr><td colspan="5">Koi pending Main Exam approval nahi hai.</td></tr>'}</tbody></table></div>`;}
function renderApproval(){const mount=document.getElementById("cloudApprovalMount"),adminContent=document.getElementById("adminContent");if(!mount||!adminContent||!document.getElementById("eCourse"))return;let feed=mount.querySelector("#cloudApprovalFeed");if(!feed){mount.innerHTML='<div class="card" style="margin:18px 0"><h3>🔐 Pending Monthly Main Exam Approvals</h3><div id="cloudApprovalFeed"></div></div>';feed=mount.querySelector("#cloudApprovalFeed");}if(feed)feed.innerHTML=renderRows(latestRows);}
function attachAdminFeed(){const screenOpen=!!document.getElementById("eCourse");if(!screenOpen){if(adminUnsub){adminUnsub();adminUnsub=null;}return;}renderApproval();if(adminUnsub)return;if(isMainAdmin()){adminUnsub=api.watchAdminRequests(rows=>{latestRows=rows;renderApproval();});}else{latestRows=[];renderApproval();const feed=document.getElementById("cloudApprovalFeed");if(feed&&window.__bcsmFirebaseRole!=="admin")feed.innerHTML='<p class="muted">Pending approvals dekhne ke liye official Main Admin account se login karein. Institute Admin ko approval access nahi hai.</p>';}}
window.approveExamRequest=async id=>{try{await api.setRequestStatus(id,"approved");}catch(e){alert("Approval failed: "+(e.message||e));}};
window.denyExamRequest=async id=>{try{await api.setRequestStatus(id,"denied");}catch(e){alert("Deny failed: "+(e.message||e));}};
const observer=new MutationObserver(()=>{if(document.getElementById("eCourse")&&!document.getElementById("cloudApprovalFeed"))attachAdminFeed();else if(!document.getElementById("eCourse")&&adminUnsub){adminUnsub();adminUnsub=null;}});observer.observe(document.body,{childList:true,subtree:true});
onAuthStateChanged(auth,()=>setTimeout(attachAdminFeed,200));window.addEventListener("bcsm-firebase-ready",()=>setTimeout(attachAdminFeed,200));window.addEventListener("bcsm-firebase-auth-ready",()=>setTimeout(attachAdminFeed,250));
