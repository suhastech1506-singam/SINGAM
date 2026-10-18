
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

const DAILY_CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.DAILY_CHAT_LIMIT || "100", 10) || 100
);

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openrouter/free";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = "8mb";
const MAX_CHAT_MESSAGES = 20;
const MAX_CHAT_TITLE_LENGTH = 80;
const MAX_PDF_PAGES = 30;
const MAX_PDF_TEXT_LENGTH = 30000;
const MAX_MESSAGE_LENGTH = 12000;

app.disable("x-powered-by");

app.use(express.json({ limit: MAX_REQUEST_BYTES }));
app.use(express.urlencoded({
  extended: true,
  limit: MAX_REQUEST_BYTES,
  parameterLimit: 100
}));

// STATIC FILE CACHING OPTIMIZATION
// HTML revalidates so new deployments are picked up promptly.
// Other public assets can be cached for one day.
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      const extension = path.extname(filePath).toLowerCase();

      if (extension === ".html") {
        res.setHeader("Cache-Control", "no-cache");
      } else {
        res.setHeader(
          "Cache-Control",
          "public, max-age=86400, stale-while-revalidate=604800"
        );
      }
    }
  })
);

/* GENERAL HELPERS */

const clean = value => String(value ?? "").trim();

function isUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function todayIndia() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

/* SUPABASE REQUEST */

async function supabaseRequest(table, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error("Supabase server configuration is missing.");
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);

  if (options.query) {
    url.search = new URLSearchParams(options.query).toString();
  }

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json"
  };

  if (options.prefer !== false) {
    headers.Prefer = options.prefer || "return=representation";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!response.ok) {
    console.error("Supabase error:", response.status, data || text);
    throw new Error(
      data?.message || `Supabase returned HTTP ${response.status}.`
    );
  }

  return data;
}

/* AUTHENTICATION */

async function authenticate(req, res, next) {
  try {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      return res.status(503).json({
        error: "Supabase is not configured."
      });
    }

    const match = String(req.headers.authorization || "")
      .match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        error: "Please sign in first."
      });
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
      return res.status(401).json({
        error: "Could not verify your account."
      });
    }

    req.user = user;
    req.accessToken = match[1];
    return next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(503).json({
      error: "Unable to verify your session."
    });
  }
}

/* DAILY USAGE */

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

  if (!response.ok) {
    throw new Error("Could not load daily usage.");
  }

  const rows = await response.json();
  const count = Number(rows?.[0]?.chat_count || 0);

  return {
    usage_date: todayIndia(),
    chat_count: count,
    daily_limit: DAILY_CHAT_LIMIT,
    remaining: Math.max(0, DAILY_CHAT_LIMIT - count)
  };
}

/* SMART RECALL */

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

/* CHAT HISTORY HELPERS */

function makeChatTitle(message) {
  const title = clean(message)
    .replace(/\s+/g, " ")
    .slice(0, MAX_CHAT_TITLE_LENGTH);

  return title || "New chat";
}

async function getOwnedChat(conversationId, userId) {
  if (!isUuid(conversationId)) return null;

  const rows = await supabaseRequest("chat_conversations", {
    query: {
      select: "id,user_id,title,created_at,updated_at",
      id: `eq.${conversationId}`,
      user_id: `eq.${userId}`,
      limit: "1"
    }
  });

  return rows?.[0] || null;
}

async function createChat(userId, title) {
  const rows = await supabaseRequest("chat_conversations", {
    method: "POST",
    body: {
      user_id: userId,
      title: makeChatTitle(title),
      updated_at: new Date().toISOString()
    }
  });

  if (!rows?.[0]?.id) {
    throw new Error("Could not create chat conversation.");
  }

  return rows[0];
}

async function saveChatMessages(userId, conversationId, message, reply) {
  const messages = [
    {
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: String(message || "Please analyze the uploaded file.").slice(0, MAX_MESSAGE_LENGTH)
    },
    {
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: String(reply || "").slice(0, 20000)
    }
  ];

  await supabaseRequest("chat_messages", {
    method: "POST",
    body: messages
  });

  await supabaseRequest("chat_conversations", {
    method: "PATCH",
    query: {
      id: `eq.${conversationId}`,
      user_id: `eq.${userId}`
    },
    body: {
      updated_at: new Date().toISOString()
    },
    prefer: "return=minimal"
  });
}

/* CHAT HISTORY APIs */

app.get("/api/chats", authenticate, async (req, res) => {
  try {
    const chats = await supabaseRequest("chat_conversations", {
      query: {
        select: "id,title,created_at,updated_at",
        user_id: `eq.${req.user.id}`,
        order: "updated_at.desc",
        limit: "100"
      }
    });

    return res.json({ chats: chats || [] });
  } catch (error) {
    console.error("Load chats:", error.message);
    return res.status(500).json({
      error: "Could not load Chat History."
    });
  }
});

app.post("/api/chats", authenticate, async (req, res) => {
  try {
    const title = makeChatTitle(req.body?.title || "New chat");
    const chat = await createChat(req.user.id, title);

    return res.status(201).json({ chat });
  } catch (error) {
    console.error("Create chat:", error.message);
    return res.status(500).json({
      error: "Could not create a new chat."
    });
  }
});

app.get("/api/chats/:id/messages", authenticate, async (req, res) => {
  try {
    const chat = await getOwnedChat(req.params.id, req.user.id);

    if (!chat) {
      return res.status(404).json({
        error: "Chat not found."
      });
    }

    const messages = await supabaseRequest("chat_messages", {
      query: {
        select: "id,conversation_id,role,content,created_at",
        conversation_id: `eq.${chat.id}`,
        user_id: `eq.${req.user.id}`,
        order: "created_at.asc",
        limit: "1000"
      }
    });

    return res.json({
      chat,
      messages: messages || []
    });
  } catch (error) {
    console.error("Load chat messages:", error.message);
    return res.status(500).json({
      error: "Could not load this conversation."
    });
  }
});

app.patch("/api/chats/:id", authenticate, async (req, res) => {
  try {
    const title = clean(req.body?.title);

    if (!title) {
      return res.status(400).json({
        error: "Chat title cannot be empty."
      });
    }

    const rows = await supabaseRequest("chat_conversations", {
      method: "PATCH",
      query: {
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        select: "id,title,created_at,updated_at"
      },
      body: {
        title: title.slice(0, MAX_CHAT_TITLE_LENGTH),
        updated_at: new Date().toISOString()
      }
    });

    if (!rows?.length) {
      return res.status(404).json({
        error: "Chat not found."
      });
    }

    return res.json({ chat: rows[0] });
  } catch (error) {
    console.error("Rename chat:", error.message);
    return res.status(500).json({
      error: "Could not rename this chat."
    });
  }
});

app.delete("/api/chats/:id", authenticate, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({
        error: "Invalid chat ID."
      });
    }

    const rows = await supabaseRequest("chat_conversations", {
      method: "DELETE",
      query: {
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        select: "id"
      }
    });

    if (!rows?.length) {
      return res.status(404).json({
        error: "Chat not found."
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Delete chat:", error.message);
    return res.status(500).json({
      error: "Could not delete this chat."
    });
  }
});

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

/* SECURE IMAGE AND PDF ATTACHMENTS */

function decodeBase64(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("The uploaded file is empty.");
  }

  let base64 = value.trim();

  // Permit Base64 data URLs, but never trust their MIME declaration.
  if (/^data:/i.test(base64)) {
    const comma = base64.indexOf(",");
    if (comma === -1) {
      throw new Error("Invalid file data URL.");
    }
    base64 = base64.slice(comma + 1);
  }

  // Reject malformed Base64 before decoding.
  if (
    !base64 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("Invalid Base64 file data.");
  }

  const estimatedBytes = (base64.length / 4) * 3 -
    (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

  if (estimatedBytes <= 0) {
    throw new Error("The uploaded file is empty.");
  }

  if (estimatedBytes > MAX_FILE_BYTES) {
    throw new Error("Maximum file size is 5 MB.");
  }

  const buffer = Buffer.from(base64, "base64");

  // Node's decoder is permissive; require canonical Base64.
  if (buffer.toString("base64") !== base64) {
    throw new Error("Invalid Base64 file encoding.");
  }

  if (buffer.length > MAX_FILE_BYTES) {
    throw new Error("Maximum file size is 5 MB.");
  }

  return buffer;
}

function detectImageMimeType(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function getImage(body) {
  let value = body.imageData || body.imageBase64 || body.image;
  let mimeType = body.imageMimeType || body.mimeType || "image/jpeg";

  if (!value) return null;

  if (typeof value === "object") {
    mimeType = value.mimeType || mimeType;
    value = value.data || value.base64 || "";
  }

  if (typeof value !== "string") {
    throw new Error("Invalid image data.");
  }

  const dataUrlMatch = value.match(/^data:([^;,]+);base64,/i);

  if (dataUrlMatch) {
    const dataUrlMime = dataUrlMatch[1].toLowerCase();

    if (String(mimeType).toLowerCase() !== dataUrlMime) {
      throw new Error("Image MIME type does not match the data URL.");
    }

    value = value.slice(dataUrlMatch[0].length);
  }

  mimeType = String(mimeType).toLowerCase();

  const allowedMimeTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  if (!allowedMimeTypes.includes(mimeType)) {
    throw new Error("Supported images: JPG, PNG, WEBP and GIF.");
  }

  const buffer = decodeBase64(value);
  const actualMimeType = detectImageMimeType(buffer);

  if (!actualMimeType) {
    throw new Error("The file is not a supported image or has an invalid signature.");
  }

  if (actualMimeType !== mimeType) {
    throw new Error("The image content does not match its declared file type.");
  }

  return {
    mimeType: actualMimeType,
    base64: buffer.toString("base64")
  };
}

async function getPdfText(body) {
  let value = body.pdfBase64 || body.pdfData || body.pdf;

  if (!value) return "";

  if (typeof value === "object") {
    value = value.data || value.base64 || "";
  }

  const buffer = decodeBase64(value);

  // Require a PDF signature near the beginning of the document.
  const header = buffer.subarray(0, Math.min(buffer.length, 1024));

  if (!header.includes(Buffer.from("%PDF-", "ascii"))) {
    throw new Error("The uploaded file is not a valid PDF.");
  }

  // This is a parsing limit, not a malware scanner.
  const parsed = await pdfParse(buffer, { max: MAX_PDF_PAGES + 1 });

  if (parsed.numpages > MAX_PDF_PAGES) {
    throw new Error("PDF maximum supported length is 30 pages.");
  }

  if (!Number.isInteger(parsed.numpages) || parsed.numpages < 1) {
    throw new Error("The PDF has no valid pages.");
  }

  const text = clean(parsed.text).slice(0, MAX_PDF_TEXT_LENGTH);

  return text ||
    "No selectable text was found. This may be a scanned PDF; OCR is not enabled.";
}

/* PDF GENERATION */

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

    doc.fillColor("#087E8B")
      .font("Helvetica-Bold")
      .fontSize(18)
      .text("SINGAM TECHNICIAN AI", { align: "center" });

    doc.moveDown(0.3);
    doc.fillColor("#17232C")
      .fontSize(12)
      .text(title, { align: "center" });

    doc.moveDown();

    const lines = String(reportText || "")
      .replace(/\r/g, "")
      .split("\n");

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
        doc.fillColor("#087E8B")
          .font("Helvetica-Bold")
          .fontSize(12)
          .text(cleanLine);
        doc.moveDown(0.15);
      } else if (/^[-*•]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) {
        doc.fillColor("#17232C")
          .font("Helvetica")
          .fontSize(10)
          .text("•  " + cleanLine.replace(/^([-*•]|\d+[.)])\s+/, ""), {
            indent: 10,
            lineGap: 2
          });
      } else {
        doc.fillColor("#17232C")
          .font("Helvetica")
          .fontSize(10)
          .text(cleanLine, { lineGap: 3 });
      }
    }

    doc.end();
  });
}

async function askOpenRouter(messages) {
  if (!SINGAM_API_KEY) {
    throw new Error("SINGAM_API_KEY is missing from server environment.");
  }

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

    throw new Error(
      result?.error?.message ||
      `AI provider returned HTTP ${response.status}.`
    );
  }

  const reply = result?.choices?.[0]?.message?.content;

  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error("The AI provider returned an empty response.");
  }

  return reply.trim();
}

/* REPAIR HISTORY */

const allowedStatuses = [
  "pending",
  "in_progress",
  "completed",
  "unable_to_repair"
];

function cleanRepair(body, partial = false) {
  const result = {};

  const aliases = {
    device_type: body.device_type ?? body.device,
    complaint: body.complaint ?? body.notes,
    brand_model: body.brand_model ?? body.model
  };

  for (const field of [
    "customer_name",
    "device_type",
    "brand_model",
    "complaint",
    "diagnosis",
    "repair_actions",
    "parts_used",
    "cost",
    "status"
  ]) {
    let value = body[field];

    if (field in aliases) {
      value = aliases[field];
    }

    if (value === undefined) continue;

    if (field === "cost") {
      if (value === "" || value === null) {
        result.cost = null;
      } else {
        const cost = Number(value);

        if (!Number.isFinite(cost) || cost < 0) {
          throw new Error("Cost must be a valid non-negative number.");
        }

        result.cost = cost;
      }
    } else if (field === "status") {
      if (!allowedStatuses.includes(value)) {
        throw new Error("Invalid repair status.");
      }

      result.status = value;
    } else {
      const maxLength = field === "device_type" ? 100 : 10000;
      result[field] = clean(value).slice(0, maxLength) || null;
    }
  }

  if (!partial) {
    if (!result.device_type) {
      throw new Error("Device type is required.");
    }

    if (!result.complaint) {
      throw new Error("Customer complaint is required.");
    }

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

    return res.json({ repairs: repairs || [] });
  } catch (error) {
    console.error("Load repairs:", error.message);
    return res.status(500).json({
      error: "Could not load Repair History. Check Supabase configuration."
    });
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

    return res.status(201).json({ repair: rows?.[0] || null });
  } catch (error) {
    console.error("Create repair:", error.message);
    return res.status(400).json({
      error: error.message || "Could not save repair."
    });
  }
});

app.patch("/api/repairs/:id", authenticate, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: "Invalid repair ID." });
    }

    const input = cleanRepair(req.body || {}, true);

    if (!Object.keys(input).length) {
      return res.status(400).json({
        error: "No editable fields provided."
      });
    }

    const rows = await supabaseRequest("repair_history", {
      method: "PATCH",
      query: {
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        select: "*"
      },
      body: {
        ...input,
        updated_at: new Date().toISOString()
      }
    });

    if (!rows?.length) {
      return res.status(404).json({ error: "Repair record not found." });
    }

    return res.json({ repair: rows[0] });
  } catch (error) {
    console.error("Update repair:", error.message);
    return res.status(400).json({
      error: error.message || "Could not update repair."
    });
  }
});

app.delete("/api/repairs/:id", authenticate, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: "Invalid repair ID." });
    }

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

    return res.json({ success: true });
  } catch (error) {
    console.error("Delete repair:", error.message);
    return res.status(500).json({
      error: "Could not delete repair record."
    });
  }
});

app.get("/api/repairs/:id/pdf", authenticate, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: "Invalid repair ID." });
    }

    const rows = await supabaseRequest("repair_history", {
      query: {
        select: "*",
        id: `eq.${req.params.id}`,
        user_id: `eq.${req.user.id}`,
        limit: "1"
      }
    });

    const repair = rows?.[0];

    if (!repair) {
      return res.status(404).json({ error: "Repair record not found." });
    }

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
      `attachment; filename="${String(repair.report_number || "repair")
        .replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`
    );

    return res.send(pdf);
  } catch (error) {
    console.error("Repair PDF:", error.message);
    return res.status(500).json({
      error: "Could not generate repair PDF."
    });
  }
});

/* HEALTH, CONFIG AND USAGE */

app.get("/health", (req, res) => {
  return res.json({
    status: "ok",
    service: "SINGAM Technician AI",
    features: [
      "Technician troubleshooting",
      "Image analysis",
      "Secure image signature validation",
      "PDF text extraction",
      "PDF upload size and page limits",
      "Formatted PDF reports",
      "Supabase Smart Recall",
      "Supabase Repair History",
      "Chat History",
      "Daily usage limits"
    ]
  });
});

app.get("/config", (req, res) => {
  return res.json({
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
    dailyChatLimit: DAILY_CHAT_LIMIT,
    features: {
      imageAnalysis: true,
      pdfTextExtraction: true,
      pdfReportGeneration: true,
      smartRecall: true,
      repairHistory: true,
      chatHistory: true,
      dailyUsage: true
    }
  });
});

app.get("/usage", authenticate, async (req, res) => {
  try {
    return res.json(await getUsage(req.user.id, req.accessToken));
  } catch (error) {
    console.error("Usage error:", error.message);
    return res.status(500).json({
      error: "Could not load daily usage."
    });
  }
});

/* MAIN AI ROUTE WITH CHAT HISTORY */

app.post("/ask", authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const message = clean(body.message || body.command);

    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: "Message is too long. Please keep it under 12,000 characters."
      });
    }

    const image = getImage(body);
    const pdfText = await getPdfText(body);

    if (!message && !image && !pdfText) {
      return res.status(400).json({
        error: "Enter a message or attach an image/PDF."
      });
    }

    let conversation = null;
    const requestedConversationId = clean(body.conversationId);

    if (requestedConversationId) {
      if (!isUuid(requestedConversationId)) {
        return res.status(400).json({
          error: "Invalid conversation ID."
        });
      }

      conversation = await getOwnedChat(
        requestedConversationId,
        req.user.id
      );

      if (!conversation) {
        return res.status(404).json({
          error: "Chat not found or you do not have access."
        });
      }
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

    if (conversation) {
      const previous = await supabaseRequest("chat_messages", {
        query: {
          select: "role,content,created_at",
          conversation_id: `eq.${conversation.id}`,
          user_id: `eq.${req.user.id}`,
          order: "created_at.desc",
          limit: String(MAX_CHAT_MESSAGES)
        }
      });

      const chronological = (previous || []).reverse();

      for (const item of chronological) {
        if (
          ["user", "assistant"].includes(item.role) &&
          typeof item.content === "string"
        ) {
          messages.push({
            role: item.role,
            content: item.content.slice(0, MAX_MESSAGE_LENGTH)
          });
        }
      }
    }

    let userContent = message || "Please analyze the uploaded file.";

    if (pdfText && !image) {
      userContent += `\n\nExtracted PDF text:\n${pdfText}`;
    }

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

    messages.push({
      role: "user",
      content: userContent
    });

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

    if (!conversation) {
      conversation = await createChat(
        req.user.id,
        message || "Uploaded file analysis"
      );
    }

    try {
      await saveChatMessages(
        req.user.id,
        conversation.id,
        message || "Please analyze the uploaded file.",
        reply
      );
    } catch (error) {
      console.error("Chat History save failed:", error.message);

      return res.status(500).json({
        error: "SINGAM replied, but the chat could not be saved. Please retry or check Chat History."
      });
    }

    await saveConversation(req.user.id, message, reply);

    const responseBody = {
      reply,
      conversationId: conversation.id
    };

    if (
      /\b(generate|create|make|prepare|export|download|save|produce)\b/i.test(message) &&
      /\b(pdf|repair report|service report|diagnostic report|technician report|job sheet)\b/i.test(message)
    ) {
      try {
        const pdf = await createPdf(reply);

        responseBody.pdf = {
          filename: "singam-repair-report.pdf",
          mimeType: "application/pdf",
          data: pdf.toString("base64")
        };
      } catch (error) {
        console.error("Report PDF error:", error.message);
      }
    }

    return res.json(responseBody);
  } catch (error) {
    console.error("Ask route error:", error.message);

    const message = error.message || "SINGAM could not complete the request.";

    const isClientFileError =
      /uploaded file|file data|base64|image|pdf|maximum file size|maximum supported length|too many pages|invalid file/i.test(message);

    return res.status(isClientFileError ? 400 : /rate-limited/i.test(message) ? 429 : 500).json({
      error: message
    });
  }
});

/* UNKNOWN API ROUTES */

app.use("/api", (req, res) => {
  return res.status(404).json({
    error: "API route not found."
  });
});

/* GLOBAL ERROR HANDLER */

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (
    error?.type === "entity.too.large" ||
    error?.status === 413
  ) {
    return res.status(413).json({
      error: "Request is too large. Files must be 5 MB or smaller, and the total request must fit within the 8 MB limit."
    });
  }

  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "Invalid JSON request body."
    });
  }

  if (error?.type === "encoding.unsupported") {
    return res.status(415).json({
      error: "Unsupported request encoding."
    });
  }

  console.error("Server error:", error.message);

  return res.status(500).json({
    error: "Unexpected server error."
  });
});

/* START SERVER */

app.listen(PORT, () => {
  console.log("SINGAM TECHNICIAN AI IS ONLINE");
  console.log(`Server running on port ${PORT}`);
});
