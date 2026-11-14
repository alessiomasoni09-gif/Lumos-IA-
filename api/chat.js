const SYSTEM_PROMPT = `Sei Lumos IA, un assistente virtuale cordiale, chiaro e competente. Rispondi in italiano salvo richiesta diversa. Spiega in modo semplice quando l'utente è uno studente. Se non conosci una risposta, dillo chiaramente e non inventare fatti. Mantieni il contesto della conversazione.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo non consentito." });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "Il servizio IA non è ancora configurato: manca la chiave API sul server." });
  }

  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 12) {
      return res.status(400).json({ error: "Conversazione non valida." });
    }

    const messages = body.messages.map((m) => {
      if (!m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string") {
        throw new Error("Messaggio non valido.");
      }
      return { role: m.role, content: m.content.slice(0, 4000) };
    });

    if (messages[messages.length - 1].role !== "user") {
      return res.status(400).json({ error: "L'ultimo messaggio deve essere dell'utente." });
    }

    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
        temperature: 0.7,
        max_completion_tokens: 900
      })
    });

    const result = await upstream.json();
    if (!upstream.ok) {
      console.error("Groq API error:", result);
      return res.status(502).json({ error: "Il servizio IA non ha risposto. Riprova tra poco." });
    }

    const reply = result.choices?.[0]?.message?.content;
    if (!reply) return res.status(502).json({ error: "La risposta dell'IA era vuota." });
    return res.status(200).json({ reply });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Errore interno. Riprova." });
  }
}
