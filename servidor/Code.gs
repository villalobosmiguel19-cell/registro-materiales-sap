/**
 * REGISTRO DE MATERIALES SAP · Servidor de intercambio (Google Apps Script) — proyecto GAS_Registro_Materiales_SAP
 *
 * Intermediario entre la app móvil (GitHub Pages) y Plan Infra. NO es una segunda base de Plan Infra:
 *  - Los técnicos, plantas, OT semanales y TAG los PUBLICA Plan Infra (acción publicarCatalogo). Google no crea usuarios.
 *  - Guarda las solicitudes recibidas hasta que Plan Infra las importa y confirma.
 *  - Nunca toca SAP ni crea órdenes.
 *
 * Basado en el mecanismo de Registro Operacional (independiente de él: otra hoja, otra clave, otro proyecto).
 * Puesta en marcha (una vez): ejecutar configurar() y definir la propiedad de script PLANINFRA_CLAVE (≥ 24 caracteres),
 * la misma que MAT_GAS_CLAVE en el .env de Plan Infra.
 *
 * Autenticación de técnicos: Plan Infra publica, por técnico, la huella de un CÓDIGO DE ACTIVACIÓN de un solo uso
 * (la contraseña de Plan Infra nunca llega aquí). Con él, el técnico define su código personal (huella en Propiedades).
 */

const ARCHIVO = 'GAS_Registro_Materiales_SAP';
const H = { SOL: 'Solicitudes', LIN: 'Lineas', SYNC: 'Sincronizacion', ERR: 'Errores', AUD: 'Auditoria' };
const ENC_SOL = ['ID origen', 'Recepción', 'Recibida (servidor)', 'Fecha teléfono', 'Usuario', 'Técnico', 'Planta',
  'OT id', 'OT semanal', 'TAG id', 'TAG', 'Título TAG', 'Observación', 'Líneas', 'Estado', 'Comprobante Plan Infra',
  'Estado en Plan Infra', 'Mensaje', 'Importada en', 'Actualizado', 'Dispositivo'];
const C = {}; ENC_SOL.forEach(function (n, i) { C[n] = i + 1; });   // columna (1-based) por encabezado
const ENC_LIN = ['ID origen', 'Recepción', 'Línea', 'Código SAP', 'Descripción', 'Cantidad', 'Unidad', 'Observación'];
const ESTADOS = { PEND: 'pendiente_importacion', IMP: 'importada', ERR: 'error_validacion', REV: 'revision' };
const SESION_SEG = 21600;          // 6 h, se renueva con cada uso
const MAX_FALLOS = 8, VENTANA_FALLOS = 900, MIN_CODIGO = 6;
const MAX_LINEAS = 50;
const RE_CODIGO = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/;
const RE_UNIDAD = /^[A-Z0-9]{1,10}$/;
const RE_ORIGEN = /^[A-Za-z0-9-]{16,64}$/;
const FMT = 'dd-MM-yyyy HH:mm:ss';

// ───────────────────────── Puesta en marcha ─────────────────────────

function configurar() {
  const props = PropertiesService.getScriptProperties();
  let ss = null;
  const id = props.getProperty('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create(ARCHIVO); props.setProperty('SHEET_ID', ss.getId()); }
  const inicial = ss.getSheets()[0];
  const sol = asegurar_(ss, H.SOL, ENC_SOL);
  sol.getRange('A:B').setNumberFormat('@');
  sol.getRange('P:P').setNumberFormat('@');
  asegurar_(ss, H.LIN, ENC_LIN).getRange('A:B').setNumberFormat('@');
  asegurar_(ss, H.SYNC, ['Fecha', 'Acción', 'Detalle']);
  asegurar_(ss, H.ERR, ['Fecha', 'Origen', 'Código', 'Mensaje', 'Detalle']);
  asegurar_(ss, H.AUD, ['Fecha', 'Usuario', 'Acción', 'Detalle']);
  if (Object.values(H).indexOf(inicial.getName()) === -1 && ss.getSheets().length > 1) ss.deleteSheet(inicial);
  Logger.log('Hoja lista: ' + ss.getUrl());
  Logger.log('Define la propiedad de script PLANINFRA_CLAVE (≥ 24 caracteres) = MAT_GAS_CLAVE del .env de Plan Infra.');
}

/** Genera (o rota) la clave compartida con Plan Infra DENTRO de Google y la guarda en PLANINFRA_CLAVE.
 *  Ejecutar desde el editor; copiar el valor del registro de ejecución a MAT_GAS_CLAVE del .env de Plan Infra.
 *  Evita tener que pegar la clave a mano en las propiedades del script. */
function generarClavePlanInfra() {
  const c = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  PropertiesService.getScriptProperties().setProperty('PLANINFRA_CLAVE', c);
  Logger.log('MAT_GAS_CLAVE=' + c);
}

function asegurar_(ss, nombre, enc) {
  let sh = ss.getSheetByName(nombre);
  if (!sh) sh = ss.insertSheet(nombre);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, enc.length).setValues([enc]).setFontWeight('bold').setBackground('#0B2545').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
  }
  return sh;
}

// ───────────────────────── Entrada HTTP ─────────────────────────

function doGet(e) {
  const api = e && e.parameter && e.parameter.api;
  if (api === 'estado') return json_({ ok: true, servicio: 'REGISTRO DE MATERIALES SAP', hora: ahora_(), catalogo: (catalogoGuardado_() || {}).publicado || '' });
  return json_({ ok: false, error: 'Usa la aplicación móvil.' });
}

function doPost(e) {
  let p;
  try { p = JSON.parse((e && e.postData && e.postData.contents) || ''); }
  catch (x) { return json_({ ok: false, error: 'Solicitud inválida.', codigo: 'VALIDACION' }); }
  try {
    return json_(despachar_(p || {}));
  } catch (x) {
    if (x && x.codigo) return json_({ ok: false, error: x.message, codigo: x.codigo });
    console.error(x);
    registrarError_('servidor', 'SERVIDOR', String(x && x.message || x), '');
    return json_({ ok: false, error: 'Error interno del servidor.', codigo: 'SERVIDOR' });
  }
}

function despachar_(p) {
  switch (p.accion) {
    case 'login': return login_(p);
    // Plan Infra (clave propia)
    case 'publicarCatalogo': return publicarCatalogo_(p);
    case 'pendientes': return pendientes_(p);
    case 'confirmar': return confirmar_(p);
  }
  const s = sesion_(p.token);
  if (s.cambiar && p.accion !== 'definirCodigo' && p.accion !== 'salir') {
    throw falla_('Primero define tu código personal.', 'CAMBIAR_CODIGO');
  }
  switch (p.accion) {
    case 'definirCodigo': return definirCodigo_(s, p);
    case 'cambiarCodigo': return cambiarCodigo_(s, p);
    case 'catalogo': return { ok: true, catalogo: catalogoTecnico_(s) };
    case 'enviar': return enviar_(s, p);
    case 'historial': return historial_(s);
    case 'salir':
      CacheService.getScriptCache().remove('s_' + p.token);
      return { ok: true };
  }
  throw falla_('Acción desconocida.');
}

// ───────────────────────── Catálogo publicado por Plan Infra ─────────────────────────

function validarClavePlanInfra_(recibida) {
  const clave = PropertiesService.getScriptProperties().getProperty('PLANINFRA_CLAVE');
  const cache = CacheService.getScriptCache();
  const fallos = Number(cache.get('f_planinfra') || 0);
  if (fallos >= MAX_FALLOS) throw falla_('Demasiados intentos fallidos. Espera 15 minutos.', 'BLOQUEO');
  if (!clave || clave.length < 24 || String(recibida || '') !== clave) {
    cache.put('f_planinfra', String(fallos + 1), VENTANA_FALLOS);
    throw falla_('Clave de Plan Infra inválida.', 'CREDENCIALES');
  }
}

function publicarCatalogo_(p) {
  validarClavePlanInfra_(p.clave);
  const c = p.catalogo || {};
  if (!Array.isArray(c.tecnicos) || !Array.isArray(c.plantas) || !Array.isArray(c.tags)) throw falla_('Catálogo incompleto.');
  const limpio = {
    publicado: texto_(c.publicado, 25), unidades: (c.unidades || []).map(function (u) { return texto_(u, 10); }),
    tecnicos: c.tecnicos.map(function (t) {
      return { uid: texto_(t.uid, 12), usuario: texto_(t.usuario, 40).toLowerCase(), nombre: texto_(t.nombre, 120),
        plantas: (t.plantas || []).map(function (x) { return texto_(x, 20); }), activo: t.activo === true,
        activacion: t.activacion ? { sal: texto_(t.activacion.sal, 64), hash: texto_(t.activacion.hash, 64),
          emitido: texto_(t.activacion.emitido, 25) } : null };
    }),
    plantas: c.plantas.map(function (x) {
      return { codigo: texto_(x.codigo, 20), nombre: texto_(x.nombre, 80), ot: x.ot ? { id: Number(x.ot.id), codigo: texto_(x.ot.codigo, 20),
        sap: texto_(x.ot.sap, 20), inicio: texto_(x.ot.inicio, 25), fin: texto_(x.ot.fin, 25) } : null };
    }),
    tags: c.tags.map(function (t) {
      return { planta: texto_(t.planta, 20), id: Number(t.id), tag: texto_(t.tag, 80), titulo: texto_(t.titulo, 120), estado: texto_(t.estado, 40) };
    }),
  };
  guardarCatalogo_(limpio);
  // Sesiones de técnicos desactivados: se cortan en su siguiente uso (sesion_ consulta el catálogo).
  hoja_(H.SYNC).appendRow([new Date(), 'publicarCatalogo', limpio.tecnicos.length + ' técnicos · ' + limpio.tags.length + ' TAG · ' + limpio.publicado]);
  return { ok: true, tecnicos: limpio.tecnicos.length, tags: limpio.tags.length };
}

function guardarCatalogo_(cat) {
  const props = PropertiesService.getScriptProperties();
  const txt = JSON.stringify(cat);
  const n = Math.ceil(txt.length / 8000);
  const anterior = Number(props.getProperty('CAT_N') || 0);
  const nuevo = {};
  for (let i = 0; i < n; i++) nuevo['CAT_' + i] = txt.substr(i * 8000, 8000);
  nuevo.CAT_N = String(n);
  props.setProperties(nuevo);
  for (let i = n; i < anterior; i++) props.deleteProperty('CAT_' + i);
  CacheService.getScriptCache().remove('catalogo');
}

function catalogoGuardado_() {
  const cache = CacheService.getScriptCache();
  const enCache = cache.get('catalogo');
  if (enCache) return JSON.parse(enCache);
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty('CAT_N') || 0);
  if (!n) return null;
  let txt = '';
  for (let i = 0; i < n; i++) txt += props.getProperty('CAT_' + i) || '';
  if (txt.length < 95000) cache.put('catalogo', txt, 600);
  return JSON.parse(txt);
}

function tecnico_(usuarioOUid, porUid) {
  const cat = catalogoGuardado_();
  if (!cat) return null;
  const k = String(usuarioOUid || '').toLowerCase();
  for (let i = 0; i < cat.tecnicos.length; i++) {
    const t = cat.tecnicos[i];
    if ((porUid ? t.uid.toLowerCase() : t.usuario) === k) return t;
  }
  return null;
}

function otVigente_(planta) {
  if (!planta || !planta.ot) return null;
  const ahora = new Date();
  return (fechaIso_(planta.ot.inicio) <= ahora && ahora < fechaIso_(planta.ot.fin)) ? planta.ot : null;
}

function catalogoTecnico_(s) {
  const cat = catalogoGuardado_();
  if (!cat) throw falla_('Plan Infra aún no publica el catálogo. Intenta más tarde.', 'SIN_CATALOGO');
  const t = tecnico_(s.uid, true);
  const plantas = cat.plantas.filter(function (p) { return t.plantas.indexOf(p.codigo) !== -1; }).map(function (p) {
    const ot = otVigente_(p);
    return { codigo: p.codigo, nombre: p.nombre, ot: ot,
      tags: ot ? cat.tags.filter(function (x) { return x.planta === p.codigo; }) : [] };
  });
  return { plantas: plantas, unidades: cat.unidades, publicado: cat.publicado, usuario: t.usuario, nombre: t.nombre };
}

// ───────────────────────── Técnicos: códigos y sesiones ─────────────────────────

function login_(p) {
  const u = String(p.usuario || '').trim().toLowerCase();
  const codigo = String(p.codigo || '');
  const cache = CacheService.getScriptCache();
  const claveFallos = 'f_' + u;
  const fallos = Number(cache.get(claveFallos) || 0);
  if (fallos >= MAX_FALLOS) throw falla_('Demasiados intentos fallidos. Espera 15 minutos.', 'BLOQUEO');
  const t = tecnico_(u, false);
  let ok = false, cambiar = false;
  if (t && t.activo && t.activacion && codigo) {
    const personal = personal_(t);
    if (personal) {
      ok = hash_(codigo, personal.sal) === personal.hash;
    } else {
      ok = hash_(codigo, t.activacion.sal) === t.activacion.hash;
      cambiar = ok;
    }
  }
  if (!ok) {
    cache.put(claveFallos, String(fallos + 1), VENTANA_FALLOS);
    auditar_(u || '?', 'Ingreso rechazado', '');
    throw falla_('Usuario o código incorrecto.', 'CREDENCIALES');
  }
  cache.remove(claveFallos);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const s = { uid: t.uid, u: t.usuario, nombre: t.nombre, cambiar: cambiar, disp: texto_(p.dispositivo, 40) };
  cache.put('s_' + token, JSON.stringify(s), SESION_SEG);
  auditar_(t.usuario, cambiar ? 'Ingreso con código de activación' : 'Inicio de sesión', 'Dispositivo ' + s.disp);
  return { ok: true, token: token, usuario: t.usuario, nombre: t.nombre, uid: t.uid, cambiar: cambiar };
}

/** Código personal vigente: solo vale si se definió con la activación ACTUAL (una activación nueva lo anula). */
function personal_(t) {
  const v = PropertiesService.getScriptProperties().getProperty('HASH_' + t.uid);
  if (!v) return null;
  const partes = v.split('|');
  if (partes[0] !== t.activacion.emitido) return null;
  const sh = partes[1].split(':');
  return { sal: sh[0], hash: sh[1] };
}

function sesion_(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(String(token))) throw falla_('Sesión no válida. Ingresa de nuevo.', 'SESION');
  const cache = CacheService.getScriptCache();
  const v = cache.get('s_' + token);
  if (!v) throw falla_('Tu sesión venció. Ingresa de nuevo.', 'SESION');
  const s = JSON.parse(v);
  const t = tecnico_(s.uid, true);
  if (!t || !t.activo || !t.activacion) { cache.remove('s_' + token); throw falla_('Tu acceso móvil fue desactivado en Plan Infra.', 'SESION'); }
  if (!s.cambiar && !personal_(t)) { cache.remove('s_' + token); throw falla_('Tu código cambió. Ingresa de nuevo.', 'SESION'); }
  s.nombre = t.nombre; s.token = token;
  cache.put('s_' + token, JSON.stringify({ uid: s.uid, u: s.u, nombre: s.nombre, cambiar: s.cambiar, disp: s.disp }), SESION_SEG);
  return s;
}

function hash_(codigo, sal) {
  let d = sal + '|' + codigo, b = null;
  for (let i = 0; i < 300; i++) {
    b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, d, Utilities.Charset.UTF_8);
    d = Utilities.base64Encode(b) + sal;
  }
  return Utilities.base64Encode(b);
}

function guardarPersonal_(t, codigo) {
  const sal = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('HASH_' + t.uid, t.activacion.emitido + '|' + sal + ':' + hash_(codigo, sal));
}

function validarCodigoNuevo_(c) {
  c = String(c || '');
  if (c.length < MIN_CODIGO || c.length > 64) throw falla_('El código debe tener entre ' + MIN_CODIGO + ' y 64 caracteres.');
}

function definirCodigo_(s, p) {
  if (!s.cambiar) throw falla_('Tu código ya está definido. Usa «Cambiar código».');
  const t = tecnico_(s.uid, true);
  validarCodigoNuevo_(p.nuevo);
  if (hash_(String(p.nuevo), t.activacion.sal) === t.activacion.hash) throw falla_('Elige un código distinto del de activación.');
  guardarPersonal_(t, String(p.nuevo));
  s.cambiar = false;
  CacheService.getScriptCache().put('s_' + s.token, JSON.stringify({ uid: s.uid, u: s.u, nombre: s.nombre, cambiar: false, disp: s.disp }), SESION_SEG);
  auditar_(s.u, 'Código personal definido', '');
  return { ok: true };
}

function cambiarCodigo_(s, p) {
  const t = tecnico_(s.uid, true);
  const personal = personal_(t);
  if (!personal || hash_(String(p.actual || ''), personal.sal) !== personal.hash) throw falla_('El código actual no es correcto.');
  validarCodigoNuevo_(p.nuevo);
  guardarPersonal_(t, String(p.nuevo));
  auditar_(s.u, 'Cambio de código', '');
  return { ok: true };
}

// ───────────────────────── Recepción de solicitudes ─────────────────────────

function cantidad_(v, n) {
  let t = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (t.indexOf(',') !== -1) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(t)) throw falla_('Línea ' + n + ': cantidad no válida (mayor que cero, hasta 3 decimales).');
  const x = Number(t);
  if (!(x > 0) || x > 999999) throw falla_('Línea ' + n + ': la cantidad debe ser mayor que cero.');
  return t;
}

function enviar_(s, p) {
  const r = p.solicitud || {};
  const origen = String(r.origen_id || '');
  if (!RE_ORIGEN.test(origen)) throw falla_('Identificador de la solicitud inválido.');
  const cat = catalogoGuardado_();
  if (!cat) throw falla_('Plan Infra aún no publica el catálogo.', 'SIN_CATALOGO');
  const t = tecnico_(s.uid, true);
  if (t.plantas.indexOf(String(r.planta)) === -1) throw falla_('No tienes autorización para esa planta.', 'PERMISO');
  const planta = cat.plantas.filter(function (x) { return x.codigo === r.planta; })[0];
  const ot = otVigente_(planta);
  if (!ot) throw falla_('No hay OT semanal vigente para ' + (planta ? planta.nombre : r.planta) + '. Avisa al supervisor.');
  if (Number(r.ot_id) !== ot.id) throw falla_('La OT semanal cambió. Actualiza la app y vuelve a intentar.');
  const tag = cat.tags.filter(function (x) { return x.planta === r.planta && x.id === Number(r.work_order_id); })[0];
  if (!tag) throw falla_('El TAG no existe en Plan Infra o no pertenece a la planta.');
  const lineas = Array.isArray(r.lineas) ? r.lineas : [];
  if (!lineas.length) throw falla_('Agrega al menos un material.');
  if (lineas.length > MAX_LINEAS) throw falla_('Máximo ' + MAX_LINEAS + ' materiales por solicitud.');
  const limpias = lineas.map(function (l, i) {
    const n = i + 1;
    const codigo = String(l.codigo || '').trim().toUpperCase();
    const desc = texto_(l.descripcion, 200);
    const unidad = String(l.unidad || '').trim().toUpperCase();
    if (!RE_CODIGO.test(codigo)) throw falla_('Línea ' + n + ': código de material SAP no válido.');
    if (!desc) throw falla_('Línea ' + n + ': falta la descripción.');
    if (!RE_UNIDAD.test(unidad)) throw falla_('Línea ' + n + ': unidad de medida no válida.');
    return [n, codigo, desc, cantidad_(l.cantidad, n), unidad, texto_(l.observacion, 300)];
  });
  const obs = texto_(r.observacion, 500);
  const fechaTel = fechaIso_(r.creada) || new Date();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw falla_('Servidor ocupado. Se reintentará.', 'OCUPADO');
  try {
    const sh = hoja_(H.SOL);
    const enc = sh.getRange('A:A').createTextFinder(origen).matchEntireCell(true).findNext();
    if (enc) {
      const fila = sh.getRange(enc.getRow(), 1, 1, ENC_SOL.length).getValues()[0];
      return { ok: true, duplicado: true, origen_id: origen, recepcion: fila[C['Recepción'] - 1], recibida: legible_(fila[C['Recibida (servidor)'] - 1]) };
    }
    const props = PropertiesService.getScriptProperties();
    const anio = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy');
    const n = Number(props.getProperty('REC_' + anio) || 0) + 1;
    props.setProperty('REC_' + anio, String(n));
    const recepcion = 'REC-' + anio + '-' + ('000000' + n).slice(-6);
    const ahora = new Date();
    sh.appendRow([origen, recepcion, ahora, fechaTel, s.uid, txt_(s.nombre), r.planta, ot.id, ot.codigo, tag.id, txt_(tag.tag),
      txt_(tag.titulo), txt_(obs), limpias.length, ESTADOS.PEND, '', '', '', '', ahora, txt_(texto_(r.dispositivo || s.disp, 40))]);
    hoja_(H.LIN).getRange(hoja_(H.LIN).getLastRow() + 1, 1, limpias.length, ENC_LIN.length).setValues(
      limpias.map(function (l) { return [origen, recepcion, l[0], txt_(l[1]), txt_(l[2]), txt_(l[3]), l[4], txt_(l[5])]; }));
    SpreadsheetApp.flush();
    return { ok: true, duplicado: false, origen_id: origen, recepcion: recepcion, recibida: fmt_(ahora) };
  } finally {
    lock.releaseLock();
  }
}

function lineasPorOrigen_() {
  const v = hoja_(H.LIN).getDataRange().getValues();
  const m = {};
  for (let i = 1; i < v.length; i++) {
    const k = String(v[i][0]);
    (m[k] = m[k] || []).push({ linea: Number(v[i][2]), codigo: String(v[i][3]), descripcion: String(v[i][4]),
      cantidad: String(v[i][5]), unidad: String(v[i][6]), observacion: String(v[i][7]) });
  }
  return m;
}

function historial_(s) {
  const v = hoja_(H.SOL).getDataRange().getValues();
  const lin = lineasPorOrigen_();
  const nombres = {};
  ((catalogoGuardado_() || {}).plantas || []).forEach(function (p) { nombres[p.codigo] = p.nombre; });
  const salida = [];
  for (let i = v.length - 1; i >= 1 && salida.length < 100; i--) {
    if (String(v[i][C['Usuario'] - 1]) !== s.uid) continue;
    const f = fila_(v[i], lin);
    f.planta_nombre = nombres[f.planta] || f.planta;
    salida.push(f);
  }
  return { ok: true, solicitudes: salida };
}

function fila_(f, lin) {
  const g = function (n) { return f[C[n] - 1]; };
  return { origen_id: String(g('ID origen')), recepcion: String(g('Recepción')), recibida: legible_(g('Recibida (servidor)')),
    planta: String(g('Planta')), ot: String(g('OT semanal')), tag: String(g('TAG')), titulo: String(g('Título TAG')),
    observacion: String(g('Observación')), estado: String(g('Estado')), comprobante: String(g('Comprobante Plan Infra')),
    estado_planinfra: String(g('Estado en Plan Infra')), mensaje: String(g('Mensaje')),
    importada: legible_(g('Importada en')), lineas: lin[String(g('ID origen'))] || [] };
}

// ───────────────────────── Plan Infra: pendientes y confirmación ─────────────────────────

function pendientes_(p) {
  validarClavePlanInfra_(p.clave);
  const max = Math.min(Math.max(Number(p.max) || 50, 1), 200);
  const v = hoja_(H.SOL).getDataRange().getValues();
  const lin = lineasPorOrigen_();
  const salida = [];
  for (let i = 1; i < v.length && salida.length < max; i++) {
    const f = v[i];
    if (String(f[C['Estado'] - 1]) !== ESTADOS.PEND) continue;
    salida.push({ origen_id: String(f[0]), recepcion_id: String(f[1]), recibida: iso_(f[C['Recibida (servidor)'] - 1]),
      uid: String(f[C['Usuario'] - 1]), planta: String(f[C['Planta'] - 1]), ot_id: Number(f[C['OT id'] - 1]),
      work_order_id: Number(f[C['TAG id'] - 1]), observacion: String(f[C['Observación'] - 1]),
      dispositivo: String(f[C['Dispositivo'] - 1]), lineas: lin[String(f[0])] || [] });
  }
  return { ok: true, solicitudes: salida };
}

function confirmar_(p) {
  validarClavePlanInfra_(p.clave);
  const res = Array.isArray(p.resultados) ? p.resultados : [];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw falla_('Servidor ocupado. Reintenta.', 'OCUPADO');
  let actualizadas = 0;
  try {
    const sh = hoja_(H.SOL);
    const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (x) { return String(x[0]); });
    const ahora = new Date();
    res.forEach(function (r) {
      const estado = [ESTADOS.IMP, ESTADOS.ERR, ESTADOS.REV].indexOf(r.estado) !== -1 ? r.estado : null;
      const i = ids.indexOf(String(r.origen_id || ''));
      if (!estado || i < 1) return;
      const fila = i + 1;
      const actual = sh.getRange(fila, 1, 1, ENC_SOL.length).getValues()[0];
      if (actual[C['Estado'] - 1] === ESTADOS.IMP && estado !== ESTADOS.IMP) return;   // una importada no retrocede
      actual[C['Estado'] - 1] = estado;
      if (r.comprobante) actual[C['Comprobante Plan Infra'] - 1] = txt_(texto_(r.comprobante, 20));
      actual[C['Estado en Plan Infra'] - 1] = txt_(texto_(r.etiqueta || '', 60));
      actual[C['Mensaje'] - 1] = txt_(texto_(r.mensaje || r.referencia || '', 300));
      if (estado === ESTADOS.IMP && !actual[C['Importada en'] - 1]) actual[C['Importada en'] - 1] = ahora;
      actual[C['Actualizado'] - 1] = ahora;
      sh.getRange(fila, 1, 1, ENC_SOL.length).setValues([actual]);
      if (estado === ESTADOS.ERR) registrarError_('planinfra', 'VALIDACION', String(r.mensaje || ''), String(r.origen_id));
      actualizadas++;
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  hoja_(H.SYNC).appendRow([new Date(), 'confirmar', actualizadas + ' de ' + res.length + ' actualizadas']);
  return { ok: true, actualizadas: actualizadas };
}

// ───────────────────────── Utilidades ─────────────────────────

function auditar_(u, accion, detalle) { hoja_(H.AUD).appendRow([new Date(), txt_(u), accion, txt_(detalle || '')]); }
function registrarError_(origen, codigo, msg, detalle) { try { hoja_(H.ERR).appendRow([new Date(), origen, codigo, txt_(msg), txt_(detalle)]); } catch (e) { console.error(e); } }
function txt_(v) { v = String(v == null ? '' : v); return /^[=+\-@]/.test(v) ? "'" + v : v; }   // evita fórmulas
function texto_(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function hoja_(nombre) {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw falla_('Servidor sin configurar: ejecuta configurar().', 'SERVIDOR');
  const sh = SpreadsheetApp.openById(id).getSheetByName(nombre);
  if (!sh) throw falla_('Falta la hoja ' + nombre + ': ejecuta configurar().', 'SERVIDOR');
  return sh;
}
function fechaIso_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)) : null;
}
function iso_(d) { return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss") : ''; }
function legible_(v) { return v instanceof Date ? fmt_(v) : String(v || ''); }
function fmt_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), FMT); }
function ahora_() { return fmt_(new Date()); }
function falla_(msg, codigo) { const e = new Error(msg); e.codigo = codigo || 'VALIDACION'; return e; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
