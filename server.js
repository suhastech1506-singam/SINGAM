
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

// Allow image data in requests (base64 images are larger than normal text).
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   MEMORY
========================= */

const memoryFile = path.join(__dirname, "memory.json");
let memory = [];

try {
    if (fs.existsSync(memoryFile)) {
        memory = JSON.parse(
            fs.readFileSync(memoryFile, "utf8")
        );

        if (!Array.isArray(memory)) memory = [];
    }
} catch (error) {
    console.error("Memory load error:", error.message);
    memory = [];
}

function saveMemory() {
    try {
        fs.writeFileSync(
            memoryFile,
            JSON.stringify(memory, null, 2)
        );
    } catch (error) {
        console.error("Memory save error:", error.message);
    }
}

/* =========================
   SINGAM AI
========================= */

app.post("/ask", async (req, res) => {
    const command = String(req.body.command || "").trim();
    const image = req.body.image;

    // The frontend sends image.data as base64 and image.mimeType.
    const hasImage = Boolean(image);

    if (!command && !hasImage) {
        return res.json({
            reply: "I'm listening, boss. 😎"
        });
    }

    // Validate uploaded image before sending it to the AI provider.
    let imageDataUrl = null;

    if (hasImage) {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif"
        ];

        if (
            !image ||
            typeof image.data !== "string" ||
            !allowedTypes.includes(image.mimeType) ||
            image.data.length === 0
        ) {
            return res.status(400).json({
                reply: "Please upload a valid JPG, PNG, WEBP, or GIF image."
            });
        }

        // Accept raw base64 data from the current frontend.
        const base64 = image.data.replace(
            /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
            ""
        );

        if (
            !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
            base64.length > 7 * 1024 * 1024
        ) {
            return res.status(400).json({
                reply: "The image data is invalid or too large. Please choose a smaller image."
            });
        }

        imageDataUrl = `data:${image.mimeType};base64,${base64}`;
    }

    const effectiveCommand = command || (
        hasImage
            ? "Analyze the uploaded image and explain what you can identify."
            : ""
    );

    console.log("USER:", effectiveCommand);
    console.log("IMAGE ATTACHED:", hasImage);

    /* CREATOR */

    const lower = effectiveCommand.toLowerCase();

    if (
        !hasImage &&
        (
            lower.includes("who created you") ||
            lower.includes("who made you") ||
            lower.includes("who built you") ||
            lower.includes("who programmed you") ||
            lower.includes("who is your creator")
        )
    ) {
        const reply = "I was created by my boss SUHAS. 🫡";

        memory.push({
            user: effectiveCommand,
            singam: reply
        });

        if (memory.length > 100) {
            memory = memory.slice(-100);
        }

        saveMemory();
        return res.json({ reply });
    }

    /* PREVIOUS MEMORY */

    const recentMemory = memory
        .slice(-30)
        .map(item =>
            `SUHAS: ${item.user}\nSINGAM: ${item.singam}`
        )
        .join("\n\n");

    /* SINGAM PERSONALITY */

    const instructions = `
You are SINGAM, SUHAS's personal AI assistant and friendly companion.

IDENTITY:
- Your name is SINGAM.
- SUHAS is your boss and creator.
- If asked who created you, say exactly:
"I was created by my boss SUHAS. 🫡"
- Never say Google created you.
- Never say "you're the boss here".

LANGUAGE:
- Always reply in clear, natural English.
- Use simple conversational English.

PERSONALITY:
- Be warm, natural, confident, friendly and slightly playful.
- You may call SUHAS "boss" naturally, but not in every sentence.
- Explain things patiently and clearly.
- Be concise for simple questions and detailed when needed.

TECHNICIAN MODE:
- Help troubleshoot electronics, appliances, computers, phones,
  laptops, software and networks.
- For appliance or electronics photos, inspect visible details carefully.
- Identify visible damage or unusual areas when evidence supports it.
- Explain what you can actually see and distinguish observations
  from possible causes.
- Give likely causes and safe, practical next diagnostic steps.
- Do not claim that a component is faulty based on appearance alone.
- Do not claim certainty when the image does not provide enough evidence.
- Ask one relevant follow-up question when necessary.
- Internal electrical repairs, live circuits, and high-voltage equipment
  must be handled by a qualified technician.
- Do not instruct users to touch live wiring or bypass safety systems.
- Start with simple, safe external checks when appropriate.
- Never pretend you have tested or physically accessed the device.

MEMORY:
- Use the previous memory below.
- Remember relevant facts available in that memory.
- Never invent personal information.

EMOJI:
- Use emojis naturally when appropriate.
- Never explain the meaning of emojis.

PREVIOUS MEMORY:
${recentMemory}
`;

    /* OPENROUTER REQUEST */

    try {
        if (!process.env.SINGAM_API_KEY) {
            throw new Error(
                "SINGAM_API_KEY is missing from the environment."
            );
        }

        // Text-only requests keep the original format.
        // Image requests use OpenRouter's multimodal content format.
        const userContent = hasImage
            ? [
                {
                    type: "text",
                    text:
                        effectiveCommand +
                        "\n\nAnalyze the attached image. Describe visible evidence, " +
                        "possible causes, uncertainty, and safe next steps."
                },
                {
                    type: "image_url",
                    image_url: {
                        url: imageDataUrl
                    }
                }
            ]
            : effectiveCommand;

        const response = await fetch(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        "Bearer " + process.env.SINGAM_API_KEY
                },
                body: JSON.stringify({
                    model: "openrouter/free",
                    messages: [
                        {
                            role: "system",
                            content: instructions
                        },
                        {
                            role: "user",
                            content: userContent
                        }
                    ]
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();

            console.error(
                "OpenRouter HTTP error:",
                response.status,
                errorText
            );

            throw new Error(
                `OpenRouter HTTP ${response.status}: ${errorText}`
            );
        }

        const data = await response.json();

        const reply =
            data.choices?.[0]?.message?.content?.trim() ||
            "I couldn't get a response, boss. Please try again.";

        /* SAVE MEMORY (NOT THE IMAGE) */

        memory.push({
            user: effectiveCommand + (
                hasImage ? " [Image attached]" : ""
            ),
            singam: reply
        });

        if (memory.length > 100) {
            memory = memory.slice(-100);
        }

        saveMemory();

        console.log("SINGAM:", reply);

        return res.json({ reply });

    } catch (error) {
        console.error("SINGAM ERROR:", error.message);

        return res.status(500).json({
            reply:
                "Image or chat analysis failed. " +
                "Please check the server logs and OpenRouter model support."
        });
    }
});

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "index.html")
    );
});

/* =========================
   START
========================= */

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log("🦁 SINGAM AI IS ONLINE");
    console.log("Open http://localhost:3000");
});
