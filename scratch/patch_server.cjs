const fs = require('fs');
const serverPath = 'f:/SIH/Patient-case-taking-software-/server.js';
let content = fs.readFileSync(serverPath, 'utf8');

// 1. Add generateUniquePatientId
const targetMask = `function maskMobile(phone) {
  if (!phone) return "******0000";
  const str = String(phone).replace(/\\D/g, "");
  if (str.length < 4) return "******" + str;
  return "******" + str.slice(-4);
}`;

const replacementMask = `function maskMobile(phone) {
  if (!phone) return "******0000";
  const str = String(phone).replace(/\\D/g, "");
  if (str.length < 4) return "******" + str;
  return "******" + str.slice(-4);
}

async function generateUniquePatientId() {
  const year = new Date().getFullYear();
  const allPatients = await prisma.patient.findMany({ select: { patientId: true } });
  let maxSeq = 0;
  for (const p of allPatients) {
    if (p.patientId && p.patientId.startsWith(\`PAT-\${year}-\`)) {
      const num = parseInt(p.patientId.replace(\`PAT-\${year}-\`, ""), 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  }
  let nextSeq = Math.max(maxSeq + 1, allPatients.length + 1);
  let patientId = \`PAT-\${year}-\${String(nextSeq).padStart(4, "0")}\`;
  while (await prisma.patient.findUnique({ where: { patientId } })) {
    nextSeq++;
    patientId = \`PAT-\${year}-\${String(nextSeq).padStart(4, "0")}\`;
  }
  return patientId;
}`;

if (!content.includes(targetMask)) {
  throw new Error('targetMask not found');
}
content = content.replace(targetMask, replacementMask);

// 2. Replace patientId generation in POST /api/patients
const targetRegPatientId = `    const patientCount = await prisma.patient.count();
    const patientId = \`PAT-\${new Date().getFullYear()}-\${String(patientCount + 1).padStart(4, "0")}\`;`;

const replacementRegPatientId = `    const patientId = await generateUniquePatientId();`;

if (!content.includes(targetRegPatientId)) {
  throw new Error('targetRegPatientId not found');
}
content = content.replace(targetRegPatientId, replacementRegPatientId);

// 3. Replace patientId generation in POST /api/intake
const targetIntakePatientId = `      const patientCount  = await prisma.patient.count();
      const generatedId   = \`PAT-\${new Date().getFullYear()}-\${String(patientCount + 1).padStart(4, "0")}\`;`;

const replacementIntakePatientId = `      const generatedId   = await generateUniquePatientId();`;

if (!content.includes(targetIntakePatientId)) {
  throw new Error('targetIntakePatientId not found');
}
content = content.replace(targetIntakePatientId, replacementIntakePatientId);

// 4. Update login throttling to per-account throttleKey
const targetLoginThrottle = `    if (isLoginThrottled(throttleKey) || isLoginThrottled(ip)) {
      logRequest(req, 429, { throttled: true, email });
      return ERR.TOO_MANY_REQUESTS(res, "Too many failed login attempts. Account temporarily throttled for 15 minutes.");
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!user || !user.active || !user.passwordHash || !user.salt) {
      recordFailedLogin(throttleKey);
      recordFailedLogin(ip);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    const isValid = await verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      recordFailedLogin(throttleKey);
      recordFailedLogin(ip);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    resetFailedLogin(throttleKey);
    resetFailedLogin(ip);`;

const replacementLoginThrottle = `    if (isLoginThrottled(throttleKey)) {
      logRequest(req, 429, { throttled: true, email });
      return ERR.TOO_MANY_REQUESTS(res, "Too many failed login attempts. Account temporarily throttled for 15 minutes.");
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() }
    });

    if (!user || !user.active || !user.passwordHash || !user.salt) {
      recordFailedLogin(throttleKey);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    const isValid = await verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      recordFailedLogin(throttleKey);
      logRequest(req, 401, { reason: "invalid_credentials" });
      return ERR.AUTHENTICATION_REQUIRED(res, "Invalid email or password");
    }

    resetFailedLogin(throttleKey);`;

if (!content.includes(targetLoginThrottle)) {
  throw new Error('targetLoginThrottle not found');
}
content = content.replace(targetLoginThrottle, replacementLoginThrottle);

// 5. Update logError to include err.message
const targetLogError = `function logError(req, code, message, err) {
  console.error("[API:ERROR]", JSON.stringify({
    requestId: req.requestId,
    path: req.path,
    errorCode: code,
    message
  }));
}`;

const replacementLogError = `function logError(req, code, message, err) {
  console.error("[API:ERROR]", JSON.stringify({
    requestId: req.requestId,
    path: req.path,
    errorCode: code,
    message,
    details: err?.message || null
  }));
}`;

if (!content.includes(targetLogError)) {
  throw new Error('targetLogError not found');
}
content = content.replace(targetLogError, replacementLogError);

fs.writeFileSync(serverPath, content, 'utf8');
console.log('server.js updated successfully with unique patientId generator and per-account throttle!');
