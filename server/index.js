import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { createCanvas } from "@napi-rs/canvas";
import pg from "pg";
import pgConnectionString from "pg-connection-string";
import Holidays from "date-holidays";
import { z } from "zod";

const { Pool } = pg;
const { parse: parseConnectionString } = pgConnectionString;
const indiaHolidayProvider = new Holidays("IN");
const indiaStateCalendars = Object.entries(indiaHolidayProvider.getStates("IN"))
  .map(([code, name]) => ({ name, calendar: new Holidays("IN", code) }));
const indiaHolidayYearCache = new Map();
const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET;
const adminEmail = (process.env.ADMIN_EMAIL || "vighnesh.keerthi39@gmail.com").toLowerCase();
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || "uploads");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
const dropboxTokenKey = process.env.DROPBOX_TOKEN_ENCRYPTION_KEY
  ? Buffer.from(process.env.DROPBOX_TOKEN_ENCRYPTION_KEY, "base64")
  : null;
const dropboxConfigured = Boolean(
  process.env.DROPBOX_APP_KEY
  && process.env.DROPBOX_APP_SECRET
  && process.env.DROPBOX_REDIRECT_URI
  && dropboxTokenKey?.length === 32
);
const dropboxOAuthStates = new Map();
const allowedMime = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
const mimeByExtension = new Map([
  [".pdf", "application/pdf"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
]);
const profileMimeByExtension = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
if (!jwtSecret || jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters.");

const pool = new Pool({
  ...(process.env.DATABASE_HOST_OVERRIDE
    ? { ...parseConnectionString(process.env.DATABASE_URL), host: process.env.DATABASE_HOST_OVERRIDE }
    : { connectionString: process.env.DATABASE_URL }),
  ssl: process.env.DATABASE_URL.includes("neon.tech")
    ? {
        servername: new URL(process.env.DATABASE_URL).hostname,
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) =>
          tls.checkServerIdentity(new URL(process.env.DATABASE_URL).hostname, certificate)
      }
    : undefined,
  max: 10,
  idleTimeoutMillis: 30000
});

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173",
  credentials: true
}));
app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
});
const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return callback(new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname));
    }
    callback(null, true);
  }
});
const captchaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false
});
const captchaChallenges = new Map();
const captchaAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const captchaLifetimeMs = 5 * 60 * 1000;

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const randomCaptchaInt = (min, max) => crypto.randomInt(min, max);
function createCaptchaImage(answer) {
  const canvas = createCanvas(200, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "#f3f2ef";
  context.fillRect(0, 0, 200, 64);
  for (let index = 0; index < 7; index += 1) {
    context.beginPath();
    context.moveTo(randomCaptchaInt(4, 196), randomCaptchaInt(4, 60));
    context.lineTo(randomCaptchaInt(4, 196), randomCaptchaInt(4, 60));
    context.strokeStyle = ["#9b91c8", "#a9b5c4", "#c4a0a0"][randomCaptchaInt(0, 3)];
    context.globalAlpha = 0.65;
    context.lineWidth = 1.2;
    context.stroke();
  }
  context.globalAlpha = 1;
  context.font = "bold 29px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  [...answer].forEach((character, index) => {
    const x = 20 + index * 31;
    const y = randomCaptchaInt(30, 40);
    context.save();
    context.translate(x, y);
    context.rotate(randomCaptchaInt(-22, 23) * Math.PI / 180);
    context.fillStyle = "#242333";
    context.fillText(character, 0, 0);
    context.restore();
  });
  return canvas.toBuffer("image/png").toString("base64");
}
function issueCaptcha() {
  const now = Date.now();
  for (const [id, challenge] of captchaChallenges) {
    if (challenge.expiresAt <= now) captchaChallenges.delete(id);
  }
  while (captchaChallenges.size >= 5000) {
    captchaChallenges.delete(captchaChallenges.keys().next().value);
  }
  const answer = Array.from({ length: 6 }, () => captchaAlphabet[randomCaptchaInt(0, captchaAlphabet.length)]).join("");
  const challengeId = crypto.randomUUID();
  captchaChallenges.set(challengeId, { answer, expiresAt: now + captchaLifetimeMs });
  return {
    challengeId,
    image: `data:image/png;base64,${createCaptchaImage(answer)}`
  };
}
function consumeCaptcha(challengeId, answer) {
  if (typeof challengeId !== "string" || typeof answer !== "string") return false;
  const challenge = captchaChallenges.get(challengeId);
  if (!challenge) return false;
  captchaChallenges.delete(challengeId);
  if (challenge.expiresAt <= Date.now()) return false;
  const candidate = answer.trim().toUpperCase();
  if (candidate.length !== challenge.answer.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(challenge.answer));
}
function encryptDropboxToken(token) {
  if (!dropboxConfigured) throw new Error("Dropbox storage is not configured.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dropboxTokenKey, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}
function decryptDropboxToken(value) {
  if (!dropboxConfigured) throw new Error("Dropbox storage is not configured.");
  const [encodedIv, encodedTag, encodedData] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", dropboxTokenKey, Buffer.from(encodedIv, "base64"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedData, "base64")),
    decipher.final()
  ]).toString("utf8");
}
async function getDropboxAccessToken(userId) {
  const { rows } = await pool.query(
    `SELECT access_token_encrypted, refresh_token_encrypted, access_token_expires_at
     FROM dropbox_accounts WHERE user_id = $1`,
    [userId]
  );
  const account = rows[0];
  if (!account) return null;
  if (account.access_token_expires_at && new Date(account.access_token_expires_at).getTime() > Date.now() + 60000) {
    return decryptDropboxToken(account.access_token_encrypted);
  }
  const response = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decryptDropboxToken(account.refresh_token_encrypted),
      client_id: process.env.DROPBOX_APP_KEY,
      client_secret: process.env.DROPBOX_APP_SECRET
    })
  });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string" || !Number.isFinite(result.expires_in)) {
    throw new Error("Dropbox authorization expired. Reconnect your Dropbox account.");
  }
  await pool.query(
    `UPDATE dropbox_accounts
     SET access_token_encrypted = $1, access_token_expires_at = NOW() + make_interval(secs => $2), updated_at = NOW()
     WHERE user_id = $3`,
    [encryptDropboxToken(result.access_token), result.expires_in, userId]
  );
  return result.access_token;
}
async function dropboxApi(accessToken, endpoint, args) {
  const response = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(`Dropbox request failed: ${result.error_summary || response.statusText}`);
    error.statusCode = 502;
    throw error;
  }
  return result;
}
async function uploadDropboxFile(accessToken, remotePath, filePath) {
  const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: remotePath, mode: "add", autorename: true, mute: true })
    },
    body: fs.readFileSync(filePath)
  });
  const result = await response.json();
  if (!response.ok || typeof result.path_lower !== "string") {
    const error = new Error(`Dropbox upload failed: ${result.error_summary || response.statusText}`);
    error.statusCode = 502;
    throw error;
  }
  return result.path_lower;
}
async function downloadDropboxFile(accessToken, remotePath) {
  const response = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({ path: remotePath })
    }
  });
  if (!response.ok) {
    const errorBody = await response.text();
    let summary;
    try { summary = JSON.parse(errorBody).error_summary; } catch { summary = null; }
    const error = new Error(`Dropbox download failed: ${summary || response.statusText}`);
    error.statusCode = 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}
const monthStart = (value = new Date()) => {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
};
function getRegionalIndiaHolidays(year) {
  if (indiaHolidayYearCache.has(year)) return indiaHolidayYearCache.get(year);
  const holidaysByDateAndName = new Map();
  for (const state of indiaStateCalendars) {
    for (const holiday of state.calendar.getHolidays(year)) {
      if (holiday.type !== "public") continue;
      const date = holiday.date.slice(0, 10);
      const key = `${date}|${holiday.name}`;
      const existing = holidaysByDateAndName.get(key);
      if (existing) {
        existing.regions.add(state.name);
      } else {
        holidaysByDateAndName.set(key, {
          holiday_date: date,
          name: holiday.name,
          category: "Indian public holiday",
          regions: new Set([state.name])
        });
      }
    }
  }
  const holidays = [...holidaysByDateAndName.values()].map(({ regions, ...holiday }) => ({
    ...holiday,
    region: regions.size >= indiaStateCalendars.length ? "India" : [...regions].join(", ")
  }));
  if (indiaHolidayYearCache.size >= 10) indiaHolidayYearCache.delete(indiaHolidayYearCache.keys().next().value);
  indiaHolidayYearCache.set(year, holidays);
  return holidays;
}
const makeToken = (user) => jwt.sign(
  { sub: user.id, role: user.role },
  jwtSecret,
  { expiresIn: "12h", issuer: "orbit-people" }
);
const setAuthCookie = (res, token) => {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `orbit_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`);
};
const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  role: row.role,
  status: row.status,
  fullName: row.full_name || row.email,
  employeeCode: row.employee_code || null,
  designation: row.designation || null,
  department: row.department || null,
  joiningDate: row.joining_date || null,
  upiId: row.upi_id || null,
  profilePicture: row.profile_picture
    ? `/api/employees/${row.id}/photo?v=${encodeURIComponent(path.basename(row.profile_picture))}`
    : null
});
const audit = (db, actorId, action, entityType, entityId, details = {}) =>
  db.query(
    "INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details) VALUES ($1, $2, $3, $4, $5)",
    [actorId || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details)]
  );
const notify = (db, userId, title, message) =>
  db.query(
    "INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)",
    [userId || null, title, message]
  );
const matchesDocumentSignature = (file) => {
  const extension = path.extname(file.originalname).toLowerCase();
  if (mimeByExtension.get(extension) !== file.mimetype) return false;
  const bytes = fs.readFileSync(file.path);
  if (extension === ".pdf") return bytes.subarray(0, 5).toString() === "%PDF-";
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".doc") return bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  return extension === ".docx"
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && bytes.includes(Buffer.from("word/document.xml"))
    && bytes.includes(Buffer.from("[Content_Types].xml"));
};
const matchesProfileImageSignature = (file) => {
  const extension = path.extname(file.originalname).toLowerCase();
  if (profileMimeByExtension.get(extension) !== file.mimetype) return false;
  const bytes = file.buffer;
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return extension === ".webp"
    && bytes.subarray(0, 4).toString() === "RIFF"
    && bytes.subarray(8, 12).toString() === "WEBP";
};

async function ensureBalances(db, userId, forDate = new Date()) {
  const month = monthStart(forDate);
  const { rows } = await db.query("SELECT value FROM admin_settings WHERE key = 'leave_policy'");
  const policy = rows[0]?.value || { medical: 2, casual: 1 };
  await db.query(
    `INSERT INTO leave_balances (user_id, month, leave_type, allowance)
     VALUES ($1, $2, 'medical', $3), ($1, $2, 'casual', $4)
     ON CONFLICT (user_id, month, leave_type) DO NOTHING`,
    [userId, month, Number(policy.medical || 2), Number(policy.casual || 1)]
  );
}

async function currentUser(req, res, next) {
  const header = req.headers.authorization || "";
  const cookie = (req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("orbit_session="));
  let token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    if (!token && cookie) token = decodeURIComponent(cookie.slice("orbit_session=".length));
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret, { issuer: "orbit-people" });
  } catch {
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.role, u.status, p.full_name, p.employee_code, p.designation,
              p.profile_picture, p.upi_id, d.name AS department, p.joining_date
       FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id
       LEFT JOIN departments d ON d.id = p.department_id WHERE u.id = $1`,
      [claims.sub]
    );
    if (!rows[0] || rows[0].status !== "approved") return res.status(401).json({ error: "This account is not active." });
    req.user = publicUser(rows[0]);
    next();
  } catch (error) {
    next(error);
  }
}

const allow = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: "You do not have permission to perform this action." });
  next();
};

const handleAuthError = (res, error) => res.status(400).json({ error: error.message });

app.get("/api/health", asyncRoute(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, database: "connected" });
}));

app.get("/api/bootstrap", asyncRoute(async (_req, res) => {
  const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM users WHERE role = 'super_admin') AS configured");
  res.json({
    setupRequired: !rows[0].configured,
    adminEmail,
    workdayThresholds: { halfDayMinutes: 240, fullDayMinutes: 480 }
  });
}));

app.get("/api/auth/captcha", captchaLimiter, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(issueCaptcha());
});

app.post("/api/auth/setup", authLimiter, asyncRoute(async (req, res) => {
  if (!consumeCaptcha(req.body.captchaChallengeId, req.body.captchaAnswer)) {
    return res.status(400).json({ error: "CAPTCHA answer is incorrect or expired. Please try the new challenge." });
  }
  try {
    const input = z.object({
      email: z.string().email().transform((value) => value.toLowerCase()),
      password: z.string().min(12).max(128),
      fullName: z.string().trim().min(2).max(100)
    }).parse(req.body);
    if (input.email !== adminEmail) return res.status(403).json({ error: "Use the configured administrator email for initial setup." });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(772611)");
      const { rowCount } = await client.query("SELECT id FROM users WHERE role = 'super_admin'");
      if (rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "Initial administrator setup has already been completed." });
      }
      const hash = await bcrypt.hash(input.password, 12);
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, 'super_admin', 'approved') RETURNING id, email, role, status`,
        [input.email, hash]
      );
      const department = await client.query(
        "INSERT INTO departments (name) VALUES ('Administration') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id"
      );
      await client.query(
        `INSERT INTO employee_profiles (user_id, employee_code, full_name, department_id, designation, employment_type, monthly_salary)
         VALUES ($1, 'ADMIN', $2, $3, 'Super Administrator', 'Administrator', 0)`,
        [rows[0].id, input.fullName, department.rows[0].id]
      );
      await audit(client, rows[0].id, "admin.setup", "user", rows[0].id);
      await client.query("COMMIT");
      setAuthCookie(res, makeToken(rows[0]));
      res.status(201).json({ user: { ...rows[0], fullName: input.fullName } });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0].message });
    handleAuthError(res, error);
  }
}));

app.post("/api/auth/register", authLimiter, profileImageUpload.single("profilePicture"), asyncRoute(async (req, res) => {
  if (req.file && !matchesProfileImageSignature(req.file)) {
    return res.status(400).json({ error: "The profile picture content does not match its file type." });
  }
  if (!consumeCaptcha(req.body.captchaChallengeId, req.body.captchaAnswer)) {
    return res.status(400).json({ error: "CAPTCHA answer is incorrect or expired. Please try the new challenge." });
  }
  try {
    const input = z.object({
      fullName: z.string().trim().min(2).max(100),
      email: z.string().email().transform((value) => value.toLowerCase()),
      phone: z.string().trim().max(30).optional().default(""),
      password: z.string().min(10).max(128),
      department: z.string().trim().min(2).max(80),
      designation: z.string().trim().min(2).max(80),
      employmentType: z.enum(["Intern", "Full-Time Employee", "HR", "Manager"]),
      joiningDate: z.string().optional().default(""),
      address: z.string().max(300).optional().default(""),
      emergencyContact: z.string().max(100).optional().default("")
    }).parse(req.body);
    if (input.email === adminEmail) return res.status(409).json({ error: "That email is reserved for the administrator." });

    const role = {
      Intern: "intern",
      "Full-Time Employee": "employee",
      HR: "hr",
      Manager: "manager"
    }[input.employmentType];
    const baseSalary = { Intern: 12000, "Full-Time Employee": 30000, HR: 30000, Manager: 30000 }[input.employmentType];
    let savedProfilePicture;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const hash = await bcrypt.hash(input.password, 12);
      const { rows } = await client.query(
        "INSERT INTO users (email, password_hash, role, status) VALUES ($1, $2, $3, 'pending') RETURNING id, email, role, status",
        [input.email, hash, role]
      );
      const department = await client.query(
        "INSERT INTO departments (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        [input.department]
      );
      const employeeCode = `EMP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      const profilePicture = req.file
        ? `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`
        : null;
      await client.query(
        `INSERT INTO employee_profiles
         (user_id, employee_code, full_name, phone, department_id, designation, employment_type, joining_date, address, emergency_contact, monthly_salary, profile_picture)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULLIF($8, '')::date, NULLIF($9, ''), NULLIF($10, ''), $11, $12)`,
        [rows[0].id, employeeCode, input.fullName, input.phone, department.rows[0].id, input.designation, input.employmentType, input.joiningDate, input.address, input.emergencyContact, baseSalary, profilePicture]
      );
      await ensureBalances(client, rows[0].id);
      await notify(client, null, "New registration", `${input.fullName} submitted an employee registration.`);
      await audit(client, null, "employee.register", "user", rows[0].id);
      if (req.file && profilePicture) {
        fs.mkdirSync(uploadRoot, { recursive: true });
        savedProfilePicture = path.join(uploadRoot, profilePicture);
        fs.writeFileSync(savedProfilePicture, req.file.buffer, { flag: "wx" });
      }
      await client.query("COMMIT");
      res.status(201).json({ message: "Registration submitted. An administrator must approve your account before you can sign in." });
    } catch (error) {
      await client.query("ROLLBACK");
      if (savedProfilePicture && fs.existsSync(savedProfilePicture)) fs.unlinkSync(savedProfilePicture);
      if (error.code === "23505") return res.status(409).json({ error: "An account with that email already exists." });
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0].message });
    handleAuthError(res, error);
  }
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  if (!consumeCaptcha(req.body.captchaChallengeId, req.body.captchaAnswer)) {
    return res.status(400).json({ error: "CAPTCHA answer is incorrect or expired. Please try the new challenge." });
  }
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter a valid email address and password." });
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.role, u.status, p.full_name, p.employee_code, p.designation,
            p.profile_picture, p.upi_id, d.name AS department, p.joining_date
     FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id
     LEFT JOIN departments d ON d.id = p.department_id WHERE u.email = $1`,
    [input.data.email.toLowerCase()]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(input.data.password, user.password_hash))) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (user.status === "pending") return res.status(403).json({ error: "Your registration is awaiting administrator approval." });
  if (user.status !== "approved") return res.status(403).json({ error: "This account is not active. Contact your administrator." });
  await pool.query("INSERT INTO login_events (user_id) VALUES ($1)", [user.id]);
  setAuthCookie(res, makeToken(user));
  res.json({ user: publicUser(user) });
}));

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "orbit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.status(204).end();
});

app.get("/api/me", currentUser, (req, res) => res.json({ user: req.user }));

app.patch("/api/me/payment-details", currentUser, asyncRoute(async (req, res) => {
  const input = z.object({
    upiId: z.string().trim().max(100).refine(
      (value) => value === "" || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(value),
      "Enter a valid UPI ID, such as name@bank."
    )
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || "Enter a valid UPI ID." });
  const { rows } = await pool.query(
    "UPDATE employee_profiles SET upi_id = $1 WHERE user_id = $2 RETURNING upi_id",
    [input.data.upiId || null, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Your employee profile was not found." });
  res.json({ user: { ...req.user, upiId: rows[0].upi_id } });
}));

app.post("/api/me/profile-picture", currentUser, profileImageUpload.single("profilePicture"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a JPG, PNG, or WebP profile picture." });
  if (!matchesProfileImageSignature(req.file)) {
    return res.status(400).json({ error: "The profile picture content does not match its file type." });
  }

  const filename = `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase()}`;
  const fullPath = path.join(uploadRoot, filename);
  fs.mkdirSync(uploadRoot, { recursive: true });
  fs.writeFileSync(fullPath, req.file.buffer, { flag: "wx" });

  try {
    const previous = await pool.query(
      "SELECT profile_picture FROM employee_profiles WHERE user_id = $1",
      [req.user.id]
    );
    if (!previous.rows[0]) {
      fs.unlinkSync(fullPath);
      return res.status(404).json({ error: "Your employee profile was not found." });
    }

    const { rows } = await pool.query(
      "UPDATE employee_profiles SET profile_picture = $1 WHERE user_id = $2 RETURNING profile_picture",
      [filename, req.user.id]
    );
    if (!rows[0]) {
      fs.unlinkSync(fullPath);
      return res.status(404).json({ error: "Your employee profile was not found." });
    }
    const oldFilename = previous.rows[0].profile_picture && path.basename(previous.rows[0].profile_picture);
    if (oldFilename && oldFilename !== filename && profileMimeByExtension.has(path.extname(oldFilename).toLowerCase())) {
      const oldPath = path.join(uploadRoot, oldFilename);
      try {
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (cleanupError) {
        console.error("Previous profile picture cleanup failed:", cleanupError.message);
      }
    }

    res.json({
      user: {
        ...req.user,
        profilePicture: `/api/employees/${req.user.id}/photo?v=${encodeURIComponent(filename)}`
      }
    });
  } catch (error) {
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    throw error;
  }
}));

app.get("/api/dropbox/status", currentUser, asyncRoute(async (req, res) => {
  if (!dropboxConfigured) return res.json({ configured: false, connected: false, email: null });
  const { rows } = await pool.query("SELECT email FROM dropbox_accounts WHERE user_id = $1", [req.user.id]);
  res.json({ configured: true, connected: Boolean(rows[0]), email: rows[0]?.email || null });
}));

app.get("/api/dropbox/connect", currentUser, (_req, res, next) => {
  if (!dropboxConfigured) {
    return res.status(503).json({ error: "Dropbox is not configured. Ask the administrator to configure its OAuth app." });
  }
  try {
    const now = Date.now();
    for (const [nonce, state] of dropboxOAuthStates) {
      if (state.expiresAt <= now) dropboxOAuthStates.delete(nonce);
    }
    const nonce = crypto.randomBytes(24).toString("hex");
    const state = jwt.sign({ sub: _req.user.id, nonce }, jwtSecret, { expiresIn: "10m", issuer: "orbit-dropbox" });
    dropboxOAuthStates.set(nonce, { userId: _req.user.id, expiresAt: now + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: process.env.DROPBOX_APP_KEY,
      response_type: "code",
      token_access_type: "offline",
      redirect_uri: process.env.DROPBOX_REDIRECT_URI,
      state,
      scope: "files.content.read files.content.write account_info.read",
      include_granted_scopes: "user"
    });
    res.redirect(302, `https://www.dropbox.com/oauth2/authorize?${params}`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/dropbox/callback", asyncRoute(async (req, res) => {
  const clientOrigin = process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173";
  if (req.query.error) return res.redirect(303, `${clientOrigin}/?dropbox=denied`);
  const stateToken = typeof req.query.state === "string" ? req.query.state : "";
  let claims;
  try {
    claims = jwt.verify(stateToken, jwtSecret, { issuer: "orbit-dropbox" });
  } catch {
    return res.status(400).send("Dropbox connection expired. Return to V_Solutions and try again.");
  }
  const state = dropboxOAuthStates.get(claims.nonce);
  if (!state || state.expiresAt <= Date.now() || state.userId !== claims.sub) {
    dropboxOAuthStates.delete(claims.nonce);
    return res.status(400).send("Dropbox connection expired or was already used. Return to V_Solutions and try again.");
  }
  dropboxOAuthStates.delete(claims.nonce);
  if (!dropboxConfigured) return res.status(503).send("Dropbox is not configured on this server.");
  if (typeof req.query.code !== "string") return res.status(400).send("Dropbox did not return an authorization code.");
  try {
    const tokenResponse = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        client_id: process.env.DROPBOX_APP_KEY,
        client_secret: process.env.DROPBOX_APP_SECRET,
        redirect_uri: process.env.DROPBOX_REDIRECT_URI
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
      throw new Error("Dropbox did not provide a usable offline authorization.");
    }
    const accountResponse = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}` }
    });
    const account = await accountResponse.json();
    if (!accountResponse.ok || typeof account.account_id !== "string" || typeof account.email !== "string") {
      throw new Error("Could not verify the Dropbox account.");
    }
    await pool.query(
      `INSERT INTO dropbox_accounts
       (user_id, dropbox_account_id, email, refresh_token_encrypted, access_token_encrypted, access_token_expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
       ON CONFLICT (user_id) DO UPDATE SET
         dropbox_account_id = EXCLUDED.dropbox_account_id,
         email = EXCLUDED.email,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         updated_at = NOW()`,
      [
        state.userId,
        account.account_id,
        account.email,
        encryptDropboxToken(tokens.refresh_token),
        encryptDropboxToken(tokens.access_token),
        tokens.expires_in
      ]
    );
    return res.redirect(303, `${clientOrigin}/?dropbox=connected`);
  } catch (error) {
    console.error("Dropbox OAuth callback failed:", error.message);
    return res.redirect(303, `${clientOrigin}/?dropbox=error`);
  }
}));

app.get("/api/dashboard", currentUser, asyncRoute(async (req, res) => {
  if (req.user.role === "super_admin" || req.user.role === "hr") {
    const [stats, pending, attendance, payroll, trends, latest] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE u.status = 'approved')::int AS employees,
        COUNT(*) FILTER (WHERE u.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE p.employment_type = 'Intern' AND u.status = 'approved')::int AS interns,
        COUNT(*) FILTER (WHERE p.employment_type = 'Manager' AND u.status = 'approved')::int AS managers,
        COUNT(*) FILTER (WHERE p.employment_type = 'HR' AND u.status = 'approved')::int AS hr
        FROM users u LEFT JOIN employee_profiles p ON p.user_id = u.id WHERE u.role <> 'super_admin'`),
      pool.query(`SELECT u.id, u.email, u.role, u.created_at, p.full_name, p.employee_code, p.designation, d.name AS department
        FROM users u JOIN employee_profiles p ON p.user_id = u.id LEFT JOIN departments d ON d.id = p.department_id
        WHERE u.status = 'pending' ORDER BY u.created_at DESC LIMIT 8`),
      pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE attendance_date = CURRENT_DATE)::int AS today
        FROM attendance WHERE attendance_date >= date_trunc('month', CURRENT_DATE)::date`),
      pool.query("SELECT COALESCE(SUM(net_pay), 0)::numeric AS total FROM salary_records WHERE pay_month = date_trunc('month', CURRENT_DATE)::date"),
      pool.query(`SELECT TO_CHAR(attendance_date, 'Mon') AS month, COUNT(*)::int AS days
        FROM attendance WHERE attendance_date >= CURRENT_DATE - INTERVAL '5 months'
        GROUP BY date_trunc('month', attendance_date), TO_CHAR(attendance_date, 'Mon')
        ORDER BY date_trunc('month', attendance_date)`),
      pool.query(`SELECT title, message, created_at FROM notifications WHERE user_id IS NULL
        ORDER BY created_at DESC LIMIT 5`)
    ]);
    return res.json({
      stats: { ...stats.rows[0], attendance: attendance.rows[0].total, attendanceToday: attendance.rows[0].today, monthlyPayroll: payroll.rows[0].total },
      pending: pending.rows,
      attendanceTrend: trends.rows,
      notifications: latest.rows
    });
  }

  await ensureBalances(pool, req.user.id);
  const [profile, attendance, balances, salary, performance, notifications] = await Promise.all([
    pool.query(`SELECT p.*, d.name AS department FROM employee_profiles p LEFT JOIN departments d ON d.id = p.department_id WHERE p.user_id = $1`, [req.user.id]),
    pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'present')::int AS present,
      COUNT(*) FILTER (WHERE attendance_date = CURRENT_DATE AND check_in IS NOT NULL)::int AS checked_in
      FROM attendance WHERE user_id = $1 AND attendance_date >= date_trunc('month', CURRENT_DATE)::date`, [req.user.id]),
    pool.query("SELECT leave_type, allowance - used AS remaining FROM leave_balances WHERE user_id = $1 AND month = $2", [req.user.id, monthStart()]),
    pool.query("SELECT net_pay, payment_status, pay_month FROM salary_records WHERE user_id = $1 ORDER BY pay_month DESC LIMIT 1", [req.user.id]),
    pool.query("SELECT overall_score, review_month FROM performance_reviews WHERE user_id = $1 ORDER BY review_month DESC LIMIT 1", [req.user.id]),
    pool.query("SELECT title, message, created_at FROM notifications WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 5", [req.user.id])
  ]);
  res.json({ profile: profile.rows[0], stats: attendance.rows[0], balances: balances.rows, salary: salary.rows[0] || null, performance: performance.rows[0] || null, notifications: notifications.rows });
}));

app.get("/api/team-activity", currentUser, allow("super_admin"), asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(
    `WITH india_day AS (
       SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today
     ),
     last_login AS (
       SELECT DISTINCT ON (l.user_id) l.user_id, l.logged_in_at
       FROM login_events l CROSS JOIN india_day d
       WHERE (l.logged_in_at AT TIME ZONE 'Asia/Kolkata')::date = d.today
       ORDER BY l.user_id, l.logged_in_at DESC
     ),
     today_attendance AS (
       SELECT a.* FROM attendance a CROSS JOIN india_day d
       WHERE a.attendance_date = d.today
     )
     SELECT u.id, u.email, u.role, p.full_name, p.employee_code, p.designation,
       d.name AS department, ll.logged_in_at, a.check_in, a.check_out,
       COALESCE(a.working_minutes,
         CASE WHEN a.check_in IS NOT NULL AND a.check_out IS NULL
           THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - a.check_in)) / 60)::int)
           ELSE NULL
         END
       ) AS working_minutes,
       CASE
         WHEN a.check_in IS NULL AND ll.logged_in_at IS NOT NULL THEN 'Logged in · not checked in'
         WHEN a.check_in IS NULL THEN 'Not logged in'
         WHEN COALESCE(a.working_minutes,
           CASE WHEN a.check_out IS NULL THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - a.check_in)) / 60)::int ELSE 0 END
         ) >= 480 THEN CASE WHEN a.check_out IS NULL THEN 'Full day · in progress' ELSE 'Full day' END
         WHEN COALESCE(a.working_minutes,
           CASE WHEN a.check_out IS NULL THEN FLOOR(EXTRACT(EPOCH FROM (NOW() - a.check_in)) / 60)::int ELSE 0 END
         ) >= 240 THEN CASE WHEN a.check_out IS NULL THEN 'Half day · in progress' ELSE 'Half day' END
         WHEN a.check_out IS NULL THEN 'In progress · under 4 hours'
         ELSE 'Under 4 hours'
       END AS day_classification
     FROM users u
     JOIN employee_profiles p ON p.user_id = u.id
     LEFT JOIN departments d ON d.id = p.department_id
     LEFT JOIN last_login ll ON ll.user_id = u.id
     LEFT JOIN today_attendance a ON a.user_id = u.id
     WHERE u.status = 'approved' AND u.role <> 'super_admin'
     ORDER BY p.full_name`,
    []
  );
  res.json({ activity: rows, thresholds: { halfDayMinutes: 240, fullDayMinutes: 480 } });
}));

app.get("/api/holidays", currentUser, asyncRoute(async (req, res) => {
  const year = z.coerce.number().int().min(2020).max(2100).safeParse(req.query.year || new Date().getFullYear());
  if (!year.success) return res.status(400).json({ error: "Choose a valid holiday calendar year." });
  const { rows } = await pool.query(
    `SELECT id, to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date, name, category, region
     FROM holidays
     WHERE holiday_date >= make_date($1, 1, 1)
       AND holiday_date < make_date($1 + 1, 1, 1)
     ORDER BY holiday_date`,
    [year.data]
  );
  const combined = new Map(rows.map((holiday) => [`${holiday.holiday_date}|${holiday.name}`, holiday]));
  for (const holiday of getRegionalIndiaHolidays(year.data)) {
    const key = `${holiday.holiday_date}|${holiday.name}`;
    const existing = combined.get(key);
    if (existing) {
      if (existing.region === "India" && holiday.region !== "India") continue;
      if (existing.region !== "India" && holiday.region !== "India") {
        existing.region = [...new Set(`${existing.region}, ${holiday.region}`.split(", "))].join(", ");
      }
    } else {
      combined.set(key, holiday);
    }
  }
  res.json({ year: year.data, holidays: [...combined.values()].sort((left, right) => left.holiday_date.localeCompare(right.holiday_date)) });
}));

app.get("/api/employees", currentUser, allow("super_admin", "hr", "manager"), asyncRoute(async (req, res) => {
  const params = [];
  let where = "WHERE u.role <> 'super_admin'";
  if (req.user.role === "manager") {
    params.push(req.user.id);
    where += ` AND p.manager_id = $${params.length}`;
  }
  if (req.query.status && req.user.role === "super_admin") {
    params.push(String(req.query.status));
    where += ` AND u.status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.status, u.created_at, p.employee_code, p.full_name, p.phone,
            p.designation, p.employment_type, p.joining_date, p.address, p.emergency_contact,
            CASE WHEN p.profile_picture IS NOT NULL THEN '/api/employees/' || u.id || '/photo' END AS profile_picture,
            ${req.user.role === "super_admin" ? "p.monthly_salary" : "NULL::numeric"} AS monthly_salary,
            ${req.user.role === "super_admin" ? "p.upi_id" : "NULL::text"} AS upi_id,
            d.name AS department
     FROM users u JOIN employee_profiles p ON p.user_id = u.id
     LEFT JOIN departments d ON d.id = p.department_id ${where}
     ORDER BY u.created_at DESC`,
    params
  );
  res.json({ employees: rows });
}));

app.get("/api/employees/:id/photo", currentUser, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT profile_picture, manager_id FROM employee_profiles WHERE user_id = $1",
    [req.params.id]
  );
  const employee = rows[0];
  if (!employee?.profile_picture) return res.status(404).json({ error: "Profile picture was not found." });
  const canView = employee.manager_id === req.user.id
    || ["super_admin", "hr"].includes(req.user.role);
  if (req.params.id !== req.user.id && !canView) {
    return res.status(403).json({ error: "You may not access this profile picture." });
  }
  const filename = path.basename(employee.profile_picture);
  const fullPath = path.join(uploadRoot, filename);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "The stored profile picture is unavailable." });
  const mimeType = profileMimeByExtension.get(path.extname(filename).toLowerCase());
  if (!mimeType) return res.status(404).json({ error: "The stored profile picture has an unsupported file type." });
  res.setHeader("Cache-Control", "private, no-store");
  res.type(mimeType);
  res.sendFile(fullPath);
}));

app.patch("/api/employees/:id/status", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({ status: z.enum(["approved", "rejected", "inactive"]) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Choose an allowed account status." });
  const { rows } = await pool.query(
    `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 AND role <> 'super_admin'
     RETURNING id, email, status`,
    [input.data.status, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Employee account was not found." });
  await audit(pool, req.user.id, `employee.${input.data.status}`, "user", rows[0].id);
  await notify(pool, rows[0].id, "Account status updated", `Your employee account was ${input.data.status}.`);
  res.json({ employee: rows[0] });
}));

app.patch("/api/employees/:id/salary", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({ monthlySalary: z.number().positive().max(10000000) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter a valid monthly salary." });
  const { rows } = await pool.query(
    `UPDATE employee_profiles SET monthly_salary = $1 WHERE user_id = $2
     RETURNING user_id, monthly_salary`,
    [input.data.monthlySalary, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Employee was not found." });
  await audit(pool, req.user.id, "salary.update", "employee", req.params.id, { monthlySalary: input.data.monthlySalary });
  res.json({ employee: rows[0] });
}));

app.get("/api/attendance", currentUser, asyncRoute(async (req, res) => {
  const canSeeAll = req.user.role === "super_admin";
  const isManager = req.user.role === "manager";
  if (!canSeeAll && !isManager && req.query.userId && String(req.query.userId) !== req.user.id) return res.status(403).json({ error: "You may only view your own attendance." });
  const target = req.query.userId ? String(req.query.userId) : null;
  const month = z.string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine((value) => Number(value.slice(0, 4)) >= 1900 && Number(value.slice(0, 4)) <= 2100)
    .safeParse(req.query.month || new Date().toISOString().slice(0, 7));
  if (!month.success) return res.status(400).json({ error: "Choose a valid attendance month." });
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, to_char(a.attendance_date, 'YYYY-MM-DD') AS attendance_date,
            a.check_in, a.check_out, a.working_minutes, a.status, a.leave_type, a.created_at,
            p.full_name, p.employee_code FROM attendance a
     LEFT JOIN employee_profiles p ON p.user_id = a.user_id
     WHERE a.attendance_date >= $5::date AND a.attendance_date < ($5::date + INTERVAL '1 month')
       AND (($1::boolean AND ($2::uuid IS NULL OR a.user_id = $2))
         OR ($3::boolean AND (a.user_id = $4 OR p.manager_id = $4))
         OR (NOT $1::boolean AND NOT $3::boolean AND a.user_id = $4))
     ORDER BY a.attendance_date DESC`,
    [canSeeAll, target, isManager, req.user.id, `${month.data}-01`]
  );
  res.json({ attendance: rows });
}));

app.post("/api/attendance", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({
    userId: z.string().uuid(),
    attendanceDate: z.string().date(),
    status: z.enum(["present", "absent", "half_day", "leave"]),
    leaveType: z.enum(["medical", "casual", "unpaid"]).nullable().default(null)
  }).refine(
    (value) => value.status === "leave" ? value.leaveType !== null : value.leaveType === null,
    "Choose a leave type only when attendance status is Leave."
  ).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || "Enter valid attendance details." });
  const employee = await pool.query(
    `SELECT u.id FROM users u
     WHERE u.id = $1 AND u.status = 'approved' AND u.role <> 'super_admin'`,
    [input.data.userId]
  );
  if (!employee.rowCount) return res.status(404).json({ error: "Approved employee was not found." });
  const { rows } = await pool.query(
    `INSERT INTO attendance (user_id, attendance_date, status, leave_type, check_in, check_out, working_minutes)
     VALUES ($1, $2, $3, $4, NULL, NULL, NULL)
     ON CONFLICT (user_id, attendance_date) DO UPDATE SET
       status = EXCLUDED.status, leave_type = EXCLUDED.leave_type,
       check_in = NULL, check_out = NULL, working_minutes = NULL
     RETURNING *`,
    [input.data.userId, input.data.attendanceDate, input.data.status, input.data.leaveType]
  );
  await audit(pool, req.user.id, "attendance.record", "attendance", rows[0].id, {
    userId: input.data.userId,
    attendanceDate: input.data.attendanceDate,
    status: input.data.status,
    leaveType: input.data.leaveType
  });
  await notify(pool, input.data.userId, "Attendance updated", `Your attendance for ${input.data.attendanceDate} was marked ${input.data.status.replace("_", " ")}.`);
  res.status(201).json({ attendance: rows[0] });
}));

app.post("/api/attendance/check-in", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO attendance (user_id, attendance_date, check_in)
       VALUES ($1, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, NOW()) RETURNING *`,
      [req.user.id]
    );
    res.status(201).json({ attendance: rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "You have already checked in today." });
    throw error;
  }
}));

app.post("/api/attendance/check-out", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE attendance SET check_out = NOW(),
       working_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - check_in)) / 60)::int),
       status = CASE
         WHEN EXTRACT(EPOCH FROM (NOW() - check_in)) / 60 >= 480 THEN 'present'
         WHEN EXTRACT(EPOCH FROM (NOW() - check_in)) / 60 >= 240 THEN 'half_day'
         ELSE 'present'
       END
     WHERE user_id = $1 AND attendance_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
       AND check_in IS NOT NULL AND check_out IS NULL
     RETURNING *`,
    [req.user.id]
  );
  if (!rows[0]) return res.status(409).json({ error: "Check in first, or today's check-out is already recorded." });
  res.json({ attendance: rows[0] });
}));

app.get("/api/messages", currentUser, asyncRoute(async (req, res) => {
  if (req.user.role === "super_admin") {
    const { rows } = await pool.query(
      `SELECT u.id AS employee_id, p.full_name, p.employee_code,
              latest.body AS last_message, latest.created_at AS last_message_at,
              COALESCE(unread.count, 0)::int AS unread_count
       FROM users u JOIN employee_profiles p ON p.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM internal_messages
         WHERE employee_id = u.id ORDER BY created_at DESC, id DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS count FROM internal_messages
         WHERE employee_id = u.id AND sender_id <> $1 AND read_at IS NULL
       ) unread ON TRUE
       WHERE u.status = 'approved' AND u.role <> 'super_admin'
       ORDER BY latest.created_at DESC NULLS LAST, p.full_name`,
      [req.user.id]
    );
    return res.json({ conversations: rows });
  }
  const { rows } = await pool.query(
    `SELECT $1::uuid AS employee_id, p.full_name, p.employee_code,
            latest.body AS last_message, latest.created_at AS last_message_at,
            COALESCE(unread.count, 0)::int AS unread_count
     FROM employee_profiles p
     LEFT JOIN LATERAL (
       SELECT body, created_at FROM internal_messages
       WHERE employee_id = p.user_id ORDER BY created_at DESC, id DESC LIMIT 1
     ) latest ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS count FROM internal_messages
       WHERE employee_id = p.user_id AND sender_id <> $1 AND read_at IS NULL
     ) unread ON TRUE
     WHERE p.user_id = $1`,
    [req.user.id]
  );
  res.json({ conversations: rows });
}));

app.get("/api/messages/:employeeId", currentUser, asyncRoute(async (req, res) => {
  const employee = await pool.query(
    `SELECT u.id FROM users u WHERE u.id = $1 AND u.status = 'approved' AND u.role <> 'super_admin'`,
    [req.params.employeeId]
  );
  if (!employee.rowCount) return res.status(404).json({ error: "Employee conversation was not found." });
  if (req.user.role !== "super_admin" && req.user.id !== req.params.employeeId) {
    return res.status(403).json({ error: "You may only access your own conversation with the super admin." });
  }
  await pool.query(
    "UPDATE internal_messages SET read_at = NOW() WHERE employee_id = $1 AND sender_id <> $2 AND read_at IS NULL",
    [req.params.employeeId, req.user.id]
  );
  const { rows } = await pool.query(
    `SELECT m.id, m.employee_id, m.sender_id, m.body, m.leave_request_id, m.created_at,
            s.role AS sender_role, sp.full_name AS sender_name,
            l.leave_type, to_char(l.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(l.end_date, 'YYYY-MM-DD') AS end_date, l.days AS leave_days,
            l.reason AS leave_reason, l.status AS leave_status
     FROM internal_messages m
     JOIN users s ON s.id = m.sender_id
     LEFT JOIN employee_profiles sp ON sp.user_id = s.id
     LEFT JOIN leave_requests l ON l.id = m.leave_request_id
     WHERE m.employee_id = $1
     ORDER BY m.created_at, m.id LIMIT 500`,
    [req.params.employeeId]
  );
  res.json({ messages: rows });
}));

app.post("/api/messages", currentUser, asyncRoute(async (req, res) => {
  const input = z.object({
    employeeId: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(2000)
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || "Enter a message up to 2,000 characters." });
  const employeeId = req.user.role === "super_admin" ? input.data.employeeId : req.user.id;
  if (!employeeId) return res.status(400).json({ error: "Choose an employee conversation." });
  if (req.user.role !== "super_admin" && input.data.employeeId && input.data.employeeId !== req.user.id) {
    return res.status(403).json({ error: "You may only message the super admin in your own conversation." });
  }
  const employee = await pool.query(
    "SELECT id FROM users WHERE id = $1 AND status = 'approved' AND role <> 'super_admin'",
    [employeeId]
  );
  if (!employee.rowCount) return res.status(404).json({ error: "Approved employee was not found." });
  const { rows } = await pool.query(
    `INSERT INTO internal_messages (employee_id, sender_id, body)
     VALUES ($1, $2, $3) RETURNING id, employee_id, sender_id, body, created_at`,
    [employeeId, req.user.id, input.data.message]
  );
  if (req.user.role === "super_admin") {
    await notify(pool, employeeId, "New message from the super admin", input.data.message.slice(0, 180));
  } else {
    const admins = await pool.query("SELECT id FROM users WHERE role = 'super_admin' AND status = 'approved'");
    for (const admin of admins.rows) {
      await notify(pool, admin.id, `Message from ${req.user.fullName}`, input.data.message.slice(0, 180));
    }
  }
  res.status(201).json({ message: rows[0] });
}));

app.get("/api/leaves", currentUser, asyncRoute(async (req, res) => {
  const isAdmin = ["super_admin", "hr"].includes(req.user.role);
  const { rows } = await pool.query(
    `SELECT l.*, p.full_name, p.employee_code FROM leave_requests l
     JOIN employee_profiles p ON p.user_id = l.user_id
     WHERE ($1::boolean OR l.user_id = $2)
     ORDER BY l.created_at DESC LIMIT 100`,
    [isAdmin, req.user.id]
  );
  await ensureBalances(pool, req.user.id);
  const balanceResult = await pool.query(
    "SELECT leave_type, allowance, used, allowance - used AS remaining FROM leave_balances WHERE user_id = $1 AND month = $2 ORDER BY leave_type",
    [req.user.id, monthStart()]
  );
  res.json({ requests: rows, balances: balanceResult.rows });
}));

app.post("/api/leaves", currentUser, asyncRoute(async (req, res) => {
  const input = z.object({
    leaveType: z.enum(["medical", "casual", "unpaid"]),
    startDate: z.string().date(),
    endDate: z.string().date(),
    reason: z.string().trim().min(5).max(1000)
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || "Enter valid leave details." });
  const from = new Date(`${input.data.startDate}T00:00:00Z`);
  const to = new Date(`${input.data.endDate}T00:00:00Z`);
  if (to < from) return res.status(400).json({ error: "End date must be on or after the start date." });
  const days = Math.floor((to - from) / 86400000) + 1;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.data.leaveType !== "unpaid") {
      const cursor = new Date(from);
      const grouped = new Map();
      while (cursor <= to) {
        const key = monthStart(cursor);
        grouped.set(key, (grouped.get(key) || 0) + 1);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      for (const [month, count] of grouped) {
        await ensureBalances(client, req.user.id, month);
        const balance = await client.query(
          "SELECT allowance, used FROM leave_balances WHERE user_id = $1 AND month = $2 AND leave_type = $3 FOR UPDATE",
          [req.user.id, month, input.data.leaveType]
        );
        const pending = await client.query(
          `SELECT COALESCE(SUM(days), 0)::numeric AS days FROM leave_requests
           WHERE user_id = $1 AND leave_type = $2 AND status = 'pending'
           AND start_date <= ($3::date + INTERVAL '1 month - 1 day')::date AND end_date >= $3::date`,
          [req.user.id, input.data.leaveType, month]
        );
        if (Number(balance.rows[0].allowance) - Number(balance.rows[0].used) - Number(pending.rows[0].days) < count) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Not enough ${input.data.leaveType} leave balance in ${month.slice(0, 7)}.` });
        }
      }
    }
    const { rows } = await client.query(
      `INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, days, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, input.data.leaveType, input.data.startDate, input.data.endDate, days, input.data.reason]
    );
    await client.query(
      `INSERT INTO internal_messages (employee_id, sender_id, body, leave_request_id)
       VALUES ($1, $1, $2, $3)`,
      [req.user.id, `Leave request · ${input.data.leaveType} · ${input.data.startDate} to ${input.data.endDate} (${days} days)\n${input.data.reason}`, rows[0].id]
    );
    await notify(client, null, "Leave request submitted", `${req.user.fullName} requested ${days} day(s) of ${input.data.leaveType} leave.`);
    await client.query("COMMIT");
    res.status(201).json({ request: rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/leaves/:id/status", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({ status: z.enum(["approved", "rejected"]) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Choose approved or rejected." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE", [req.params.id]);
    const leave = result.rows[0];
    if (!leave) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Leave request was not found." });
    }
    if (leave.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This leave request has already been reviewed." });
    }
    if (input.data.status === "approved" && leave.leave_type !== "unpaid") {
      const from = new Date(`${leave.start_date.toISOString().slice(0, 10)}T00:00:00Z`);
      const to = new Date(`${leave.end_date.toISOString().slice(0, 10)}T00:00:00Z`);
      const monthCounts = new Map();
      while (from <= to) {
        const key = monthStart(from);
        monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
        from.setUTCDate(from.getUTCDate() + 1);
      }
      for (const [month, count] of monthCounts) {
        await ensureBalances(client, leave.user_id, month);
        const balance = await client.query(
          "SELECT allowance, used FROM leave_balances WHERE user_id = $1 AND month = $2 AND leave_type = $3 FOR UPDATE",
          [leave.user_id, month, leave.leave_type]
        );
        if (Number(balance.rows[0].allowance) - Number(balance.rows[0].used) < count) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Leave balance changed; there are not enough days remaining for ${month.slice(0, 7)}.` });
        }
        await client.query(
          "UPDATE leave_balances SET used = used + $1 WHERE user_id = $2 AND month = $3 AND leave_type = $4",
          [count, leave.user_id, month, leave.leave_type]
        );
      }
    }
    const updated = await client.query(
      `UPDATE leave_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`,
      [input.data.status, req.user.id, req.params.id]
    );
    if (input.data.status === "approved") {
      const day = new Date(`${leave.start_date.toISOString().slice(0, 10)}T00:00:00Z`);
      const endDay = new Date(`${leave.end_date.toISOString().slice(0, 10)}T00:00:00Z`);
      while (day <= endDay) {
        if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
          await client.query(
            `INSERT INTO attendance (user_id, attendance_date, status, leave_type)
             VALUES ($1, $2, 'leave', $3)
             ON CONFLICT (user_id, attendance_date) DO UPDATE SET
               status = 'leave', leave_type = EXCLUDED.leave_type
             WHERE attendance.check_in IS NULL`,
            [leave.user_id, day.toISOString().slice(0, 10), leave.leave_type]
          );
        }
        day.setUTCDate(day.getUTCDate() + 1);
      }
    }
    await client.query(
      `INSERT INTO internal_messages (employee_id, sender_id, body, leave_request_id)
       VALUES ($1, $2, $3, $4)`,
      [leave.user_id, req.user.id, `Your ${leave.leave_type} leave request was ${input.data.status}.`, req.params.id]
    );
    await notify(client, leave.user_id, "Leave request reviewed", `Your ${leave.leave_type} leave request was ${input.data.status}.`);
    await audit(client, req.user.id, `leave.${input.data.status}`, "leave_request", req.params.id);
    await client.query("COMMIT");
    res.json({ request: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/payroll", currentUser, asyncRoute(async (req, res) => {
  const canSeeAll = req.user.role === "super_admin";
  const { rows } = await pool.query(
    `SELECT s.*, p.full_name, p.employee_code, p.designation,
            CASE WHEN $1::boolean THEN p.upi_id ELSE NULL::text END AS upi_id,
            COALESCE(a.present_days, 0)::int AS present_days,
            COALESCE(a.half_day_days, 0)::int AS half_day_days,
            COALESCE(a.absent_days, 0)::int AS absent_days,
            COALESCE(a.medical_leave_days, 0)::int AS medical_leave_days,
            COALESCE(a.casual_leave_days, 0)::int AS casual_leave_days,
            COALESCE(a.unpaid_leave_days, 0)::int AS unpaid_leave_days,
            pr.overall_score AS performance_score
     FROM salary_records s
     JOIN employee_profiles p ON p.user_id = s.user_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE status = 'present') AS present_days,
              COUNT(*) FILTER (WHERE status = 'half_day') AS half_day_days,
              COUNT(*) FILTER (WHERE status = 'absent') AS absent_days,
              COUNT(*) FILTER (WHERE status = 'leave' AND leave_type = 'medical') AS medical_leave_days,
              COUNT(*) FILTER (WHERE status = 'leave' AND leave_type = 'casual') AS casual_leave_days,
              COUNT(*) FILTER (WHERE status = 'leave' AND leave_type = 'unpaid') AS unpaid_leave_days
       FROM attendance a
       WHERE a.user_id = s.user_id
         AND a.attendance_date >= s.pay_month
         AND a.attendance_date < (s.pay_month + INTERVAL '1 month')
     ) a ON TRUE
     LEFT JOIN performance_reviews pr ON pr.user_id = s.user_id AND pr.review_month = s.pay_month
     WHERE ($1::boolean OR s.user_id = $2) ORDER BY s.pay_month DESC, p.full_name`,
    [canSeeAll, req.user.id]
  );
  const salary = await pool.query("SELECT monthly_salary FROM employee_profiles WHERE user_id = $1", [req.user.id]);
  res.json({ records: rows, monthlySalary: salary.rows[0]?.monthly_salary ?? null });
}));

app.patch("/api/payroll/:id", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({
    baseSalary: z.number().min(0).max(10000000),
    bonus: z.number().min(0).max(10000000),
    deductions: z.number().min(0).max(10000000)
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter valid salary, bonus, and deduction amounts." });
  const { rows } = await pool.query(
    `UPDATE salary_records
     SET base_salary = $1, bonus = $2, deductions = $3,
         net_pay = ROUND(GREATEST(0, $1 + $2 - $3), 2)
     WHERE id = $4 AND payment_status <> 'paid'
     RETURNING id, user_id, pay_month, base_salary, bonus, deductions, net_pay, payment_status`,
    [input.data.baseSalary, input.data.bonus, input.data.deductions, req.params.id]
  );
  if (!rows[0]) {
    const existing = await pool.query("SELECT payment_status FROM salary_records WHERE id = $1", [req.params.id]);
    if (!existing.rowCount) return res.status(404).json({ error: "Salary record was not found." });
    return res.status(409).json({ error: "Paid salary records cannot be edited." });
  }
  await pool.query(
    `UPDATE payroll SET total_amount = (
       SELECT COALESCE(SUM(net_pay), 0) FROM salary_records WHERE pay_month = $1
     ) WHERE pay_month = $1`,
    [rows[0].pay_month]
  );
  await audit(pool, req.user.id, "salary.record.update", "salary_record", req.params.id, {
    baseSalary: input.data.baseSalary,
    bonus: input.data.bonus,
    deductions: input.data.deductions,
    netPay: rows[0].net_pay
  });
  res.json({ record: rows[0] });
}));

app.post("/api/payroll/generate", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({
    payMonth: z.string().regex(/^\d{4}-\d{2}$/),
    bonus: z.number().min(0).max(10000000).default(0),
    deductions: z.number().min(0).max(10000000).default(0)
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter a valid payroll month, bonus, and deduction." });
  const month = `${input.data.payMonth}-01`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO payroll (pay_month, created_by) VALUES ($1, $2) ON CONFLICT (pay_month) DO NOTHING`,
      [month, req.user.id]
    );
    const employees = await client.query(
      `SELECT u.id, p.monthly_salary FROM users u JOIN employee_profiles p ON p.user_id = u.id
       WHERE u.status = 'approved' AND u.role <> 'super_admin'`
    );
    for (const employee of employees.rows) {
      const netPay = Math.max(0, Number(employee.monthly_salary) + input.data.bonus - input.data.deductions);
      await client.query(
        `INSERT INTO salary_records (user_id, pay_month, base_salary, bonus, deductions, net_pay, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, pay_month) DO NOTHING`,
        [employee.id, month, employee.monthly_salary, input.data.bonus, input.data.deductions, netPay, req.user.id]
      );
    }
    const total = await client.query("SELECT COALESCE(SUM(net_pay), 0) AS total FROM salary_records WHERE pay_month = $1", [month]);
    await client.query("UPDATE payroll SET total_amount = $1, status = 'review' WHERE pay_month = $2", [total.rows[0].total, month]);
    await audit(client, req.user.id, "payroll.generate", "payroll", month, { total: total.rows[0].total });
    await client.query("COMMIT");
    res.status(201).json({ message: "Payroll records generated for administrator review.", total: total.rows[0].total, count: employees.rowCount });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

app.patch("/api/payroll/:id/status", currentUser, allow("super_admin"), asyncRoute(async (req, res) => {
  const input = z.object({ status: z.enum(["paid", "failed"]) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Choose paid or failed." });
  const { rows } = await pool.query(
    "UPDATE salary_records SET payment_status = $1, paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE NULL END WHERE id = $2 RETURNING user_id, payment_status",
    [input.data.status, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Salary record was not found." });
  await notify(pool, rows[0].user_id, "Salary payment updated", `Your salary payment was marked ${input.data.status}.`);
  await audit(pool, req.user.id, `salary.${input.data.status}`, "salary_record", req.params.id);
  res.json({ record: rows[0] });
}));

app.get("/api/performance", currentUser, asyncRoute(async (req, res) => {
  const canSeeAll = ["super_admin", "hr", "manager"].includes(req.user.role);
  if (!canSeeAll && req.query.userId && String(req.query.userId) !== req.user.id) return res.status(403).json({ error: "You may only view your own performance." });
  const params = [];
  let where = "";
  if (req.user.role === "super_admin" || req.user.role === "hr") {
    if (req.query.all !== "true") {
      params.push(req.query.userId ? String(req.query.userId) : req.user.id);
      where = "WHERE r.user_id = $1";
    }
  } else if (req.user.role === "manager") {
    params.push(req.user.id);
    where = "WHERE p.manager_id = $1";
  } else {
    params.push(req.user.id);
    where = "WHERE r.user_id = $1";
  }
  const { rows } = await pool.query(
    `SELECT r.*, p.full_name, p.employee_code FROM performance_reviews r
     JOIN employee_profiles p ON p.user_id = r.user_id ${where}
     ORDER BY r.review_month DESC LIMIT 100`,
    params
  );
  res.json({ reviews: rows });
}));

app.post("/api/performance", currentUser, allow("super_admin", "manager"), asyncRoute(async (req, res) => {
  const score = z.number().min(0).max(100);
  const input = z.object({
    userId: z.string().uuid(),
    reviewMonth: z.string().regex(/^\d{4}-\d{2}$/),
    taskCompletion: score,
    productivity: score,
    quality: score,
    attendance: score,
    teamwork: score,
    communication: score,
    feedback: z.string().max(2000).default(""),
    suggestions: z.string().max(2000).default("")
  }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: input.error.issues[0]?.message || "Enter valid performance scores." });
  if (req.user.role === "manager") {
    const assigned = await pool.query("SELECT 1 FROM employee_profiles WHERE user_id = $1 AND manager_id = $2", [input.data.userId, req.user.id]);
    if (!assigned.rowCount) return res.status(403).json({ error: "Managers may review assigned team members only." });
  }
  const d = input.data;
  const overall = d.taskCompletion * 0.25 + d.productivity * 0.2 + d.quality * 0.2 + d.attendance * 0.15 + d.teamwork * 0.1 + d.communication * 0.1;
  const { rows } = await pool.query(
    `INSERT INTO performance_reviews
     (user_id, review_month, task_completion, productivity, quality, attendance, teamwork, communication, overall_score, feedback, suggestions, reviewed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (user_id, review_month) DO UPDATE SET
       task_completion = EXCLUDED.task_completion, productivity = EXCLUDED.productivity, quality = EXCLUDED.quality,
       attendance = EXCLUDED.attendance, teamwork = EXCLUDED.teamwork, communication = EXCLUDED.communication,
       overall_score = EXCLUDED.overall_score, feedback = EXCLUDED.feedback, suggestions = EXCLUDED.suggestions,
       reviewed_by = EXCLUDED.reviewed_by
     RETURNING *`,
    [d.userId, `${d.reviewMonth}-01`, d.taskCompletion, d.productivity, d.quality, d.attendance, d.teamwork, d.communication, overall, d.feedback, d.suggestions, req.user.id]
  );
  await notify(pool, d.userId, "Performance review published", `Your ${d.reviewMonth} performance review is available.`);
  await audit(pool, req.user.id, "performance.publish", "performance_review", rows[0].id);
  res.status(201).json({ review: rows[0] });
}));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    fs.mkdirSync(uploadRoot, { recursive: true });
    callback(null, uploadRoot);
  },
  filename: (_req, file, callback) => callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, allowedMime.has(file.mimetype))
});

app.get("/api/documents", currentUser, asyncRoute(async (req, res) => {
  const isAdmin = ["super_admin", "hr"].includes(req.user.role);
  if (!isAdmin && req.query.userId && String(req.query.userId) !== req.user.id) return res.status(403).json({ error: "You may only access your own documents." });
  const target = isAdmin && req.query.userId ? String(req.query.userId) : req.user.id;
  const { rows } = await pool.query(
    `SELECT d.id, d.user_id, d.file_name, d.mime_type, d.file_size, d.category, d.uploaded_at, p.full_name,
            CASE WHEN d.storage_path LIKE 'dropbox:%' THEN 'Dropbox' ELSE 'Private storage' END AS storage_provider
     FROM documents d JOIN employee_profiles p ON p.user_id = d.user_id
     WHERE ($1::boolean OR d.user_id = $2) ORDER BY d.uploaded_at DESC`,
    [isAdmin, target]
  );
  res.json({ documents: rows });
}));

app.post("/api/documents", currentUser, upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file || !allowedMime.has(req.file.mimetype)) return res.status(400).json({ error: "Choose a PDF, JPG, PNG, DOC, or DOCX file." });
  if (!matchesDocumentSignature(req.file)) {
    fs.unlinkSync(path.join(uploadRoot, req.file.filename));
    return res.status(400).json({ error: "The file content does not match its file type." });
  }
  const category = z.enum(["resume", "identity", "education", "internship", "experience", "salary", "other"]).safeParse(req.body.category);
  if (!category.success) {
    fs.unlinkSync(path.join(uploadRoot, req.file.filename));
    return res.status(400).json({ error: "Choose a valid document category." });
  }
  let dropboxAccessToken = null;
  let dropboxPath = null;
  try {
    const linked = await pool.query("SELECT 1 FROM dropbox_accounts WHERE user_id = $1", [req.user.id]);
    if (linked.rowCount) {
      if (!dropboxConfigured) {
        fs.unlinkSync(req.file.path);
        return res.status(503).json({ error: "Dropbox credentials are not configured on this server." });
      }
      dropboxAccessToken = await getDropboxAccessToken(req.user.id);
      const safeName = path.basename(req.file.originalname).replace(/[^\w.-]/g, "_");
      const remoteName = `${crypto.randomUUID()}-${safeName}`;
      dropboxPath = await uploadDropboxFile(dropboxAccessToken, `/${remoteName}`, req.file.path);
      fs.unlinkSync(req.file.path);
    }
    const storagePath = dropboxPath ? `dropbox:${dropboxPath}` : req.file.filename;
    const { rows } = await pool.query(
      `INSERT INTO documents (user_id, file_name, storage_path, mime_type, file_size, category)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, file_name, mime_type, file_size, category, uploaded_at`,
      [req.user.id, path.basename(req.file.originalname), storagePath, req.file.mimetype, req.file.size, category.data]
    );
    res.status(201).json({ document: { ...rows[0], storage_provider: dropboxPath ? "Dropbox" : "Private storage" } });
  } catch (error) {
    if (dropboxPath && dropboxAccessToken) {
      try {
        await dropboxApi(dropboxAccessToken, "files/delete_v2", { path: dropboxPath });
      } catch (cleanupError) {
        console.error("Dropbox upload cleanup failed:", cleanupError.message);
      }
    }
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    throw error;
  }
}));

app.get("/api/documents/:id/download", currentUser, asyncRoute(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM documents WHERE id = $1", [req.params.id]);
  const document = rows[0];
  if (!document) return res.status(404).json({ error: "Document was not found." });
  if (document.user_id !== req.user.id && !["super_admin", "hr"].includes(req.user.role)) {
    return res.status(403).json({ error: "You may not access this document." });
  }
  if (document.storage_path.startsWith("dropbox:")) {
    const accessToken = await getDropboxAccessToken(document.user_id);
    if (!accessToken) return res.status(409).json({ error: "The employee's Dropbox account is not connected." });
    const file = await downloadDropboxFile(accessToken, document.storage_path.slice("dropbox:".length));
    return res.type(document.mime_type).attachment(document.file_name).send(file);
  }
  const fullPath = path.join(uploadRoot, path.basename(document.storage_path));
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "The stored document is unavailable." });
  res.download(fullPath, document.file_name);
}));

app.delete("/api/documents/:id", currentUser, asyncRoute(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM documents WHERE id = $1", [req.params.id]);
  const document = rows[0];
  if (!document) return res.status(404).json({ error: "Document was not found." });
  if (document.user_id !== req.user.id && !["super_admin", "hr"].includes(req.user.role)) {
    return res.status(403).json({ error: "You may not delete this document." });
  }
  if (document.storage_path.startsWith("dropbox:")) {
    const accessToken = await getDropboxAccessToken(document.user_id);
    if (!accessToken) return res.status(409).json({ error: "The employee's Dropbox account is not connected." });
    await dropboxApi(accessToken, "files/delete_v2", { path: document.storage_path.slice("dropbox:".length) });
  }
  await pool.query("DELETE FROM documents WHERE id = $1", [req.params.id]);
  if (!document.storage_path.startsWith("dropbox:")) {
    const fullPath = path.join(uploadRoot, path.basename(document.storage_path));
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  res.status(204).end();
}));

app.get("/api/notifications", currentUser, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, title, message, read_at, created_at FROM notifications WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 50",
    [req.user.id]
  );
  res.json({ notifications: rows });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "API route was not found." }));

const clientBuild = path.resolve(here, "../dist");
app.use(express.static(clientBuild, { index: false }));
app.get("*", (_req, res, next) => {
  res.sendFile(path.join(clientBuild, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    let message = "The file could not be uploaded.";
    if (error.code === "LIMIT_FILE_SIZE") {
      message = error.field === "profilePicture"
        ? "Profile picture exceeds the 5 MB limit."
        : `File exceeds the ${process.env.MAX_UPLOAD_MB || 10} MB limit.`;
    } else if (error.field === "profilePicture") {
      message = "Choose one JPG, PNG, or WebP profile picture.";
    }
    return res.status(400).json({ error: message });
  }
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || "Invalid input." });
  if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
  console.error("API error:", error.message);
  res.status(500).json({ error: "The request could not be completed. Please try again." });
});

const schema = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
await pool.query(schema);
const configuredAdmin = await pool.query(
  "SELECT COUNT(*)::int AS count, BOOL_AND(LOWER(email) = $1) AS email_matches FROM users WHERE role = 'super_admin'",
  [adminEmail]
);
if (configuredAdmin.rows[0].count > 1 || (configuredAdmin.rows[0].count === 1 && !configuredAdmin.rows[0].email_matches)) {
  throw new Error("The existing super-admin account does not match ADMIN_EMAIL. Correct the local configuration before starting the API.");
}
app.listen(port, "0.0.0.0", () => console.log(`API listening on port ${port}`));
