/**
 * Multi-Layer CSRF Defense Middleware
 * Unified Healthcare Intelligence Platform: MedSync + AuraHealth Nexus
 *
 * Enforces:
 * 1. Origin / Referer validation for mutating requests.
 * 2. Custom header (X-Requested-With) validation for cookie-authenticated requests.
 * 3. Canonical error code: CSRF_VIOLATION (403).
 */

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173"
]);

export function isAllowedOrigin(originHeader) {
  if (!originHeader) return true; // Checked via other headers or same-origin
  try {
    const url = new URL(originHeader);
    const normalized = `${url.protocol}//${url.host}`;
    if (ALLOWED_ORIGINS.has(normalized)) return true;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
    return false;
  } catch (e) {
    return false;
  }
}

export function csrfProtection(req, res, next) {
  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (!isMutating) {
    return next();
  }

  const origin = req.headers["origin"];
  const referer = req.headers["referer"];

  // 1. Origin / Referer validation when present
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({
      error: {
        code: "CSRF_VIOLATION",
        message: "Cross-origin request blocked: unauthorized Origin",
        requestId: req.requestId || res.getHeader("X-Request-Id") || "unknown"
      }
    });
  }

  if (!origin && referer && !isAllowedOrigin(referer)) {
    return res.status(403).json({
      error: {
        code: "CSRF_VIOLATION",
        message: "Cross-origin request blocked: unauthorized Referer",
        requestId: req.requestId || res.getHeader("X-Request-Id") || "unknown"
      }
    });
  }

  // Pre-session login exemption for cookie checks
  if (req.path === "/api/auth/login") {
    return next();
  }

  // 2. For cookie-authenticated requests, enforce custom AJAX header
  const cookies = req.cookies || {};
  const hasAuthCookie = Boolean(
    cookies.ms_user_session ||
    cookies.ms_encounter_session ||
    cookies.ms_device_session
  );

  if (hasAuthCookie) {
    const xRequestedWith = req.headers["x-requested-with"];
    if (!xRequestedWith || xRequestedWith.toLowerCase() !== "xmlhttprequest") {
      return res.status(403).json({
        error: {
          code: "CSRF_VIOLATION",
          message: "State-changing request requires X-Requested-With: XMLHttpRequest header",
          requestId: req.requestId || res.getHeader("X-Request-Id") || "unknown"
        }
      });
    }
  }

  next();
}
