/**
 * Perfil de cliente ideal (ICP) de Cali Clean.
 *
 * Cada segmento define cómo se reconoce, cuánto vale un cliente de ese tipo y
 * con qué argumento se le abre la conversación. Es el archivo que se toca para
 * cambiar a quién persiguen los agentes.
 */

export const SEGMENTS = {
  property_manager: {
    label: { es: 'Administrador de propiedades', en: 'Property manager' },
    // Cómo se nombra al colectivo en el correo, sin pluralizar a la fuerza.
    plural: { es: 'administradores de propiedades', en: 'property managers' },
    // Peso base: cuánto vale este segmento antes de mirar nada más.
    weight: 30,
    // Cómo se estima el trabajo para calcular el valor del contrato.
    quote: { segment: 'residential', bedrooms: 2, bathrooms: 1, serviceType: 'move', frequency: 'weekly' },
    keywords: ['property management', 'property manager', 'realty', 'real estate', 'apartments',
      'leasing', 'rentals', 'inmobiliaria', 'administracion de propiedades'],
    naics: ['531110', '531210', '531311', '531312', '531390'],
    pain: {
      es: 'cada unidad que se desocupa tiene que estar lista para enseñar en 48 horas',
      en: 'every unit that turns has to be show-ready within 48 hours',
    },
  },

  office_clinic: {
    label: { es: 'Oficina o consultorio', en: 'Office or clinic' },
    // Cómo se nombra al colectivo en el correo, sin pluralizar a la fuerza.
    plural: { es: 'consultorios y oficinas', en: 'clinics and offices' },
    weight: 26,
    quote: { segment: 'commercial', sqft: 4000, serviceType: 'office', frequency: 'weekly' },
    keywords: ['dental', 'dentist', 'clinic', 'medical', 'physician', 'chiropractic', 'law office',
      'attorney', 'accounting', 'insurance agency', 'consultorio', 'clinica', 'despacho'],
    naics: ['621210', '621111', '621310', '541110', '541211', '524210', '541613'],
    pain: {
      es: 'un consultorio sucio le cuesta pacientes antes de que nadie se queje',
      en: 'a dingy waiting room costs you patients before anyone complains',
    },
  },

  restaurant_retail: {
    label: { es: 'Restaurante o local', en: 'Restaurant or retail' },
    // Cómo se nombra al colectivo en el correo, sin pluralizar a la fuerza.
    plural: { es: 'restaurantes y locales', en: 'restaurants and shops' },
    weight: 22,
    quote: { segment: 'commercial', sqft: 2500, serviceType: 'restaurant', frequency: 'daily' },
    keywords: ['restaurant', 'cafe', 'coffee', 'bakery', 'bar', 'grill', 'taqueria', 'pizzeria',
      'retail', 'boutique', 'store', 'market', 'salon', 'barber', 'gym', 'fitness'],
    naics: ['722511', '722513', '722515', '311811', '445110', '448140', '812112', '713940'],
    pain: {
      es: 'una inspección de salubridad no avisa y el personal de cocina no debería limpiar el piso a las 2 a.m.',
      en: 'a health inspection never calls ahead, and your kitchen staff should not be mopping at 2 a.m.',
    },
  },

  str_host: {
    label: { es: 'Anfitrión de renta corta', en: 'Short-term rental host' },
    // Cómo se nombra al colectivo en el correo, sin pluralizar a la fuerza.
    plural: { es: 'anfitriones de rentas cortas', en: 'short-term rental hosts' },
    weight: 20,
    quote: { segment: 'residential', bedrooms: 2, bathrooms: 1, serviceType: 'standard', frequency: 'weekly' },
    keywords: ['short term rental', 'vacation rental', 'airbnb', 'str', 'guest house', 'hospitality',
      'renta corta', 'alquiler vacacional'],
    naics: ['721199', '721110', '531110'],
    pain: {
      es: 'una reseña de cuatro estrellas por limpieza cuesta más que la limpieza misma',
      en: 'one four-star review for cleanliness costs more than the cleaning ever did',
    },
  },

  post_construction: {
    label: { es: 'Obra terminada', en: 'Finished construction' },
    // Cómo se nombra al colectivo en el correo, sin pluralizar a la fuerza.
    plural: { es: 'contratistas al cerrar obra', en: 'contractors closing out jobs' },
    weight: 24,
    quote: { segment: 'commercial', sqft: 3000, serviceType: 'post_construction', frequency: 'one_time' },
    keywords: ['construction', 'contractor', 'builder', 'remodel', 'renovation', 'general contractor',
      'constructora', 'remodelacion'],
    naics: ['236118', '236220', '238210', '238350'],
    pain: {
      es: 'la obra no se entrega hasta que alguien retira el polvo, y eso suele caer el mismo día de la entrega',
      en: 'the job is not handed over until someone clears the dust, and that always lands on handover day',
    },
  },
};

export const SEGMENT_KEYS = Object.keys(SEGMENTS);

const normalize = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Clasifica un prospecto por su nombre, descripción y código NAICS.
 * Devuelve el segmento y la confianza, para que el agente sepa cuándo no fiarse.
 */
export function classify({ businessName, description, naics, signalType } = {}) {
  // Una obra recién terminada manda sobre cualquier otra pista: es la señal
  // más fuerte y la más perecedera.
  if (signalType === 'permit_finaled') {
    return { segment: 'post_construction', confidence: 0.9, matched: ['permit_finaled'] };
  }

  const haystack = normalize(`${businessName || ''} ${description || ''}`);
  const code = String(naics || '').replace(/\D/g, '');
  const scores = [];

  for (const [key, def] of Object.entries(SEGMENTS)) {
    let score = 0;
    const matched = [];
    for (const kw of def.keywords) {
      if (haystack.includes(normalize(kw))) { score += 2; matched.push(kw); }
    }
    if (code) {
      if (def.naics.includes(code)) { score += 4; matched.push(`naics:${code}`); }
      else if (def.naics.some((n) => code.startsWith(n.slice(0, 4)))) { score += 2; matched.push(`naics~${code}`); }
    }
    if (score > 0) scores.push({ segment: key, score, matched });
  }

  if (!scores.length) return { segment: null, confidence: 0, matched: [] };
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1]?.score || 0;
  // La confianza baja cuando el segundo candidato empata: ahí el agente no sabe.
  const confidence = Math.min(1, (best.score / 6) * (best.score > runnerUp ? 1 : 0.6));
  return { segment: best.segment, confidence: Math.round(confidence * 100) / 100, matched: best.matched };
}

export const segmentLabel = (key, locale = 'es') =>
  SEGMENTS[key]?.label[locale === 'es' ? 'es' : 'en'] || key;

export const segmentPain = (key, locale = 'es') =>
  SEGMENTS[key]?.pain[locale === 'es' ? 'es' : 'en'] || '';

export const segmentPlural = (key, locale = 'es') =>
  SEGMENTS[key]?.plural[locale === 'es' ? 'es' : 'en'] || segmentLabel(key, locale);

export default SEGMENTS;
