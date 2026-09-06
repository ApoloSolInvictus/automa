# Automa

Automa es un espacio de trabajo para pequeños negocios. La primera versión conecta Firebase, Vercel y un flujo determinista de seguimiento:

```text
prospecto → función segura de Vercel → regla del negocio → Firestore → tarea
```

La plantilla visual original de NexusAI se conserva en [`demo.html`](demo.html), pero está marcada como demo. Sus métricas, usuarios, integraciones y chat no son datos reales.

## Qué funciona hoy

| Área | Estado | Detalle |
| --- | --- | --- |
| Registro, login, recuperación y logout | Listo | Firebase Authentication con correo y contraseña |
| Dashboard | Listo | Firestore en tiempo real, separado por UID |
| Prospectos | Listo | Nombre, correo y valor estimado en USD |
| Automatización | Listo | Crea una tarea de seguimiento con vencimiento configurable |
| Historial | Listo | Registra si la tarea fue creada u omitida |
| Completar tareas | Listo | Completar y reabrir desde el dashboard |
| IA | Preparada, no conectada | El flujo actual no necesita un modelo |
| WhatsApp, email, Slack, CRM y pagos | Pendiente | Requieren integraciones y credenciales adicionales |
| Ejecución al vencer una tarea | Pendiente | La fecha se guarda; todavía no existe un cron que envíe mensajes |
| Equipos y organizaciones | Pendiente | Esta versión tiene un espacio individual por usuario |

La automatización no necesita Claude ni OpenAI para crear la tarea. El servidor aplica la regla y escribe en Firestore. Una IA se debe usar cuando el proceso necesite comprender lenguaje: clasificar un prospecto, resumir una conversación, extraer campos o preparar una respuesta. La IA propone o clasifica; el código mantiene los permisos, límites, reintentos, acciones y auditoría.

## Requisitos

- Node.js 22.
- Una cuenta de GitHub con acceso al repositorio.
- Un proyecto de Firebase.
- Una cuenta de Vercel.
- Una cuenta de OpenAI solamente si se va a activar la capa de IA.
- Java 21 o superior si se desea ejecutar el emulador local de Firestore.

## 1. Descargar y preparar el proyecto

```sh
git clone https://github.com/ApoloSolInvictus/automa.git
cd automa
npm ci
```

Crear un archivo local a partir de [`.env.example`](.env.example). En PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Nunca subas `.env.local`, una clave de servicio, una clave de OpenAI ni un archivo JSON de credenciales al repositorio. `.gitignore` ya excluye esos archivos.

## 2. Crear y configurar Firebase

### 2.1 Crear el proyecto

1. Entra a [Firebase Console](https://console.firebase.google.com/).
2. Pulsa **Add project** y usa un identificador estable, por ejemplo `automa-produccion`.
3. Activa Google Analytics solo si realmente lo necesitas; no es requisito para Automa.
4. En **Project settings → General → Your apps**, registra una aplicación web (`</>`).
5. Copia estos valores de la configuración web al `.env.local`:

```env
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=TU_PROJECT_ID.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=TU_PROJECT_ID
VITE_FIREBASE_APP_ID=
```

Estos cuatro valores forman parte del cliente web. No sustituyen las reglas de Firestore ni una sesión autenticada.

### 2.2 Activar Authentication

1. Abre **Build → Authentication → Get started**.
2. En **Sign-in method**, activa **Email/Password**.
3. Deja desactivados los proveedores que no vayas a utilizar.
4. En **Settings → Authorized domains**, agrega `localhost`, el dominio de Vercel y tu dominio personalizado si existe.

Firebase documenta el inicio de Authentication web en [Get Started with Firebase Authentication](https://firebase.google.com/docs/auth/web/start).

### 2.3 Crear Firestore y publicar reglas

1. Abre **Build → Firestore Database → Create database**.
2. Selecciona la base `(default)`.
3. Elige la región más cercana a tus usuarios; no se cambia fácilmente después.
4. Empieza en producción.
5. Desde la raíz del repositorio publica [`firestore.rules`](firestore.rules):

```sh
npx --yes firebase-tools login
npx --yes firebase-tools use --add TU_PROJECT_ID
npx --yes firebase-tools deploy --only firestore:rules --project TU_PROJECT_ID
```

No uses reglas de prueba como `allow read, write: if true`. Las reglas de este proyecto permiten lecturas únicamente al UID propietario y bloquean escrituras directas desde el navegador. La función de servidor escribe mediante Firebase Admin después de validar la sesión.

### 2.4 Crear la credencial del servidor

La función `/api/business` necesita verificar tokens de Firebase y escribir en Firestore.

1. En Firebase abre **Project settings → Service accounts**.
2. Pulsa **Generate new private key** y descarga el JSON una sola vez.
3. No lo guardes dentro del repositorio.
4. Usa sus campos para completar únicamente variables privadas:

```env
FIREBASE_PROJECT_ID=TU_PROJECT_ID
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@TU_PROJECT_ID.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FIREBASE_PROJECT_ID` debe coincidir con `VITE_FIREBASE_PROJECT_ID`. La clave puede conservar saltos `\n` dentro de la variable. No pongas el prefijo `VITE_` en ninguna credencial privada.

La cuenta de servicio debe pertenecer al mismo proyecto y conservar permisos para Firestore y Firebase Authentication. Si tu organización aplica IAM personalizado, concede únicamente los permisos necesarios para verificar tokens y leer/escribir Firestore.

### 2.5 Estructura de datos

```text
users/{uid}/leads/{requestId}
users/{uid}/tasks/{requestId}
users/{uid}/runs/{requestId}
users/{uid}/settings/followUp
users/{uid}/internal/{YYYY-MM-DD}
```

El servidor crea prospecto, tarea, historial y contador diario en una transacción. El mismo `requestId` evita duplicar un prospecto si el navegador reintenta. El límite actual es de 200 prospectos por cuenta y día UTC. El dashboard muestra como máximo los últimos 100 documentos por colección.

## 3. Ejecutar localmente

Con las variables públicas y privadas cargadas:

```sh
npm run dev
```

Para probar también la función de Vercel en local:

```sh
npx --yes vercel dev
```

Abre la URL que muestre Vercel y comprueba registro, login, creación de prospecto, tarea, historial, completar/reabrir y aislamiento con una segunda cuenta.

Si Firebase no está configurado, la pantalla se bloquea y muestra el motivo. No hay sesiones ni métricas simuladas en la aplicación real.

## 4. Publicar en Vercel

### 4.1 Importar el repositorio

1. Entra a [Vercel](https://vercel.com/) y pulsa **Add New → Project**.
2. Importa `ApoloSolInvictus/automa`.
3. Selecciona la rama `main`.
4. Usa:
   - **Framework preset:** `Vite`.
   - **Root Directory:** `.`.
   - **Build Command:** `npm run build`.
   - **Output Directory:** `dist`.
   - **Node.js Version:** `22.x`.
5. [`vercel.json`](vercel.json) ya contiene esta configuración y la ruta `/dashboard`.

El error `Could not read package.json: /vercel/path0/package.json` significa que Vercel está usando otra rama, otro repositorio o un Root Directory incorrecto. Confirma que el despliegue use `main` y el commit que contiene [`package.json`](package.json).

### 4.2 Añadir variables de entorno

En **Project settings → Environment Variables**, agrega las cuatro variables `VITE_` y las tres variables privadas de Firebase. Selecciona **Production**, **Preview** o ambos:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
```

Después de cambiar una variable `VITE_`, crea un nuevo deployment porque se incorpora durante el build. Después de cambiar una variable privada también conviene redeployar.

### 4.3 Dominios y primer despliegue

1. Copia el dominio público de Vercel.
2. Agrégalo a **Firebase Authentication → Settings → Authorized domains**.
3. En Vercel pulsa **Deploy** o **Redeploy** con el caché limpio en el primer intento.
4. Comprueba que `/` abre Automa y `/demo.html` abre únicamente la plantilla visual.
5. Repite el recorrido funcional usando el dominio de producción.

No publiques una cuenta de servicio dentro de `VITE_` ni la escribas en el código. Vercel debe guardar `FIREBASE_PRIVATE_KEY` como secreto de runtime.

## 5. Conectar OpenAI de forma segura

### 5.1 Qué aporta OpenAI

OpenAI no sustituye el motor de automatizaciones. El patrón recomendado es:

```text
evento → función de servidor → OpenAI para interpretar → validación de código → acción permitida → Firestore
```

Casos apropiados: clasificar prospectos, extraer campos, resumir conversaciones y preparar respuestas para revisión humana. No dejes que el modelo escriba directamente en Firestore, cambie permisos, envíe pagos o llame servicios arbitrarios. La función debe validar la salida y elegir una acción de una lista cerrada.

### 5.2 Crear la clave

1. Entra al [OpenAI API dashboard](https://platform.openai.com/).
2. Selecciona el proyecto que pagará el uso.
3. Crea una API key con el alcance mínimo disponible.
4. Configura límites de gasto y revisa el uso.
5. Guarda la clave únicamente como variable de servidor:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-6-astra
```

No uses `VITE_OPENAI_API_KEY`. Una variable que comienza por `VITE_` puede terminar en el bundle del navegador. No pongas la clave en GitHub, `index.html`, `src/app.js` ni en datos enviados por el cliente.

La guía oficial muestra el SDK JavaScript y `client.responses.create` en [OpenAI Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request). La documentación actual recomienda GPT-6 Astra para trabajo complejo; para equilibrar costo y capacidad consulta [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) y confirma que el modelo esté habilitado en tu proyecto.

### 5.3 Preparar el proyecto

Cuando activemos la primera función de IA, instala el SDK:

```sh
npm install openai
```

Agrega las variables a Vercel para Production y Preview. Puedes reflejar los nombres en `.env.example`, pero nunca escribas el valor:

```env
# Server only; no lo usa el flujo base todavía
OPENAI_API_KEY=
OPENAI_MODEL=gpt-6-astra
```

### 5.4 Patrón de función de servidor

El código debe vivir en `api/`, nunca en el navegador:

```js
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST.' });
  // 1. Verificar Firebase ID token y autorización del usuario.
  // 2. Validar tamaño, idioma y campos permitidos.
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-6-astra',
    input: 'Clasifica este prospecto y devuelve solo una categoría permitida: ...'
  });
  // 3. Validar response.output_text contra un esquema cerrado.
  // 4. Guardar resultado y auditoría en Firestore.
  return res.status(200).json({ result: response.output_text });
}
```

Para producción, añade límites de longitud, timeout, control de reintentos, registro sin datos sensibles, validación estructurada y una política para errores del proveedor. La clave se lee del entorno del servidor; nunca se acepta desde el body.

### 5.5 Costos y privacidad

El uso de OpenAI se factura por el consumo del modelo y puede tener límites de tasa. Empieza con entradas cortas, guarda solo el resultado necesario y define un presupuesto. No envíes contraseñas, tokens, claves, tarjetas ni información personal que no sea necesaria. Decide cuánto tiempo conservarás prompts y respuestas antes de activar el flujo con clientes reales.

## 6. Pruebas y verificación

```sh
npm test
npm run build
npm run test:ui
```

Las pruebas cubren validación, fechas, idempotencia, rechazo HTTP y UI responsive. Para las reglas de Firestore:

```sh
npm run test:rules
```

Ese comando necesita Java 21+. Debe confirmar lectura del propietario, denegación a otra cuenta y anónimos, escrituras de navegador bloqueadas y protección de la cuota interna.

Antes de producción prueba dominios autorizados, dos cuentas aisladas, claves ausentes o inválidas, reintentos, payloads fuera de rango y logs sin tokens.

## 7. Solución de problemas

**Vercel no encuentra `package.json`.** Confirma repositorio, rama `main`, Root Directory `.`, y que el commit incluya `package.json`.

**La pantalla dice “Firebase pendiente de configuración”.** Faltan variables `VITE_FIREBASE_*` durante el build. Guarda las variables en Vercel y vuelve a desplegar.

**La API devuelve 503.** Falta una variable privada, la clave tiene formato incorrecto o pertenece a otro proyecto.

**Firebase devuelve `unauthorized-domain`.** Agrega el dominio exacto de Vercel en Authorized domains.

**Firebase devuelve `permission-denied`.** Publica [`firestore.rules`](firestore.rules), confirma sesión y revisa que el proyecto de las variables sea el mismo.

**OpenAI devuelve `401`.** La clave no está disponible para la función, está revocada o pertenece a otro proyecto. Revisa `OPENAI_API_KEY` en Vercel; nunca la pruebes desde el navegador.

**El emulador no inicia.** Instala Java 21+ y vuelve a ejecutar `npm run test:rules`.

## 8. Archivos importantes

- [`index.html`](index.html): aplicación real de Automa.
- [`src/app.js`](src/app.js): Authentication, listeners y dashboard.
- [`src/app.css`](src/app.css): interfaz responsive.
- [`api/business.js`](api/business.js): función segura de Vercel y Firebase Admin.
- [`server/domain.js`](server/domain.js): validación y planificación.
- [`firestore.rules`](firestore.rules): aislamiento por usuario.
- [`vercel.json`](vercel.json): build, salida, headers y rewrite.
- [`demo.html`](demo.html): plantilla visual original.
- [`tests/`](tests/): pruebas funcionales, reglas y UI.

## 9. Próximos pasos

1. Conectar OpenAI desde una función server-side para clasificación o extracción.
2. Añadir un cron que busque tareas vencidas y cree ejecuciones idempotentes.
3. Integrar email o WhatsApp con consentimiento, plantillas y reintentos.
4. Añadir roles y organizaciones si habrá equipos.
5. Añadir observabilidad, alertas de presupuesto y protección contra abuso.
6. Añadir facturación después de definir planes y límites medibles.

## Licencia y fuentes

La interfaz original es NexusAI de Bestwpware, distribuida por ThemeWagon. Se conserva [`LICENSE`](LICENSE).

- [Firebase Authentication for web](https://firebase.google.com/docs/auth/web/start)
- [Firebase Security Rules basics](https://firebase.google.com/docs/rules/basics)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Vercel Functions runtime](https://vercel.com/docs/functions/configuring-functions/runtime)
- [OpenAI Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
