import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

try {
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  // Expose SDK handles for the next integration step; existing demo login/localStorage is not replaced yet.
  window.BCSMFirebase = { app, auth, db };
  console.info("BCSM Firebase SDK initialized", { projectId: firebaseConfig.projectId });
  window.dispatchEvent(new CustomEvent("bcsm-firebase-ready"));
} catch (error) {
  console.error("BCSM Firebase initialization failed:", error);
  window.dispatchEvent(new CustomEvent("bcsm-firebase-error", { detail: { message: error?.message || "Firebase initialization failed" } }));
}
