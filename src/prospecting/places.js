import { config } from '../config.js';
import { apiFetch } from './http.js';

/**
 * Conector de Google Places.
 *
 * El enriquecedor deduce el dominio del nombre del negocio ("Gaslamp Dental
 * Studio" → gaslampdentalstudio.com) y lo verifica contra la página. Funciona
 * con los negocios cuyo dominio se parece a su nombre, y falla con el resto:
 * `website_not_found` es el motivo de descarte más común, con diferencia.
 *
 * Places cierra ese hueco porque devuelve la web que el negocio tiene declarada,
 * en vez de adivinarla. No devuelve correos —ninguna API lo hace—, pero llevar
 * al agente a la web correcta es justo lo que separa un lote de 150 correos de
 * uno de 300.
 *
 * Es opcional y de pago: sin `GOOGLE_PLACES_API_KEY` el enriquecedor sigue
 * adivinando dominios exactamente como antes.
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/** Lo que pedimos. Cuantos menos campos, más barata sale la petición. */
const FIELD_MASK = [
  'places.displayName',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.formattedAddress',
].join(',');

export const isEnabled = () => Boolean(config.prospecting.googlePlacesApiKey);

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/**
 * Busca el negocio y devuelve su web declarada.
 * Devuelve null si no hay clave, si no hay resultado o si el que hay no tiene web.
 */
export async function findPlace({ businessName, address, city, zip } = {}) {
  if (!isEnabled()) return null;
  if (!businessName) return null;

  // La dirección es lo que distingue una franquicia de otra con el mismo nombre.
  const query = [businessName, address, city, zip && `CA ${zip}`].filter(Boolean).join(' ');

  let body;
  try {
    body = await apiFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.prospecting.googlePlacesApiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });
  } catch {
    // Places caído o cuota agotada no puede parar la prospección: el agente
    // vuelve a adivinar el dominio, que es lo que hacía antes de existir esto.
    return null;
  }

  const place = body?.places?.[0];
  if (!place?.websiteUri) return null;

  return {
    website: place.websiteUri,
    phone: place.nationalPhoneNumber || '',
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
  };
}

/**
 * ¿El sitio que devuelve Places es el de este negocio?
 *
 * Places ya ha cruzado nombre y dirección, pero una búsqueda por texto puede
 * traer al vecino. Si el teléfono o el código postal coinciden con nuestro
 * registro, eso es una prueba de identidad que se suma a las de la página.
 */
export function corroborates(place, prospect) {
  if (!place) return false;
  const ourPhone = digits(prospect.phone);
  if (ourPhone && ourPhone === digits(place.phone)) return true;

  const zip = String(prospect.zip || '').slice(0, 5);
  if (zip && String(place.address || '').includes(zip)) return true;

  return false;
}

export default findPlace;
