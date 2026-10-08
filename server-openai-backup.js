const express = require("express");
const path = require("path");
const OpenAI = require("openai");

const app = express();

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

app.use(express.json());

app.use(express.static(
    path.join(__dirname, "public")
));

app.post("/ask", async (req, res) => {

    const command = req.body.command || "";

    console.log("USER:", command);

    try {

        const response = await client.responses.create({
            model: "gpt-5-mini",
            instructions:
                "You are SINGAM, a helpful personal AI assistant. " +
                "Answer clearly and naturally. Keep answers concise " +
                "unless the user asks for detailed information.",

            input: command
        });

        const reply = response.output_text;

        console.log("SINGAM:", reply);

        res.json({
            reply: reply
        });

    } catch (error) {

        console.error("AI ERROR:", error.message);

        res.status(500).json({
            reply: "Sorry, SINGAM AI brain is currently unavailable."
        });
    }
});

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );
});

app.listen(3000, () => {

    console.log("🦁 SINGAM AI IS ONLINE");
    console.log("Open http://localhost:3000");

});
