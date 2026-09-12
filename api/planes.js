export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const response = await fetch(
      'https://api.adsb.lol/v2/point/46.7/2.4/250',
      {
        headers: {
          'User-Agent': 'AIRWATCH-veille/1.0'
        }
      }
     );

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Erreur API ADS-B : HTTP ${response.status}`
      });
    }

    const data = await response.json();

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json(data);
  } catch (error) {
    console.error('Erreur proxy ADS-B:', error);

    return res.status(500).json({
      error: 'Impossible de récupérer les données ADS-B'
    });
  }
}
