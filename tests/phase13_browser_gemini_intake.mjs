/**
 * Phase 13 — Browser Acceptance Test: Zero Dummy Intake & Real Gemini Context Propagation
 * tests/phase13_browser_gemini_intake.mjs
 */

import { chromium } from "@playwright/test";
import http from "http";
import path from "path";
import { prisma, disconnectPrisma } from "../prisma/db.js";
import app, { interviewPlanner } from "../Patient-case-taking-software-/server.js";
import { createEncounterSession } from "../Patient-case-taking-software-/server/sessions.js";

async function runBrowserIntakeTest() {
  console.log("\n=======================================================");
  console.log("PHASE 13: BROWSER INTAKE E2E (ZERO DUMMY & EXACT CONTEXT)");
  console.log("=======================================================\n");

  // 1. Backend Server
  const expressServer = http.createServer(app);
  await new Promise(r => expressServer.listen(0, "127.0.0.1", r));
  const backendPort = expressServer.address().port;
  console.log(`[Backend Server] listening on http://127.0.0.1:${backendPort}`);

  // 2. Vite Dev Server
  let vitePort = 5173;
  let viteServer = null;
  let useExistingVite = false;

  try {
    const checkRes = await new Promise((res, rej) => {
      const req = http.get("http://localhost:5173", r => res(r.statusCode));
      req.on("error", rej);
      setTimeout(() => rej(new Error("timeout")), 1000);
    });
    if (checkRes === 200) {
      useExistingVite = true;
      console.log(`[Vite UI Server] Reusing existing Vite server at http://localhost:5173`);
    }
  } catch (_) {
    // Not running
  }

  if (!useExistingVite) {
    const vitePath = path.resolve("Patient-case-taking-software-/node_modules/vite/dist/node/index.js");
    const { createServer: createViteServer } = await import(`file:///${vitePath.replace(/\\/g, "/")}`);
    viteServer = await createViteServer({
      root: path.resolve("Patient-case-taking-software-"),
      server: {
        port: 0,
        host: "127.0.0.1",
        proxy: {
          "/api": {
            target: `http://127.0.0.1:${backendPort}`,
            changeOrigin: true
          }
        }
      }
    });
    await viteServer.listen();
    vitePort = viteServer.config.server.port;
    console.log(`[Vite UI Server] listening on http://127.0.0.1:${vitePort}`);
  }

  // 3. Configure Mock Gemini Boundary for Deterministic Contract Validation (Rule 7)
  const recordedPrompts = [];
  const testGeminiClient = {
    models: {
      generateContent: async ({ contents }) => {
        const prompt = contents?.[0]?.text || "";
        recordedPrompts.push(prompt);

        if (prompt.includes("2 baar ulti hui")) {
          return {
            text: JSON.stringify({
              questionText: "उल्टी के साथ क्या बुखार, चक्कर या पेट में मरोड़ महसूस हो रही है?",
              questionKey: "associated_symptoms",
              clinicalDomain: "associated_symptoms",
              options: ["हाँ, हल्का बुखार है", "सिर्फ उल्टी जैसा लग रहा है", "पेट में मरोड़ है", "कोई अन्य लक्षण नहीं"]
            })
          };
        }

        return {
          text: JSON.stringify({
            questionText: "यह उल्टी की समस्या कब से शुरू हुई है और क्या कुछ खाने के बाद बढ़ी?",
            questionKey: "duration_onset",
            clinicalDomain: "duration_onset",
            options: ["आज सुबह से", "कल रात से", "2-3 दिन से", "लगातार"]
          })
        };
      }
    }
  };
  interviewPlanner.setGenAiClient(testGeminiClient);

  // 4. Launch Chromium Browser
  console.log("[Playwright] Launching Chromium browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }
  });
  const page = await context.newPage();

  const results = [];
  function record(id, name, status, details = "") {
    results.push({ id, name, status, details });
    const icon = status === "PASS" ? "✅" : "❌";
    console.log(`${icon} [${id}] ${name}: ${status}`);
    if (details) console.log(`   └─ ${details}`);
  }

  try {
    // Seed patient and encounter for authenticated intake session
    const patientUid = "55555555-1313-1313-1313-000000000001";
    const encounterId = "ENC-BROWSER-GEMINI-01";

    await prisma.interviewTurn.deleteMany({ where: { session: { patientUid } } }).catch(() => {});
    await prisma.interviewSession.deleteMany({ where: { patientUid } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { encounterId } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { patientUid } }).catch(() => {});

    await prisma.patient.create({
      data: {
        patientUid,
        patientId: "PAT-BRW-001",
        fullName: "Ramesh Sharma",
        age: 42,
        gender: "Male",
        mobileNumber: "9811122233"
      }
    });

    await prisma.encounter.create({
      data: {
        encounterId,
        patientUid,
        tokenNumber: "801",
        consultationStatus: "waiting"
      }
    });

    const hostDomain = useExistingVite ? "localhost" : "127.0.0.1";
    const baseUrl = `http://${hostDomain}:${vitePort}`;
    const encToken = createEncounterSession(patientUid, encounterId);

    await context.addCookies([
      {
        name: "ms_encounter_session",
        value: encToken,
        domain: hostDomain,
        path: "/"
      }
    ]);

    if (useExistingVite) {
      await page.route("**/api/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const targetUrl = `http://127.0.0.1:${backendPort}${url.pathname}${url.search}`;
        const headers = { ...req.headers() };
        headers["host"] = `127.0.0.1:${backendPort}`;

        const postData = req.postDataBuffer();
        try {
          const response = await fetch(targetUrl, {
            method: req.method(),
            headers,
            body: postData
          });
          const bodyBuffer = await response.arrayBuffer();
          const responseHeaders = {};
          response.headers.forEach((v, k) => { responseHeaders[k] = v; });
          await route.fulfill({
            status: response.status,
            headers: responseHeaders,
            body: Buffer.from(bodyBuffer)
          });
        } catch (err) {
          await route.abort();
        }
      });
    }

    // Navigate directly to /kiosk/intake
    await page.goto(`${baseUrl}/kiosk/intake`, { waitUntil: "domcontentloaded" });
    console.log(`[Browser] Navigated directly to ${baseUrl}/kiosk/intake`);

    // Wait for the intake input
    await page.waitForSelector("input[placeholder*='तकलीफ']", { timeout: 10000 });
    console.log("[Browser] AI Interview View ready and interactive");

    // VERIFICATION 1: Zero forced canned dummy symptoms
    const optionChips = page.locator(".cursor-pointer, button.rounded-full");
    const chipTexts = await optionChips.allInnerTexts().catch(() => []);
    const hasForcedDummyStomach = chipTexts.some(t => t.includes("पेट में तेज दर्द / गैस") || t.includes("बुखार और शरीर"));
    if (!hasForcedDummyStomach) {
      record("BROWSER-INTAKE-01", "Zero forced canned symptoms on intake view", "PASS",
        "Initial view does not force hardcoded dummy symptoms onto patient");
    } else {
      record("BROWSER-INTAKE-01", "Zero forced canned symptoms on intake view", "FAIL",
        `Found forced chips: ${chipTexts.join(", ")}`);
    }

    // VERIFICATION 2: Real patient types exact input: "ulti feel ho rahi hai"
    const chatInput = page.locator("input[placeholder*='तकलीफ']").first();
    await chatInput.fill("ulti feel ho rahi hai");
    await page.waitForTimeout(200);

    // Click Send
    const sendBtn = page.locator("button:has(svg.lucide-send), button:has-text('Send'), button:has-text('भेजें')").first();
    await sendBtn.click();
    console.log("[Browser] Submitted patient answer 'ulti feel ho rahi hai'");

    // Wait for response to render in chat
    await page.waitForTimeout(1500);

    // VERIFICATION 3: Exact patient answer appears in conversation UI
    const patientMsg = page.locator("text='ulti feel ho rahi hai'");
    const isRenderedInChat = (await patientMsg.count()) > 0;
    if (isRenderedInChat) {
      record("BROWSER-INTAKE-02", "Exact patient answer rendered in conversation UI", "PASS",
        "Exact text 'ulti feel ho rahi hai' is displayed in conversation view");
    } else {
      record("BROWSER-INTAKE-02", "Exact patient answer rendered in conversation UI", "FAIL",
        "Patient message not visible in DOM");
    }

    // VERIFICATION 4: Gemini received the exact patient answer in request context
    const hasPromptReceivedAnswer = recordedPrompts.some(p => p.includes("ulti feel ho rahi hai"));
    if (hasPromptReceivedAnswer) {
      record("BROWSER-INTAKE-03", "Exact patient answer transmitted to Gemini prompt context", "PASS",
        "Backend Gemini request contains exact patient string 'ulti feel ho rahi hai'");
    } else {
      record("BROWSER-INTAKE-03", "Exact patient answer transmitted to Gemini prompt context", "FAIL",
        "Gemini prompt did not contain 'ulti feel ho rahi hai'");
    }

    // VERIFICATION 5: Next question reflects the Gemini response
    const dynamicAiQuestion = page.getByText("उल्टी की समस्या कब से शुरू हुई");
    const isAiQuestionRendered = (await dynamicAiQuestion.count()) > 0;
    if (isAiQuestionRendered) {
      record("BROWSER-INTAKE-04", "Dynamic Gemini question rendered to patient without replacement", "PASS",
        "Rendered question: 'यह उल्टी की समस्या कब से शुरू हुई है और क्या कुछ खाने के बाद बढ़ी?'");
    } else {
      record("BROWSER-INTAKE-04", "Dynamic Gemini question rendered to patient without replacement", "FAIL",
        "Generated question not found in conversation DOM");
    }

    // VERIFICATION 6: Follow-up turn with exact patient response: "2 baar ulti hui"
    recordedPrompts.length = 0;
    await chatInput.fill("2 baar ulti hui");
    await page.waitForTimeout(200);
    await sendBtn.click();
    console.log("[Browser] Submitted follow-up answer '2 baar ulti hui'");
    await page.waitForTimeout(1500);

    // VERIFICATION 7: Cumulative context propagated to Gemini
    const hasBothTurns = recordedPrompts.some(p => p.includes("ulti feel ho rahi hai") && p.includes("2 baar ulti hui"));
    if (hasBothTurns) {
      record("BROWSER-INTAKE-05", "Cumulative conversation turns propagated to next Gemini call", "PASS",
        "Gemini received both Turn 0 ('ulti feel ho rahi hai') and Turn 1 ('2 baar ulti hui')");
    } else {
      record("BROWSER-INTAKE-05", "Cumulative conversation turns propagated to next Gemini call", "FAIL",
        "Gemini prompt missing cumulative history");
    }

    // Capture visual screenshot
    const screenshotPath = "C:\\Users\\Rahul\\.gemini\\antigravity-ide\\brain\\7d1eb9bc-33df-4065-baf5-54a1a28045a7\\intake_browser_gemini_verified.png";
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Browser] Screenshot saved: ${screenshotPath}`);

  } catch (err) {
    console.error("Browser test error:", err);
    record("BROWSER-ERROR", "Browser execution completed without unhandled crash", "FAIL", err.message);
  } finally {
    await browser.close();
    interviewPlanner.setGenAiClient(null);
    if (viteServer) await viteServer.close();
    await new Promise(r => expressServer.close(r));
    await disconnectPrisma();
  }

  console.log("\n-------------------------------------------------------");
  const passed = results.filter(r => r.status === "PASS").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  console.log(`TOTAL: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log("-------------------------------------------------------\n");

  if (failed > 0) process.exit(1);
}

runBrowserIntakeTest().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
