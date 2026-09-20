/** Etiquetas bilingües compartidas por widget, landing y correos. */
export const LOCALES = ['en', 'es'];
export const pickLocale = (value) => (String(value || '').toLowerCase().startsWith('es') ? 'es' : 'en');

export const t = {
  en: {
    serviceType: {
      standard: 'Standard cleaning', deep: 'Deep cleaning', move: 'Move in / Move out',
      post_construction: 'Post-construction', office: 'Office', retail: 'Retail',
      medical: 'Medical facility', restaurant: 'Restaurant',
    },
    frequency: {
      one_time: 'One time', weekly: 'Weekly', biweekly: 'Every 2 weeks',
      monthly: 'Monthly', daily: 'Daily',
    },
    addons: {
      fridge: 'Inside fridge', oven: 'Inside oven', windows_interior: 'Interior windows',
      laundry: 'Laundry', garage: 'Garage', cabinets: 'Inside cabinets', patio: 'Patio / balcony',
      windows_exterior: 'Exterior windows', carpet_shampoo: 'Carpet shampoo',
      floor_wax: 'Floor stripping & wax', disinfection: 'Disinfection service',
    },
    segment: { residential: 'Home', commercial: 'Business' },
  },
  es: {
    serviceType: {
      standard: 'Limpieza estándar', deep: 'Limpieza profunda', move: 'Mudanza (entrada/salida)',
      post_construction: 'Post-construcción', office: 'Oficina', retail: 'Local comercial',
      medical: 'Clínica / consultorio', restaurant: 'Restaurante',
    },
    frequency: {
      one_time: 'Una vez', weekly: 'Semanal', biweekly: 'Cada 2 semanas',
      monthly: 'Mensual', daily: 'Diaria',
    },
    addons: {
      fridge: 'Interior del refrigerador', oven: 'Interior del horno', windows_interior: 'Ventanas por dentro',
      laundry: 'Lavandería', garage: 'Garaje', cabinets: 'Interior de gabinetes', patio: 'Patio / balcón',
      windows_exterior: 'Ventanas por fuera', carpet_shampoo: 'Lavado de alfombras',
      floor_wax: 'Pulido y encerado de pisos', disinfection: 'Servicio de desinfección',
    },
    segment: { residential: 'Hogar', commercial: 'Negocio' },
  },
};

export const label = (locale, group, key, fallback = '') =>
  t[pickLocale(locale)]?.[group]?.[key] || fallback || key;
