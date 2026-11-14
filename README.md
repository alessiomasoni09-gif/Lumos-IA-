# Lumos IA

Chatbot in italiano con interfaccia web e API server-side. La chiave Groq non viene inserita nel browser.

## Requisiti
- Account Groq per creare una API key: https://console.groq.com/keys
- Account GitHub: https://github.com
- Account Vercel: https://vercel.com

## Pubblicazione (gratis per progetto personale)
1. Estrai lo ZIP.
2. Crea un nuovo repository GitHub e carica tutti i file e la cartella `api`.
3. Su Vercel scegli **Add New → Project** e importa il repository GitHub.
4. Nelle impostazioni del progetto, in **Environment Variables**, aggiungi:
   - Nome: `GROQ_API_KEY`
   - Valore: la chiave creata su Groq
5. Facoltativo: aggiungi `GROQ_MODEL` con valore `openai/gpt-oss-20b`.
6. Avvia il deploy. Vercel ti darà un indirizzo pubblico `*.vercel.app`.

## Prova in locale (facoltativa)
Installa Node.js, poi nel progetto esegui:
```bash
npm install -g vercel
vercel dev
```
Crea `.env.local` con:
```env
GROQ_API_KEY=incolla_qui_la_tua_chiave
```

## Importante
- Non inserire mai la chiave API in `index.html`, nel repository GitHub o in messaggi pubblici.
- L'accesso al modello dipende dai limiti, dalla disponibilità e dalle condizioni dell'account Groq; il piano gratuito può avere limiti e cambiare.
- Il piano Vercel Hobby è gratuito per progetti personali e soggetto ai limiti e alle condizioni di Vercel.
- Prima di condividere pubblicamente il sito, valuta limiti di utilizzo e protezioni anti-abuso: chiunque abbia il link può usare l'endpoint e consumare la quota API.
