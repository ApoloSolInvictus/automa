# Automa · Automatización de seguimiento

Aplicación inicial para Vercel + Firebase, basada visualmente en NexusAI. La plantilla original se conserva en `/demo.html`, claramente marcada como demostración. Su login simulado y llamada directa a Anthropic fueron desactivados.

## Alcance real

| Función | Implementación |
| --- | --- |
| Registro, login, recuperar contraseña, logout | Firebase Authentication, proveedor correo/contraseña |
| Dashboard | Firestore en tiempo real; métricas de los últimos 100 registros por colección |
| Prospectos | Nombre, correo, valor estimado USD; persistencia vía servidor |
| Automatización | Guardar prospecto crea tarea con vencimiento configurable (1–720 horas) |
| Historial | Ejecuciones completadas u omitidas al desactivar la automatización |
| Tareas | Completar/reabrir; cada cuenta solo accede a sus datos |
| IA, WhatsApp, Slack, CRM, facturación, pagos | No implementados; la demo no representa conexiones existentes |
| Envío al llegar el vencimiento, cron, webhooks públicos | No implementados |
| Organizaciones con varios miembros | No implementadas; espacio individual por UID |

No se atribuyen ingresos reales, ahorros o tasas de resolución a los datos de demostración. Una tarea con vencimiento es un registro interno; no envía correos automáticamente.

## Dónde entra la IA

La automatización actual no depende de una IA: la función del servidor recibe el prospecto, aplica una regla y crea la tarea de forma determinista. Eso es más económico, auditable y fiable para acciones de negocio.

La plantilla mencionaba Claude, pero solo intentaba usarlo como chat desde el navegador; no ejecutaba automatizaciones y la llamada no incluía una autenticación segura. Esa llamada fue retirada. Claude, OpenAI u otro modelo se puede agregar después, siempre desde una función del servidor, para tareas que sí necesitan lenguaje o criterio: clasificar prospectos, resumir conversaciones, extraer datos, proponer respuestas o decidir una categoría. La ejecución final, permisos, límites, reintentos y auditoría deben seguir en código. El diseño permite elegir proveedor cuando se defina el primer caso de IA y sus requisitos de privacidad, costo y calidad.

## Desarrollo

Requiere Node.js 22.

```sh
npm ci
cp .env.example .env.local
# Completar las variables de tu proyecto, sin publicarlas en Git.
npm run dev
```

`npm run dev` sirve el frontend. Para probar también `/api/business`, usa `npx vercel dev` con las variables privadas configuradas en `.env.local` o en el proyecto de Vercel vinculado.

## Firebase

1. Seleccionar o crear un proyecto de Firebase y registrar una app web.
2. Crear Firestore (base `(default)`) en modo producción, en la región elegida para el negocio.
3. Activar Authentication → Proveedores → Correo/contraseña.
4. Copiar los campos de configuración web a `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Son identificadores públicos del cliente; no autorizan por sí mismos acceso a Firestore.
5. Configurar una cuenta de servicio del mismo proyecto en el servidor: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`. La clave PEM admite saltos reales o `\n`. Guardarla únicamente como secreto de servidor en Vercel; nunca usar el prefijo `VITE_`.
6. Publicar las reglas ANTES de habilitar usuarios reales:

```sh
npx firebase login
npx firebase deploy --only firestore:rules --project TU_PROJECT_ID
```

7. Agregar el dominio real de Vercel y el dominio personalizado a Authentication → Configuración → Dominios autorizados. Agregar localhost solo si se necesita desarrollo local.

La cuenta de servicio requiere acceso a Firestore y a Firebase Authentication para verificar tokens revocados. Las reglas bloquean todas las escrituras del navegador; el Admin SDK valida token, acción, tamaños y UID en la función. No usar reglas públicas de prueba. Cada UID tiene su propio espacio, sin colaboración entre cuentas.

## Vercel

Importar este repositorio como proyecto Vite. `vercel.json` configura `npm run build`, salida `dist`, ruta `/dashboard` y la función Node `/api/business`.

1. Agregar las siete variables de `.env.example` en los entornos que se desplegarán. Los dos project IDs deben coincidir.
2. Desplegar con `npx vercel` para preview y `npx vercel --prod` para producción, o conectar la rama desde GitHub.
3. Volver a desplegar cuando cambien las variables `VITE_`, porque se incorporan durante el build.
4. Comprobar registro, login, creación de prospecto, tarea, desactivación de regla, logout y aislamiento con una segunda cuenta.

Sin configuración pública Firebase el formulario se bloquea y explica la causa. Sin credenciales privadas la API devuelve 503, nunca un éxito simulado. El frontend puede publicarse antes de completar Firebase, pero eso no significa que el negocio esté operativo.

## Datos y fiabilidad

`users/{uid}/leads`, `tasks`, `runs`, `settings/followUp` y cuota privada `internal/{fechaUTC}`. Cada prospecto, su tarea, historial y cuota se escriben en una única transacción. El UUID de solicitud evita duplicación al reintentar la misma operación; máximo 200 prospectos por cuenta/día UTC. No es una cuota global ni protección completa contra creación masiva de cuentas. Configurar alertas de presupuesto y protección contra abuso antes de abrir registro público a escala.

Los snapshots están limitados a los últimos 100 documentos, sin paginación en esta versión. Las métricas lo indican; no son totales históricos. Fechas del servidor, textos renderizados con `textContent`, claves privadas fuera del bundle, caché deshabilitada para la API.

## Verificación

```sh
npm test
npm run build
npm run test:ui
# Java 21+ para el emulador Firestore:
npm run test:rules
```

Pruebas de validación, fechas de seguimiento y rechazo HTTP sin autenticación. Las pruebas de reglas comprueban lectura del propietario, denegación a terceros y anónimos, prohibición de escrituras del cliente y protección de cuotas. No equivalen a una prueba de despliegue con credenciales reales.

## Origen y documentación

Plantilla original: NexusAI de Bestwpware, distribuida por ThemeWagon. Se conserva LICENSE.

- https://firebase.google.com/docs/auth/web/start
- https://firebase.google.com/docs/rules/basics
- https://vercel.com/docs/project-configuration/vercel-json
- https://vercel.com/docs/functions/configuring-functions/runtime
