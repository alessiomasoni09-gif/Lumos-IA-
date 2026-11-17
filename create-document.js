import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from "docx";
import pptxgen from "pptxgenjs";
import ExcelJS from "exceljs";
import crypto from "node:crypto";

const SUPABASE_URL = "https://vszyugcnkwcrcdfncary.supabase.co";
const OWNER_EMAILS = ["alessiomasoni09@gmail.com", "alessiomasoni12@gmail.com"];
const FORMATS = new Set(["pdf", "docx", "pptx", "xlsx"]);

function safeFilename(value, ext) {
  const base = String(value || "Documento Lumos").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 65) || "Documento-Lumos";
  return `${base}.${ext}`;
}

async function authenticatedUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error("Sessione non valida. Accedi nuovamente con Google.");
  const user = await response.json();
  if (!user?.id) throw new Error("Non è stato possibile verificare l'account.");
  return user;
}

async function getPlan(userId) {
  const url = `${SUPABASE_URL}/rest/v1/lumos_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,current_period_end&limit=1`;
  const response = await fetch(url, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) throw new Error("Impossibile verificare il tuo abbonamento.");
  const sub = (await response.json())?.[0];
  const valid = sub && ["active", "trialing"].includes(sub.status) && (!sub.current_period_end || new Date(sub.current_period_end) > new Date());
  return valid && ["base", "premium"].includes(sub.plan) ? sub.plan : "free";
}

async function rpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error(`Supabase RPC ${name}:`, response.status, detail);
    throw new Error("Il sistema dei limiti di creazione non è configurato correttamente. Controlla il passaggio SQL su Supabase.");
  }
  return response.json();
}

async function generateStructuredContent(prompt, format) {
  const instructions = `Crea il contenuto completo richiesto dall'utente per un file ${format.toUpperCase()}. Rispondi SOLO con JSON valido, senza markdown e senza blocchi code. Schema: {"title":"titolo breve","subtitle":"sottotitolo facoltativo","sections":[{"heading":"titolo sezione","paragraphs":["testo..."],"bullets":["punto..."]}],"slides":[{"title":"titolo slide","bullets":["punto..."]}],"sheets":[{"name":"Foglio1","columns":["Colonna A","Colonna B"],"rows":[["dato","dato"]]}]}. Per PDF e DOCX usa sections; per PPTX usa slides (6-10 slide se adatto); per XLSX usa sheets con dati tabellari coerenti. Per XLSX, se l'utente chiede un modello vuoto, crea intestazioni e righe vuote. Non inventare dati personali o numeri presentandoli come reali: se servono esempi, etichettali come esempi. Lingua italiana salvo richiesta diversa. Testi chiari e ben organizzati.`;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages: [{ role: "system", content: instructions }, { role: "user", content: prompt.slice(0, 7000) }],
      temperature: 0.45,
      max_completion_tokens: 5000,
      stream: false
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Groq document generation:", response.status, result);
    throw new Error("L'IA non è riuscita a preparare il documento. Riprova tra poco.");
  }
  let raw = result.choices?.[0]?.message?.content || "";
  raw = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Il contenuto generato non è valido. Riprova con una richiesta più semplice.");
  const data = JSON.parse(raw.slice(start, end + 1));
  if (!data.title) data.title = "Documento Lumos";
  if (!Array.isArray(data.sections)) data.sections = [];
  if (!Array.isArray(data.slides)) data.slides = [];
  if (!Array.isArray(data.sheets)) data.sheets = [];
  return data;
}

function textBuffer(value) { return String(value ?? ""); }
function flattenSections(data) {
  const lines = [data.title, data.subtitle || ""];
  for (const section of data.sections) {
    lines.push("", section.heading || "");
    for (const p of section.paragraphs || []) lines.push(String(p));
    for (const b of section.bullets || []) lines.push("• " + String(b));
  }
  return lines.join("\n");
}

async function makePdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 54, bufferPages: true, info: { Title: data.title, Author: "Lumos IA" } });
      const chunks = [];
      doc.on("data", c => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      doc.font("Helvetica-Bold").fontSize(22).fillColor("#30205f").text(textBuffer(data.title), { align: "left" });
      if (data.subtitle) doc.moveDown(0.5).font("Helvetica").fontSize(11).fillColor("#666666").text(textBuffer(data.subtitle));
      doc.moveDown(1.2);
      for (const section of data.sections) {
        if (section.heading) doc.moveDown(0.5).font("Helvetica-Bold").fontSize(15).fillColor("#49318a").text(textBuffer(section.heading), { keepWithNext: true });
        for (const p of section.paragraphs || []) doc.moveDown(0.35).font("Helvetica").fontSize(10.5).fillColor("#222222").text(textBuffer(p), { lineGap: 3, align: "left" });
        for (const b of section.bullets || []) doc.moveDown(0.2).font("Helvetica").fontSize(10.5).fillColor("#222222").text("•  " + textBuffer(b), { indent: 12, lineGap: 2 });
      }
      if (!data.sections.length) doc.font("Helvetica").fontSize(11).fillColor("#222222").text("Contenuto non disponibile.");
      doc.end();
    } catch (e) { reject(e); }
  });
}

async function makeDocx(data) {
  const children = [new Paragraph({ text: textBuffer(data.title), heading: HeadingLevel.TITLE })];
  if (data.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: textBuffer(data.subtitle), italics: true, color: "666666" })] }));
  for (const section of data.sections) {
    if (section.heading) children.push(new Paragraph({ text: textBuffer(section.heading), heading: HeadingLevel.HEADING_1, spacing: { before: 260, after: 100 } }));
    for (const p of section.paragraphs || []) children.push(new Paragraph({ text: textBuffer(p), spacing: { after: 140, line: 300 } }));
    for (const b of section.bullets || []) children.push(new Paragraph({ text: textBuffer(b), bullet: { indent: 360 }, spacing: { after: 80 } }));
  }
  if (children.length === 1) children.push(new Paragraph("Contenuto non disponibile."));
  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function makePptx(data) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Lumos IA";
  pptx.subject = "Presentazione creata con Lumos IA";
  pptx.title = textBuffer(data.title);
  const slides = data.slides.length ? data.slides : data.sections.map(s => ({ title: s.heading, bullets: [...(s.paragraphs || []), ...(s.bullets || [])] }));
  const cover = pptx.addSlide();
  cover.background = { color: "080D2B" };
  cover.addText(textBuffer(data.title), { x: 0.7, y: 1.8, w: 11, h: 1.2, fontFace: "Aptos Display", fontSize: 30, bold: true, color: "FFFFFF", margin: 0.1, breakLine: false });
  if (data.subtitle) cover.addText(textBuffer(data.subtitle), { x: 0.75, y: 3.1, w: 10.5, h: 0.8, fontSize: 17, color: "B9B5E8", margin: 0.05 });
  for (const item of slides.slice(0, 24)) {
    const slide = pptx.addSlide();
    slide.background = { color: "F7F8FF" };
    slide.addText(textBuffer(item.title || "Punti principali"), { x: 0.55, y: 0.45, w: 12.1, h: 0.65, fontSize: 25, bold: true, color: "30205F", margin: 0.04 });
    const bullets = (item.bullets || []).slice(0, 9).map(t => ({ text: textBuffer(t), options: { bullet: { indent: 18 }, hanging: 4, breakLine: true } }));
    if (bullets.length) slide.addText(bullets, { x: 0.85, y: 1.45, w: 11.5, h: 5.1, fontSize: 18, color: "20233A", paraSpaceAfterPt: 15, breakLine: false, valign: "mid", margin: 0.1, fit: "shrink" });
  }
  return pptx.write({ outputType: "nodebuffer" });
}

async function makeXlsx(data) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Lumos IA";
  workbook.created = new Date();
  const sheets = data.sheets.length ? data.sheets : [{ name: "Dati", columns: ["Contenuto"], rows: data.sections.flatMap(s => [[s.heading || ""], ...(s.paragraphs || []).map(p => [p]), ...(s.bullets || []).map(b => [b])]) }];
  for (const [index, source] of sheets.slice(0, 10).entries()) {
    const name = String(source.name || `Foglio${index + 1}`).replace(/[\\/*?:\[\]]/g, " ").slice(0, 31) || `Foglio${index + 1}`;
    const sheet = workbook.addWorksheet(name);
    const columns = Array.isArray(source.columns) && source.columns.length ? source.columns : ["Colonna 1"];
    sheet.addRow(columns.map(textBuffer));
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF49318A" } };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of (source.rows || []).slice(0, 500)) sheet.addRow(Array.isArray(row) ? row.slice(0, 30).map(v => (typeof v === "number" ? v : textBuffer(v))) : [textBuffer(row)]);
    sheet.columns.forEach((col, i) => { col.width = Math.min(42, Math.max(14, String(columns[i] || "").length + 5)); });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return workbook.xlsx.writeBuffer();
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Metodo non consentito." }); }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.GROQ_API_KEY) return res.status(500).json({ error: "Configurazione del server incompleta." });

  let reservationId = null;
  let userId = null;
  try {
    const user = await authenticatedUser(req);
    if (!user) return res.status(401).json({ error: "Accedi con Google per creare documenti." });
    userId = user.id;
    const body = req.body || {};
    const format = String(body.format || "").toLowerCase();
    const prompt = String(body.prompt || "").trim();
    if (!FORMATS.has(format)) return res.status(400).json({ error: "Formato non supportato. Scegli PDF, Word, PowerPoint o Excel." });
    if (prompt.length < 5) return res.status(400).json({ error: "Scrivi una richiesta più dettagliata (almeno 5 caratteri)." });
    if (prompt.length > 7000) return res.status(400).json({ error: "La richiesta è troppo lunga. Massimo 7.000 caratteri." });

    const owner = OWNER_EMAILS.includes(String(user.email || "").toLowerCase().trim());
    const plan = owner ? "premium" : await getPlan(user.id);
    let quota = { used: 0, limit: "illimitato", remaining: "illimitato", reset_at: null };
    if (!owner) {
      const reserved = await rpc("reserve_lumos_creation", { p_user_id: user.id, p_plan: plan, p_request_id: crypto.randomUUID() });
      if (!reserved?.allowed) {
        return res.status(429).json({ error: `Hai raggiunto il limite di ${reserved.limit} creazioni nelle ultime 24 ore del piano ${plan.toUpperCase()}. Potrai creare un nuovo file dopo il rinnovo indicato.`, plan, quota: reserved });
      }
      reservationId = reserved.request_id;
      quota = reserved;
    }

    const data = await generateStructuredContent(prompt, format);
    let output;
    if (format === "pdf") output = await makePdf(data);
    else if (format === "docx") output = await makeDocx(data);
    else if (format === "pptx") output = await makePptx(data);
    else output = await makeXlsx(data);

    const ext = format;
    const filename = safeFilename(data.title, ext);
    res.setHeader("Content-Type", ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Lumos-Plan", plan);
    res.setHeader("X-Lumos-Creations-Remaining", String(quota.remaining));
    res.setHeader("X-Lumos-Creations-Limit", String(quota.limit));
    res.setHeader("X-Lumos-Creations-Used", String(quota.used));
    return res.status(200).send(Buffer.from(output));
  } catch (error) {
    if (reservationId && userId) {
      try { await rpc("release_lumos_creation", { p_user_id: userId, p_request_id: reservationId }); }
      catch (releaseError) { console.error("Impossibile rilasciare la creazione:", releaseError); }
    }
    console.error("Errore creazione Lumos:", error);
    return res.status(400).json({ error: error.message || "Errore durante la creazione del file." });
  }
}
