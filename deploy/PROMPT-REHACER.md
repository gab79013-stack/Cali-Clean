# Prompt para reconstruir este sistema desde cero

Este es el encargo condensado: incluye las decisiones que en la conversación
original costaron varias vueltas, para que un agente nuevo no tenga que
redescubrirlas.

**Antes de usarlo, pregúntate si de verdad hace falta.** Para un cliente nuevo
del mismo sector, clonar este repositorio y ejecutar `deploy/new-client.sh` hace
lo mismo en un minuto. Este prompt sirve para empezar de cero: otro stack, otro
sector, o porque el código se perdió.

Sustituye lo que va entre `<...>` y borra lo que no aplique.

---

```
Vamos a construir una máquina de generación de clientes para <NEGOCIO>, una
empresa de <SECTOR> en <ZONA>. Su web es <URL>.

Léelo entero antes de escribir código. Al final hay decisiones ya tomadas: no
vuelvas a preguntármelas.

## El objetivo

Agentes externos que salen a buscar clientes potenciales, los cualifican y los
cargan en un CRM ya rellenos y puntuados. El envío de correos va por Sender
(SMTP o su API REST).

NO es un formulario de contacto ni un chatbot en la web. El motor principal es
outbound: el sistema sale a buscar, no espera.

## Arquitectura

Cinco agentes en cadena, cada uno dejando su resultado en la base de datos para
que una corrida interrumpida se retome sola:

  registros públicos → descubrir → enriquecer → cualificar → redactar → contactar → CRM

1. Descubrir: consulta fuentes de datos abiertos, clasifica cada negocio por
   segmento y deduplica (el mismo negocio aparece varias veces y en varias
   fuentes).
2. Enriquecer: encuentra la web del negocio, la visita y saca de ahí el correo
   que el propio negocio publica.
3. Cualificar: puntúa contra el perfil de cliente ideal, estima el valor del
   contrato y descarta lo que no llega al umbral.
4. Redactar: escribe el correo de primer contacto usando el dato concreto que
   justifica escribir.
5. Contactar: crea el lead, lo encola en una secuencia en frío y lo empuja al
   CRM.

Además, un panel web para ver el embudo y un CRM local propio que es la fuente
de verdad: si el CRM externo se cae o cambia, la prospección no se detiene ni
se pierde un contacto.

## Decisiones ya tomadas (no las replantees)

- **Señales de intención, no listas.** Persigue eventos que crean la necesidad
  ahora: <ej. una obra que acaba de cerrarse, un negocio que acaba de abrir>.
  La antigüedad de la señal pesa en la puntuación: a las dos semanas ya no vale
  lo mismo.
- **Nunca inventes un correo.** Solo se usa el que el negocio publica en su
  web. Nada de probar patrones tipo info@ o contacto@: rebotan, y los rebotes
  queman la reputación del dominio. Si no publica correo, se descarta con ese
  motivo anotado.
- **robots.txt se respeta sin excepción**, con ritmo lento y User-Agent
  identificado. Si el sitio prohíbe el rastreo, ese prospecto se descarta.
- **Verifica antes de fiarte.** Antes de dar por buena la web de un negocio,
  comprueba que la página coincide con él (nombre más teléfono, código postal o
  dirección). Una sola coincidencia puede ser casualidad.
- **Envío automático de punta a punta**, pero con el interruptor general
  apagado por defecto.
- **Bilingüe <ES/EN>** en correos y paneles.
- **Un CRM por cliente, aislado**: carpeta, base de datos, configuración,
  usuario de sistema y dominio propios. Nada compartido entre clientes.

## Salvaguardas obligatorias

El envío es automático y nadie revisa antes de que salga el correo, así que
estas comprobaciones corren **inmediatamente antes de cada envío**, no al
programarlo: entre una cosa y otra pasan días y alguien puede haberse dado de
baja en ese hueco.

- Lista de supresión por correo y por dominio.
- Comprobación de bajas previas, insensible a mayúsculas (una mayúscula suelta
  no puede reabrir la puerta a quien ya se dio de baja).
- Enfriamiento por dominio: nunca dos correos a la misma empresa en <90> días.
- Cupo diario con calentamiento progresivo del dominio.
- Comprobación de registro MX del destinatario.
- Franja horaria de envío.
- Umbral mínimo de puntuación.
- Interruptor general que se pueda accionar desde el panel sin reiniciar.

Dos de ellas deben **aplazar** en vez de descartar: el cupo agotado y el
interruptor general. Apagar el sistema no puede destruir la cola.

Cada correo lleva enlace de baja, cabecera List-Unsubscribe de un clic,
dirección física y una línea que explica por qué lo recibe. Darse de baja
cancela la secuencia en el acto.

Secuencia en frío de cuatro toques como máximo. Insistir más a quien nunca pidió
nada es lo que convierte una campaña en una denuncia por spam.

## Sobre la redacción con LLM

El modelo personaliza; la plantilla fija la estructura, el aviso de procedencia
y la baja. Valida siempre lo que devuelve el modelo antes de enviarlo:
marcadores sin rellenar, que nombre al negocio, longitud. Si no pasa, usa el
texto determinista y deja anotado por qué. Sin clave de API, todo debe seguir
funcionando con plantillas.

## Stack

Node.js, sin framework pesado. SQLite en un archivo (el volumen de una pyme no
justifica un servidor de base de datos, y respaldar es copiar un archivo).
Dependencias mínimas. Despliegue en un VPS Ubuntu con systemd y nginx.

## Entregables

1. El pipeline de agentes.
2. El CRM local con panel: embudo por etapa, por qué se descarta cada prospecto
   en lenguaje llano, la evidencia de cada verificación, el desglose de la
   puntuación y **el correo redactado visible antes de enviarse**.
3. Conector al CRM externo. Si no sé cuál tengo, quiero un detector que lo
   identifique desde su URL sin credenciales.
4. Scripts de despliegue idempotentes y de alta de cliente nuevo.
5. Tests automatizados, incluido el pipeline completo contra servidores que
   simulen las fuentes y las webs de los prospectos.
6. README que explique **por qué** está construido así, no solo cómo se usa.

## Cómo quiero que trabajes

- Antes de construir, pregúntame lo que cambie el diseño: a quién perseguimos,
  de qué fuentes, hasta dónde llega la automatización. Lo que tenga un valor por
  defecto razonable, decídelo tú y dímelo.
- Si no puedes acceder a algo (la web del negocio, una API, un panel), **dímelo
  claramente y sigue** con supuestos declarados. No te quedes parado ni finjas
  que lo viste.
- Prueba lo que escribes de verdad: levanta el servidor, ejecuta el pipeline,
  abre el panel en un navegador. Los tests que pasan sin ejercitar el camino
  real no valen.
- Cuando encuentres un fallo mientras pruebas, arréglalo y dímelo en una línea.
- No pongas datos inventados del negocio (teléfono, dirección, precios,
  testimonios) como si fueran reales. Déjalos como marcadores evidentes y
  dímelo al final.
- Comprueba lo que afirmes. Si dices que algo funciona, que sea porque lo
  ejecutaste.

## Trampas concretas que quiero evitar

- Descartar en silencio un lead real por una heurística antispam. Marcarlo, sí;
  perderlo, nunca: un cliente perdido cuesta más que un registro dudoso.
- Que el panel o los correos se rompan cuando falta un dato de configuración
  (por ejemplo, un negocio sin teléfono).
- Instalar en un servidor que ya aloja otras cosas sin comprobar puertos
  ocupados ni la configuración de nginx existente.
- Adivinar la versión o el nombre de una API sin leer su documentación.
```

---

## Qué NO incluye este prompt a propósito

- **Los precios y el catálogo de servicios.** Son del negocio concreto: hay que
  preguntarlos, no heredarlos.
- **La lista de fuentes de datos.** Dependen de la ciudad y del sector.
- **El perfil de cliente ideal.** Es la decisión más específica del negocio y la
  que conviene discutir en la conversación, no dar hecha.
