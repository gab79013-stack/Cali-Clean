/**
 * Filtro geográfico: "San Diego y cincuenta millas a la redonda".
 *
 * Los registros públicos no traen un radio, traen una dirección. Este módulo
 * decide si esa dirección cae dentro del área de servicio, con la mejor prueba
 * que tenga a mano y en este orden:
 *
 *   1. Coordenadas en la fila  → distancia real (haversine). Es exacto.
 *   2. Ciudad reconocida       → lista de municipios del condado dentro del radio.
 *   3. Código postal del condado → rango 91901-92199 menos los lejanos.
 *
 * Si nada de eso resuelve, el prospecto queda fuera: es preferible perder un
 * prospecto bueno que escribirle a un negocio de Los Ángeles diciéndole que
 * estamos "aquí al lado".
 */

/** Centro del área de servicio: centro de San Diego. */
export const CENTER = { lat: 32.7157, lon: -117.1611 };
export const RADIUS_MILES = 50;

const norm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Municipios y comunidades del condado de San Diego dentro de las 50 millas.
 * Todas las ciudades incorporadas del condado entran salvo las del desierto y
 * la montaña, que están en FAR_PLACES.
 */
export const CITIES_WITHIN_RADIUS = new Set([
  // Las 18 ciudades incorporadas del condado
  'san diego', 'chula vista', 'oceanside', 'escondido', 'carlsbad', 'el cajon',
  'vista', 'san marcos', 'encinitas', 'national city', 'la mesa', 'santee',
  'poway', 'imperial beach', 'lemon grove', 'coronado', 'solana beach', 'del mar',
  // Comunidades no incorporadas y barrios que aparecen como "ciudad" en los registros
  'spring valley', 'la jolla', 'point loma', 'pacific beach', 'ocean beach',
  'mission valley', 'north park', 'hillcrest', 'clairemont', 'kearny mesa',
  'mira mesa', 'rancho bernardo', 'rancho penasquitos', 'scripps ranch',
  'carmel valley', 'sorrento valley', 'otay mesa', 'san ysidro', 'paradise hills',
  'bonita', 'jamul', 'alpine', 'lakeside', 'ramona', 'valley center', 'fallbrook',
  'bonsall', 'rainbow', 'cardiff by the sea', 'cardiff', 'leucadia', 'olivenhain',
  'rancho santa fe', 'julian', 'pine valley', 'campo', 'dulzura', 'potrero',
  'tecate', 'descanso', 'guatay', 'boulevard', 'san diego country estates',
  'casa de oro', 'mount helix', 'winter gardens', 'harbison canyon', 'crest',
  'granite hills', 'rancho san diego', 'eucalyptus hills', 'barona', 'lake san marcos',
  'hidden meadows', 'san luis rey', 'camp pendleton', 'oceanside harbor',
]);

/**
 * Sitios del condado que quedan fuera del radio: desierto de Anza-Borrego,
 * montaña de Palomar y la franja este hacia Imperial. Están antes que
 * cualquier otra regla porque su ZIP sí cae en el rango del condado.
 */
export const FAR_PLACES = new Set([
  'borrego springs', 'ocotillo wells', 'shelter valley', 'ranchita',
  'warner springs', 'palomar mountain', 'santa ysabel', 'pauma valley',
  'la jolla amago', 'jacumba', 'jacumba hot springs', 'mount laguna',
]);

/** ZIP del condado de San Diego que quedan fuera de las 50 millas. */
export const FAR_ZIPS = new Set([
  '92004', // Borrego Springs
  '92066', // Ranchita
  '92086', // Warner Springs
  '92060', // Palomar Mountain
  '92061', // Pauma Valley
  '92059', // Pala
  '92070', // Santa Ysabel
  '91934', // Jacumba
  '91948', // Mount Laguna
  '91905', // Boulevard
  '92004', // Anza-Borrego
]);

/** Rango de códigos postales del condado de San Diego. */
const ZIP_MIN = 91901;
const ZIP_MAX = 92199;

const toRad = (deg) => (deg * Math.PI) / 180;

/** Distancia en millas entre dos puntos. */
export function haversineMiles(a, b) {
  const R = 3958.7613; // radio terrestre en millas
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/**
 * ¿Esta dirección está dentro del área de servicio?
 * Devuelve { inside, basis, miles } — `basis` explica con qué prueba se decidió,
 * y el panel lo muestra para que un descarte nunca sea un misterio.
 */
export function withinServiceArea({ city, zip, lat, lon } = {}) {
  const place = norm(city);
  const zip5 = String(zip || '').trim().slice(0, 5);

  // 1. Lo lejano se descarta primero: su ZIP pertenece al condado y colaría.
  if (place && FAR_PLACES.has(place)) return { inside: false, basis: 'far_place', miles: null };
  if (zip5 && FAR_ZIPS.has(zip5)) return { inside: false, basis: 'far_zip', miles: null };

  // 2. Coordenadas: la única prueba exacta.
  const la = numOrNull(lat);
  const lo = numOrNull(lon);
  if (la !== null && lo !== null) {
    const miles = haversineMiles(CENTER, { lat: la, lon: lo });
    return { inside: miles <= RADIUS_MILES, basis: 'coordinates', miles: Math.round(miles * 10) / 10 };
  }

  // 3. Ciudad reconocida.
  if (place && CITIES_WITHIN_RADIUS.has(place)) return { inside: true, basis: 'city', miles: null };

  // 4. Código postal del condado.
  const zipNum = Number(zip5);
  if (Number.isInteger(zipNum) && zipNum >= ZIP_MIN && zipNum <= ZIP_MAX) {
    return { inside: true, basis: 'zip_range', miles: null };
  }

  return { inside: false, basis: 'outside_area', miles: null };
}

export default withinServiceArea;
