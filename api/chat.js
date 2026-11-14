
const SYSTEM_PROMPT = `Sei Lumos IA, un assistente virtuale cordiale, chiaro e competente.
Rispondi in italiano salvo richiesta diversa.
Spiega in modo semplice quando l'utente è uno studente.
Per domande complesse, organizza la risposta in sezioni brevi e fai esempi quando aiutano.
Se non conosci una risposta, dillo chiaramente e non inventare fatti.
Mantieni il contesto della conversazione.
Fornisci direttamente la risposta utile, senza mostrare ragionamenti interni.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Metodo non consentito."
    });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({
      error: "Manca la chiave API sul server."
    });
  }

  try {
    const body = req.body || {};

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      body.messages.length > 12
    ) {
      return res.status(400).json({
        error: "Conversazione non valida."
      });
    }

    const messages = body.messages.map((m) => {
      if (
        !m ||
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string"
      ) {
        throw new Error("Messaggio non valido.");
      }

      return {
        role: m.role,
        content: m.content.slice(0, 4000)
      };
    });

    if (messages[messages.length - 1].role !== "user") {
      return res.status(400).json({
        error: "L'ultimo messaggio deve essere dell'utente."
      });
    }

    const upstream = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages
          ],
          temperature: 0.6,
          max_completion_tokens: 2048,
          reasoning_effort: "low",
          include_reasoning: false,
          stream: false
        })
      }
    );

    let result;

    try {
      result = await upstream.json();
    } catch {
      console.error("Risposta Groq non valida:", upstream.status);

      return res.status(502).json({
        error: "Il servizio IA ha restituito una risposta non valida. Riprova."
      });
    }

    if (!upstream.ok) {
      console.error("Errore Groq:", upstream.status, result);

      return res.status(502).json({
        error: "Il servizio IA non ha risposto correttamente. Riprova."
      });
    }

    const choice = result.choices?.[0];

    const reply =
      typeof choice?.message?.content === "string"
        ? choice.message.content.trim()
        : "";

    if (!reply) {
      console.error(
        "Risposta vuota. Finish reason:",
        choice?.finish_reason
      );

      return res.status(502).json({
        error: choice?.finish_reason === "length"
          ? "La risposta era troppo lunga. Dividi la domanda in parti."
          : "L'IA non ha generato una risposta. Riprova."
      });
    }

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Errore Lumos IA:", error);

    return res.status(500).json({
      error: "Errore interno. Riprova."
    });
  }
}
