
require("dotenv").config();

const express = require("express");
const path = require("path");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SINGAM_API_KEY = process.env.SINGAM_API_KEY || "";
const DAILY_CHAT_LIMIT = Math.max(1, Number.parseInt(process.env.DAILY_CHAT_LIMIT || "100", 10) || 100);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";
const MAX_FILE_BYTES = 5 * 1024 * 1024;

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const clean = value => String(value ?? "").trim();

function todayIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function supabaseRequest(table, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Supabase server configuration is missing.");
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);

  if (options.query) {
    url.search = new URLSearchParams(options.query).toString();
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation"
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    console.error("Supabase error:", response.status, data || text);
    throw new Error(data?.message || `Supabase returned HTTP ${response.status}.`);
  }

  return data;
}

async function authenticate(req, res, next) {
  try {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      return res.status(503).json({ error: "Supabase is not configured." });
    }

    const match = String(req.headers.authorization || "")
      .match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({ error: "Please sign in first." });
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${match[1]}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({
        error: "Your session expired. Please sign in again."
      });
    }

    const user = await response.json();

    if (!user?.id) {
      return res.status(401).json({ error: "Could not verify your account." });
    }

    req.user = user;
    req.accessToken = match[1];
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    res.status(503).json({ error: "Unable to verify your session." });
  }
}

/* DAILY CHAT USAGE */

async function consumeDailyChat(userId) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/consume_daily_chat`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_daily_limit: DAILY_CHAT_LIMIT
      })
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Usage RPC error:", result);
    throw new Error("Could not update daily chat usage. Check the Supabase RPC.");
  }

  return result;
}

async function getUsage(userId, token) {
  const query = new URLSearchParams({
    select: "usage_date,chat_count",
    user_id: `eq.${userId}`,
    usage_date: `eq.${todayIndia()}`,
    limit: "1"
  });

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_chat_usage?${query}`,
    {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) throw new Error("Could not load daily usage.");

  const rows = await response.json();
  const count = Number(rows?.[0]?.chat_count || 0);

  return {
    usage_date: todayIndia(),
    chat_count: count,
    daily_limit: DAILY_CHAT_LIMIT,
    remaining: Math.max(0, DAILY_CHAT_LIMIT - count)
  };
}

/* SMART RECALL — SUPABASE, SEPARATE FOR EACH USER */

async function getRelevantMemory(userId, message) {
  if (!clean(message)) return "";

  const rows = await supabaseRequest("conversation_memory", {
    query: {
      select: "user_message,assistant_reply,created_at",
      user_id: `eq.${userId}`,
      order: "created_at.desc",
      limit: "100"
    }
  });

  const words = clean(message)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length >= 3);

  if (!words.length) return "";

  return (rows || [])
    .map(row => {
      const content =
        `${row.user_message || ""} ${row.assistant_reply || ""}`.toLowerCase();

      const score = words.reduce(
        (total, word) => total + (content.includes(word) ? 1 : 0),
        0
      );

      return { row, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ row }) =>
      `User: ${String(row.user_message || "").slice(0, 500)}\n` +
      `SINGAM: ${String(row.assistant_reply || "").slice(0, 700)}`
    )
    .join("\n\n");
}

async function saveConversation(userId, message, reply) {
  try {
    await supabaseRequest("conversation_memory", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        user_id: userId,
        user_message: String(message || "").slice(0, 5000),
        assistant_reply: String(reply || "").slice(0, 8000)
      }
    });
  } catch (error) {
    console.error("Smart Recall save failed:", error.message);
  }
}

/* TECHNICIAN AI MODES */

function buildSystemPrompt(message, memory, pdfText) {
  const modes = [];

  if (/error code|fault code|error message/i.test(message)) {
    modes.push("ERROR CODE: Ask for exact device model and code if missing. Never invent code meanings.");
  }

  if (/diagnos|troubleshoot|not working|won't start|how to fix/i.test(message)) {
    modes.push("STEP-BY-STEP DIAGNOSIS: Give safe numbered checks. Ask one focused question when needed.");
  }

  if (/pc|computer|motherboard|ram|cpu|gpu|ssd|bios|no display|blue screen/i.test(message)) {
    modes.push("PC HARDWARE: Help diagnose hardware, boot, display, storage, memory and cooling issues. Never advise opening a power supply.");
  }

  if (/compatib|ddr[345]|cpu socket|nvme|m\.2/i.test(message)) {
    modes.push("COMPATIBILITY: Check exact models, sockets, supported RAM, interfaces and BIOS requirements. State uncertainty clearly.");
  }

  if (/network|wifi|wi-fi|internet|router|ethernet|dns/i.test(message)) {
    modes.push("NETWORK: Diagnose network issues systematically. Do not request passwords or recommend factory reset first.");
  }

  if (/repair report|service report|technician report|job sheet/i.test(message)) {
    modes.push("REPAIR REPORT: Use supplied facts only. Include complaint, diagnosis, actions, parts, status and verification. Mark missing information as Not provided.");
  }

  return `You are SINGAM Technician AI, a practical assistant for technicians and repair shops.

IDENTITY:
Your name is SINGAM.
If asked who created you, reply exactly:
"I was created by my boss SUHAS. 🫡"
Never claim Google created you.
Always reply in English.

RULES:
Be friendly, clear and professional.
Never invent specifications, fault codes, test results or repair outcomes.
Separate suspected causes from confirmed findings.
Give beginner-friendly numbered steps.
Prioritize safe checks and warn before data loss.
Never ask for passwords or API keys.
Never claim you physically tested a device.
Disconnect equipment from power before inspection.
Refer hazardous electrical work to a qualified technician.

SPECIALIST MODES:
${modes.join("\n")}

RELEVANT SAVED CONVERSATIONS:
${memory || "No relevant memory found."}

EXTRACTED PDF TEXT:
${pdfText || "No PDF attached."}

Use saved memory only when relevant to the current request.`;
}

/* IMAGE AND PDF ATTACHMENTS */

function decodeBase64(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The uploaded file is empty.");
  }

  const base64 = value.replace(/^data:[^,]*;base64,/i, "").trim();

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("Invalid file data.");
  }

  const buffer = Buffer.from(base64, "base64");

  if (!buffer.length) throw new Error("The uploaded file is empty.");
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Maximum file size is 5 MB.");

  return buffer;
}

function getImage(body) {
  let value = body.imageData || body.imageBase64 || body.image;
  let mimeType = body.imageMimeType || body.mimeType || "image/jpeg";

  if (!value) return null;

  if (typeof value === "object") {
    mimeType = value.mimeType || mimeType;
    value = value.data || value.base64 || "";
  }

  const match = String(value).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,/i);

  if (match) {
    mimeType = match[1].toLowerCase();
    value = value.replace(/^data:[^,]*;base64,/i, "");
  }

  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    throw new Error("Supported images: JPG, PNG, WEBP and GIF.");
  }

  return {
    mimeType,
    base64: decodeBase64(value).toString("base64")
  };
}

async function getPdfText(body) {
  let value = body.pdfBase64 || body.pdfData || body.pdf;

  if (!value) return "";

  if (typeof value === "object") value = value.data || value.base64 || "";

  const parsed = await pdfParse(decodeBase64(value));

  if (parsed.numpages > 30) {
    throw new Error("PDF maximum supported length is 30 pages.");
  }

  const text = clean(parsed.text).slice(0, 30000);

  return text || "No selectable text was found. This may be a scanned PDF; OCR is not enabled.";
}

/* FORMATTED PDF REPORT */

function createPdf(reportText, title = "TECHNICAL REPAIR REPORT") {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 48, bottom: 55, left: 52, right: 52 },
      info: { Title: title, Author: "SINGAM Technician AI" }
    });

    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fillColor("#087E8B").font("Helvetica-Bold").fontSize(18)
      .text("SINGAM TECHNICIAN AI", { align: "center" });

    doc.moveDown(0.3);
    doc.fillColor("#17232C").fontSize(12)
      .text(title, { align: "center" });

    doc.moveDown();

    const lines = String(reportText || "").replace(/\r/g, "").split("\n");

    for (const raw of lines) {
      const line = raw.trim();

      if (!line) {
        doc.moveDown(0.35);
        continue;
      }

      const cleanLine = line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/__(.*?)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

      if (/^#{1,3}\s+/.test(line)) {
        doc.moveDown(0.3);
        doc.fillColor("#087E8B").font("Helvetica-Bold").fontSize(12)
          .text(cleanLine);
        doc.moveDown(0.15);
      } else if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        doc.fillColor("#17232C").font("Helvetica").fontSize(10)
          .text("•  " + cleanLine.replace(/^([-*•]|\d+[.)])\s+/, ""), {
            indent: 10,
            lineGap: 2
          });
      } else {
        doc.fillColor("#17232C").font("Helvetica").fontSize(10)
          .text(cleanLine, { lineGap: 3 });
      }
    }

    doc.end();
  });
}

async function askOpenRouter(messages) {
  if (!SINGAM_API_KEY) throw new Error("SINGAM_API_KEY is missing from server environment.");

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SINGAM_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://singam-ai.onrender.com",
      "X-Title": "SINGAM Technician AI"
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 1800
    })
  });

  const result = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error("The AI service is temporarily rate-limited. Please try again later.");
    }

    if ([401, 403].includes(response.status)) {
      throw new Error("AI provider rejected the server credentials. Check the server environment.");
    }

    throw new Error(result?.error?.message || `AI provider returned HTTP ${response.status}.`);
  }

  const reply = result?.choices?.[0]?.message?.content;

  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("The AI provider returned an empty response.");
  }

  return reply.trim();
}

/* REPAIR HISTORY */

const allowedStatuses = ["pending", "in_progress", "completed", "unable_to_repair"];

function cleanRepair(body, partial = false) {
  const result = {};

  for (const field of [
    "customer_name", "device_type", "brand_model", "complaint",
    "diagnosis", "repair_actions", "parts_used", "cost", "status"
  ]) {
    if (body[field] === undefined) continue;

    if (field === "cost") {
      if (body[field] === "" || body[field] === null) {
        result.cost = null;
      } else {
        const cost = Number(body[field]);
        if (!Number.isFinite(cost) || cost < 0) {
          throw new Error("Cost must be a valid non-negative number.");
        }
        result.cost = cost;
      }
    } else if (field === "status") {
      if (!allowedStatuses.includes(body.status)) {
        throw new Error("Invalid repair status.");
      }
      result.status = body.status;
    } else {
      const maxLength = field === "device_type" ? 100 : 10000;
      result[field] = clean(body[field]).slice(0, maxLength) || null;
    }
  }

  if (!partial) {
    if (!result.device_type) throw new Error("Device type is required.");
    if (!result.complaint) throw new Error("Customer complaint is required.");
    if (!result.status) result.status = "pending";
  }

  return result;
}

function makeReportNumber() {
  return "SG-" + Date.now().toString(36).toUpperCase() +
    "-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

app.get("/api/repairs", authenticate, async (req, res) => {
  try {
    const query = {
      select: "*",
      user_id: `eq.${req.user.id}`,
      order: "created_at.desc",
      limit: "500"
    };

    if (allowedStatuses.includes(req.query.status)) {
      query.status = `eq.${req.query.status}`;
    }

    const repairs = await supabaseRequest("repair_history", { query });
    res.json({ repairs: repairs || [] });
  } catch (error) {
    console.error("Load repairs:", error.message);
    res.status(500).json({ error: "Could not load Repair History. Check Supabase configuration." });
  }
});

app.post("/api/repairs", authenticate, async (req, res) => {
  try {
    const input = cleanRepair(req.body || {});
    const rows = await supabaseRequest("repair_history", {
      method: "POST",
      body: {
        ...input,
        user_id: req.user.id,
        report_number: makeReportNumber()
      }
    });

    res.status(201).json({ repair: rows?.[0] || null });
  } catch (error) {
    console.error("Create repair:", error.message);
    res.status(400).json({ error: error.message || "Could not save repair." });
  }
});

app.patch("/api/repairs/:id", authenticate, async (req, res) => {
  try {
    const input = cleanRepair(req.body || {}, true);

    if (!Object.keys(input).length) {
      return res.status(400).json({ error: "No editable fields provided." });
    }

    const rows = await supabaseRequest("repair_history", {
      method: "PATCH",
      query: {
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        select: "*"
      },
      body: { ...input, updated_at: new Date().toISOString() }
    });

    if (!rows?.length) {
      return res.status(404).json({ error: "Repair record not found." });
    }

    res.json({ repair: rows[0] });
  } catch (error) {
    console.error("Update repair:", error.message);
    res.status(400).json({ error: error.message || "Could not update repair." });
  }
});

app.delete("/api/repairs/:id", authenticate, async (req, res) => {
  try {
    const rows = await supabaseRequest("repair_history", {
      method: "DELETE",
      query: {
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        select: "id"
      }
    });

    if (!rows?.length) {
      return res.status(404).json({ error: "Repair record not found." });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Delete repair:", error.message);
    res.status(500).json({ error: "Could not delete repair record." });
  }
});

app.get("/api/repairs/:id/pdf", authenticate, async (req, res) => {
  try {
    const rows = await supabaseRequest("repair_history", {
      query: {
        select: "*",
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        limit: "1"
      }
    });

    const repair = rows?.[0];

    if (!repair) return res.status(404).json({ error: "Repair record not found." });

    const text = [
      `Report number: ${repair.report_number}`,
      `Customer: ${repair.customer_name || "Not provided"}`,
      `Device: ${repair.device_type || "Not provided"}`,
      `Brand / model: ${repair.brand_model || "Not provided"}`,
      `Complaint: ${repair.complaint || "Not provided"}`,
      `Diagnosis: ${repair.diagnosis || "Not provided"}`,
      `Repair actions: ${repair.repair_actions || "Not provided"}`,
      `Parts used: ${repair.parts_used || "Not provided"}`,
      `Cost: ${repair.cost ?? "Not provided"}`,
      `Status: ${repair.status || "pending"}`,
      `Created: ${repair.created_at || ""}`
    ].join("\n\n");

    const pdf = await createPdf(text, "REPAIR SERVICE RECORD");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(repair.report_number || "repair").replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`
    );

    res.send(pdf);
  } catch (error) {
    console.error("Repair PDF:", error.message);
    res.status(500).json({ error: "Could not generate repair PDF." });
  }
});

/* HEALTH, CONFIG AND USAGE */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "SINGAM Technician AI",
    features: [
      "Technician troubleshooting",
      "Image analysis",
      "PDF text extraction",
      "Formatted PDF reports",
      "Supabase Smart Recall",
      "Supabase Repair History",
      "Daily usage limits"
    ]
  });
});

app.get("/config", (req, res) => {
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
    dailyChatLimit: DAILY_CHAT_LIMIT,
    features: {
      imageAnalysis: true,
      pdfTextExtraction: true,
      pdfReportGeneration: true,
      smartRecall: true,
      repairHistory: true,
      dailyUsage: true
    }
  });
});

app.get("/usage", authenticate, async (req, res) => {
  try {
    res.json(await getUsage(req.user.id, req.accessToken));
  } catch (error) {
    console.error("Usage error:", error.message);
    res.status(500).json({ error: "Could not load daily usage." });
  }
});

/* MAIN AI ROUTE */

app.post("/ask", authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const message = clean(body.message || body.command);
    const image = getImage(body);
    const pdfText = await getPdfText(body);

    if (!message && !image && !pdfText) {
      return res.status(400).json({
        error: "Enter a message or attach an image/PDF."
      });
    }

    let memory = "";

    try {
      memory = await getRelevantMemory(req.user.id, message);
    } catch (error) {
      console.error("Smart Recall retrieval failed:", error.message);
    }

    const messages = [{
      role: "system",
      content: buildSystemPrompt(message, memory, pdfText)
    }];

    let userContent = message || "Please analyze the uploaded file.";

    if (image) {
      userContent = [
        { type: "text", text: userContent },
        {
          type: "image_url",
          image_url: {
            url: `data:${image.mimeType};base64,${image.base64}`
          }
        }
      ];
    }

    messages.push({ role: "user", content: userContent });

    const usage = await consumeDailyChat(req.user.id);

    if (
      usage === false ||
      usage?.allowed === false ||
      usage?.success === false
    ) {
      return res.status(429).json({
        error: "You have reached today's chat limit. Please try again tomorrow."
      });
    }

    const reply = await askOpenRouter(messages);

    await saveConversation(req.user.id, message, reply);

    if (
      /\b(generate|create|make|prepare|export|download|save|produce)\b/i.test(message) &&
      /\b(pdf|repair report|service report|diagnostic report|technician report|job sheet)\b/i.test(message)
    ) {
      try {
        const pdf = await createPdf(reply);

        return res.json({
          reply,
          pdf: {
            filename: "singam-repair-report.pdf",
            mimeType: "application/pdf",
            data: pdf.toString("base64")
          }
        });
      } catch (error) {
        console.error("Report PDF error:", error.message);
      }
    }

    res.json({ reply });
  } catch (error) {
    console.error("Ask route error:", error.message);

    res.status(/rate-limited/i.test(error.message) ? 429 : 500).json({
      error: error.message || "SINGAM could not complete the request."
    });
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "API route not found." });
});

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
  console.log("🦁 SINGAM TECHNICIAN AI IS ONLINE");
  console.log(`Server running on port ${PORT}`);
});
