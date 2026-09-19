import crypto from "crypto";

// --------------------------------------------------------------------------
// Clinical Domains & Question Templates Registry
// --------------------------------------------------------------------------
const CLINICAL_DOMAINS = [
  "duration_onset",
  "severity_character",
  "radiation_spread",
  "aggravating_relieving",
  "associated_symptoms",
  "current_medications"
];

const DOMAIN_QUESTIONS = {
  CARDIAC_CHEST: {
    duration_onset: {
      key: "duration_onset",
      Hindi: "यह सीने में भारीपन या दर्द कब से शुरू हुआ है और क्या अचानक शुरू हुआ था?",
      English: "When did this chest discomfort or pain begin, and did it start suddenly?",
      options: ["आज सुबह से (Since morning)", "2-3 दिन से (2-3 days)", "1 हफ्ते से (Past week)", "काफी समय से (Chronic)"]
    },
    severity_character: {
      key: "severity_character",
      Hindi: "दर्द कैसा महसूस हो रहा है — भारी दबाव, जलन, या चुभन जैसा? (1 से 10 तक कितना तेज है?)",
      English: "How does the pain feel — heavy pressure, burning, or sharp? (Scale of 1 to 10)",
      options: ["भारी दबाव जैसा (Heavy pressure)", "हल्का दर्द (Mild pain)", "तेज असहनीय दर्द (Severe pain)", "गैस / जलन जैसा (Burning/Gas)"]
    },
    radiation_spread: {
      key: "radiation_spread",
      Hindi: "क्या यह दर्द बाएं हाथ, कंधे, जबड़े या पीठ की तरफ फैलता हुआ महसूस होता है?",
      English: "Does the pain radiate to your left arm, shoulder, jaw, or back?",
      options: ["बाएं हाथ में फैलता है (To left arm)", "पीठ / कंधे में (To back/shoulder)", "सिर्फ सीने के बीच में (Chest only)", "गले / जबड़े में (To throat/jaw)"]
    },
    aggravating_relieving: {
      key: "aggravating_relieving",
      Hindi: "क्या चलने या सीढ़ियां चढ़ने पर दर्द बढ़ता है, और बैठने या आराम करने पर राहत मिलती है?",
      English: "Does walking or climbing stairs worsen the pain, and does rest relieve it?",
      options: ["चलने पर बढ़ता है (Worse with exertion)", "आराम से राहत मिलती है (Relieved by rest)", "लगातार बना रहता है (Constant)", "गहरी सांस पर बढ़ता है (Worse on breathing)"]
    },
    associated_symptoms: {
      key: "associated_symptoms",
      Hindi: "क्या पसीना आना, घबराहट, चक्कर आना या सांस फूलने जैसी तकलीफ भी हो रही है?",
      English: "Are you also experiencing sweating, palpitations, dizziness, or breathlessness?",
      options: ["पसीना और घबराहट (Sweating & anxiety)", "सांस फूलती है (Shortness of breath)", "चक्कर आते हैं (Dizziness)", "इनमें से कोई नहीं (None of these)"]
    },
    current_medications: {
      key: "current_medications",
      Hindi: "क्या आप पहले से बीपी, दिल या खून पतला करने की कोई गोली ले रहे हैं?",
      English: "Are you currently taking any medications for blood pressure, heart, or blood thinners?",
      options: ["बीपी की दवा लेते हैं (On BP meds)", "डायबिटीज की दवा (On diabetes meds)", "कोई नियमित दवा नहीं (No regular meds)", "सोरबिट्रेट ली थी (Took Sorbitrate)"]
    }
  },
  RESPIRATORY: {
    duration_onset: {
      key: "duration_onset",
      Hindi: "यह खांसी या सांस की तकलीफ कितने दिनों से चल रही है?",
      English: "How many days have you had this cough or breathing difficulty?",
      options: ["2-3 दिन से (2-3 days)", "1 हफ्ते से (Past week)", "2 हफ्ते से ज्यादा (Over 2 weeks)", "महीनों से (Months)"]
    },
    severity_character: {
      key: "severity_character",
      Hindi: "खांसी सूखी (dry) है या बलगम (phlegm) निकल रहा है? बलगम का रंग कैसा है?",
      English: "Is the cough dry or are you coughing up phlegm? What color is it?",
      options: ["सूखी खांसी है (Dry cough)", "सफेद बलगम (White phlegm)", "पीला/हरा बलगम (Yellow/Green phlegm)", "खून के छींटे (Blood-streaked)"]
    },
    radiation_spread: {
      key: "radiation_spread",
      Hindi: "क्या खांसने पर सीने या पसलियों के दोनों तरफ खिंचाव या दर्द होता है?",
      English: "Do you feel pain or pulling in your chest or ribs when coughing?",
      options: ["पसलियों में दर्द (Rib pain)", "गले में तेज जलन (Throat soreness)", "सीने में जकड़न (Chest tightness)", "कोई दर्द नहीं (No pain)"]
    },
    aggravating_relieving: {
      key: "aggravating_relieving",
      Hindi: "क्या रात के समय, ठंडी हवा में या धूल-धुएं से खांसी ज्यादा बढ़ जाती है?",
      English: "Does the cough worsen at night, in cold air, or around dust and smoke?",
      options: ["रात को ज्यादा होती है (Worse at night)", "धूल/ठंड से बढ़ती है (Triggered by dust/cold)", "हर समय एक जैसी (Constant)", "गर्म पानी से आराम (Relieved by warm water)"]
    },
    associated_symptoms: {
      key: "associated_symptoms",
      Hindi: "क्या इसके साथ बुखार, ठंड लगना, या सीटी जैसी आवाज (wheezing) आ रही है?",
      English: "Do you have fever, chills, or wheezing sounds while breathing?",
      options: ["हल्का बुखार है (Mild fever)", "तेज बुखार और ठंड (High fever/chills)", "सांस में सीटी की आवाज (Wheezing)", "सिर्फ खांसी है (Cough only)"]
    },
    current_medications: {
      key: "current_medications",
      Hindi: "क्या आपने कोई कफ सिरप, इनहेलर या एंटीबायोटिक ली है?",
      English: "Have you taken any cough syrup, inhaler, or antibiotics?",
      options: ["कफ सिरप लिया (Took syrup)", "इनहेलर लेते हैं (Use inhaler)", "पैरासिटामोल ली (Took paracetamol)", "कोई दवा नहीं ली (No medication)"]
    }
  },
  GASTROINTESTINAL: {
    duration_onset: {
      key: "duration_onset",
      Hindi: "पेट में यह दर्द या तकलीफ कब से हो रही है?",
      English: "When did this abdominal pain or stomach upset begin?",
      options: ["आज सुबह से (Since morning)", "1-2 दिन से (1-2 days)", "1 हफ्ते से (Past week)", "काफी समय से बार-बार (Chronic recurrent)"]
    },
    severity_character: {
      key: "severity_character",
      Hindi: "दर्द पेट में किस जगह है — ऊपर छाती के पास, नाभि के पास, या पेट के निचले हिस्से में?",
      English: "Where is the pain located — upper abdomen, around the navel, or lower abdomen?",
      options: ["ऊपर पेट में (Upper abdomen / Acidity)", "नाभि के पास (Around navel)", "निचले पेट में (Lower abdomen)", "पूरे पेट में मरोड़ (All over cramp)"]
    },
    radiation_spread: {
      key: "radiation_spread",
      Hindi: "क्या दर्द पेट से पीठ की तरफ या कमर के दोनों तरफ फैलता है?",
      English: "Does the pain radiate to your back or sides (flanks)?",
      options: ["पीठ की तरफ जाता है (Radiates to back)", "कमर के दाईं तरफ (Right flank)", "कमर के बाईं तरफ (Left flank)", "सिर्फ पेट में ही है (Abdomen only)"]
    },
    aggravating_relieving: {
      key: "aggravating_relieving",
      Hindi: "क्या खाना खाने के बाद दर्द बढ़ता है, या खाली पेट ज्यादा जलन होती है?",
      English: "Does eating worsen the pain, or is it worse on an empty stomach?",
      options: ["खाना खाने के बाद बढ़ता है (Worse after food)", "खाली पेट ज्यादा जलन (Worse empty stomach)", "दूध/पानी से आराम (Relieved by milk/water)", "मोशन के बाद आराम (Relieved after stool)"]
    },
    associated_symptoms: {
      key: "associated_symptoms",
      Hindi: "क्या उल्टी, दस्त, खट्टी डकार, या पेट फूला हुआ लग रहा है?",
      English: "Are you experiencing vomiting, diarrhea, acidity, or abdominal bloating?",
      options: ["उल्टी जैसा लगता है (Nausea/Vomiting)", "दस्त / लूज मोशन (Diarrhea)", "खट्टी डकार और जलन (Heartburn)", "कब्ज और भारीपन (Constipation/Bloating)"]
    },
    current_medications: {
      key: "current_medications",
      Hindi: "क्या आपने कोई एंटासिड (जैसे डाइजीन/पेंटोप) या दर्द की गोली ली है?",
      English: "Have you taken any antacid (like Digene/Pantop) or painkiller?",
      options: ["गैस की दवा ली (Took antacid)", "दर्द निवारक दवा (Took painkiller)", "ओआरएस / पुदीन हरा (Took ORS/home remedy)", "कुछ नहीं लिया (Nothing taken)"]
    }
  },
  GENERAL: {
    duration_onset: {
      key: "duration_onset",
      Hindi: "यह समस्या कितने समय से चल रही है?",
      English: "How long have you been experiencing this problem?",
      options: ["आज से (Since today)", "2-3 दिन से (2-3 days)", "1 हफ्ते से (Past week)", "लंबे समय से (Chronic)"]
    },
    severity_character: {
      key: "severity_character",
      Hindi: "यह तकलीफ आपके दैनिक काम को कितना प्रभावित कर रही है? (हल्की, मध्यम, या बहुत तेज)",
      English: "How severe is this issue? Does it interfere with your daily routine?",
      options: ["हल्की परेशानी (Mild)", "मध्यम तकलीफ (Moderate)", "बहुत तेज असहनीय (Severe)", "रुक-रुक कर होती है (Intermittent)"]
    },
    radiation_spread: {
      key: "radiation_spread",
      Hindi: "क्या शरीर के किसी और हिस्से में भी दर्द या कमजोरी महसूस हो रही है?",
      English: "Do you feel pain or weakness spreading to any other part of the body?",
      options: ["सिर में दर्द (Headache)", "हाथ-पैरों में दर्द (Limb aches)", "कमर में दर्द (Backache)", "कहीं और नहीं (Localized only)"]
    },
    aggravating_relieving: {
      key: "aggravating_relieving",
      Hindi: "क्या किसी खास काम या समय पर यह तकलीफ बढ़ जाती है?",
      English: "Does anything specific worsen or relieve this symptom?",
      options: ["शारीरिक मेहनत से बढ़ता है (Worse on exertion)", "रात में बढ़ता है (Worse at night)", "आराम से ठीक रहता है (Better with rest)", "लगातार एक जैसा (Constant)"]
    },
    associated_symptoms: {
      key: "associated_symptoms",
      Hindi: "क्या बुखार, कमजोरी, भूख न लगना या वजन घटने जैसी कोई और शिकायत है?",
      English: "Any other symptoms like fever, fatigue, loss of appetite, or weight loss?",
      options: ["कमजोरी और थकान (Weakness/Fatigue)", "हल्का बुखार (Mild fever)", "भूख कम लगना (Loss of appetite)", "कोई अन्य लक्षण नहीं (No other symptoms)"]
    },
    current_medications: {
      key: "current_medications",
      Hindi: "क्या आप किसी बीमारी की नियमित दवा ले रहे हैं या कोई एलर्जी है?",
      English: "Are you taking regular medications for any chronic condition, or any drug allergies?",
      options: ["नियमित दवाएं लेते हैं (On regular meds)", "दवा से एलर्जी है (Have drug allergy)", "कोई दवा नहीं (No regular meds)", "पता नहीं (Not sure)"]
    }
  }
};

// --------------------------------------------------------------------------
// InterviewPlanner: Authoritative Clinical State Machine (Phase 5A Hardened)
// --------------------------------------------------------------------------
export class InterviewPlanner {
  constructor(prismaClient) {
    this.prisma = prismaClient;
    this.MAX_QUESTIONS = 5;
  }

  /**
   * Classify complaint into a clinical category
   * Evaluates Latin, Hinglish, and native Devanagari script
   */
  classifyComplaint(text = "") {
    const lower = text.toLowerCase();

    // 1. Cardiac / Chest / Severe Vascular
    if (
      lower.includes("chest") ||
      lower.includes("seene") ||
      lower.includes("सीने") ||
      lower.includes("छाती") ||
      lower.includes("dil") ||
      lower.includes("दिल") ||
      lower.includes("heart") ||
      lower.includes("ghabrahat") ||
      lower.includes("घबराहट") ||
      lower.includes("left arm") ||
      lower.includes("baayein") ||
      lower.includes("बाएं")
    ) {
      return "CARDIAC_CHEST";
    }

    // 2. Respiratory / Pulmonary
    if (
      lower.includes("khansi") ||
      lower.includes("खांसी") ||
      lower.includes("cough") ||
      lower.includes("jukam") ||
      lower.includes("जुकाम") ||
      lower.includes("cold") ||
      lower.includes("gala") ||
      lower.includes("गला") ||
      lower.includes("throat") ||
      lower.includes("balgam") ||
      lower.includes("बलगम") ||
      lower.includes("phlegm") ||
      lower.includes("saans") ||
      lower.includes("सांस") ||
      lower.includes("breath") ||
      lower.includes("asthma")
    ) {
      return "RESPIRATORY";
    }

    // 3. Gastrointestinal / Abdomen
    if (
      lower.includes("pet") ||
      lower.includes("पेट") ||
      lower.includes("stomach") ||
      lower.includes("ulti") ||
      lower.includes("उल्टी") ||
      lower.includes("vomit") ||
      lower.includes("dast") ||
      lower.includes("दस्त") ||
      lower.includes("loose") ||
      lower.includes("gas") ||
      lower.includes("गैस") ||
      lower.includes("acidity") ||
      lower.includes("jalan") ||
      lower.includes("जलन") ||
      lower.includes("kabz") ||
      lower.includes("कब्ज") ||
      lower.includes("motion")
    ) {
      return "GASTROINTESTINAL";
    }

    return "GENERAL";
  }

  /**
   * Detect pre-covered dimensions directly in text (chief complaint or free-text answers)
   */
  detectPreCoveredDimensions(text = "") {
    const covered = new Set();
    const lower = text.toLowerCase();

    // Duration mentions
    if (
      lower.includes("din") ||
      lower.includes("दिन") ||
      lower.includes("day") ||
      lower.includes("hafte") ||
      lower.includes("हफ्ते") ||
      lower.includes("week") ||
      lower.includes("mahine") ||
      lower.includes("महीने") ||
      lower.includes("month") ||
      lower.includes("subah") ||
      lower.includes("सुबह") ||
      lower.includes("aaj") ||
      lower.includes("आज") ||
      lower.includes("yesterday") ||
      lower.includes("kal") ||
      lower.includes("कल")
    ) {
      covered.add("duration_onset");
    }

    // Severity / Character mentions
    if (
      lower.includes("tez") ||
      lower.includes("तेज") ||
      lower.includes("severe") ||
      lower.includes("halka") ||
      lower.includes("हल्का") ||
      lower.includes("mild") ||
      lower.includes("sookhi") ||
      lower.includes("सूखी") ||
      lower.includes("dabav") ||
      lower.includes("दबाव") ||
      lower.includes("भारी") ||
      lower.includes("dard") ||
      lower.includes("दर्द") ||
      lower.includes("jalan") ||
      lower.includes("जलन")
    ) {
      covered.add("severity_character");
    }

    // Medication mentions
    if (
      lower.includes("dawa") ||
      lower.includes("दवा") ||
      lower.includes("goli") ||
      lower.includes("गोली") ||
      lower.includes("syrup") ||
      lower.includes("सिरप") ||
      lower.includes("tablet") ||
      lower.includes("medicine")
    ) {
      covered.add("current_medications");
    }

    return covered;
  }

  /**
   * Aggregate all covered clinical dimensions across all turns
   */
  detectAllCoveredDimensions(turns = []) {
    const covered = new Set();
    const initialTurn = turns.find(t => t.turnIndex === 0);
    if (initialTurn?.answerText) {
      for (const d of this.detectPreCoveredDimensions(initialTurn.answerText)) {
        covered.add(d);
      }
    }
    for (const t of turns) {
      if (t.turnIndex > 0 && t.questionKey) {
        covered.add(t.questionKey);
        if (t.answerText && t.answerType === "answered") {
          for (const d of this.detectPreCoveredDimensions(t.answerText)) {
            covered.add(d);
          }
        }
      }
    }
    return covered;
  }

  /**
   * Start a new dynamic interview session
   * Idempotent: If an active session exists for this encounterId, returns it without creating a duplicate.
   */
  async startSession({ patientUid, encounterId, chiefComplaint, language = "Hindi" }) {
    if (!patientUid || !encounterId) {
      throw new Error("patientUid and encounterId are required to start an interview session");
    }

    // Idempotency check: Look for existing active or completed session on this encounter
    const existingSession = await this.prisma.interviewSession.findFirst({
      where: {
        encounterId,
        status: { in: ["in_progress", "review_dirty", "completed"] }
      },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (existingSession) {
      const allCovered = this.detectAllCoveredDimensions(existingSession.turns);
      if (existingSession.status === "completed") {
        const turns = await this.getReview(existingSession.sessionId);
        return {
          sessionId: existingSession.sessionId,
          status: "completed",
          category: existingSession.complaintCategory,
          currentStep: existingSession.totalQuestions,
          totalQuestions: this.MAX_QUESTIONS,
          coveredDomains: Array.from(allCovered),
          nextQuestion: null,
          isComplete: true,
          isExisting: true,
          reviewSummary: turns
        };
      }

      // Existing in-progress or review_dirty session
      const nextKey = this.selectNextDomain(existingSession.complaintCategory, allCovered);
      const nextQuestion = this.getQuestion(existingSession.complaintCategory, nextKey, language);

      return {
        sessionId: existingSession.sessionId,
        status: existingSession.status,
        category: existingSession.complaintCategory,
        currentStep: Math.min(existingSession.totalQuestions + 1, this.MAX_QUESTIONS),
        totalQuestions: this.MAX_QUESTIONS,
        coveredDomains: Array.from(allCovered),
        nextQuestion,
        isComplete: false,
        isExisting: true
      };
    }

    const sessionId = `intv_${crypto.randomUUID()}`;
    const category = this.classifyComplaint(chiefComplaint);
    const preCovered = this.detectPreCoveredDimensions(chiefComplaint);

    // Create new session record in database
    const session = await this.prisma.interviewSession.create({
      data: {
        sessionId,
        patientUid,
        encounterId,
        complaintCategory: category,
        status: "in_progress",
        totalQuestions: 0
      }
    });

    // Record initial chief complaint as Turn 0
    await this.prisma.interviewTurn.create({
      data: {
        sessionId,
        turnIndex: 0,
        questionKey: "chief_complaint",
        questionText: "आज आपको क्या तकलीफ है? कृपया अपनी परेशानी बताइए।",
        answerText: chiefComplaint || "Initial visit check-in",
        answerType: "answered",
        provenance: "PATIENT_REPORTED"
      }
    });

    // Select the first uncovered domain
    const nextKey = this.selectNextDomain(category, preCovered);
    const questionObj = this.getQuestion(category, nextKey, language);

    return {
      sessionId: session.sessionId,
      status: session.status,
      category,
      currentStep: 1,
      totalQuestions: this.MAX_QUESTIONS,
      coveredDomains: Array.from(preCovered),
      nextQuestion: questionObj,
      isComplete: false,
      isExisting: false
    };
  }

  /**
   * Select next uncovered clinical domain based on priority
   */
  selectNextDomain(category, coveredSet) {
    const priority = [
      "duration_onset",
      "severity_character",
      "radiation_spread",
      "aggravating_relieving",
      "associated_symptoms",
      "current_medications"
    ];

    for (const key of priority) {
      if (!coveredSet.has(key)) {
        return key;
      }
    }
    return null; // All core domains covered
  }

  /**
   * Retrieve formatted question with quick options
   */
  getQuestion(category, key, language = "Hindi") {
    if (!key) return null;
    const catQuestions = DOMAIN_QUESTIONS[category] || DOMAIN_QUESTIONS.GENERAL;
    const qData = catQuestions[key] || DOMAIN_QUESTIONS.GENERAL[key];

    if (!qData) {
      return {
        questionKey: key,
        text: language === "English" ? "Could you describe this symptom in more detail?" : "क्या आप इस तकलीफ के बारे में थोड़ा और विस्तार से बता सकते हैं?",
        options: ["हाँ, बिल्कुल", "नहीं, इतना ही है", "पता नहीं", "छोड़ें (Skip)"]
      };
    }

    return {
      questionKey: key,
      text: language === "English" ? qData.English : qData.Hindi,
      options: qData.options
    };
  }

  /**
   * Process patient response (answer, skip, or unknown / "Pata Nahi")
   * Idempotent on retries; strictly enforces lifecycle boundaries.
   */
  async processStep({ sessionId, questionKey, answerText, action = "answer", language = "Hindi" }) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Interview session not found: ${sessionId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    // Lifecycle Guard: Abandoned sessions cannot accept steps
    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot advance an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Lifecycle Guard: Completed sessions cannot accept steps (must use review/edit)
    if (session.status === "completed") {
      const err = new Error("LIFECYCLE_COMPLETED: Interview session is already completed. Use edit to modify turns.");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Canonical Provenance Reconciliation
    let answerType = "answered";
    let provenance = "PATIENT_REPORTED";
    let finalAnswerText = answerText ? String(answerText).trim() : "";

    if (action === "skip") {
      answerType = "skipped";
      provenance = "NOT_REPORTED";
      finalAnswerText = "[Skipped by patient]";
    } else if (
      action === "unknown" ||
      finalAnswerText.toLowerCase().includes("pata nahi") ||
      finalAnswerText.toLowerCase().includes("don't know")
    ) {
      answerType = "unknown";
      provenance = "MISSING_OR_UNKNOWN";
      finalAnswerText = "[Patient does not know / Pata nahi]";
    }

    // Idempotency / Retry Guard: Did the client retry the exact same questionKey?
    const existingTurn = session.turns.find(t => t.questionKey === questionKey && t.turnIndex > 0);
    if (existingTurn) {
      // Idempotently update the turn without incrementing question count or creating duplicates
      await this.prisma.interviewTurn.update({
        where: { id: existingTurn.id },
        data: { answerText: finalAnswerText, answerType, provenance }
      });

      const allCovered = this.detectAllCoveredDimensions(session.turns);
      const nextKey = this.selectNextDomain(session.complaintCategory, allCovered);
      const nextQuestion = this.getQuestion(session.complaintCategory, nextKey, language);

      return {
        sessionId,
        status: session.status,
        isComplete: false,
        currentStep: Math.min(session.totalQuestions + 1, this.MAX_QUESTIONS),
        totalQuestions: this.MAX_QUESTIONS,
        coveredDomains: Array.from(allCovered),
        nextQuestion,
        isRetry: true
      };
    }

    const nextTurnIndex = session.turns.length;
    const currentQData = this.getQuestion(session.complaintCategory, questionKey, language);

    // Record new turn in database
    await this.prisma.interviewTurn.create({
      data: {
        sessionId,
        turnIndex: nextTurnIndex,
        questionKey: questionKey || "followup",
        questionText: currentQData?.text || "Clinical assessment question",
        answerText: finalAnswerText,
        answerType,
        provenance
      }
    });

    const newQuestionCount = session.totalQuestions + 1;

    // Aggregate all covered domains
    const covered = new Set();
    for (const t of session.turns) {
      if (t.questionKey) covered.add(t.questionKey);
    }
    if (questionKey) covered.add(questionKey);

    const initialTurn = session.turns.find(t => t.turnIndex === 0);
    if (initialTurn?.answerText) {
      for (const d of this.detectPreCoveredDimensions(initialTurn.answerText)) {
        covered.add(d);
      }
    }

    // Termination criteria: max 5 questions reached, or all core domains covered
    const nextKey = this.selectNextDomain(session.complaintCategory, covered);
    const isTerminated = newQuestionCount >= this.MAX_QUESTIONS || nextKey === null;

    if (isTerminated) {
      await this.prisma.interviewSession.update({
        where: { sessionId },
        data: {
          status: "completed",
          totalQuestions: newQuestionCount,
          completedAt: new Date()
        }
      });

      const turns = await this.getReview(sessionId);
      return {
        sessionId,
        status: "completed",
        isComplete: true,
        currentStep: newQuestionCount,
        totalQuestions: this.MAX_QUESTIONS,
        nextQuestion: null,
        coveredDomains: Array.from(covered),
        reviewSummary: turns
      };
    }

    // Advance session in DB
    await this.prisma.interviewSession.update({
      where: { sessionId },
      data: { totalQuestions: newQuestionCount }
    });

    const nextQuestion = this.getQuestion(session.complaintCategory, nextKey, language);

    return {
      sessionId,
      status: "in_progress",
      isComplete: false,
      currentStep: newQuestionCount + 1,
      totalQuestions: this.MAX_QUESTIONS,
      coveredDomains: Array.from(covered),
      nextQuestion
    };
  }

  /**
   * Retrieve structured review summary for patient verification
   */
  async getReview(sessionId) {
    const turns = await this.prisma.interviewTurn.findMany({
      where: { sessionId },
      orderBy: { turnIndex: "asc" }
    });

    return turns.map(t => ({
      turnIndex: t.turnIndex,
      questionKey: t.questionKey,
      questionText: t.questionText,
      answerText: t.answerText,
      answerType: t.answerType,
      provenance: t.provenance,
      timestamp: t.timestamp
    }));
  }

  /**
   * Patient edits a previously recorded turn
   * Revalidates dependencies: marks session dirty and recomputes category and covered domains.
   */
  async editTurn({ sessionId, turnIndex, newAnswerText }) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Interview session not found: ${sessionId}`);
      err.code = "NOT_FOUND";
      throw err;
    }

    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot edit an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    const existing = await this.prisma.interviewTurn.findFirst({
      where: { sessionId, turnIndex: parseInt(turnIndex, 10) }
    });

    if (!existing) {
      throw new Error(`Turn not found at index ${turnIndex}`);
    }

    let answerType = "answered";
    let provenance = "PATIENT_REPORTED";
    let finalAnswerText = String(newAnswerText).trim();

    if (finalAnswerText === "[Skipped by patient]" || finalAnswerText.toLowerCase() === "skip") {
      answerType = "skipped";
      provenance = "NOT_REPORTED";
      finalAnswerText = "[Skipped by patient]";
    } else if (
      finalAnswerText.toLowerCase().includes("pata nahi") ||
      finalAnswerText.toLowerCase().includes("don't know") ||
      finalAnswerText === "[Patient does not know / Pata nahi]"
    ) {
      answerType = "unknown";
      provenance = "MISSING_OR_UNKNOWN";
      finalAnswerText = "[Patient does not know / Pata nahi]";
    }

    const updated = await this.prisma.interviewTurn.update({
      where: { id: existing.id },
      data: {
        answerText: finalAnswerText,
        answerType,
        provenance
      }
    });

    // Revalidate and recompute downstream dependency state
    const allTurns = await this.prisma.interviewTurn.findMany({
      where: { sessionId },
      orderBy: { turnIndex: "asc" }
    });

    let complaintCategory = session.complaintCategory;
    if (parseInt(turnIndex, 10) === 0) {
      complaintCategory = this.classifyComplaint(finalAnswerText);
    }

    const recomputedCovered = this.detectAllCoveredDimensions(allTurns);

    // Mark session review_dirty to prevent stale downstream assumptions
    await this.prisma.interviewSession.update({
      where: { sessionId },
      data: {
        status: "review_dirty",
        complaintCategory
      }
    });

    return {
      success: true,
      turn: {
        turnIndex: updated.turnIndex,
        questionKey: updated.questionKey,
        answerText: updated.answerText,
        answerType: updated.answerType,
        provenance: updated.provenance
      },
      revalidatedState: {
        status: "review_dirty",
        isDirty: true,
        complaintCategory,
        coveredDimensions: Array.from(recomputedCovered)
      }
    };
  }

  /**
   * Finalize intake interview and compile narrative into Encounter
   * Idempotent on repeated calls; re-synthesizes from freshly revalidated turns.
   */
  async submitIntake(sessionId) {
    const session = await this.prisma.interviewSession.findUnique({
      where: { sessionId },
      include: { turns: { orderBy: { turnIndex: "asc" } } }
    });

    if (!session) {
      const err = new Error(`Session ${sessionId} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }

    if (session.status === "abandoned") {
      const err = new Error("LIFECYCLE_ABANDONED: Cannot submit an abandoned interview session");
      err.code = "INVALID_LIFECYCLE_TRANSITION";
      throw err;
    }

    // Repeated submit idempotency: If already completed and not modified (review_dirty), return existing state
    if (session.status === "completed") {
      const chiefComplaint = session.turns.find(t => t.turnIndex === 0)?.answerText || "Clinical visit";
      const turns = session.turns.filter(t => t.answerType === "answered" && t.answerText && !t.answerText.startsWith("["));
      const hpiNarrative = turns.map(t => `${t.questionText}: ${t.answerText}`).join("\n");

      return {
        success: true,
        sessionId,
        encounterId: session.encounterId,
        chiefComplaint,
        hpi: hpiNarrative,
        totalAnswered: turns.length,
        alreadySubmitted: true
      };
    }

    // Build synthesized narrative HPI from validated turns
    const turns = session.turns.filter(t => t.answerType === "answered" && t.answerText && !t.answerText.startsWith("["));
    const chiefComplaint = session.turns.find(t => t.turnIndex === 0)?.answerText || "Clinical visit";

    const hpiLines = turns.map(t => `${t.questionText}: ${t.answerText}`);
    const hpiNarrative = hpiLines.join("\n");

    const medTurn = session.turns.find(t => t.questionKey === "current_medications" && t.answerType === "answered");
    const currentMedsJson = medTurn?.answerText ? JSON.stringify([medTurn.answerText]) : null;

    // Atomically persist to Encounter and mark InterviewSession completed
    await this.prisma.$transaction([
      this.prisma.encounter.updateMany({
        where: { encounterId: session.encounterId },
        data: {
          chiefComplaint,
          hpi: hpiNarrative,
          currentMedsJson,
          intakeConversation: JSON.stringify(session.turns)
        }
      }),
      this.prisma.interviewSession.update({
        where: { sessionId },
        data: {
          status: "completed",
          completedAt: new Date()
        }
      })
    ]);

    return {
      success: true,
      sessionId,
      encounterId: session.encounterId,
      chiefComplaint,
      hpi: hpiNarrative,
      totalAnswered: turns.length,
      revalidated: true
    };
  }
}
