const Parser = require('rss-parser');
const { OpenAI } = require('openai');
const fs = require('fs');

const parser = new Parser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AirwatchBot/1.0)' }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RSS_FEEDS = [
  'https://www.air-journal.fr/feed',
  'https://www.flightglobal.com/rss/news',
  'https://www.aerotime.aero/feed'
];

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
          content: item.contentSnippet || item.content || ''
        });
      });
    } catch (e) {
      console.error(`Erreur sur le flux ${url}:`, e.message);
    }
  }

  console.log(`${articles.length} articles récupérés au total.`);

  if (articles.length === 0) {
    throw new Error("Aucun article récupéré depuis les flux RSS — arrêt.");
  }

  console.log("Envoi à l'IA...");

  const prompt = `
Voici une liste d'articles d'actualité aéronautique récents :
${JSON.stringify(articles, null, 2)}

Analyse ces articles et sélectionne les 8-10 actualités les plus pertinentes pour un média de veille aéronautique.
Pour chaque article retenu, retourne un objet respectant strictement la structure suivante :
- cat : l'un des choix parmi ["securite", "technique", "meteo", "innovation", "industrie", "formation", "passager"]
- label : la catégorie en majuscules (ex: "SÉCURITÉ", "INNOVATION")
- fresh : une mention de temporalité (ex: "< 24 H · FLASH" ou "RÉCENT")
- title : titre court et percutant en français
- city : lieu principal ou zone géographique + date courte (ex: "France · 9 sept.")
- copy : résumé clair et pédagogique de 2 phrases maximum en français
- src : le média d'origine
- url : le lien vers l'article d'origine
- img : une URL d'image valide liée à l'article ou une image générique d'aviation

Réponds UNIQUEMENT avec un objet JSON de cette forme exacte : {"items": [ {...}, {...} ]}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: "json_object" }
  });

  const rawContent = response.choices[0].message.content;
  console.log("Réponse brute de l'IA :", rawContent);

  const output = JSON.parse(rawContent);
  const newItems = output.items || [];

  console.log(`${newItems.length} actualités extraites de la réponse IA.`);

  if (newItems.length > 0) {
    fs.writeFileSync('./items.json', JSON.stringify(newItems, null, 2));
    console.log("Fichier items.json mis à jour avec succès !");
  } else {
    throw new Error("Aucun article généré par l'IA — vérifier le format de la réponse ci-dessus.");
  }
}

run().catch(err => {
  console.error("Échec du script de veille :", err);
  process.exit(1);
});