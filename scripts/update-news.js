const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

// customFields permet à rss-parser de remonter les balises media:content /
// media:thumbnail que le parseur n'expose pas par défaut, en plus de
// l'"enclosure" déjà gérée nativement.
const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AirwatchBot/1.0)' },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }]
    ]
  }
});
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RSS_FEEDS = [
  'https://www.air-journal.fr/feed',
  'https://www.flightglobal.com/rss/news',
  'https://www.aerotime.aero/feed'
];

// Images de secours fiables (Wikimedia Commons, liens stables) utilisées
// quand aucune image exploitable n'a été trouvée dans le flux RSS.
// L'IA ne choisit JAMAIS elle-même une image : elle ne fait que reprendre
// l'URL réelle qu'on lui fournit, ou "" si on n'en a pas trouvé.
const FALLBACK_IMAGES = {
  securite: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Air_Traffic_Control_Tower.jpg/800px-Air_Traffic_Control_Tower.jpg',
  technique: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Airplane_engine.jpg/800px-Airplane_engine.jpg',
  meteo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Cumulonimbus_cloud.jpg/800px-Cumulonimbus_cloud.jpg',
  innovation: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/94/Airbus_A350-900_MSN_002_F-WWCF.jpg/800px-Airbus_A350-900_MSN_002_F-WWCF.jpg',
  industrie: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Airbus_A320neo_%28cropped%29.jpg/800px-Airbus_A320neo_%28cropped%29.jpg',
  formation: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Cockpit_training.jpg/800px-Cockpit_training.jpg',
  passager: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Airport_departure_hall.jpg/800px-Airport_departure_hall.jpg',
  default: 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Aircraft_in_flight.jpg/800px-Aircraft_in_flight.jpg'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Essaie de récupérer une vraie image liée à l'article, dans l'ordre :
// enclosure (standard RSS) -> media:content -> media:thumbnail ->
// première balise <img> trouvée dans le contenu HTML de l'article.
function extractImage(item) {
  if (item.enclosure && item.enclosure.url && /^https?:\/\//.test(item.enclosure.url)) {
    return item.enclosure.url;
  }
  if (Array.isArray(item.mediaContent) && item.mediaContent.length > 0) {
    const url = item.mediaContent[0]?.$?.url;
    if (url) return url;
  }
  if (Array.isArray(item.mediaThumbnail) && item.mediaThumbnail.length > 0) {
    const url = item.mediaThumbnail[0]?.$?.url;
    if (url) return url;
  }
  const html = item['content:encoded'] || item.content || '';
  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (match && /^https?:\/\//.test(match[1])) {
    return match[1];
  }
  return null;
}

// Réessaie l'appel à l'API Gemini en cas d'erreur temporaire (503 = surcharge, 429 = quota)
async function generateContentWithRetry(params, maxRetries = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (e) {
      lastError = e;
      const status = e.status || (e.error && e.error.code);
      const isRetryable = status === 503 || status === 429 || status === 500;
      if (!isRetryable || attempt === maxRetries) {
        throw e;
      }
      const waitMs = 5000 * attempt; // 5s, 10s, 15s...
      console.log(`Tentative ${attempt}/${maxRetries} échouée (${status}), nouvelle tentative dans ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function run() {
  console.log("Récupération des flux RSS...");
  let articles = [];

  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      console.log(`OK — ${url} : ${feed.items.length} articles trouvés`);
      feed.items.slice(0, 5).forEach(item => {
        articles.push({
          title: item.title,
          link: item.link,
          content: item.contentSnippet || item.content || '',
          // image réelle trouvée dans le flux (ou null si aucune)
          realImage: extractImage(item)
        });
      });
    } catch (e) {
      console.error(`Erreur sur le flux ${url}:`, e.message);
    }
  }

  console.log(`${articles.length} articles récupérés au total.`);
  console.log(`${articles.filter(a => a.realImage).length} article(s) avec une image réelle détectée.`);

  if (articles.length === 0) {
    throw new Error("Aucun article récupéré depuis les flux RSS — arrêt.");
  }

  console.log("Envoi à l'IA...");

  const prompt = `
Voici une liste d'articles d'actualité aéronautique récents. Chaque article possède un champ
"realImage" qui contient soit l'URL réelle de l'image associée à l'article dans le flux RSS
d'origine, soit null si aucune image n'a été trouvée :
${JSON.stringify(articles, null, 2)}

Analyse ces articles et produis un objet JSON avec exactement 4 clés :

1. "items" : les 8-10 actualités les plus pertinentes pour un média de veille aéronautique.
   Chaque objet respecte STRICTEMENT cette structure :
   - cat : l'un des choix parmi ["securite", "technique", "meteo", "innovation", "industrie", "formation", "passager"]
   - label : la catégorie en majuscules (ex: "SÉCURITÉ", "INNOVATION")
   - fresh : une mention de temporalité (ex: "< 24 H · FLASH" ou "RÉCENT")
   - title : titre court et percutant en français
   - city : lieu principal ou zone géographique + date courte (ex: "France · 9 sept.")
   - copy : résumé clair et pédagogique de 2 phrases maximum en français
   - src : le média d'origine
   - url : le lien vers l'article d'origine
   - img : recopie EXACTEMENT la valeur du champ "realImage" de l'article correspondant, sans la modifier
     et sans en inventer une autre. Si "realImage" vaut null, mets une chaîne vide "" pour "img".

2. "lexicon" : 4 termes techniques ou mots un peu compliqués apparus dans ces actualités,
   avec pour chacun :
   - "term" : le mot ou sigle (ex: "Remise de gaz", "CBTA", "EMAS")
   - "def" : une définition pédagogique d'environ 2 phrases, en français, compréhensible par un néophyte.

3. "stat" : LE chiffre marquant de la semaine tiré de ces actualités :
   - "big" : le chiffre formaté court (ex: "+0,2%", "15", "6 M€")
   - "text" : 2 phrases maximum qui contextualisent le chiffre (source, périmètre, pourquoi il compte).

4. "sources" : 6 à 10 liens vers les sources ORIGINALES citées par ces actualités
   (communiqués officiels, régulateurs, agences de presse), avec pour chacun :
   - "label" : un libellé court en français (ex: "NATS — Incident technique, 9 sept.")
   - "url" : le lien exact de la source

IMPORTANT pour "items" : n'invente jamais d'URL d'image, ne complète jamais une image manquante
par une image générique trouvée sur Unsplash ou ailleurs. Le champ "img" doit être soit une
copie exacte de "realImage", soit une chaîne vide.

IMPORTANT pour "lexicon", "stat" et "sources" : ne reprends QUE ce qui se trouve réellement
dans les articles fournis. N'invente aucun chiffre, aucune définition, aucun lien.

Réponds UNIQUEMENT avec un objet JSON valide de la forme :
{ "items": [...], "lexicon": [...], "stat": { "big": "...", "text": "..." }, "sources": [...] }
`;

  const response = await generateContentWithRetry({
    model: 'gemini-3.6-flash',
    contents: prompt,
    config: { responseMimeType: 'application/json' }
  });

  const rawContent = response.text;
  console.log("Réponse brute de l'IA :", rawContent);

  const parsed = JSON.parse(rawContent);

  // Compatibilité : l'IA peut renvoyer directement un tableau (ancien format)
  // ou l'objet complet { items, lexicon, stat, sources } demandé.
  const newItems = Array.isArray(parsed) ? parsed : (parsed.items || []);

  console.log(`${newItems.length} actualités extraites de la réponse IA.`);

  if (!Array.isArray(newItems) || newItems.length === 0) {
    throw new Error("Aucun article généré par l'IA — vérifier le format de la réponse ci-dessus.");
  }

  // Filet de sécurité final : si l'IA a quand même renvoyé un champ "img"
  // vide, invalide, ou pointant vers un domaine non http(s), on retombe sur
  // l'image de secours fiable correspondant à la catégorie de l'article.
  const finalItems = newItems.map(it => {
    const hasValidImg = typeof it.img === 'string' && /^https?:\/\//.test(it.img.trim());
    return {
      ...it,
      img: hasValidImg ? it.img.trim() : (FALLBACK_IMAGES[it.cat] || FALLBACK_IMAGES.default)
    };
  });

  // On emballe les actualités avec la date de génération : le site affichera
  // automatiquement la date de dernière actualisation, le lexique, le chiffre
  // de la semaine et les sources.
  const payload = {
    updated: new Date().toISOString(),
    items: finalItems
  };

  // Champs éditoriaux générés par l'IA — on ne garde que ce qui est exploitable,
  // sinon le site conserve son contenu statique par défaut.
  if (Array.isArray(parsed.lexicon) && parsed.lexicon.length > 0) {
    payload.lexicon = parsed.lexicon
      .filter(t => t && typeof t.term === 'string' && typeof t.def === 'string')
      .slice(0, 6);
  }
  if (parsed.stat && typeof parsed.stat.big === 'string' && parsed.stat.big.trim() !== '') {
    payload.stat = { big: parsed.stat.big.trim(), text: String(parsed.stat.text || '') };
  }
  if (Array.isArray(parsed.sources) && parsed.sources.length > 0) {
    payload.sources = parsed.sources
      .filter(s => s && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
      .slice(0, 12);
  }

  fs.writeFileSync('./items.json', JSON.stringify(payload, null, 2));
  console.log("Fichier items.json mis à jour avec succès !");
}

run().catch(err => {
  console.error("Échec du script de veille :", err);
  process.exit(1);
});