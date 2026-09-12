export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const ids = 'LFPG,LFPO,LFLL,LFBO,LFML,LFRS';

  try {
    const url =
      'https://aviationweather.gov/api/data/metar?ids=' +
      ids +
      '&format=json';

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AIRWATCH-veille/1.0'
      }
    } );

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Erreur API METAR : HTTP ${response.status}`
      });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erreur proxy METAR:', error);

    return res.status(500).json({
      error: 'Impossible de récupérer les données météo'
    });
  }
}
