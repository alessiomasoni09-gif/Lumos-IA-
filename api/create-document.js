import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun, AlignmentType } from "docx";
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
  const instructions = `Sei il direttore creativo e redattore di Lumos IA. Crea un contenuto completo, accurato e visivamente progettato per un file ${format.toUpperCase()}. Rispondi SOLO con JSON valido, senza markdown. Schema: {"title":"titolo","subtitle":"sottotitolo","sections":[{"heading":"titolo","paragraphs":["testo"],"bullets":["punto"],"imageQuery":"query precisa per una fotografia pertinente"}],"slides":[{"title":"titolo","subtitle":"sottotitolo breve","bullets":["punto"],"imageQuery":"query fotografica specifica","layout":"hero|split|editorial|data"}],"sheets":[{"name":"Foglio1","columns":["Colonna A"],"rows":[["dato"]]}]}. REGOLE: PDF e DOCX: crea sezioni ben sviluppate e indica imageQuery per ogni sezione importante. PPTX: crea 6-10 slide quando appropriato, ognuna con una sola idea centrale, massimo 3-4 punti brevi, imageQuery specifica e pertinente (non generica), layout alternati tra hero, split, editorial e data. La copertina è generata dal sistema. XLSX: crea fogli con dati coerenti, intestazioni chiare e righe utili; non aggiungere dati inventati come reali. Se l'utente chiede un modello vuoto, lascia le righe vuote. Non ripetere lo stesso contenuto. Lingua italiana salvo richiesta diversa.`;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages: [{ role: "system", content: instructions }, { role: "user", content: prompt.slice(0, 7000) }],
      temperature: 0.5, max_completion_tokens: 6500, stream: false
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { console.error("Groq document generation:", response.status, result); throw new Error("L'IA non è riuscita a preparare il documento. Riprova tra poco."); }
  let raw = (result.choices?.[0]?.message?.content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Il contenuto generato non è valido. Riprova con una richiesta più semplice.");
  const data = JSON.parse(raw.slice(start, end + 1));
  if (!data.title) data.title = "Documento Lumos";
  if (!Array.isArray(data.sections)) data.sections = [];
  if (!Array.isArray(data.slides)) data.slides = [];
  if (!Array.isArray(data.sheets)) data.sheets = [];
  return data;
}

async function searchVisual(query) {
  if (!process.env.TAVILY_API_KEY || !query) return null;
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: String(query).slice(0, 300), search_depth: "basic", topic: "general", max_results: 5, include_images: true, include_image_descriptions: true }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) { console.warn("Ricerca immagini Tavily non disponibile:", response.status); return null; }
    const data = await response.json();
    const images = Array.isArray(data.images) ? data.images : [];
    for (const item of images) {
      const url = typeof item === "string" ? item : item?.url;
      const image = await downloadVisual(url);
      if (image) return { ...image, description: typeof item === "object" ? String(item.description || "") : "" };
    }
  } catch (error) { console.warn("Ricerca immagine saltata:", error.message); }
  return null;
}

async function downloadVisual(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (!["https:", "http:"].includes(url.protocol) || !url.hostname || ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname)) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(9000), redirect: "follow", headers: { "User-Agent": "LumosIA/1.0" } });
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!["image/jpeg", "image/png"].includes(type)) return null;
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 5 * 1024 * 1024) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) return null;
    const isPng = type === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const isJpg = type === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) return null;
    return { buffer: bytes, extension: isPng ? "png" : "jpg", mimeType: type };
  } catch { return null; }
}

async function addVisuals(data, format) {
  if (format === "pptx") {
    const targets = [{ query: `${data.title} ${data.subtitle || ""} cinematic editorial photography wide landscape` }, ...data.slides.slice(0, 10).map(item => ({ query: item.imageQuery || `${item.title} ${data.title} realistic editorial photography` }))];
    const results = await Promise.all(targets.map(x => searchVisual(x.query)));
    data.coverVisual = results[0] || null;
    data.slides.forEach((item, index) => { item.visual = results[index + 1] || null; });
  } else if (format === "xlsx") {
    const targets = data.sheets.slice(0, 6).map(item => ({ query: item.imageQuery || `${item.name} ${data.title} professional data dashboard illustration` }));
    const results = await Promise.all(targets.map(x => searchVisual(x.query)));
    data.sheets.forEach((item, index) => { item.visual = results[index] || null; });
  } else {
    const targets = [{ query: `${data.title} ${data.subtitle || ""} elegant editorial cover photography` }, ...data.sections.slice(0, 8).map(item => ({ query: item.imageQuery || `${item.heading} ${data.title} realistic editorial photography` }))];
    const results = await Promise.all(targets.map(x => searchVisual(x.query)));
    data.coverVisual = results[0] || null;
    data.sections.forEach((item, index) => { item.visual = results[index + 1] || null; });
  }
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
      const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: data.title, Author: "Lumos IA" } });
      const chunks = []; doc.on("data", c => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
      doc.rect(0, 0, 595.28, 842).fill("#081225");
      if (data.coverVisual?.buffer) { try { doc.image(data.coverVisual.buffer, 0, 0, { width: 595.28, height: 330, cover: [595.28, 330] }); } catch {} }
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(29).text(textBuffer(data.title), 48, 365, { width: 495 });
      if (data.subtitle) doc.moveDown(0.7).font("Helvetica").fontSize(13).fillColor("#B8C7DD").text(textBuffer(data.subtitle), { width: 490 });
      doc.fontSize(8).fillColor("#91A7C5").text("LUMOS IA  /  DOCUMENTO EDITION", 48, 790);
      for (const [index, section] of data.sections.entries()) {
        doc.addPage({ margin: 48 });
        doc.fillColor("#5B75A5").font("Helvetica-Bold").fontSize(9).text(`CAPITOLO ${(index + 1).toString().padStart(2, "0")}`, { characterSpacing: 1.5 });
        doc.moveDown(0.35).fillColor("#13233D").fontSize(22).text(textBuffer(section.heading || "Approfondimento"), { width: 495 });
        if (section.visual?.buffer) { try { doc.moveDown(0.8).image(section.visual.buffer, 48, doc.y, { fit: [499, 245], align: "center" }); doc.moveDown(0.8); } catch {} }
        for (const p of section.paragraphs || []) doc.moveDown(0.45).font("Helvetica").fontSize(10.5).fillColor("#344258").text(textBuffer(p), { lineGap: 4, width: 495 });
        for (const b of section.bullets || []) doc.moveDown(0.25).font("Helvetica").fontSize(10.5).fillColor("#24344C").text("•  " + textBuffer(b), { indent: 12, lineGap: 3, width: 480 });
        doc.fontSize(8).fillColor("#8291A8").text(`LUMOS IA     /     ${index + 1}`, 48, 800, { lineBreak: false });
      }
      if (!data.sections.length) doc.addPage().font("Helvetica").fontSize(11).fillColor("#222222").text("Contenuto non disponibile.");
      doc.end();
    } catch (e) { reject(e); }
  });
}

async function makeDocx(data) {
  const children = [new Paragraph({ text: textBuffer(data.title), heading: HeadingLevel.TITLE, spacing: { after: 180 } })];
  if (data.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: textBuffer(data.subtitle), italics: true, color: "64748B", size: 24 })], spacing: { after: 300 } }));
  if (data.coverVisual?.buffer) { try { children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: data.coverVisual.buffer, transformation: { width: 520, height: 280 }, type: data.coverVisual.extension })], spacing: { after: 260 } })); } catch {} }
  for (const section of data.sections) {
    if (section.heading) children.push(new Paragraph({ text: textBuffer(section.heading), heading: HeadingLevel.HEADING_1, spacing: { before: 340, after: 140 }, keepNext: true }));
    if (section.visual?.buffer) {
      try { children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: section.visual.buffer, transformation: { width: 520, height: 280 }, type: section.visual.extension })], spacing: { after: 180 } })); } catch {}
    }
    for (const p of section.paragraphs || []) children.push(new Paragraph({ text: textBuffer(p), spacing: { after: 160, line: 320 } }));
    for (const b of section.bullets || []) children.push(new Paragraph({ text: textBuffer(b), bullet: { indent: 360 }, spacing: { after: 100 } }));
  }
  if (children.length === 1) children.push(new Paragraph("Contenuto non disponibile."));
  const doc = new Document({ creator: "Lumos IA", title: textBuffer(data.title), styles: { default: { document: { run: { font: "Aptos", size: 22, color: "25334A" } } } }, sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

async function makePptx(data) {
  const pptx = new pptxgen(); pptx.layout = "LAYOUT_WIDE"; pptx.author = "Lumos IA"; pptx.subject = "Presentazione creata con Lumos IA"; pptx.title = textBuffer(data.title);
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "it-IT" };
  const slides = data.slides.length ? data.slides : data.sections.map(s => ({ title: s.heading, bullets: [...(s.paragraphs || []), ...(s.bullets || [])], visual: s.visual }));
  const W = 13.333, H = 7.5;
  const cover = pptx.addSlide(); cover.background = { color: "071225" };
  if (data.coverVisual?.buffer) { try { cover.addImage({ data: `image/${data.coverVisual.extension};base64,${data.coverVisual.buffer.toString("base64")}`, x: 0, y: 0, w: W, h: H, transparency: 18 }); } catch {} }
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: "061225", transparency: data.coverVisual ? 32 : 0 }, line: { color: "061225", transparency: 100 } });
  cover.addText("LUMOS IA  /  CINEMATIC EDITION", { x: 0.75, y: 0.72, w: 7, h: 0.3, fontFace: "Aptos", fontSize: 10, charSpacing: 2, color: "B9C9E2", bold: true, margin: 0 });
  cover.addText(textBuffer(data.title), { x: 0.75, y: 2.05, w: 11.6, h: 1.25, fontFace: "Aptos Display", fontSize: 34, bold: true, color: "FFFFFF", margin: 0, breakLine: false, fit: "shrink" });
  if (data.subtitle) cover.addText(textBuffer(data.subtitle), { x: 0.8, y: 3.48, w: 10.8, h: 0.7, fontSize: 18, color: "D5E0EF", margin: 0 });
  cover.addText("CREATO CON LUMOS IA", { x: 0.8, y: 6.82, w: 5, h: 0.25, fontSize: 9, charSpacing: 1.5, color: "A7B8D0", margin: 0 });
  for (const [index, item] of slides.slice(0, 24).entries()) {
    const slide = pptx.addSlide(); slide.background = { color: "071225" };
    const image = item.visual?.buffer;
    const layout = ["hero", "split", "editorial", "data"].includes(item.layout) ? item.layout : ["hero", "split", "editorial", "data"][index % 4];
    if (image) {
      const img = { data: `image/${item.visual.extension};base64,${image.toString("base64")}` };
      if (layout === "hero") {
        slide.addImage({ ...img, x: 5.3, y: 0, w: 8.033, h: 7.5, transparency: 4 });
        slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 7.2, h: 7.5, fill: { color: "071225", transparency: 4 }, line: { transparency: 100 } });
        slide.addShape(pptx.ShapeType.rect, { x: 4.7, y: 0, w: 2.0, h: 7.5, fill: { color: "071225", transparency: 40 }, line: { transparency: 100 } });
      } else if (layout === "editorial") {
        slide.addImage({ ...img, x: 0, y: 0, w: 6.0, h: 7.5 });
      } else {
        slide.addImage({ ...img, x: 7.0, y: 0.75, w: 5.75, h: 5.95 });
      }
    }
    const textX = layout === "editorial" && image ? 6.55 : 0.78;
    const textW = layout === "editorial" && image ? 5.95 : (image && layout === "split" ? 5.7 : 6.2);
    slide.addText(`CAPITOLO ${(index + 1).toString().padStart(2, "0")}`, { x: textX, y: 0.65, w: textW, h: 0.25, fontSize: 9, charSpacing: 2, color: "91A9CA", bold: true, margin: 0 });
    slide.addText(textBuffer(item.title || "Punti principali"), { x: textX, y: 1.18, w: textW, h: 1.1, fontFace: "Aptos Display", fontSize: 27, bold: true, color: "FFFFFF", margin: 0, fit: "shrink" });
    if (item.subtitle) slide.addText(textBuffer(item.subtitle), { x: textX, y: 2.32, w: textW, h: 0.55, fontSize: 13, color: "AFC2DC", margin: 0 });
    const bullets = (item.bullets || []).slice(0, 5);
    if (bullets.length) slide.addText(bullets.map(t => ({ text: textBuffer(t), options: { bullet: { indent: 13 }, hanging: 4, breakLine: true } })), { x: textX + 0.05, y: item.subtitle ? 3.05 : 2.72, w: textW - 0.15, h: 3.35, fontSize: 16, color: "E8EEF7", paraSpaceAfterPt: 17, breakLine: false, valign: "top", margin: 0.08, fit: "shrink" });
    slide.addText(`LUMOS IA     /     ${String(index + 1).padStart(2, "0")}  —  ${String(slides.length).padStart(2, "0")}`, { x: 0.78, y: 7.08, w: 5.8, h: 0.18, fontSize: 8, charSpacing: 1, color: "8FA2BD", margin: 0 });
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
    sheet.getRow(1).height = 26;
    sheet.eachRow((row, rowNumber) => { if (rowNumber > 1 && rowNumber % 2 === 0) row.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5FA" } }; }); });
    if (source.visual?.buffer) {
      const imageId = workbook.addImage({ buffer: source.visual.buffer, extension: source.visual.extension });
      sheet.addImage(imageId, { tl: { col: 0, row: (source.rows || []).length + 3 }, ext: { width: 420, height: 220 } });
    }
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
    await addVisuals(data, format);
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
