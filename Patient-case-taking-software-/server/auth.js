import crypto from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(crypto.scrypt);

// Scrypt configuration per specification:
// N = 16384, r = 8, p = 1, keylen = 64
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024
};
const KEY_LEN = 64;

/**
 * Generates a 16-byte random salt and derives a 64-byte hex hash.
 */
export async function hashPassword(password, customSalt = null) {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  const salt = customSalt || crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, KEY_LEN, SCRYPT_OPTIONS);
  return {
    hash: derivedKey.toString("hex"),
    salt
  };
}

/**
 * Constant-time password verification using crypto.timingSafeEqual.
 */
export async function verifyPassword(password, storedHash, storedSalt) {
  if (!password || !storedHash || !storedSalt) {
    return false;
  }
  try {
    const derivedKey = await scryptAsync(password, storedSalt, KEY_LEN, SCRYPT_OPTIONS);
    const keyHex = derivedKey.toString("hex");
    const keyBuf = Buffer.from(keyHex, "hex");
    const hashBuf = Buffer.from(storedHash, "hex");
    if (keyBuf.length !== hashBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(keyBuf, hashBuf);
  } catch (err) {
    return false;
  }
}

// --------------------------------------------------------------------------
// Rate Limiter / Brute-Force Defense
// 5 failed attempts per 15 minutes per IP/account -> 429 TOO_MANY_REQUESTS
// --------------------------------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_ATTEMPTS = 5;

const failedAttemptsMap = new Map(); // key -> { count, windowStart }

export function isLoginThrottled(key) {
  if (!key) return false;
  const now = Date.now();
  const entry = failedAttemptsMap.get(key);
  if (!entry) return false;

  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    failedAttemptsMap.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

export function recordFailedLogin(key) {
  if (!key) return 1;
  const now = Date.now();
  const entry = failedAttemptsMap.get(key) || { count: 0, windowStart: now };

  if (now - entry.windowStart > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  failedAttemptsMap.set(key, entry);
  return entry.count;
}

export function resetFailedLogin(key) {
  if (key) {
    failedAttemptsMap.delete(key);
  }
}

/**
 * Seeds or updates dev users (Doctor and Admin) with scrypt hashes if not already set.
 */
export async function seedDevUsers(prisma) {
  try {
    // 1. Doctor User: Dr. K. S. Sharma
    const doctorEmail = "dr.sharma@hospital.gov.in";
    const doctorPass = process.env.DEV_DOCTOR_PASSWORD || "DoctorSecure123!";
    let doctor = await prisma.user.findUnique({ where: { email: doctorEmail } });

    if (doctor && (!doctor.passwordHash || !doctor.salt)) {
      const { hash, salt } = await hashPassword(doctorPass);
      await prisma.user.update({
        where: { id: doctor.id },
        data: { passwordHash: hash, salt }
      });
      console.log(`[Auth] Seeded scrypt credentials for doctor: ${doctorEmail}`);
    } else if (!doctor) {
      const { hash, salt } = await hashPassword(doctorPass);
      doctor = await prisma.user.create({
        data: {
          userUid: crypto.randomUUID(),
          name: "Dr. K. S. Sharma",
          email: doctorEmail,
          passwordHash: hash,
          salt,
          role: "doctor",
          chamber: "OPD Chamber #04 - General Medicine",
          active: true
        }
      });
      console.log(`[Auth] Created doctor user: ${doctorEmail}`);
    }

    // 2. Admin User: Admin User
    const adminEmail = "admin@hospital.gov.in";
    const adminPass = process.env.DEV_ADMIN_PASSWORD || "AdminSecure123!";
    let admin = await prisma.user.findUnique({ where: { email: adminEmail } });

    if (admin && (!admin.passwordHash || !admin.salt)) {
      const { hash, salt } = await hashPassword(adminPass);
      await prisma.user.update({
        where: { id: admin.id },
        data: { passwordHash: hash, salt }
      });
      console.log(`[Auth] Seeded scrypt credentials for admin: ${adminEmail}`);
    } else if (!admin) {
      const { hash, salt } = await hashPassword(adminPass);
      admin = await prisma.user.create({
        data: {
          userUid: crypto.randomUUID(),
          name: "Hospital Administrator",
          email: adminEmail,
          passwordHash: hash,
          salt,
          role: "admin",
          active: true
        }
      });
      console.log(`[Auth] Created admin user: ${adminEmail}`);
    }
    // 3. Clinical Staff User
    const staffEmail = "staff@hospital.gov.in";
    const staffPass = process.env.DEV_STAFF_PASSWORD || "StaffSecure123!";
    let staff = await prisma.user.findUnique({ where: { email: staffEmail } });

    if (staff && (!staff.passwordHash || !staff.salt)) {
      const { hash, salt } = await hashPassword(staffPass);
      await prisma.user.update({
        where: { id: staff.id },
        data: { passwordHash: hash, salt }
      });
      console.log(`[Auth] Seeded scrypt credentials for clinical_staff: ${staffEmail}`);
    } else if (!staff) {
      const { hash, salt } = await hashPassword(staffPass);
      staff = await prisma.user.create({
        data: {
          userUid: crypto.randomUUID(),
          name: "Clinical Staff Nurse",
          email: staffEmail,
          passwordHash: hash,
          salt,
          role: "clinical_staff",
          active: true
        }
      });
      console.log(`[Auth] Created clinical_staff user: ${staffEmail}`);
    }

    // 4. Kiosk Operator User
    const operatorEmail = "operator@hospital.gov.in";
    const operatorPass = process.env.DEV_OPERATOR_PASSWORD || "OperatorSecure123!";
    let operator = await prisma.user.findUnique({ where: { email: operatorEmail } });

    if (operator && (!operator.passwordHash || !operator.salt)) {
      const { hash, salt } = await hashPassword(operatorPass);
      await prisma.user.update({
        where: { id: operator.id },
        data: { passwordHash: hash, salt }
      });
      console.log(`[Auth] Seeded scrypt credentials for kiosk_operator: ${operatorEmail}`);
    } else if (!operator) {
      const { hash, salt } = await hashPassword(operatorPass);
      operator = await prisma.user.create({
        data: {
          userUid: crypto.randomUUID(),
          name: "Kiosk Terminal Operator",
          email: operatorEmail,
          passwordHash: hash,
          salt,
          role: "kiosk_operator",
          active: true
        }
      });
      console.log(`[Auth] Created kiosk_operator user: ${operatorEmail}`);
    }
  } catch (err) {
    console.error("[Auth] Error seeding dev users:", err.message);
  }
}

export const CANONICAL_ROLES = new Set(["doctor", "clinical_staff", "kiosk_operator", "admin"]);

