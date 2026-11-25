# Registro de Materiales SAP – app móvil (Plan Infra)

Aplicación web instalable (PWA) para que los técnicos de mantenimiento registren materiales por TAG desde el celular.
Se publica en **GitHub Pages**; el servidor de intercambio es un **Google Apps Script** independiente
(`servidor/Code.gs`, proyecto `GAS_Registro_Materiales_SAP`) con su propia hoja. **Plan Infra** (en el PC del
supervisor) es el sistema maestro: publica técnicos/OT/TAG, importa las solicitudes y confirma.

```
Celular (esta PWA) ─HTTPS─► Apps Script + hoja propia ◄─HTTPS saliente─ Plan Infra (conector, cada 5 min) ─► base central
```

* No contiene secretos: `config.js` solo lleva la URL pública `/exec`. La clave entre Plan Infra y Google vive en las
  propiedades del script (`PLANINFRA_CLAVE`) y en el `.env` del PC (`MAT_GAS_CLAVE`).
* Los técnicos ingresan con su **usuario de Plan Infra** y un **código móvil**: la primera vez, el código de activación
  de un solo uso que emite el supervisor en Plan Infra; luego definen el suyo. La contraseña de Plan Infra nunca llega
  a Google.
* La app nunca se conecta a SAP ni a la base de Plan Infra.
* Basada en el mecanismo de «Registro Operacional» (cola local, IDs de origen, reintentos, anti-duplicados), sin
  compartir con él hoja, clave ni código de servidor.

## Archivos
| Archivo | Uso |
|---|---|
| `index.html`, `app.js`, `styles.css` | La aplicación |
| `config.js` | URL del Apps Script desplegado (`API_URL`) |
| `manifest.json`, `sw.js`, `icons/` | Instalación como app y funcionamiento sin conexión |
| `servidor/Code.gs`, `servidor/appsscript.json` | Servidor de Google Apps Script (copiar al proyecto de Apps Script) |
| `herramientas/generar_iconos.py` | Regenera los íconos (Pillow) |

## Puesta en marcha (resumen)
1. **Apps Script:** nuevo proyecto `GAS_Registro_Materiales_SAP` → pegar `Code.gs` y `appsscript.json` → ejecutar
   `configurar()` → Propiedades de script: `PLANINFRA_CLAVE` = clave larga (≥ 24) → Implementar › Aplicación web
   (ejecutar como: yo; acceso: cualquier usuario) → copiar la URL `/exec`.
2. **Esta app:** poner la URL en `config.js` → publicar el repositorio en GitHub Pages (rama `main`, carpeta raíz).
3. **Plan Infra:** en `.env` agregar `MAT_GAS_URL=<url /exec>` y `MAT_GAS_CLAVE=<la misma clave>` → reiniciar
   `iniciar.bat` → Materiales SAP › App móvil › Sincronizar ahora → emitir los códigos de activación.

Detalle completo en Plan Infra: `docs/integracion_sap_materiales/11_APP_MOVIL.md`.

## Al cambiar la app
Subir `VERSION` en `sw.js` (p. ej. `ms-v2`) para que los teléfonos tomen la versión nueva.
