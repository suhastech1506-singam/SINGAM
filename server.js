require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
// OpenRouter is used for SINGAM's AI brain
const app = express();

app.use(express.json());
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
   SINGAM
========================= */

app.post("/ask", async (req, res) => {

    const command =
        String(req.body.command || "").trim();

    console.log("USER:", command);

    if (!command) {
        return res.json({
            reply: "I'm listening, boss. 😎"
        });
    }

    /* CREATOR */

    const lower = command.toLowerCase();

    if (
        lower.includes("who created you") ||
        lower.includes("who made you") ||
        lower.includes("who built you") ||
        lower.includes("who programmed you") ||
        lower.includes("who is your creator")
    ) {

        const reply =
            "I was created by my boss SUHAS. 🫡";

        memory.push({
            user: command,
            singam: reply
        });

        if (memory.length > 100) {
            memory = memory.slice(-100);
        }

        saveMemory();

        return res.json({ reply });
    }

    /* PREVIOUS MEMORY */

    const recentMemory =
        memory
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
- Never say the user is your boss.
- Never say "you're the boss here".
- Your identity is SINGAM.

LANGUAGE:
- ALWAYS reply in ENGLISH.
- NEVER reply in Tamil.
- NEVER reply in Tanglish.
- Even if SUHAS speaks Tamil or Tanglish, answer in clear natural English.
- Use simple conversational English.

PERSONALITY:
- Talk to SUHAS like a close friend.
- Be warm, natural, confident and slightly playful.
- You may call him "boss" naturally.
- Do not call him boss in every sentence.
- Match his mood.
- If he is excited, match his energy.
- If he is confused, explain patiently.
- If he jokes, joke back naturally.
- Make occasional clean jokes when appropriate.
- Do not force jokes.
- Never sound like customer support.
- Never say "As an AI language model".

JARVIS STYLE:
- Intelligent.
- Calm.
- Confident.
- Helpful.
- Slightly futuristic.
- Concise for simple questions.
- Detailed when necessary.

MEMORY:
- Use the previous memory below.
- If SUHAS explicitly tells you a personal fact or preference, remember it.
- If the answer exists in memory, use it.
- Never invent personal information.
- If something is not in memory, honestly say you don't know.

EMOJI RULE:
- NEVER explain, define, translate, or describe the meaning of emojis.
- Use emojis directly and naturally when appropriate.

PREVIOUS MEMORY:
${recentMemory}
`;

    /* GEMINI */

    try {

        const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + process.env.SINGAM_API_KEY
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
                    content: command
                }
            ]
        })
    }
);

if (!response.ok) {
    throw new Error(
        `OpenRouter HTTP ${response.status}: ${await response.text()}`
    );
}

const data = await response.json();

const reply =
    data.choices?.[0]?.message?.content?.trim() ||
    "I didn't get a response, boss.";

        /* SAVE */

        memory.push({
            user: command,
            singam: reply
        });

        if (memory.length > 100) {
            memory = memory.slice(-100);
        }

        saveMemory();

        console.log("SINGAM:", reply);

        return res.json({
            reply: reply
        });

    } catch (error) {

        console.error("========== GEMINI ERROR ==========");
        console.error(error);
        console.error("===================================");

        return res.status(500).json({
            reply:
                "Gemini Error:"+
                error.message
        });
    }
});


/* =========================
   HOME
========================= */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


/* =========================
   START
========================= */

app.listen(process.env.PORT || 3000, "0.0.0.0", () => {

    console.log("🦁 SINGAM AI IS ONLINE");
    console.log("Open http://localhost:3000");

});
