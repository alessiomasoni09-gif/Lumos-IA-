import PDFDocument from "pdfkit";
import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, ImageRun,
  PageBreak, AlignmentType
} from "docx";
import pptxgen from "pptxgenjs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import crypto from "node:crypto";

const SUPABASE_URL = "https://vszyugcnkwcrcdfncary.supabase.co";
const OWNER_EMAILS = ["alessiomasoni09@gmail.com", "alessiomasoni12@gmail.com"];
const FORMATS = new Set(["pdf", "docx", "pptx", "xlsx"]);
const IMAGE_CACHE = new Map();
const IMAGE_TIMEOUT_MS = 7500;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function safeFilename(value, ext) {
  const base = String(value || "Documento Lumos").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 65) || "Documento-Lumos";
  return `${base}.${ext}`;
}

function plain(value, max = 1400) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
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
  const instructions = `Sei il progettista editoriale e visuale di Lumos IA. Prepara contenuti accurati, completi e già pensati per un'impaginazione di alta qualità nel formato ${format.toUpperCase()}. Rispondi SOLO con JSON valido, senza markdown. Schema: {"title":"titolo breve","subtitle":"sottotitolo","sections":[{"heading":"titolo sezione","paragraphs":["testo"],"bullets":["punto"]}],"slides":[{"title":"titolo slide","bullets":["punto breve"],"visual":"descrizione visuale"}],"sheets":[{"name":"Foglio1","columns":["Colonna A","Colonna B"],"rows":[["dato",12]]}]}. Regole: per PDF e DOCX crea 4-8 sezioni ben sviluppate, con paragrafi leggibili, elenchi e contenuti utili; per PPTX crea 7-10 slide oltre alla copertina, con massimo 4-5 punti brevi per slide, ritmo narrativo, fatti e numeri verificabili o esplicitamente indicati come esempi, e una descrizione visuale pertinente in ogni slide; per XLSX crea fogli tabellari realmente utili, intestazioni chiare e dati coerenti, usando numeri come numeri e non come testo. Se l'utente chiede un modello vuoto, crea intestazioni e righe vuote. Non inventare dati personali o statistiche reali. Non ripetere gli stessi concetti. Lingua italiana salvo richiesta diversa. Il titolo deve essere breve e adatto a una copertina cinematografica.`;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
      messages: [{ role: "system", content: instructions }, { role: "user", content: prompt.slice(0, 7000) }],
      temperature: 0.42,
      max_completion_tokens: 6500,
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
  let data;
  try { data = JSON.parse(raw.slice(start, end + 1)); }
  catch { throw new Error("L'IA ha restituito un formato non valido. Riprova."); }
  data.title = plain(data.title || "Documento Lumos", 120);
  data.subtitle = plain(data.subtitle || "", 240);
  data.sections = Array.isArray(data.sections) ? data.sections.slice(0, 12).map(s => ({
    heading: plain(s?.heading, 180),
    paragraphs: Array.isArray(s?.paragraphs) ? s.paragraphs.slice(0, 8).map(p => plain(p, 2400)).filter(Boolean) : [],
    bullets: Array.isArray(s?.bullets) ? s.bullets.slice(0, 10).map(b => plain(b, 600)).filter(Boolean) : []
  })) : [];
  data.slides = Array.isArray(data.slides) ? data.slides.slice(0, 18).map(s => ({
    title: plain(s?.title || "Punti principali", 160),
    bullets: Array.isArray(s?.bullets) ? s.bullets.slice(0, 6).map(b => plain(b, 420)).filter(Boolean) : [],
    visual: plain(s?.visual, 240)
  })) : [];
  data.sheets = Array.isArray(data.sheets) ? data.sheets.slice(0, 8).map(s => ({
    name: plain(s?.name || "Dati", 31),
    columns: Array.isArray(s?.columns) ? s.columns.slice(0, 24).map(c => plain(c, 80)) : [],
    rows: Array.isArray(s?.rows) ? s.rows.slice(0, 500).map(row => Array.isArray(row) ? row.slice(0, 24).map(v => typeof v === "number" && Number.isFinite(v) ? v : plain(v, 500)) : [plain(row, 500)]) : []
  })) : [];
  return data;
}

function decodeHtml(value) {
  return plain(String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'"), 180);
}

async function fetchWithTimeout(url, options = {}, timeout = IMAGE_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

async function findCommonsImages(query, count = 1) {
  const normalized = plain(query, 160).replace(/[|{}<>]/g, " ");
  if (!normalized) return [];
  const cacheKey = `${normalized.toLowerCase()}::${count}`;
  if (IMAGE_CACHE.has(cacheKey)) return IMAGE_CACHE.get(cacheKey);
  const task = (async () => {
    try {
      const api = new URL("https://commons.wikimedia.org/w/api.php");
      api.search = new URLSearchParams({
        action: "query", generator: "search", gsrsearch: `filetype:bitmap ${normalized}`,
        gsrnamespace: "6", gsrlimit: "8", prop: "imageinfo", iiprop: "url|mime|extmetadata",
        iiurlwidth: "1500", format: "json", origin: "*"
      }).toString();
      const searchResponse = await fetchWithTimeout(api.toString(), { headers: { "User-Agent": "LumosIA/1.0 (document image retrieval)" } });
      if (!searchResponse.ok) return [];
      const payload = await searchResponse.json();
      const pages = Object.values(payload?.query?.pages || {});
      const candidates = pages.map(page => {
        const info = page.imageinfo?.[0];
        const url = info?.thumburl || info?.url;
        const mime = info?.thumbmime || info?.mime || "";
        if (!url || !["image/jpeg", "image/png"].includes(mime)) return null;
        const meta = info.extmetadata || {};
        const author = decodeHtml(meta.Artist?.value || meta.Credit?.value || "Wikimedia Commons");
        const license = decodeHtml(meta.LicenseShortName?.value || "Licenza indicata su Wikimedia Commons");
        return { url, mime, title: plain(page.title?.replace(/^File:/, "") || "Immagine"), credit: `${author} · ${license}` };
      }).filter(Boolean).slice(0, Math.max(count * 2, count));
      const images = [];
      for (const item of candidates) {
        if (images.length >= count) break;
        try {
          const imageResponse = await fetchWithTimeout(item.url, { headers: { "User-Agent": "LumosIA/1.0" } });
          if (!imageResponse.ok) continue;
          const contentType = (imageResponse.headers.get("content-type") || item.mime).split(";")[0];
          if (!["image/jpeg", "image/png"].includes(contentType)) continue;
          const buffer = Buffer.from(await imageResponse.arrayBuffer());
          if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) continue;
          images.push({ ...item, mime: contentType, ext: contentType === "image/png" ? "png" : "jpg", buffer });
        } catch { /* Le immagini sono facoltative: il documento deve poter essere creato anche senza rete immagini. */ }
      }
      return images;
    } catch (error) {
      console.warn("Ricerca immagini Commons non disponibile:", error?.message || error);
      return [];
    }
  })();
  IMAGE_CACHE.set(cacheKey, task);
  const result = await task;
  IMAGE_CACHE.set(cacheKey, result);
  return result;
}

async function collectVisuals(data, format) {
  const topics = [];
  if (format === "pptx" && data.slides.length) {
    topics.push({ key: "cover", query: `${data.title} ${data.subtitle}` });
    data.slides.forEach((slide, index) => topics.push({ key: `slide-${index}`, query: `${slide.title} ${slide.visual || ""}` }));
  } else if (format === "xlsx") {
    topics.push({ key: "dashboard", query: `${data.title} ${data.subtitle}` });
  } else {
    topics.push({ key: "cover", query: `${data.title} ${data.subtitle}` });
    data.sections.forEach((section, index) => topics.push({ key: `section-${index}`, query: `${section.heading} ${section.paragraphs?.[0] || ""}` }));
  }
  const results = await Promise.all(topics.map(async topic => ({
    key: topic.key,
    images: await findCommonsImages(topic.query, format === "pptx" && topic.key.startsWith("slide-") ? 2 : 1)
  })));
  return Object.fromEntries(results.map(item => [item.key, item.images]));
}

function addPdfImage(doc, image, x, y, width, height) {
  if (!image) return y;
  try {
    doc.image(image.buffer, x, y, { fit: [width, height], align: "center", valign: "center" });
    return y + height;
  } catch (error) {
    console.warn("Immagine PDF ignorata:", error?.message || error);
    return y;
  }
}

async function makePdf(data, visuals) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 52, bufferPages: true, info: { Title: data.title, Author: "Lumos IA" } });
      const chunks = [];
      doc.on("data", chunk => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Copertina editoriale cinematografica.
      doc.rect(0, 0, 595.28, 841.89).fill("#080D2B");
      const cover = visuals.cover?.[0];
      if (cover) {
        doc.save(); doc.opacity(0.32);
        addPdfImage(doc, cover, 0, 80, 595.28, 430);
        doc.restore();
      }
      doc.save();
      doc.circle(520, 110, 120).fillOpacity(0.14).fill("#8B5CF6");
      doc.circle(40, 740, 180).fillOpacity(0.10).fill("#22D3EE");
      doc.restore();
      doc.roundedRect(52, 92, 125, 26, 13).fill("#6D4AFF");
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#FFFFFF").text("LUMOS IA  /  INSIGHT", 64, 100, { width: 110, align: "center" });
      doc.font("Helvetica-Bold").fontSize(30).fillColor("#FFFFFF").text(data.title, 52, 280, { width: 480, lineGap: 5 });
      if (data.subtitle) doc.moveDown(0.7).font("Helvetica").fontSize(14).fillColor("#D5D9F5").text(data.subtitle, { width: 460, lineGap: 4 });
      doc.moveTo(52, 720).lineTo(175, 720).lineWidth(3).strokeColor("#A78BFA").stroke();
      doc.font("Helvetica").fontSize(10).fillColor("#B9C2EA").text("Creato con Lumos IA", 52, 742);
      if (cover) doc.font("Helvetica").fontSize(6.5).fillColor("#AEB6D8").text(`Immagine: ${cover.title} · ${cover.credit}`, 52, 770, { width: 490 });

      doc.addPage({ margin: 52 });
      doc.rect(0, 0, 595.28, 12).fill("#6D4AFF");
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#7C69C9").text("LUMOS IA", 52, 28);
      doc.moveDown(2);
      for (const [index, section] of data.sections.entries()) {
        if (doc.y > 680) doc.addPage({ margin: 52 });
        if (section.heading) {
          doc.moveDown(0.4).font("Helvetica-Bold").fontSize(18).fillColor("#30205F").text(section.heading, { width: 490 });
          doc.moveDown(0.25).moveTo(52, doc.y).lineTo(118, doc.y).lineWidth(2.5).strokeColor("#8B5CF6").stroke();
        }
        const image = visuals[`section-${index}`]?.[0];
        if (image && doc.y < 600) {
          const y = doc.y + 12;
          const nextY = addPdfImage(doc, image, 52, y, 490, 180);
          if (nextY > y) doc.y = nextY + 8;
          doc.font("Helvetica-Oblique").fontSize(7).fillColor("#777777").text(`Immagine: ${image.title} · ${image.credit}`, { width: 490 });
        }
        for (const paragraph of section.paragraphs || []) {
          if (doc.y > 700) doc.addPage({ margin: 52 });
          doc.moveDown(0.35).font("Helvetica").fontSize(10.5).fillColor("#25263A").text(paragraph, { width: 490, lineGap: 3, align: "left" });
        }
        for (const bullet of section.bullets || []) {
          if (doc.y > 700) doc.addPage({ margin: 52 });
          doc.moveDown(0.18).font("Helvetica").fontSize(10).fillColor("#38334F").text(`•  ${bullet}`, { width: 470, indent: 12, lineGap: 2 });
        }
      }
      if (!data.sections.length) doc.font("Helvetica").fontSize(11).fillColor("#222222").text("Contenuto non disponibile.");

      const range = doc.bufferedPageRange();
      for (let i = 1; i < range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(52, 790).lineTo(543, 790).lineWidth(0.5).strokeColor("#E5E2F0").stroke();
        doc.font("Helvetica").fontSize(8).fillColor("#77718E").text("LUMOS IA  ·  Documento generato con supporto IA", 52, 800, { width: 390 });
        doc.text(`${i + 1} / ${range.count}`, 480, 800, { width: 63, align: "right" });
      }
      doc.end();
    } catch (error) { reject(error); }
  });
}

async function makeDocx(data, visuals) {
  const purple = "6D4AFF";
  const children = [
    new Paragraph({ spacing: { before: 1400, after: 260 }, children: [new TextRun({ text: "LUMOS IA  /  INSIGHT", bold: true, color: purple, size: 20, characterSpacing: 3 })] }),
    new Paragraph({ spacing: { before: 400, after: 220 }, children: [new TextRun({ text: data.title, bold: true, color: "17143A", size: 42 })] })
  ];
  if (data.subtitle) children.push(new Paragraph({ spacing: { after: 400 }, children: [new TextRun({ text: data.subtitle, italics: true, color: "6B6682", size: 24 })] }));
  if (visuals.cover?.[0]) {
    const cover = visuals.cover[0];
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 240, after: 160 }, children: [new ImageRun({ data: cover.buffer, transformation: { width: 570, height: 260 } })] }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 500 }, children: [new TextRun({ text: `Immagine: ${cover.title} · ${cover.credit}`, color: "777777", size: 14, italics: true })] }));
  }
  children.push(new Paragraph({ children: [new PageBreak()] }));
  for (const [index, section] of data.sections.entries()) {
    if (section.heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 160 }, children: [new TextRun({ text: section.heading, color: purple, bold: true })] }));
    const image = visuals[`section-${index}`]?.[0];
    if (image) {
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 60 }, children: [new ImageRun({ data: image.buffer, transformation: { width: 520, height: 220 } })] }));
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 140 }, children: [new TextRun({ text: `Immagine: ${image.title} · ${image.credit}`, color: "777777", size: 13, italics: true })] }));
    }
    for (const paragraph of section.paragraphs || []) children.push(new Paragraph({ spacing: { after: 170, line: 300 }, children: [new TextRun({ text: paragraph, color: "29283A", size: 22 })] }));
    for (const bullet of section.bullets || []) children.push(new Paragraph({ bullet: { indent: 420 }, spacing: { after: 100 }, children: [new TextRun({ text: bullet, color: "39344E", size: 21 })] }));
  }
  if (children.length <= 4) children.push(new Paragraph({ children: [new TextRun("Contenuto non disponibile.")] }));
  const doc = new Document({
    creator: "Lumos IA", title: data.title, subject: data.subtitle,
    styles: { default: { document: { run: { font: "Aptos", size: 22, color: "29283A" }, paragraph: { spacing: { after: 120 } } } } },
    sections: [{ properties: { page: { margin: { top: 900, right: 1000, bottom: 900, left: 1000 } } }, children }]
  });
  return Packer.toBuffer(doc);
}

function addGlow(slide, x, y, w, h) {
  slide.addShape("ellipse", { x, y, w, h, line: { color: "8B5CF6", transparency: 100 }, fill: { color: "8B5CF6", transparency: 76 } });
}

async function addFadeTransitions(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slidePaths = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path));
  await Promise.all(slidePaths.map(async path => {
    let xml = await zip.file(path).async("string");
    if (!xml.includes("<p:transition")) {
      const transition = '<p:transition spd="med" advClick="1"><p:fade/></p:transition>';
      if (xml.includes("</p:clrMapOvr>")) xml = xml.replace("</p:clrMapOvr>", `</p:clrMapOvr>${transition}`);
      else xml = xml.replace("</p:sld>", `${transition}</p:sld>`);
      zip.file(path, xml);
    }
  }));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function makePptx(data, visuals) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Lumos IA";
  pptx.subject = "Presentazione cinematografica creata con Lumos IA";
  pptx.title = data.title;
  pptx.company = "Lumos IA";
  pptx.lang = "it-IT";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos", lang: "it-IT" };
  const slides = data.slides.length ? data.slides : data.sections.map(section => ({ title: section.heading, bullets: [...section.paragraphs, ...section.bullets] }));

  const cover = pptx.addSlide();
  cover.background = { color: "080D2B" };
  const coverImage = visuals.cover?.[0];
  if (coverImage) cover.addImage({ data: `data:${coverImage.mime};base64,${coverImage.buffer.toString("base64")}`, x: 0, y: 0, w: 13.333, h: 7.5 });
  cover.addShape("rect", { x: 0, y: 0, w: 13.333, h: 7.5, line: { color: "080D2B", transparency: 100 }, fill: { color: "080D2B", transparency: coverImage ? 35 : 0 } });
  addGlow(cover, 9.6, -1.1, 4.4, 4.4);
  addGlow(cover, -1.4, 5.5, 4.0, 4.0);
  cover.addShape("rect", { x: 0.78, y: 1.12, w: 0.09, h: 4.95, line: { color: "A78BFA", transparency: 100 }, fill: { color: "A78BFA" } });
  cover.addText("LUMOS IA  /  CINEMATIC EDITION", { x: 1.12, y: 1.14, w: 7.2, h: 0.32, fontFace: "Aptos", fontSize: 10, bold: true, charSpacing: 2.4, color: "C4B5FD", margin: 0 });
  cover.addText(data.title, { x: 1.08, y: 2.0, w: 10.7, h: 1.85, fontFace: "Aptos Display", fontSize: 34, bold: true, color: "FFFFFF", margin: 0, breakLine: false, valign: "mid", fit: "shrink", shadow: { type: "outer", color: "000000", blur: 3, angle: 45, distance: 1, opacity: 0.35 } });
  if (data.subtitle) cover.addText(data.subtitle, { x: 1.12, y: 4.12, w: 9.8, h: 0.9, fontFace: "Aptos", fontSize: 17, color: "E3E3FF", margin: 0, breakLine: false, fit: "shrink" });
  cover.addShape("line", { x: 1.12, y: 5.52, w: 1.35, h: 0, line: { color: "A78BFA", width: 2.5 } });
  cover.addText("CREATO CON LUMOS IA", { x: 1.12, y: 5.72, w: 4.5, h: 0.28, fontSize: 9, bold: true, charSpacing: 2, color: "C4B5FD", margin: 0 });
  if (coverImage) cover.addText(`Immagine: ${coverImage.title} · ${coverImage.credit}`, { x: 1.12, y: 6.15, w: 10.8, h: 0.22, fontSize: 6.2, color: "D7D4F2", margin: 0, fit: "shrink" });

  for (const [index, item] of slides.slice(0, 18).entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: "080D2B" };
    const slideVisuals = visuals[`slide-${index}`] || [];
    const visual = slideVisuals[0];
    const secondaryVisual = slideVisuals[1];
    if (visual) slide.addImage({ data: `data:${visual.mime};base64,${visual.buffer.toString("base64")}`, x: 7.05, y: 0, w: 6.283, h: 7.5 });
    slide.addShape("rect", { x: 0, y: 0, w: 7.5, h: 7.5, line: { color: "080D2B", transparency: 100 }, fill: { color: "080D2B", transparency: 0 } });
    if (visual) slide.addShape("rect", { x: 7.05, y: 0, w: 6.283, h: 7.5, line: { color: "080D2B", transparency: 100 }, fill: { color: "080D2B", transparency: 48 } });
    addGlow(slide, 5.6, -0.9, 2.5, 2.5);
    slide.addShape("rect", { x: 0.62, y: 0.62, w: 0.07, h: 0.52, line: { color: "A78BFA", transparency: 100 }, fill: { color: "A78BFA" } });
    slide.addText(`CAPITOLO ${String(index + 1).padStart(2, "0")}`, { x: 0.86, y: 0.64, w: 3.6, h: 0.22, fontSize: 9, bold: true, charSpacing: 2, color: "B9A8FF", margin: 0 });
    slide.addText(item.title || "Punti principali", { x: 0.68, y: 1.38, w: 5.95, h: 1.12, fontFace: "Aptos Display", fontSize: 25, bold: true, color: "FFFFFF", margin: 0, fit: "shrink", valign: "mid" });
    slide.addShape("line", { x: 0.7, y: 2.62, w: 0.95, h: 0, line: { color: "8B5CF6", width: 2.5 } });
    const bullets = (item.bullets || []).slice(0, 5);
    let y = 2.95;
    for (const [bulletIndex, bullet] of bullets.entries()) {
      slide.addShape("ellipse", { x: 0.76, y: y + 0.06, w: 0.18, h: 0.18, line: { color: "A78BFA", transparency: 100 }, fill: { color: "A78BFA" } });
      slide.addText(bullet, { x: 1.12, y, w: 5.55, h: 0.62, fontFace: "Aptos", fontSize: 14, color: "E6E7FF", margin: 0, breakLine: false, fit: "shrink", valign: "mid", paraSpaceAfterPt: 4 });
      y += 0.76;
    }
    if (visual) {
      if (secondaryVisual) {
        slide.addShape("roundRect", { x: 9.45, y: 0.52, w: 3.35, h: 1.92, rectRadius: 0.08, line: { color: "D8CCFF", width: 1.2 }, fill: { color: "111638" } });
        slide.addImage({ data: `data:${secondaryVisual.mime};base64,${secondaryVisual.buffer.toString("base64")}`, x: 9.55, y: 0.62, w: 3.15, h: 1.72 });
      }
      slide.addShape("roundRect", { x: 7.5, y: 5.92, w: 5.25, h: 0.86, rectRadius: 0.08, line: { color: "A78BFA", transparency: 55, width: 0.7 }, fill: { color: "090D27", transparency: 18 } });
      slide.addText(`VISUAL: ${plain(item.visual || visual.title, 95)}`, { x: 7.75, y: 6.13, w: 4.75, h: 0.35, fontSize: 9, color: "F1EEFF", margin: 0, fit: "shrink" });
      const credits = [visual, secondaryVisual].filter(Boolean).map(img => `${img.title} · ${img.credit}`).join("  |  ");
      slide.addText(`Immagini: ${credits}`, { x: 7.5, y: 6.92, w: 5.55, h: 0.18, fontSize: 5.2, color: "E1DDF6", margin: 0, fit: "shrink" });
    } else {
      slide.addShape("ellipse", { x: 8.35, y: 1.45, w: 3.4, h: 3.4, line: { color: "8B5CF6", transparency: 30, width: 1.5 }, fill: { color: "8B5CF6", transparency: 88 } });
      slide.addShape("ellipse", { x: 9.0, y: 2.1, w: 2.1, h: 2.1, line: { color: "22D3EE", transparency: 28, width: 1.3 }, fill: { color: "22D3EE", transparency: 91 } });
    }
    slide.addText(`${String(index + 1).padStart(2, "0")}  /  ${String(slides.length).padStart(2, "0")}`, { x: 0.7, y: 7.12, w: 2.0, h: 0.16, fontSize: 7, color: "8585B5", charSpacing: 1, margin: 0 });
    slide.addText("LUMOS IA", { x: 11.45, y: 7.12, w: 1.2, h: 0.16, fontSize: 7, bold: true, color: "C4B5FD", align: "right", margin: 0 });
  }
  const raw = await pptx.write({ outputType: "nodebuffer" });
  return addFadeTransitions(Buffer.from(raw));
}

function numericColumns(source) {
  const cols = source.columns || [];
  return cols.map((name, index) => ({ name, index })).filter(col => (source.rows || []).filter(row => typeof row?.[col.index] === "number" && Number.isFinite(row[col.index])).length >= 2).slice(0, 3);
}

async function makeQuickChart(source, numeric) {
  const labels = (source.rows || []).slice(0, 14).map((row, index) => plain(row?.[0] ?? `Voce ${index + 1}`, 40));
  const datasets = numeric.map((col, index) => ({
    label: col.name,
    data: (source.rows || []).slice(0, 14).map(row => typeof row?.[col.index] === "number" ? row[col.index] : null),
    backgroundColor: ["rgba(124,92,255,0.72)", "rgba(34,211,238,0.65)", "rgba(236,72,153,0.58)"][index],
    borderColor: ["#7657F6", "#22BBD0", "#DB4D9B"][index],
    borderWidth: 2,
    fill: false,
    tension: 0.35
  }));
  const config = { type: numeric.length > 1 ? "line" : "bar", data: { labels, datasets }, options: { plugins: { legend: { display: true, position: "bottom" }, title: { display: true, text: "Panoramica dei dati", color: "#252044", font: { size: 20 } } }, scales: { x: { ticks: { color: "#514D68" }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: "#514D68" }, grid: { color: "#ECEAF4" } } } } };
  try {
    const url = `https://quickchart.io/chart?width=1100&height=560&format=png&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(config))}`;
    const response = await fetchWithTimeout(url, {}, 9000);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
    return buffer;
  } catch { return null; }
}

async function makeXlsx(data, visuals) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Lumos IA";
  workbook.created = new Date();
  workbook.subject = "Dashboard e dati creati con Lumos IA";
  workbook.views = [{ x: 0, y: 0, width: 18000, height: 10000 }];
  const sourceSheets = data.sheets.length ? data.sheets : [{ name: "Dati", columns: ["Contenuto"], rows: data.sections.flatMap(section => [[section.heading], ...(section.paragraphs || []).map(p => [p]), ...(section.bullets || []).map(b => [b])]) }];

  const dashboard = workbook.addWorksheet("Dashboard", { properties: { tabColor: { argb: "FF7657F6" } }, views: [{ showGridLines: false }] });
  dashboard.mergeCells("A1:H2");
  dashboard.getCell("A1").value = data.title;
  dashboard.getCell("A1").font = { name: "Aptos Display", size: 22, bold: true, color: { argb: "FFFFFFFF" } };
  dashboard.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
  dashboard.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111638" } };
  for (let row = 1; row <= 2; row++) for (let col = 1; col <= 8; col++) dashboard.getCell(row, col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111638" } };
  dashboard.mergeCells("A3:H3");
  dashboard.getCell("A3").value = data.subtitle || "Dashboard riepilogativa · Lumos IA";
  dashboard.getCell("A3").font = { size: 11, italic: true, color: { argb: "FF645C84" } };
  dashboard.getRow(4).height = 12;
  const totalRows = sourceSheets.reduce((sum, sheet) => sum + (sheet.rows?.length || 0), 0);
  const totalColumns = sourceSheets.reduce((sum, sheet) => sum + (sheet.columns?.length || 0), 0);
  const metrics = [{ label: "FOGLI", value: sourceSheets.length }, { label: "RIGHE DATI", value: totalRows }, { label: "COLONNE", value: totalColumns }];
  const metricRanges = [["A5:B5", "A6:B7"], ["D5:E5", "D6:E7"], ["G5:H5", "G6:H7"]];
  metrics.forEach((metric, index) => {
    const [labelRange, valueRange] = metricRanges[index];
    dashboard.mergeCells(labelRange); dashboard.mergeCells(valueRange);
    const labelCell = dashboard.getCell(labelRange.split(":")[0]);
    const valueCell = dashboard.getCell(valueRange.split(":")[0]);
    labelCell.value = metric.label; labelCell.font = { bold: true, size: 9, color: { argb: "FF7A6CA8" } };
    valueCell.value = metric.value; valueCell.font = { bold: true, size: 22, color: { argb: "FF30205F" } };
    for (const range of [labelRange, valueRange]) {
      const [start, end] = range.split(":");
      const a = dashboard.getCell(start), b = dashboard.getCell(end);
      for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) dashboard.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2EFFF" } };
    }
  });
  dashboard.mergeCells("A9:H9");
  dashboard.getCell("A9").value = "VISUALIZZAZIONE DEI DATI";
  dashboard.getCell("A9").font = { bold: true, size: 12, color: { argb: "FF30205F" } };
  dashboard.getCell("A9").border = { bottom: { style: "medium", color: { argb: "FF8B5CF6" } } };
  if (visuals.dashboard?.[0]) {
    const dashboardImage = visuals.dashboard[0];
    const imageId = workbook.addImage({ buffer: dashboardImage.buffer, extension: dashboardImage.ext });
    dashboard.addImage(imageId, { tl: { col: 0, row: 10 }, br: { col: 8, row: 25 } });
    dashboard.mergeCells("A26:H27");
    dashboard.getCell("A26").value = `Immagine: ${dashboardImage.title} · ${dashboardImage.credit}`;
    dashboard.getCell("A26").font = { italic: true, size: 8, color: { argb: "FF77718E" } };
  }
  dashboard.columns = Array.from({ length: 8 }, () => ({ width: 15 }));
  dashboard.views = [{ state: "frozen", ySplit: 4, showGridLines: false }];

  const usedNames = new Set(["dashboard"]);
  const chartJobs = [];
  for (const [index, source] of sourceSheets.entries()) {
    let name = String(source.name || `Foglio${index + 1}`).replace(/[\\/*?:\[\]]/g, " ").trim().slice(0, 31) || `Foglio${index + 1}`;
    let unique = name, suffix = 2;
    while (usedNames.has(unique.toLowerCase())) unique = `${name.slice(0, 27)} ${suffix++}`;
    usedNames.add(unique.toLowerCase());
    const sheet = workbook.addWorksheet(unique, { properties: { tabColor: { argb: index % 2 ? "FF22BBD0" : "FF7657F6" } } });
    const columns = source.columns.length ? source.columns : ["Colonna 1"];
    sheet.addRow(columns);
    const header = sheet.getRow(1);
    header.height = 30;
    header.font = { name: "Aptos", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF30205F" } };
    header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    header.border = { bottom: { style: "medium", color: { argb: "FF8B5CF6" } } };
    for (const row of source.rows || []) sheet.addRow(row.map(value => typeof value === "number" && Number.isFinite(value) ? value : plain(value, 500)));
    sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: columns.length } };
    sheet.columns.forEach((column, columnIndex) => {
      const headerLength = String(columns[columnIndex] || "").length;
      const sampleLength = Math.max(0, ...(source.rows || []).slice(0, 50).map(row => String(row?.[columnIndex] ?? "").length));
      column.width = Math.min(38, Math.max(14, headerLength + 4, sampleLength + 2));
      column.alignment = { vertical: "middle", wrapText: true };
    });
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
      const row = sheet.getRow(rowIndex);
      row.height = 23;
      if (rowIndex % 2 === 0) row.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F3FF" } }; });
      row.eachCell(cell => { if (typeof cell.value === "number") { cell.numFmt = "#,##0.00;[Red]-#,##0.00"; cell.alignment = { horizontal: "right", vertical: "middle" }; } });
    }
    const nums = numericColumns(source);
    if (nums.length) chartJobs.push({ source, nums, name });
  }

  // Grafici PNG incorporati nella dashboard, generati solo da colonne realmente numeriche.
  const charts = await Promise.all(chartJobs.slice(0, 2).map(job => makeQuickChart(job.source, job.nums)));
  charts.forEach((buffer, index) => {
    if (!buffer) return;
    const imageId = workbook.addImage({ buffer, extension: "png" });
    const startCol = index === 0 ? 0 : 4;
    const hasDashboardImage = Boolean(visuals.dashboard?.[0]);
    dashboard.addImage(imageId, { tl: { col: startCol, row: hasDashboardImage ? 28 : 10 }, br: { col: startCol + 4, row: hasDashboardImage ? 43 : 25 } });
    dashboard.getCell(hasDashboardImage ? 44 : 26, startCol + 1).value = `Grafico: ${chartJobs[index].name}`;
    dashboard.getCell(hasDashboardImage ? 44 : 26, startCol + 1).font = { italic: true, size: 9, color: { argb: "FF77718E" } };
  });
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
    const visuals = await collectVisuals(data, format);
    let output;
    if (format === "pdf") output = await makePdf(data, visuals);
    else if (format === "docx") output = await makeDocx(data, visuals);
    else if (format === "pptx") output = await makePptx(data, visuals);
    else output = await makeXlsx(data, visuals);

    const filename = safeFilename(data.title, format);
    const mimeTypes = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    };
    res.setHeader("Content-Type", mimeTypes[format]);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Lumos-Plan", plan);
    res.setHeader("X-Lumos-Creations-Remaining", String(quota.remaining));
    res.setHeader("X-Lumos-Creations-Limit", String(quota.limit));
    res.setHeader("X-Lumos-Creations-Used", String(quota.used));
    const imageCount = Object.values(visuals).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : value ? 1 : 0), 0);
    res.setHeader("X-Lumos-Images-Used", String(imageCount));
    return res.status(200).send(Buffer.from(output));
  } catch (error) {
    if (reservationId && userId) {
      try { await rpc("release_lumos_creation", { p_user_id: userId, p_request_id: reservationId }); }
      catch (releaseError) { console.error("Impossibile rilasciare la creazione:", releaseError); }
    }
    console.error("Errore creazione Lumos:", error);
    const status = /Sessione|Accedi/.test(error.message || "") ? 401 : 500;
    return res.status(status).json({ error: error.message || "Errore durante la creazione del file." });
  }
}
