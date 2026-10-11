
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SINGAM_API_KEY = process.env.SINGAM_API_KEY || "";
const DAILY_CHAT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.DAILY_CHAT_LIMIT || "100", 10) || 100
);

const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_MEMORY_ITEMS = 200;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_PDF_TEXT = 30000;

let memory = [];

try {
  if (fs.existsSync(MEMORY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    memory = Array.isArray(saved) ? saved : [];
  }
} catch (error) {
  console.error("Memory file could not be loaded:", error.message);
  memory = [];
}

function saveMemory() {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (error) {
    console.error("Memory save failed:", error.message);
  }
}

function getIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function authenticate(req, res, next) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
    return res.status(503).json({
      error: "Supabase is not configured on the server."
    });
  }

  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      error: "Please sign in to SINGAM first."
    });
  }

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      return res.status(401).json({
        error: "Your session is invalid or expired. Please sign in again."
      });
    }

    const user = await response.json();

    if (!user || !user.id) {
      return res.status(401).json({ error: "Unable to verify your account." });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    return res.status(503).json({
      error: "Could not verify your account. Please try again."
    });
  }
}

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

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Daily quota RPC error:", response.status, data);
    throw new Error("Could not check your daily chat limit.");
  }

  return data;
}

async function getDailyUsage(userId) {
  const date = getIndiaDate();
  const url = new URL(`${SUPABASE_URL}/rest/v1/daily_chat_usage`);

  url.searchParams.set("select", "usage_date,chat_count");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("usage_date", `eq.${date}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
    }
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("Usage lookup error:", response.status, data);
    throw new Error("Could not load daily usage.");
  }

  const row = Array.isArray(data) ? data[0] : null;

  return {
    usageDate: date,
    used: row ? row.chat_count : 0,
    limit: DAILY_CHAT_LIMIT,
    remaining: Math.max(0, DAILY_CHAT_LIMIT - (row ? row.chat_count : 0))
  };
}

app.get("/config", (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return res.status(503).json({
      error: "Supabase configuration is missing on the server."
    });
  }

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
    dailyChatLimit: DAILY_CHAT_LIMIT
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "online", service: "SINGAM" });
});

app.get("/usage", authenticate, async (req, res) => {
  try {
    const usage = await getDailyUsage(req.user.id);
    res.json(usage);
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

function getRelevantMemory(query, userId) {
  const words = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2);

  return memory
    .filter(item => item.userId === userId)
    .map(item => {
      const text = `${item.user || ""} ${item.assistant || ""}`.toLowerCase();
      let score = 0;

      for (const word of words) {
        if (text.includes(word)) score++;
      }

      return { item, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(entry => ({
      user: entry.item.user,
      assistant: entry.item.assistant
    }));
}

function remember(userId, userText, assistantText) {
  memory.push({
    userId,
    user: String(userText || "").slice(0, 5000),
    assistant: String(assistantText || "").slice(0, 5000),
    createdAt: new Date().toISOString()
  });

  if (memory.length > MAX_MEMORY_ITEMS) {
    memory = memory.slice(-MAX_MEMORY_ITEMS);
  }

  saveMemory();
}

function getSystemPrompt(userId, command) {
  const relevant = getRelevantMemory(command, userId);

  const memoryText = relevant.length
    ? "\nRelevant previous conversations for this signed-in user:\n" +
      relevant.map(item =>
        `User: ${item.user}\nSINGAM: ${item.assistant}`
      ).join("\n\n")
    : "";

  return `You are SINGAM, a friendly personal AI technician assistant.
Speak naturally and helpfully. The user likes being addressed as "boss".
Use clear, practical explanations. Match the user's language where appropriate.
Never claim that Google created SINGAM. Gemini or other models are only underlying technology.
If asked who created, made, built, or programmed you, reply exactly:
I was created by my boss SUHAS. 🫡

Keep the signed-in user's personal conversation context private.
Do not claim you remember facts that are not present in the available context.
For technical tasks, explain safe steps and avoid inventing successful actions.
${memoryText}`;
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  const cleaned = value.replace(/^data:[^,]*;base64,/i, "").trim();

  try {
    const buffer = Buffer.from(cleaned, "base64");
    if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) return null;
    return buffer;
  } catch {
    return null;
  }
}

function getImageAttachment(body) {
  const candidates = [
    body.imageData,
    body.image,
    body.imageBase64,
    body.attachmentData
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const dataUrlMatch = candidate.match(
        /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,/i
      );

      const mime = dataUrlMatch
        ? dataUrlMatch[1].toLowerCase().replace("image/jpg", "image/jpeg")
        : (body.imageMimeType || body.mimeType || "image/jpeg").toLowerCase();

      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
        continue;
      }

      const buffer = decodeBase64(candidate);
      if (buffer) {
        return {
          dataUrl: `data:${mime};base64,${buffer.toString("base64")}`
        };
      }
    }
  }

  return null;
}

async function extractPdfText(body) {
  if (typeof body.pdfText === "string" && body.pdfText.trim()) {
    return body.pdfText.slice(0, MAX_PDF_TEXT);
  }

  const pdfCandidate =
    body.pdfBase64 ||
    body.pdfData ||
    body.pdf ||
    (body.attachmentType === "application/pdf" ? body.attachmentData : null);

  const buffer = decodeBase64(pdfCandidate);
  if (!buffer) return "";

  if (buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("The uploaded file does not appear to be a valid PDF.");
  }

  const parsed = await pdfParse(buffer);
  const text = (parsed.text || "").trim();

  if (!text) {
    return "[This PDF contains no extractable text. It may be scanned or image-only; OCR is not enabled.]";
  }

  return text.slice(0, MAX_PDF_TEXT);
}

function makePdfBuffer(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text("SINGAM AI", { align: "center" });
    doc.moveDown();
    doc.fontSize(11).text(String(text || ""), {
      align: "left",
      lineGap: 3
    });
    doc.end();
  });
}

function wantsPdf(command) {
  return /\b(make|create|generate|export|download|save)\b.{0,50}\b(pdf|as pdf|pdf file)\b|\b(pdf|pdf file)\b.{0,50}\b(make|create|generate|export|download)\b/i
    .test(command);
}

app.post("/ask", authenticate, async (req, res) => {
  const command = typeof req.body.command === "string"
    ? req.body.command.trim()
    : "";

  const imageAttachment = getImageAttachment(req.body);

  if (!command && !imageAttachment && !req.body.pdfBase64 && !req.body.pdfData && !req.body.pdf && !req.body.pdfText) {
    return res.status(400).json({
      error: "Please enter a message or attach an image/PDF."
    });
  }

  if (!SINGAM_API_KEY) {
    return res.status(503).json({
      error: "SINGAM_API_KEY is missing from Render Environment."
    });
  }

  let quota;

  try {
    quota = await consumeDailyChat(req.user.id);
  } catch (error) {
    return res.status(503).json({
      error: "Could not check your daily chat limit. Please try again."
    });
  }

  if (!quota || quota.allowed !== true) {
    const used = quota && Number.isFinite(Number(quota.chat_count))
      ? Number(quota.chat_count)
      : DAILY_CHAT_LIMIT;

    return res.status(429).json({
      error: `You've reached your daily limit of ${DAILY_CHAT_LIMIT} chats. Please try again after midnight India time.`,
      reply: `Boss, today's ${DAILY_CHAT_LIMIT}-chat limit mudinjiduchu. India time midnight-ku reset aagum.`,
      usage: {
        used,
        limit: DAILY_CHAT_LIMIT,
        remaining: 0,
        usageDate: quota && quota.usage_date ? quota.usage_date : getIndiaDate()
      }
    });
  }

  try {
    const pdfText = await extractPdfText(req.body).catch(error => {
      throw new Error(`PDF processing failed: ${error.message}`);
    });

    let userContent = command || "Please examine the attached file.";

    if (pdfText) {
      userContent += `\n\nAttached PDF text:\n${pdfText}`;
    }

    const messages = [
      {
        role: "system",
        content: getSystemPrompt(req.user.id, userContent)
      }
    ];

    if (imageAttachment) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userContent || "Please describe this image." },
          {
            type: "image_url",
            image_url: { url: imageAttachment.dataUrl }
          }
        ]
      });
    } else {
      messages.push({
        role: "user",
        content: userContent
      });
    }

    // Keep the creator identity answer exact.
    const creatorQuestion =
      /\b(who|which person)\b.{0,50}\b(created|made|built|programmed)\b|\b(who|which person)\b.{0,50}\byou\b.{0,50}\b(created|made|built|programmed)\b/i
        .test(command);

    let reply;

    if (creatorQuestion && !imageAttachment && !pdfText) {
      reply = "I was created by my boss SUHAS. 🫡";
    } else {
      const aiResponse = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SINGAM_API_KEY}`,
            "Content-Type": "application/json",
            "X-Title": "SINGAM AI"
          },
          body: JSON.stringify({
            model: "openrouter/free",
            messages,
            temperature: 0.7
          })
        }
      );

      const aiData = await aiResponse.json().catch(() => ({}));

      if (!aiResponse.ok) {
        console.error("OpenRouter error:", aiResponse.status, aiData);

        const providerMessage =
          aiData.error && aiData.error.message
            ? aiData.error.message
            : "The AI provider could not complete the request.";

        return res.status(aiResponse.status === 429 ? 503 : 502).json({
          error: `SINGAM AI provider error: ${providerMessage}`,
          usage: {
            used: Number(quota.chat_count) || 0,
            limit: DAILY_CHAT_LIMIT,
            remaining: Math.max(0, DAILY_CHAT_LIMIT - (Number(quota.chat_count) || 0)),
            usageDate: quota.usage_date || getIndiaDate()
          }
        });
      }

      reply =
        aiData.choices &&
        aiData.choices[0] &&
        aiData.choices[0].message &&
        aiData.choices[0].message.content;

      if (Array.isArray(reply)) {
        reply = reply.map(part => part.text || "").join("\n");
      }

      if (typeof reply !== "string" || !reply.trim()) {
        reply = "Sorry boss, I couldn't generate a response. Please try again.";
      }
    }

    remember(req.user.id, userContent, reply);

    const usage = {
      used: Number(quota.chat_count) || 0,
      limit: DAILY_CHAT_LIMIT,
      remaining: Math.max(0, DAILY_CHAT_LIMIT - (Number(quota.chat_count) || 0)),
      usageDate: quota.usage_date || getIndiaDate()
    };

    if (wantsPdf(command)) {
      try {
        const pdfBuffer = await makePdfBuffer(reply);

        return res.json({
          reply,
          usage,
          pdf: {
            filename: "singam-response.pdf",
            mimeType: "application/pdf",
            data: pdfBuffer.toString("base64")
          }
        });
      } catch (error) {
        console.error("PDF generation error:", error.message);
        return res.json({
          reply: `${reply}\n\n(PDF generation failed this time.)`,
          usage
        });
      }
    }

    return res.json({ reply, usage });
  } catch (error) {
    console.error("Request error:", error.message);
    return res.status(400).json({
      error: error.message || "Could not process your request."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("🦁 SINGAM IS ONLINE");
  console.log(`Server listening on port ${PORT}`);
  console.log(`Daily chat limit: ${DAILY_CHAT_LIMIT}`);
});
