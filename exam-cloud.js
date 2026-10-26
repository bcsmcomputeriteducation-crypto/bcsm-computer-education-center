/* BCSM Monthly Exam cloud sync. Exam questions, exam definitions, approval requests,
   exam results and notice text live in Firestore, not browser localStorage. */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, onSnapshot, query, where, setDoc, deleteDoc, writeBatch } from 'https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const store = getFirestore(app);
const ADMIN_EMAIL = 'bcsmcomputer.iteducation+admin@gmail.com';
const COLLECTIONS = {
  examQuestions: 'examQuestions',
  monthlyExams: 'monthlyExams',
  monthlyExamRequests: 'monthlyExamRequests',
  monthlyExamResults: 'monthlyExamResults'
};
const cache = { examQuestions: new Map(), monthlyExams: new Map(), monthlyExamRequests: new Map(), monthlyExamResults: new Map() };
const legacySeed = (() => { const d = window.BCSMExamApp?.getDB?.(); return { examQuestions: [...(d?.questions || [])], monthlyExams: [...(d?.exams || [])], monthlyExamRequests: [...(d?.examRequests || [])], monthlyExamResults: [...(d?.results || []).filter(x => x.examId && x.type && /Monthly/i.test(x.type))], notice: d?.examNotices || '' }; })();
const readyKinds = new Set();
let noticeReady = false;
let authReadyResolve;
let authReady = new Promise(resolve => authReadyResolve = resolve);
let firstCloudLoadResolve;
const cloudReady = new Promise(resolve => firstCloudLoadResolve = resolve);
let initialLoads = 0;
let requestUnsub = null, resultUnsub = null;
let syncing = false;
const signatures = new Map();
const admin = () => auth.currentUser?.email?.toLowerCase() === ADMIN_EMAIL;
const appBridge = () => window.BCSMExamApp;
const appDB = () => appBridge()?.getDB?.();
const stamp = v => JSON.stringify(v, Object.keys(v||{}).sort());
function normalize(docSnap) { return { ...docSnap.data(), id: docSnap.id }; }
function signature(v) { try { return JSON.stringify(v); } catch { return ''; } }
function reportError(err) { console.error('BCSM exam cloud error:', err); }
function applyCollection(kind, docs) {
  const items = docs.map(normalize);
  cache[kind].clear(); items.forEach(x => cache[kind].set(x.id, x));
  signatures.set(kind, signature(items));
  appBridge()?.setCloudData?.(kind, items);
  readyKinds.add(kind); initialLoads++;
  if (initialLoads >= 5) firstCloudLoadResolve();
}
function attachUserScopedListeners(user) {
  if (requestUnsub) requestUnsub(); if (resultUnsub) resultUnsub();
  requestUnsub = resultUnsub = null;
  if (!user) return;
  const requestRef = collection(store, COLLECTIONS.monthlyExamRequests);
  const resultRef = collection(store, COLLECTIONS.monthlyExamResults);
  const reqQuery = admin() ? requestRef : query(requestRef, where('studentUid', '==', user.uid));
  const resQuery = admin() ? resultRef : query(resultRef, where('studentUid', '==', user.uid));
  requestUnsub = onSnapshot(reqQuery, snap => { applyCollection('monthlyExamRequests', snap.docs); if (admin()) appBridge()?.refresh?.(); if (admin() && snap.empty) migrateLegacy('monthlyExamRequests').catch(reportError); }, reportError);
  resultUnsub = onSnapshot(resQuery, snap => {
    const items = snap.docs.map(normalize);
    cache.monthlyExamResults.clear(); items.forEach(x => cache.monthlyExamResults.set(x.id, x));
    signatures.set('monthlyExamResults', signature(items));
    appBridge()?.setCloudData?.('monthlyExamResults', items);
    readyKinds.add('monthlyExamResults'); initialLoads++;
    if (initialLoads >= 5) firstCloudLoadResolve();
    if (admin()) appBridge()?.refresh?.();
    // Never repopulate an intentionally emptied result collection from stale localStorage.
  }, reportError);
}

onAuthStateChanged(auth, user => {
  authReadyResolve();
  attachUserScopedListeners(user);
  if (user && admin()) bootstrapLegacyCloud().catch(reportError);
});

for (const kind of ['examQuestions', 'monthlyExams']) {
  onSnapshot(collection(store, COLLECTIONS[kind]), snap => {
    applyCollection(kind, snap.docs);
    // One-time migration: only the authenticated Main Admin may seed an empty cloud bank
    // from this browser's existing records. Existing cloud records are never overwritten.
  }, reportError);
}
onSnapshotNotice();
function onSnapshotNotice() {
  onSnapshot(doc(store, 'examCloudConfig', 'monthly'), snap => {
    const notice = snap.exists() ? (snap.data().notice || '') : '';
    appBridge()?.setCloudData?.('examNotices', notice);
    noticeReady = true; initialLoads++;
    if (initialLoads >= 5) firstCloudLoadResolve();
    if (admin() && !snap.exists() && legacySeed.notice) {
      setDoc(doc(store, 'examCloudConfig', 'monthly'), { notice: legacySeed.notice, updatedAt: new Date().toISOString() }).catch(reportError);
    }
  }, reportError);
}

async function bootstrapLegacyCloud() {
  if (!admin()) return;
  for (const kind of Object.keys(COLLECTIONS)) {
    if (kind === 'monthlyExamResults') continue; // Do not recreate deleted results from legacy browser data.
    const existing = await getDocs(collection(store, COLLECTIONS[kind]));
    if (existing.empty) await migrateLegacy(kind);
  }
  const noticeRef = doc(store, 'examCloudConfig', 'monthly');
  const noticeSnap = await getDoc(noticeRef);
  if (!noticeSnap.exists() && legacySeed.notice) {
    await setDoc(noticeRef, { notice: legacySeed.notice, updatedAt: new Date().toISOString() });
  }
}

async function migrateLegacy(kind) {
  if (!admin()) return;
  if (kind === 'monthlyExamResults') return; // Result deletion must remain permanent.
  const items = legacySeed[kind] || [];
  if (!items?.length) return;
  // A fresh get immediately before migration prevents a stale empty listener from overwriting cloud data.
  const existing = await getDocs(collection(store, COLLECTIONS[kind]));
  if (!existing.empty) return;
  for (let i=0; i<items.length; i+=400) {
    const batch = writeBatch(store);
    for (const item of items.slice(i, i+400)) batch.set(doc(store, COLLECTIONS[kind], String(item.id)), item);
    await batch.commit();
  }
}

async function ensureStudentAuth() {
  await authReady;
  if (!auth.currentUser) await signInAnonymously(auth);
  await cloudReady;
  return auth.currentUser.uid;
}
async function syncFromApp(d) {
  if (syncing || !d) return;
  // Do not write stale browser-seeded arrays before Firestore has provided its first snapshot.
  if (!readyKinds.has('examQuestions') || !readyKinds.has('monthlyExams')) return;
  syncing = true;
  try {
    if (admin()) {
      await syncCollection('examQuestions', d.questions || [], true);
      await syncCollection('monthlyExams', d.exams || [], true);
      const currentNotice = d.examNotices || '';
      if (noticeReady && currentNotice !== window.__bcsmCloudNotice) {
        await setDoc(doc(store, 'examCloudConfig', 'monthly'), { notice: currentNotice, updatedAt: new Date().toISOString() });
        window.__bcsmCloudNotice = currentNotice;
      }
      await syncCollection('monthlyExamRequests', d.examRequests || [], true);
      await syncCollection('monthlyExamResults', (d.results || []).filter(x => x.examId && x.type && /Monthly/i.test(x.type)), true);
    } else {
      // Students can submit new records only. Rules reject edits/deletes or forged approvals.
      await syncCollection('monthlyExamRequests', d.examRequests || [], false);
      await syncCollection('monthlyExamResults', (d.results || []).filter(x => x.examId && x.type && /Monthly/i.test(x.type)), false);
    }
  } finally { syncing = false; }
}
async function syncCollection(kind, items, canManage) {
  const refName = COLLECTIONS[kind];
  if (!refName) return;
  const deletedResults = kind === 'monthlyExamResults' ? new Set(JSON.parse(localStorage.getItem('bcsmDeletedMonthlyResults_v1') || '[]').map(String)) : new Set();
  const current = new Map((items || []).filter(x => x?.id && !deletedResults.has(String(x.id))).map(x => [String(x.id), x]));
  const previous = cache[kind];
  for (const [id, item] of current) {
    const old = previous.get(id);
    if (signature(item) === signature(old)) continue;
    if (kind === 'monthlyExamRequests' && !canManage && old) continue;
    if (kind === 'monthlyExamResults' && !canManage && old) continue;
    if (!canManage && kind === 'monthlyExamRequests' && item.status !== 'pending') continue;
    if (!canManage && kind === 'monthlyExamResults' && !item.studentUid) continue;
    try {
      await setDoc(doc(store, refName, id), item);
      previous.set(id, item);
    } catch (e) { reportError(e); throw e; }
  }
  if (canManage) {
    for (const [id] of previous) if (!current.has(id)) {
      await deleteDoc(doc(store, refName, id)); previous.delete(id);
    }
  }
  signatures.set(kind, signature([...current.values()]));
}
async function putRequest(request) {
  if (!request?.id) throw new Error('Request ID missing');
  const isAdmin = admin();
  if (!isAdmin && request.status !== 'pending') throw new Error('Student approval change nahi kar sakta');
  await setDoc(doc(store, COLLECTIONS.monthlyExamRequests, String(request.id)), request);
  cache.monthlyExamRequests.set(String(request.id), request);
}
window.BCSMExamCloud = {
  ensureStudentAuth,
  currentUid: () => auth.currentUser?.uid || '',
  isAdmin: admin,
  putRequest,
  syncFromApp,
  ready: cloudReady
};
