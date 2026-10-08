const express = require("express");
const path = require("path");
const fs = require("fs");
const OpenAI = require("openai");

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));


/* =========================
   OPENAI
========================= */

if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY is missing");
    process.exit(1);
}

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


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
- OpenAI is only the underlying AI technology.
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
- If SUHAS explicitly tells you a personal fact or preference,
  remember it.
- If the answer exists in memory, use it.
- Never invent personal information.
- If something is not in memory, honestly say you don't know.

PREVIOUS MEMORY:
${recentMemory}
`;


    /* OPENAI */

    try {

        const response =
            await client.responses.create({
                model: "gpt-5.6",
                instructions: instructions,
                input: command
            });

        const reply =
            response.output_text.trim();


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

        console.error("========== OPENAI ERROR ==========");
        console.error(error);
        console.error("===================================");

        return res.status(500).json({
            reply:
                "Sorry boss, my AI brain is temporarily unavailable."
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

app.listen(3000, () => {

    console.log("🦁 SINGAM AI IS ONLINE");
    console.log("Open http://localhost:3000");

});
