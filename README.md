# Automa

Automa es un espacio de trabajo para negocios de cualquier tamaño. El dashboard reúne CRM, agentes OpenAI y automatizaciones sobre Firebase y Vercel:

```text
prospecto → función segura de Vercel → regla del negocio → Firestore → tarea
```

La plantilla visual original de NexusAI se conserva en [`demo.html`](demo.html), pero está marcada como demo. Sus métricas, usuarios, integraciones y chat no son datos reales.

## Qué funciona hoy

| Área | Estado | Detalle |
| --- | --- | --- |
| Registro, login, recuperación y logout | Listo | Firebase Authentication con correo y contraseña |
| Dashboard | Listo | Firestore en tiempo real, separado por UID |
| CRM multiempresa | Listo | Compañías, contactos, oportunidades, actividades y pipeline por espacio de trabajo |
| Prospectos | Listo | Nombre, correo y valor estimado en USD |
| Automatización | Listo | Crea una tarea de seguimiento con vencimiento configurable |
| Historial | Listo | Registra si la tarea fue creada u omitida |
| Completar tareas | Listo | Completar y reabrir desde el dashboard |
| IA y agentes | Listo | El chat y las pruebas de agentes usan OpenAI desde funciones de Vercel; cada agente puede elegir un modelo |
| Telegram | Preparado | `/api/telegram` recibe mensajes, ejecuta el agente y responde; requiere token y webhook |
| WhatsApp, email, Slack y pagos | Pendiente | Requieren integraciones y credenciales adicionales |
| Ejecución al vencer una tarea | Pendiente | La fecha se guarda; todavía no existe un cron que envíe mensajes |
| Equipos y organizaciones | Listo | Organizaciones aisladas, selector de espacio, invitaciones y roles Owner, Admin, Member y Viewer |
| Datos demo | Listo | Crea 20 registros de ejemplo en el espacio actual y permite restablecerlo de nuevo a cero |

La automatización no necesita Claude ni OpenAI para crear una tarea. El servidor aplica la regla y escribe en Firestore. El chat y el Copilot del CRM sí usan OpenAI solo desde funciones de servidor y con `OPENAI_API_KEY` configurada. Una IA se debe usar cuando el proceso necesite comprender lenguaje: clasificar un prospecto, resumir una conversación, extraer campos o preparar una respuesta. La IA propone o clasifica; el código mantiene los permisos, límites, reintentos, acciones y auditoría.

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

No uses reglas de prueba como `allow read, write: if true`. Las reglas de este proyecto permiten lecturas únicamente al UID propietario y bloquean escrituras directas desde el navegador. Las operaciones de datos del servidor usan Firebase Admin después de validar la sesión; el chat valida el ID token mediante Firebase Authentication REST.

### 2.4 Crear la credencial del servidor

La función `/api/business` necesita verificar tokens de Firebase y escribir en Firestore. El chat está aislado en `/api/chat`: valida la sesión con Firebase Authentication REST y no carga Firebase Admin.

1. En Firebase abre **Project settings → Service accounts**.
2. Pulsa **Generate new private key** y descarga el JSON una sola vez.
3. No lo guardes dentro del repositorio.
4. Usa sus campos para completar únicamente variables privadas:

```env
FIREBASE_PROJECT_ID=TU_PROJECT_ID
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@TU_PROJECT_ID.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

En la pantalla de Vercel pega el valor de `private_key` sin las comillas exteriores del JSON. Conserva los saltos `\n`; el servidor acepta tanto esa representación como saltos de línea reales.

Como alternativa, puedes guardar el JSON completo de la cuenta de servicio en una variable privada llamada `FIREBASE_SERVICE_ACCOUNT_JSON`; el servidor extrae `project_id`, `client_email` y `private_key` automáticamente. No la añadas a `VITE_` ni al repositorio.

`FIREBASE_PROJECT_ID` debe coincidir con `VITE_FIREBASE_PROJECT_ID`. La clave puede conservar saltos `\n` dentro de la variable. No pongas el prefijo `VITE_` en ninguna credencial privada.

La cuenta de servicio debe pertenecer al mismo proyecto y conservar permisos para Firestore y Firebase Authentication. Si tu organización aplica IAM personalizado, concede únicamente los permisos necesarios para verificar tokens y leer/escribir Firestore.

### 2.5 Estructura de datos

```text
users/{uid}/leads/{requestId}
users/{uid}/tasks/{requestId}
users/{uid}/runs/{requestId}
users/{uid}/settings/followUp
users/{uid}/internal/{YYYY-MM-DD}
users/{uid}/agents/{agentId}
users/{uid}/companies/{companyId}
users/{uid}/contacts/{contactId}
users/{uid}/opportunities/{opportunityId}
users/{uid}/activities/{activityId}
users/{uid}/memberships/{organizationId}
users/{uid}/channels/telegram/chats/{chatId}
users/{uid}/channels/telegram/updates/{updateId}
users/{uid}/private/gmail                 # refresh token; sólo la función de servidor
organizations/{organizationId}
organizations/{organizationId}/members/{uid}
organizations/{organizationId}/invitations/{invitationId}
organizations/{organizationId}/agents/{agentId}
organizations/{organizationId}/automations/{automationId}
organizations/{organizationId}/integrations/{integrationId}
organizations/{organizationId}/private/gmail # refresh token; sólo la función de servidor
organizations/{organizationId}/companies/{companyId}
organizations/{organizationId}/contacts/{contactId}
organizations/{organizationId}/opportunities/{opportunityId}
organizations/{organizationId}/activities/{activityId}
```

El servidor crea prospecto, tarea, historial y contador diario en una transacción. El mismo `requestId` evita duplicar un prospecto si el navegador reintenta. El límite actual es de 200 prospectos por cuenta y día UTC. El dashboard muestra como máximo los últimos 100 documentos por colección.

### 2.6 CRM multiempresa y organizaciones

En **Dashboard → CRM** cada cuenta autenticada conserva un espacio personal. El selector de espacio de la barra superior permite crear organizaciones separadas para cada empresa, marca o unidad de negocio. Sus registros, agentes, automatizaciones e integraciones quedan aislados entre sí.

El propietario puede invitar miembros desde **Workspaces → Invite member**. Las invitaciones a cuentas Firebase existentes se activan al instante; para un correo que todavía no tiene cuenta se guarda una invitación pendiente y se acepta automáticamente cuando esa persona inicia sesión con el mismo correo. Los roles son:

- **Owner:** propietario de la organización y único rol que se crea al iniciar el espacio.
- **Admin:** puede invitar miembros y editar la operación del espacio.
- **Member:** edita registros CRM, agentes, automatizaciones e integraciones.
- **Viewer:** puede consultar el espacio y usar lecturas; las operaciones de escritura se rechazan.

En el selector se muestra el rol, el número de miembros y el detalle de cada miembro. El espacio personal mantiene el comportamiento anterior para que los datos existentes sigan visibles.

En cualquier espacio puedes crear y editar:

- **Companies:** nombre, industria, tamaño, sitio web, propietario y estado.
- **Contacts:** datos de contacto, cargo, compañía y estado.
- **Opportunities:** pipeline `Lead → Qualified → Proposal → Won/Lost`, valor, probabilidad, próximo paso y fecha estimada.
- **Activities:** llamadas, correos, reuniones, tareas y notas con vencimiento.

El buscador y el filtro de etapa trabajan sobre los registros en tiempo real. **AI CRM Copilot** envía un resumen acotado de esos registros al agente OpenAI elegido para priorizar el día, resumir el pipeline o redactar un seguimiento. La respuesta se muestra para revisión; no envía mensajes ni modifica sistemas externos por sí sola. Los botones **Add Company**, **Add Contact**, **New Opportunity** y **Log Activity** guardan mediante `/api/business` después de validar la sesión, el espacio seleccionado, el rol y los campos permitidos. La autorización de organización también se aplica a agentes, automatizaciones e integraciones.

### 2.7 Datos demo reversibles

En **Dashboard → Overview** están los botones **Crear Demo** y **Borrar Datos Locales**. El primero crea 20 registros de ejemplo repartidos entre prospectos, tareas, historial, CRM, agentes, automatizaciones e integraciones en el espacio actualmente seleccionado. El segundo restablece a cero todos los datos operativos de ese espacio (CRM, agentes, automatizaciones, integraciones, prospectos, tareas, historial y configuración), conservando la cuenta de autenticación y la membresía de la organización. Puedes usarlo en el espacio personal o en una organización donde tengas permisos de escritura. Los miembros `Viewer` solo pueden consultar los datos. La acción anterior `clearDemo` sigue disponible para integraciones antiguas y elimina solo documentos marcados como demo.

### 2.8 Restablecimiento global

El selector superior también incluye **Borrar todos los perfiles** para una limpieza inicial global. Esa acción exige el texto `DELETE_ALL_AUTOMA_DATA` y solo funciona para el UID configurado en `AUTOMA_DATA_RESET_OWNER_UID` (o en `TELEGRAM_OWNER_UID` si la variable opcional está vacía). Borra los datos operativos de todos los usuarios y organizaciones, pero conserva las cuentas de Firebase Authentication y sus membresías.

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
FIREBASE_WEB_API_KEY=...
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...
AUTOMA_DATA_RESET_OWNER_UID=...  # opcional; UID autorizado para borrar todos los perfiles
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

### 5.2 Crear la clave y guardarla en Vercel

1. Entra al [OpenAI API dashboard](https://platform.openai.com/).
2. Selecciona el proyecto que pagará el uso.
3. Crea una API key con el alcance mínimo disponible.
4. Configura límites de gasto y revisa el uso.
5. No pegues la clave en `.env.example`, `.env.local`, GitHub ni en el navegador. Guárdala directamente en Vercel como variable de servidor desde **Project settings → Environment Variables**:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.6-terra
```

En el repositorio solo deben quedar los nombres vacíos de [`.env.example`](.env.example). En Vercel crea `OPENAI_API_KEY` como **Sensitive**, selecciona Production y Preview según corresponda, y crea `OPENAI_MODEL` como variable normal. Si usas la CLI, los comandos solicitan el valor de forma interactiva:

```sh
npx --yes vercel env add OPENAI_API_KEY production
npx --yes vercel env add OPENAI_API_KEY preview
npx --yes vercel env add OPENAI_MODEL production
npx --yes vercel env add OPENAI_MODEL preview
```

Después de guardar o cambiar cualquiera de estas variables, crea un nuevo deployment. La función debe leerlas con `process.env`; el frontend no debe leerlas.

No uses `VITE_OPENAI_API_KEY`. Una variable que comienza por `VITE_` puede terminar en el bundle del navegador. No pongas la clave en GitHub, `index.html`, `src/app.js` ni en datos enviados por el cliente.

La guía oficial muestra el SDK JavaScript y `client.responses.create` en [OpenAI Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request). La documentación actual recomienda GPT-6 Astra para trabajo complejo; para equilibrar costo y capacidad consulta [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) y confirma que el modelo esté habilitado en tu proyecto.

### 5.3 Activar el chat del dashboard

El endpoint dedicado `/api/chat` llama a OpenAI desde el servidor y no depende del paquete de Firebase Admin. Agrega las variables a Vercel para Production y Preview. Puedes reflejar únicamente los nombres vacíos en `.env.example`, pero nunca escribas el valor real:

```env
# Server only; configúralo en Vercel; lo usa el chat del dashboard
FIREBASE_WEB_API_KEY=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra
```

### 5.4 Patrón de función de servidor

El código debe vivir en `api/`, nunca en el navegador. La implementación usa `POST https://api.openai.com/v1/responses`, conserva `store: false` y extrae los elementos `output_text` de la respuesta:

```js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  // 1. Verificar Firebase ID token y autorización del usuario.
  // 2. Validar tamaño, idioma y campos permitidos.
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      store: false,
      input: 'Summarize this business conversation: ...'
    })
  });
  const data = await response.json();
  // 3. Extraer y validar output[].content[].text.
  return res.status(response.status).json(data);
}
```

Para producción, añade límites de longitud, timeout, control de reintentos, registro sin datos sensibles, validación estructurada y una política para errores del proveedor. La clave se lee del entorno del servidor; nunca se acepta desde el body.

### 5.5 Conectar y probar los agentes

La sección **AI Agents** mantiene el diseño del template y ahora funciona con un solo proveedor: OpenAI. **Deploy New Agent** guarda en `users/{uid}/agents` el nombre, área de negocio, instrucciones, estado y modelo. **Configure** actualiza ese documento. **View** abre una prueba: el mensaje viaja autenticado a `/api/business`, el servidor carga la configuración del agente y llama a OpenAI; la clave nunca llega al navegador.

Los cuatro agentes de ejemplo usan estos IDs estables y se pueden probar desde el primer login:

| Agente | Modelo inicial | Uso recomendado |
| --- | --- | --- |
| Support Bot v2.1 | `gpt-5.6-terra` | Soporte y respuestas equilibradas |
| Sales Qualifier | `gpt-5.6-sol` | Calificación comercial de alta calidad |
| Data Analyzer | `gpt-5.6-luna` | Análisis rápido y de alto volumen |
| Email Automator | `gpt-5.6-terra` | Borradores de correo con revisión humana |

El catálogo permite `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra` y `gpt-5.6-luna`. `OPENAI_MODEL` es el fallback del chat y de agentes que no tengan modelo guardado; también se aceptan los IDs OpenAI que ya usaba el despliegue (`gpt-5-mini`, `gpt-4o`, `gpt-4o-mini`). Un agente en estado **Paused** no puede ejecutarse. Las instrucciones están limitadas a 6000 caracteres y los mensajes a 4000.

La ejecución actual es deliberadamente de texto: el agente analiza el mensaje y devuelve una respuesta, pero no afirma haber enviado correos, cambiado Firestore o ejecutado acciones externas. Para automatizar una acción real hay que añadir una herramienta server-side con parámetros validados, permisos y auditoría.

### 5.6 Modelos OpenAI disponibles

Los nombres del selector corresponden a modelos de la API de OpenAI, no a Claude ni Gemini:

- `gpt-6-astra`: elige esta opción para razonamiento y tareas complejas.
- `gpt-5.6-sol`: opción general de alta calidad para procesos comerciales.
- `gpt-5.6-terra`: equilibrio recomendado entre capacidad, rapidez y costo.
- `gpt-5.6-luna`: trabajos repetitivos, rápidos y de mayor volumen.

La API valida la lista antes de guardar o ejecutar un agente. Si un proyecto OpenAI no tiene acceso a un modelo, la respuesta lo informa como `model_access` y debes seleccionar otro modelo habilitado en ese proyecto.

### 5.7 Costos y privacidad

El uso de OpenAI se factura por el consumo del modelo y puede tener límites de tasa. Empieza con entradas cortas, guarda solo el resultado necesario y define un presupuesto. No envíes contraseñas, tokens, claves, tarjetas ni información personal que no sea necesaria. Decide cuánto tiempo conservarás prompts y respuestas antes de activar el flujo con clientes reales.

## 6. Conectar WSTUDIO3DBot en Telegram

El perfil público comprobado es **W Studio_bot (@WSTUDIO3DBot)**. La página muestra el botón **START BOT**; debes pulsarlo tú desde tu cuenta de Telegram para iniciar la conversación. El perfil por sí solo no conecta el bot con Vercel.

### 6.1 Variables privadas de Vercel

En **Project settings → Environment Variables**, agrega estas variables en Production (y Preview si vas a probar allí):

```env
TELEGRAM_BOT_TOKEN=                         # token que entrega @BotFather
TELEGRAM_WEBHOOK_SECRET=                    # secreto nuevo, aleatorio; sólo A-Z a-z 0-9 _ -
TELEGRAM_OWNER_UID=                         # UID del propietario; necesario para el enlace personal y el restablecimiento global
TELEGRAM_AGENT_ID=support-bot-v2-1
TELEGRAM_BOT_USERNAME=WSTUDIO3DBot
TELEGRAM_WEBHOOK_URL=https://automa.wstudio3d.com/api/telegram
```

Marca `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` como secretos. Telegram sólo acepta para `TELEGRAM_WEBHOOK_SECRET` entre 1 y 256 caracteres de `A-Z`, `a-z`, `0-9`, `_` o `-`; no uses espacios, puntos, comillas, `/`, `+` ni `=`. No los guardes en Firestore, `.env.example`, GitHub ni en el navegador. `TELEGRAM_OWNER_UID` no decide qué cliente recibe un mensaje; autoriza el enlace personal del propietario, el restablecimiento global y los diagnósticos de la cuenta personal. `TELEGRAM_BOT_USERNAME` sólo se usa para construir los enlaces de vinculación. `TELEGRAM_AGENT_ID` es el agente de respaldo; cada espacio puede seleccionar otro agente desde Configure Telegram.

### 6.2 Registrar el webhook

Después de guardar las variables y desplegar, puedes pulsar **Register webhook** en el Dashboard. Como alternativa, puedes traerlas a un archivo local protegido y ejecutar el registro. `.env.local` está excluido de Git:

```sh
npx --yes vercel env pull .env.local production
npm run telegram:set-webhook
```

También puedes exportar las cinco variables en tu terminal sin crear un archivo local. El script lee `.env.local` o `.env` automáticamente si existen.

El script llama a `setWebhook` con `https://automa.wstudio3d.com/api/telegram`, habilita mensajes normales y `business_message`, y configura `secret_token`. Telegram enviará ese secreto en el encabezado `X-Telegram-Bot-Api-Secret-Token`; la función rechaza cualquier solicitud sin coincidencia. Esta validación y el parámetro `business_connection_id` están contemplados por la documentación oficial de Telegram ([Bot API](https://core.telegram.org/bots/api), [Connected business bots](https://core.telegram.org/api/bots/connected-business-bots)).

### 6.3 Probar el flujo

1. En Telegram Business, conecta `@WSTUDIO3DBot` como bot empresarial desde los ajustes de tu cuenta.
2. En el Dashboard abre **CRM** y crea la empresa, el contacto, los contratos y los servicios. Marca como `Visible to linked customer` sólo los datos que el cliente puede consultar.
3. En **Dashboard → Integrations → Telegram → Link CRM contact**, selecciona el contacto. Automa crea un enlace de un solo uso que caduca en 15 minutos.
4. Envía ese enlace al cliente. Al abrirlo, Telegram envía `/start automa_…` al webhook y el chat queda ligado a ese contacto.
5. El cliente puede preguntar por sus servicios o contratos. Vercel carga en tiempo real únicamente los registros relacionados con ese contacto/empresa, llama al agente OpenAI seleccionado y devuelve la respuesta al mismo chat.
6. La conversación y los eventos se conservan bajo la raíz del espacio (`users/{uid}` o `organizations/{orgId}`), junto a `telegramBindings` y `telegramPairings`, que son rutas sólo de servidor.

Si Telegram Business asigna un `business_connection_id` nuevo al reconectar el bot, Automa migra automáticamente un vínculo autorizado cuando existe una sola coincidencia para ese chat dentro de los workspaces del propietario. Conserva el alcance del cliente o propietario y no migra chats ambiguos entre workspaces; esos chats requieren un nuevo enlace seguro.

Para vincular tu propio bot a la cuenta propietaria, inicia sesión con `ronnywoods77@gmail.com` (o con la cuenta propietaria correspondiente) y usa **Dashboard → Integrations → Telegram → Link my Telegram account**. Automa genera un enlace distinto de un solo uso; ábrelo con el bot nuevo antes de 15 minutos. En el workspace personal, `TELEGRAM_OWNER_UID` debe coincidir con el UID de esa sesión. En una organización, sólo el Owner o Admin puede crear el enlace. El vínculo de propietario permite consultar los campos CRM seguros de ese workspace; nunca expone tokens, credenciales ni notas privadas.

### 6.4 Registrar un cliente nuevo desde Telegram

Si todavía no existe un contacto en el CRM, abre **Dashboard → Integrations → Telegram → New client intake**. Automa genera un enlace de un solo uso que caduca en 30 minutos. El cliente lo abre en `@WSTUDIO3DBot` y responde, paso a paso, el nombre de la empresa, contacto, correo, teléfono opcional, servicios solicitados, nombre de la oportunidad, valor estimado, probabilidad, alcance y visibilidad para el cliente. Antes de guardar, el bot muestra un resumen y exige que el cliente responda **yes**.

Al confirmar, la función crea dentro del workspace correcto la empresa, el contacto, la oportunidad, cada servicio solicitado, un contrato en estado `draft` y una actividad de revisión. También registra una ejecución `telegram_intake_submitted` para que una automatización pueda escribir en Google Sheets. Si Gmail está conectado en ese mismo workspace, prepara un borrador HTML de confirmación dirigido al cliente; el borrador queda pendiente de revisión y nunca se envía sin aprobación. Si Sheets todavía no tiene OAuth, la ejecución queda con `sheetsStatus: pending_connection`.

El enlace de intake no sustituye al enlace **Link CRM contact**: este último sigue siendo el flujo apropiado cuando el contacto ya existe y sólo se quiere consultar información aprobada. **Link my Telegram account** es el flujo exclusivo para la cuenta propietaria. Un chat sin uno de esos enlaces no puede consultar ni crear datos. `/cancel` cancela el formulario y permite pedir un enlace nuevo. Las sesiones, tokens hash y resultados se guardan sólo en `telegramIntakes` y `telegramIntakeSessions` dentro de la raíz del workspace; el token original nunca se guarda.

En **Dashboard → Integrations → Telegram**, **Configure** guarda el username, el perfil empresarial, el agente que responderá y la URL pública. **Link CRM contact** genera el enlace seguro para cada cliente existente y **New client intake** genera el formulario temporal para un cliente nuevo. **Register webhook** registra la URL usando el token privado de Vercel; el registro está permitido al propietario o administrador del espacio. **Check status** consulta Telegram sin mostrar el token y confirma si el token es válido, si el webhook apunta a la URL correcta y cuántos eventos están pendientes.

El webhook procesa mensajes de texto y mantiene respuestas de texto. Los mensajes de chats sin vínculo sólo reciben instrucciones para pedir un enlace; no llegan a OpenAI ni pueden consultar el CRM. El modelo recibe una lista limitada de campos aprobados: nunca recibe notas internas, credenciales, identificadores o datos de otros contactos. Los contratos y servicios se comparten sólo cuando están marcados como visibles para el cliente. Los mensajes con fotos, audio o documentos se ignoran hasta añadir transcripción o análisis de archivos.

## 7. Conectar Gmail y enviar correos HTML

La tarjeta **Dashboard → Integrations → Gmail** permite crear un borrador con un prompt para OpenAI, elegir Astra, Sol, Terra o Luna, editar el asunto y el HTML, revisar la vista previa en vivo y enviar el resultado a varios destinatarios. El envío requiere confirmación explícita. Automa guarda el refresh token únicamente en `private/gmail`, una ruta que las reglas de Firestore no exponen al navegador.

### 7.1 Preparar Google Cloud

1. En Google Cloud, crea o selecciona un proyecto y habilita **Gmail API**.
2. Configura la pantalla de consentimiento OAuth. Durante pruebas, agrega tu cuenta de Gmail como **Test user**.
3. Crea un cliente OAuth de tipo **Web application**.
4. Registra exactamente esta Redirect URI autorizada: `https://automa.wstudio3d.com/api/gmail`.
5. En la pantalla de consentimiento, publica estos enlaces de la aplicación:
   - Privacy Policy: `https://automa.wstudio3d.com/privacy.html`
   - Terms of Service: `https://automa.wstudio3d.com/terms.html`

La conexión usa acceso offline y el scope `https://www.googleapis.com/auth/gmail.modify`, que permite leer, clasificar, marcar, archivar, redactar y enviar mensajes desde la cuenta conectada. Google entrega un refresh token al servidor; nunca se expone al navegador. Gmail exige correos MIME RFC 2822 codificados en base64URL para `users.messages.send`. Consulta la documentación oficial de [OAuth de servidor para Gmail](https://developers.google.com/workspace/gmail/api/auth/web-server), [OAuth para aplicaciones web](https://developers.google.com/identity/protocols/oauth2/web-server), [scopes de Gmail](https://developers.google.com/identity/protocols/oauth2/scopes), [listar mensajes](https://developers.google.com/workspace/gmail/api/guides/list-messages), [modificar mensajes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify) y [envío de mensajes](https://developers.google.com/workspace/gmail/api/guides/sending).

### 7.2 Variables privadas de Vercel

En **Project settings → Environment Variables**, agrega en Production las siguientes variables. Marca `GMAIL_CLIENT_SECRET` y `GMAIL_OAUTH_STATE_SECRET` como **Sensitive**.

```env
GMAIL_CLIENT_ID=                 # OAuth client ID de Google Cloud
GMAIL_CLIENT_SECRET=             # OAuth client secret de Google Cloud
GMAIL_OAUTH_STATE_SECRET=        # secreto aleatorio largo para firmar el estado OAuth
GMAIL_REDIRECT_URI=https://automa.wstudio3d.com/api/gmail
```

No uses una Web API Key de Firebase ni una API key de OpenAI en esas variables. Después de guardarlas, redeploya y pulsa **Connect Gmail**. Google abrirá su consentimiento y regresará a Automa; la aplicación muestra **Connected** cuando puede guardar el token de actualización. Para cuentas externas en producción, Google puede solicitar la verificación de la aplicación por tratarse de un scope de Gmail restringido.

### 7.3 Uso y controles

1. Pulsa **Compose email** en la tarjeta Gmail.
2. Describe el objetivo, tono, idioma, destinatario y llamada a la acción en **AI email prompt**.
3. Revisa el asunto, el código HTML y la vista previa lado a lado. Puedes cambiar el HTML antes de enviar.
4. Si quieres reutilizarlo, escribe un nombre y pulsa **Save HTML as template**. Las plantillas quedan aisladas por espacio de trabajo, se pueden cargar desde **Saved HTML templates** y borrar con el icono de papelera.
5. Añade hasta 50 destinatarios entre `To`, `CC` y `BCC`; separa correos con coma, punto y coma o salto de línea.
6. Pulsa **Send with Gmail** y confirma el envío.

Para revisar la bandeja, pulsa **AI inbox review** en la tarjeta de Gmail. Automa consulta hasta 20 mensajes de la bandeja recibidos durante los últimos 30 días, genera con el agente **Email Automator** un resumen general y otro por mensaje, clasifica señales de phishing, robo de credenciales, malware y fraude de pagos, y propone una plantilla guardada cuando una respuesta parece segura. Desde cada resultado puedes abrir el texto, marcarlo como leído, archivarlo o moverlo a la papelera. **Reply with template** crea la respuesta en el mismo hilo y siempre pide confirmación antes de enviar; ninguna respuesta, archivo o eliminación se ejecuta automáticamente.

Después de cambiar el scope desde `gmail.send` a `gmail.modify`, pulsa **Disconnect** y vuelve a pulsar **Connect Gmail** para que Google solicite el permiso ampliado. Si la tarjeta indica **Reconnect required**, repite ese ciclo. `gmail.modify` es un scope restringido: durante pruebas la cuenta debe estar en **Test users** y, para uso público, Google puede exigir verificación de OAuth.

El servidor rechaza scripts, iframes, formularios, URLs `javascript:` o `data:`, asuntos con saltos de línea y destinatarios repetidos. El historial guarda solo metadatos mínimos del envío en `runs`; no guarda el HTML ni tokens OAuth. Las plantillas guardan el HTML, el asunto y el modelo para volver a usarlos. **Disconnect** elimina de Automa el token de Gmail de ese espacio. El restablecimiento local o global también elimina las plantillas y `private/gmail`.

### 7.4 Flujo de Google Workspace e integraciones

El catálogo de Integrations mantiene un flujo común para canales y herramientas de trabajo:

`Telegram o Discord → Drive/Docs → Calendar → Sheets → Gmail`

Telegram, Discord, GitHub, Gmail, Google Drive, Google Docs, Google Calendar y Google Sheets se muestran con su alcance separado por espacio de trabajo. La opción **Configure** guarda el proveedor, el estado, el alcance aprobado y las notas de uso en `integrations`, para que cada paso pueda documentarse antes de activarlo en una automatización. Gmail conserva las acciones conectadas de OAuth (borradores HTML, revisión de bandeja, respuestas y envío). Las APIs de Drive, Docs, Calendar y Sheets deben habilitarse en Google Cloud y añadirse a la autorización OAuth antes de ejecutar acciones de lectura o escritura sobre esos servicios.

El landing usa los precios Starter de **$49/mes** y Pro de **$149/mes**. El selector anual conserva el descuento del 30% y muestra $34 y $104 al mes, respectivamente.

## 8. Pruebas y verificación

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

## 9. Solución de problemas

**Vercel no encuentra `package.json`.** Confirma repositorio, rama `main`, Root Directory `.`, y que el commit incluya `package.json`.

**La pantalla dice “Firebase pendiente de configuración”.** Faltan variables `VITE_FIREBASE_*` durante el build. Guarda las variables en Vercel y vuelve a desplegar.

**La API devuelve 503.** Si aparece `firebase_server_not_configured`, falta una variable privada. Si aparece `firebase_admin_credentials`, vuelve a generar la clave de cuenta de servicio y copia exactamente `project_id`, `client_email` y `private_key` del mismo proyecto de Firebase. Las reglas de Firestore no corrigen un fallo de inicialización de Firebase Admin.

**La función muestra `ERR_REQUIRE_ESM` al cargar Firebase Admin.** Usa el `package-lock.json` del repositorio (`npm ci`) y vuelve a desplegar. El proyecto fija `firebase-admin@13.5.0`, una versión compatible con el runtime de Vercel usado por esta aplicación; no actualices sólo ese paquete sin probar el despliegue de las funciones.

**El chat muestra `firebase_admin_sdk_load`.** El navegador está usando una versión anterior que todavía enviaba el chat a `/api/business`. Despliega el commit actual y confirma en la pestaña Network que la solicitud vaya a `/api/chat`; la respuesta incluye el header `X-Automa-Chat-Version: 2`.

**Firebase devuelve `unauthorized-domain`.** Agrega el dominio exacto de Vercel en Authorized domains.

**Firebase devuelve `permission-denied`.** Publica [`firestore.rules`](firestore.rules), confirma sesión y revisa que el proyecto de las variables sea el mismo.

**OpenAI devuelve `401`.** La clave no está disponible para la función, está revocada o pertenece a otro proyecto. Revisa `OPENAI_API_KEY` en Vercel; nunca la pruebes desde el navegador.

**Telegram no responde.** Abre **Dashboard → Integrations → Telegram → Check status**. Si el webhook aparece como `not registered` o `different URL`, ejecuta de nuevo `npm run telegram:set-webhook`. Confirma que `TELEGRAM_BOT_TOKEN` y `TELEGRAM_WEBHOOK_SECRET` existan en el mismo entorno de Vercel que el dominio público, que el bot esté conectado en Telegram Business y que el cliente haya abierto un enlace nuevo de **Link CRM contact**. Un chat sin emparejamiento recibe un aviso y no consulta OpenAI; un enlace caducado debe generarse de nuevo. Un token inválido o un secreto incorrecto produce `401`; una configuración incompleta produce `503`.

**Gmail muestra `Gmail is not configured`.** Confirma que las cuatro variables `GMAIL_*` estén en el mismo entorno de Vercel que el dominio público y redeploya. La URI de redirección debe coincidir exactamente con `https://automa.wstudio3d.com/api/gmail` en Google Cloud y en Vercel.

**Gmail vuelve a Automa con error.** Agrega la cuenta como usuario de prueba en OAuth Consent Screen, verifica que Gmail API esté habilitada y revisa que el cliente sea de tipo Web application. Si Google no devuelve refresh token, vuelve a conectar Gmail: Automa solicita consentimiento explícito para obtener uno nuevo.

**El emulador no inicia.** Instala Java 21+ y vuelve a ejecutar `npm run test:rules`.

## 10. Archivos importantes

- [`index.html`](index.html): aplicación real de Automa.
- [`src/template-app.js`](src/template-app.js): Authentication, listeners, CRM y conexión con OpenAI.
- [`css/style.css`](css/style.css): interfaz responsive y estilos del dashboard.
- [`api/business.js`](api/business.js): función segura de Vercel y Firebase Admin.
- [`api/chat.js`](api/chat.js): autenticación REST y conexión aislada con OpenAI.
- [`api/gmail.js`](api/gmail.js): OAuth de Google, generación de HTML y envío seguro por Gmail.
- [`api/telegram.js`](api/telegram.js): webhook autenticado para WSTUDIO3DBot.
- [`scripts/set-telegram-webhook.mjs`](scripts/set-telegram-webhook.mjs): registro seguro de la URL de Telegram.
- [`server/domain.js`](server/domain.js): validación y planificación.
- [`shared/models.js`](shared/models.js): catálogo y allowlist de modelos OpenAI.
- [`shared/agents.js`](shared/agents.js): configuraciones iniciales de los cuatro agentes del template.
- [`firestore.rules`](firestore.rules): aislamiento por usuario.
- [`vercel.json`](vercel.json): build, salida, headers y rewrite.
- [`demo.html`](demo.html): plantilla visual original.
- [`tests/`](tests/): pruebas funcionales, reglas y UI.

## 11. Próximos pasos

1. Añadir herramientas server-side con permisos para que un agente ejecute acciones reales de negocio.
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
