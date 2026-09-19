import http from "http";
import app from "../Patient-case-taking-software-/server.js";
import { createDeviceSession } from "../Patient-case-taking-software-/server/sessions.js";

const srv = http.createServer(app);
srv.listen(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  const devToken = createDeviceSession("KIOSK-DEV-01");

  // Lookup
  const lookupRes = await fetch(`http://127.0.0.1:${port}/api/patients/lookup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `ms_device_session=${devToken}`,
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify({ mobileNumber: "9876543210" })
  });
  const lookupData = await lookupRes.json();
  console.log("Lookup Data:", lookupData);

  // Encounter
  const encRes = await fetch(`http://127.0.0.1:${port}/api/encounters`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `ms_device_session=${devToken}`,
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify({
      lookupHandle: lookupData.lookupHandle,
      candidateId: lookupData.candidates[0].candidateId,
      chiefComplaint: "Test"
    })
  });
  console.log("Encounter status:", encRes.status);
  console.log("Encounter body:", await encRes.json());
  srv.close();
  process.exit(0);
});
