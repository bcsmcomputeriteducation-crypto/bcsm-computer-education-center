const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const ADMIN_INITIAL_PASSWORD = defineSecret("ADMIN_INITIAL_PASSWORD");
const INSTITUTE_INITIAL_PASSWORD = defineSecret("INSTITUTE_INITIAL_PASSWORD");
const TEACHER_INITIAL_PASSWORD = defineSecret("TEACHER_INITIAL_PASSWORD");
const SMTP_EMAIL = defineSecret("SMTP_EMAIL");
const SMTP_APP_PASSWORD = defineSecret("SMTP_APP_PASSWORD");
const RESET_BASE_URL = defineSecret("RESET_BASE_URL");
const ALLOWED_ORIGIN = defineSecret("ALLOWED_ORIGIN");
const TARGET_EMAIL = "bcsmcomputer.iteducation@gmail.com";
const ROLES = {
  admin: { uid: "bcsm-role-admin", secret: () => ADMIN_INITIAL_PASSWORD.value(), label: "Admin" },
  instituteAdmin: { uid: "bcsm-role-institute-admin", secret: () => INSTITUTE_INITIAL_PASSWORD.value(), label: "Institute Admin" },
  teacher: { uid: "bcsm-role-teacher", secret: () => TEACHER_INITIAL_PASSWORD.value(), label: "Teacher" }
};
const ALLOWED_ORIGINS = [
  "https://bcsm-computer-education-center.github.io",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];
function cors(req, res) {
  const origin = req.get("origin") || "";
  if (origin && origin === ALLOWED_ORIGIN.value()) res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function matches(password, salt, expected) {
  const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}
function validPassword(p) { return typeof p === "string" && p.length >= 10 && p.length <= 128; }

async function rateLimit(req, action, role, maxAttempts, windowMs) {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
  const key = crypto.createHash("sha256").update(`${action}:${role}:${ip}`).digest("hex");
  const ref = db.collection("roleAuthRateLimits").doc(key);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const d = snap.exists ? snap.data() : {};
    const start = d.windowStart || now;
    const count = now - start > windowMs ? 0 : (d.count || 0);
    if (count >= maxAttempts) throw new Error("Bahut attempts hue. Kuch der baad dobara koshish karein.");
    tx.set(ref, { windowStart: now - start > windowMs ? now : start, count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
}

async function getCredential(role) {
  const ref = db.collection("roleCredentials").doc(role);
  let snap = await ref.get();
  if (!snap.exists) {
    const initial = ROLES[role].secret();
    if (!validPassword(initial)) throw new Error("Initial password secret is missing or invalid. Follow SETUP_HINDI.txt.");
    const h = hashPassword(initial);
    await ref.create({ salt: h.salt, hash: h.hash, updatedAt: admin.firestore.FieldValue.serverTimestamp(), mustChange: true });
    snap = await ref.get();
  }
  return { ref, data: snap.data() };
}
async function sendReset(role, token) {
  const email = SMTP_EMAIL.value();
  const appPassword = SMTP_APP_PASSWORD.value();
  if (!email || !appPassword) throw new Error("SMTP secrets configure nahi hain.");
  const transport = nodemailer.createTransport({ service: "gmail", auth: { user: email, pass: appPassword } });
  const baseUrl = RESET_BASE_URL.value().replace(/\/$/, "");
  const link = `${baseUrl}/reset-password.html?role=${encodeURIComponent(role)}&token=${encodeURIComponent(token)}`;
  await transport.sendMail({
    from: `"BCSM Computer Education Center" <${email}>`,
    to: TARGET_EMAIL,
    subject: `BCSM ${ROLES[role].label} Password Reset`,
    text: `Aapne ${ROLES[role].label} password reset request ki hai.\n\nIs link se sirf ${ROLES[role].label} ka password badlega:\n${link}\n\nYeh link 30 minute mein expire hoga. Agar request aapne nahi ki to email ignore karein.`
  });
}
exports.roleAuth = onRequest({
  region: "us-central1",
  secrets: [ADMIN_INITIAL_PASSWORD, INSTITUTE_INITIAL_PASSWORD, TEACHER_INITIAL_PASSWORD, SMTP_EMAIL, SMTP_APP_PASSWORD, RESET_BASE_URL, ALLOWED_ORIGIN],
  timeoutSeconds: 30,
  memory: "256MiB"
}, async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });
  try {
    const { action, role, password, token, newPassword } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(ROLES, role)) return res.status(400).json({ error: "Role sahi nahi hai." });
    if (action === "login") {
      if (!validPassword(password)) return res.status(401).json({ error: "Password galat hai." });
      const c = await getCredential(role);
      if (!matches(password, c.data.salt, c.data.hash)) return res.status(401).json({ error: "Password galat hai." });
      const customToken = await admin.auth().createCustomToken(ROLES[role].uid, { role });
      return res.json({ customToken, role });
    }
    if (action === "requestReset") {
      const raw = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
      await db.collection("rolePasswordResets").doc(tokenHash).set({
        role, createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 30 * 60 * 1000),
        used: false
      });
      await sendReset(role, raw);
      return res.json({ ok: true });
    }
    if (action === "completeReset") {
      if (typeof token !== "string" || token.length < 32 || !validPassword(newPassword)) {
        return res.status(400).json({ error: "Reset link ya naya password valid nahi hai. Password kam se kam 10 characters ka ho." });
      }
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const resetRef = db.collection("rolePasswordResets").doc(tokenHash);
      const snap = await resetRef.get();
      if (!snap.exists) return res.status(400).json({ error: "Reset link invalid ya pehle use ho chuka hai." });
      const d = snap.data();
      if (d.used || !d.expiresAt || d.expiresAt.toMillis() < Date.now()) return res.status(400).json({ error: "Reset link expire ho gaya. Naya link mangayein." });
      const h = hashPassword(newPassword);
      await db.runTransaction(async tx => {
        const current = await tx.get(resetRef);
        if (!current.exists || current.data().used || current.data().expiresAt.toMillis() < Date.now()) throw new Error("Reset link invalid ya expire ho gaya.");
        tx.set(db.collection("roleCredentials").doc(d.role), {
          salt: h.salt, hash: h.hash,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          mustChange: false
        });
        tx.update(resetRef, { used: true, usedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "Action valid nahi hai." });
  } catch (err) {
    console.error("roleAuth error", err);
    return res.status(500).json({ error: "Request poori nahi ho saki. Firebase/SMTP setup aur Functions logs check karein." });
  }
});
