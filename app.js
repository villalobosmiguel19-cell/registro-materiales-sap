/* Materiales SAP – Plan Infra · Aplicación móvil (PWA) para técnicos
 *
 * Mismo mecanismo que Registro Operacional:
 *  - Toda solicitud entra primero a una cola LOCAL con un ID de origen único (uuid del teléfono). Si no hay
 *    conexión queda PENDIENTE DE ENVÍO y se reintenta sola. Google descarta IDs repetidos (no duplica).
 *  - Los pendientes de un usuario solo se envían con la sesión de ese mismo usuario.
 *  - Estados distintos y honestos: Guardada en el teléfono → Pendiente de envío → Recibida por Google →
 *    Pendiente de importación → Importada en Plan Infra (comprobante MAT-…) / Error de validación / Pendiente de revisión.
 *    Nunca se dice que llegó a Plan Infra si solo la recibió Google.
 *  - No hay tokens privados en este código: solo la URL pública del Apps Script (config.js).
 */
(function () {
  'use strict';

  const API = (window.MS_CONFIG || {}).API_URL || '';
  const K = { ses: 'ms_sesion', cat: 'ms_catalogo', cola: 'ms_cola', disp: 'ms_dispositivo', bor: 'ms_borrador_', ult: 'ms_ultimo_usuario', hist: 'ms_historial' };
  const $ = (id) => document.getElementById(id);
  const st = { sesion: null, cat: null, planta: null, tag: null, lineas: [], sinc: false, hist: [] };
  const ESTADO_TXT = {
    guardada: ['Guardada en el teléfono', 'pend'], pendiente: ['Pendiente de envío', 'pend'],
    pendiente_importacion: ['Recibida por Google · pendiente de importación en Plan Infra', 'pend'],
    importada: ['Importada en Plan Infra', 'ok'], error_validacion: ['Error de validación', 'rech'],
    revision: ['Pendiente de revisión', 'rech'], rechazada_google: ['Rechazada por el servidor', 'rech'],
  };

  // ── Almacenamiento local (con respaldo en memoria si el navegador no deja guardar) ──
  const memoria = {};
  const leer = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : (k in memoria ? memoria[k] : def); } catch (e) { return k in memoria ? memoria[k] : def; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); delete memoria[k]; return true; } catch (e) { memoria[k] = v; return false; } };
  const borrar = (k) => { delete memoria[k]; try { localStorage.removeItem(k); } catch (e) { /* nada */ } };
  const uuid = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function dispositivo() { let d = leer(K.disp, ''); if (!d) { d = 'Tel-' + uuid().slice(0, 8); guardar(K.disp, d); } return d; }
  function ahoraIso() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }

  // ── Comunicación con Apps Script (text/plain: sin consulta previa CORS) ──
  async function api(accion, datos) {
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(API)) throw new Error('Falta configurar la URL del servidor (config.js).');
    const cuerpo = Object.assign({ accion: accion }, datos || {});
    if (st.sesion) cuerpo.token = st.sesion.token;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(API, { method: 'POST', body: JSON.stringify(cuerpo), redirect: 'follow', signal: ctrl.signal });
      if (!r.ok) throw new Error('El servidor respondió HTTP ' + r.status + '.');
      const j = await r.json();
      if (j && j.codigo === 'SESION' && accion !== 'login') sesionVencida(j.error);
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('El servidor no respondió a tiempo.');
      if (!navigator.onLine) throw new Error('Sin conexión a Internet.');
      if (e instanceof TypeError) throw new Error('No se pudo conectar con el servidor.');
      throw e;
    } finally { clearTimeout(t); }
  }

  // ── Vistas ──
  function ir(vista) {
    document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.id !== 'v-' + vista; });
    window.scrollTo(0, 0);
    if (vista === 'inicio') pintarInicio();
    if (vista === 'historial') cargarHistorial();
    if (vista === 'pendientes') pintarPendientes();
  }
  function estado(id, tipo, msg, detalle) {
    const e = $(id); if (!e) return;
    e.className = 'estado' + (tipo ? ' visible ' + tipo : '');
    e.innerHTML = tipo ? esc(msg) + (detalle ? '<span class="detalle">' + esc(detalle) + '</span>' : '') : '';
  }
  function conexion() { const c = $('conexion'); c.textContent = navigator.onLine ? 'EN LÍNEA' : 'SIN CONEXIÓN'; c.classList.toggle('off', !navigator.onLine); }

  // ── Sesión ──
  function sesionVencida(msg) {
    st.sesion = null; borrar(K.ses);
    ir('login');
    estado('l-estado', 'pendiente', msg || 'Tu sesión venció.', 'Ingresa de nuevo. Las solicitudes pendientes se conservan en este teléfono.');
  }
  async function ingresar(ev) {
    ev.preventDefault();
    const usuario = $('l-usuario').value.trim().toLowerCase(), codigo = $('l-codigo').value;
    if (!usuario || !codigo) { estado('l-estado', 'error', 'Ingresa tu usuario y tu código.'); return; }
    estado('l-estado', 'enviando', 'Verificando…');
    try {
      const r = await api('login', { usuario: usuario, codigo: codigo, dispositivo: dispositivo() });
      if (!r.ok) { estado('l-estado', 'error', r.error || 'No se pudo ingresar.'); return; }
      st.sesion = { token: r.token, usuario: r.usuario, nombre: r.nombre, uid: r.uid, cambiar: r.cambiar };
      guardar(K.ses, st.sesion); guardar(K.ult, r.usuario);
      $('l-codigo').value = ''; estado('l-estado', '');
      if (r.cambiar) { ir('definir'); return; }
      await cargarCatalogo(); ir('inicio'); sincronizar();
    } catch (e) { estado('l-estado', 'error', 'No se pudo ingresar.', e.message); }
  }
  async function definirCodigo(ev) {
    ev.preventDefault();
    const n = $('d-nuevo').value, r2 = $('d-repetir').value;
    if (n.length < 6) { estado('d-estado', 'error', 'El código debe tener al menos 6 caracteres.'); return; }
    if (n !== r2) { estado('d-estado', 'error', 'Los códigos no coinciden.'); return; }
    try {
      const r = await api('definirCodigo', { nuevo: n });
      if (!r.ok) { estado('d-estado', 'error', r.error); return; }
      st.sesion.cambiar = false; guardar(K.ses, st.sesion); $('d-nuevo').value = $('d-repetir').value = '';
      await cargarCatalogo(); ir('inicio'); sincronizar();
    } catch (e) { estado('d-estado', 'error', 'No se pudo guardar.', e.message); }
  }
  async function salir() {
    const mios = misPendientes().length;
    if (mios && !confirm('Tienes ' + mios + ' solicitud(es) sin enviar. Se conservan en el teléfono y se enviarán cuando vuelvas a ingresar. ¿Cerrar sesión?')) return;
    try { await api('salir', {}); } catch (e) { /* sin conexión: igual se cierra localmente */ }
    st.sesion = null; borrar(K.ses); borrar(K.cat); st.cat = null; ir('login');
  }

  // ── Catálogo (lo publica Plan Infra en Google) ──
  async function cargarCatalogo() {
    try {
      const r = await api('catalogo', {});
      if (r.ok) { st.cat = r.catalogo; guardar(K.cat, st.cat); return true; }
      estado('r-estado', 'error', r.error || 'No se pudo obtener el catálogo.');
    } catch (e) { st.cat = st.cat || leer(K.cat, null); }
    return false;
  }
  function pintarInicio() {
    $('i-nombre').textContent = st.sesion ? st.sesion.nombre : '';
    const c = $('i-plantas'); c.innerHTML = '';
    if (!st.cat) { $('i-catalogo').textContent = 'Sin datos de Plan Infra todavía. Toca «Actualizar datos» con conexión.'; }
    else {
      $('i-catalogo').textContent = 'Datos de Plan Infra publicados el ' + String(st.cat.publicado || '').replace('T', ' ') + '.';
      st.cat.plantas.forEach((p) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'mbtn';
        b.innerHTML = '<span class="ico">▣</span>' + esc(p.nombre) + (p.ot ? '<small>OT ' + esc(p.ot.codigo) + '</small>' : '<small>Sin OT semanal vigente</small>');
        b.disabled = !p.ot;
        b.addEventListener('click', () => abrirPlanta(p.codigo));
        c.appendChild(b);
      });
    }
    const n = misPendientes().length; $('i-pend').textContent = n ? String(n) : '';
  }

  // ── Registro ──
  function abrirPlanta(codigo) {
    const p = st.cat.plantas.find((x) => x.codigo === codigo);
    if (!p || !p.ot) return;
    st.planta = p;
    const b = leer(K.bor + codigo, null);
    st.tag = b && b.tag && p.tags.some((t) => t.id === b.tag.id) ? b.tag : null;
    st.lineas = b ? b.lineas || [] : [];
    $('r-obs').value = b ? b.obs || '' : '';
    $('r-titulo').textContent = 'Registrar materiales · ' + p.nombre;
    $('r-ot').innerHTML = '<b>' + esc(p.ot.codigo) + '</b>' + (p.ot.sap ? ' · SAP ' + esc(p.ot.sap) : ' · N° SAP pendiente') +
      '<span class="ayuda">Semana ' + esc(p.ot.inicio.slice(8, 10) + '-' + p.ot.inicio.slice(5, 7)) + ' al ' + esc(p.ot.fin.slice(8, 10) + '-' + p.ot.fin.slice(5, 7)) + '</span>';
    $('unidades').innerHTML = (st.cat.unidades || []).map((u) => '<option value="' + esc(u) + '">').join('');
    pintarTag(); pintarLineas(); estado('r-estado', b && (b.lineas || []).length ? 'pendiente' : '', 'Se recuperó un borrador sin enviar.');
    ir('form');
  }
  function guardarBorrador() { if (st.planta) guardar(K.bor + st.planta.codigo, { tag: st.tag, lineas: st.lineas, obs: $('r-obs').value }); }
  function pintarTag() {
    const ficha = $('r-tag-ficha'), buscar = $('r-tag-buscar');
    if (st.tag) {
      ficha.innerHTML = '<b>TAG ' + esc(st.tag.tag) + '</b><span class="ayuda">' + esc(st.tag.titulo) + ' · ' + esc(st.tag.estado) + '</span>' +
        '<button type="button" class="enlace" id="r-tag-cambiar">Cambiar TAG</button>';
      ficha.classList.remove('oculto'); buscar.classList.add('oculto');
      $('r-tag-cambiar').addEventListener('click', () => { st.tag = null; guardarBorrador(); pintarTag(); $('r-tag-q').focus(); });
    } else { ficha.classList.add('oculto'); buscar.classList.remove('oculto'); buscarTag(); }
  }
  function buscarTag() {
    const q = $('r-tag-q').value.trim().toLowerCase(), res = $('r-tag-res');
    res.innerHTML = '';
    if (q.length < 2) return;
    const hall = st.planta.tags.filter((t) => t.tag.toLowerCase().includes(q) || t.titulo.toLowerCase().includes(q)).slice(0, 15);
    if (!hall.length) { res.innerHTML = '<p class="aviso">No se encontró ese TAG en ' + esc(st.planta.nombre) + '. Revisa el número: no se crean TAG desde aquí.</p>'; return; }
    hall.forEach((t) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
      b.innerHTML = '<span class="t">TAG ' + esc(t.tag) + '</span><br><span class="s">' + esc(t.titulo) + ' · ' + esc(t.estado) + '</span>';
      b.addEventListener('click', () => { st.tag = t; $('r-tag-q').value = ''; guardarBorrador(); pintarTag(); });
      res.appendChild(b);
    });
  }
  const RE_COD = /^[A-Z0-9][A-Z0-9._\/-]{0,39}$/, RE_UNI = /^[A-Z0-9]{1,10}$/;
  function cantOk(v) { const t = String(v).trim().replace(',', '.'); return /^\d+(\.\d{1,3})?$/.test(t) && Number(t) > 0 && Number(t) <= 999999; }
  function agregar() {
    const l = { codigo: $('m-codigo').value.trim().toUpperCase(), descripcion: $('m-desc').value.trim(), cantidad: $('m-cant').value.trim(),
      unidad: $('m-uni').value.trim().toUpperCase(), observacion: $('m-obs').value.trim() };
    let err = '';
    if (!RE_COD.test(l.codigo)) err = 'Ingresa un código de material SAP válido.';
    else if (!l.descripcion) err = 'Ingresa la descripción.';
    else if (!cantOk(l.cantidad)) err = 'La cantidad debe ser mayor que cero (hasta 3 decimales).';
    else if (!RE_UNI.test(l.unidad)) err = 'Ingresa la unidad de medida.';
    else if (st.lineas.length >= 50) err = 'Máximo 50 materiales por solicitud.';
    const e = $('m-error'); e.textContent = err; e.classList.toggle('oculto', !err);
    if (err) return;
    st.lineas.push(l); guardarBorrador(); pintarLineas();
    ['m-codigo', 'm-desc', 'm-cant', 'm-obs'].forEach((id) => { $(id).value = ''; }); $('m-codigo').focus();
  }
  function pintarLineas() {
    const c = $('m-lista'); c.innerHTML = '';
    st.lineas.forEach((l, i) => {
      const d = document.createElement('div'); d.className = 'linea';
      d.innerHTML = '<div class="lt"><b>' + (i + 1) + '. ' + esc(l.codigo) + '</b> ' + esc(l.descripcion) + (l.observacion ? '<span class="ayuda">' + esc(l.observacion) + '</span>' : '') + '</div>' +
        '<input class="lc" inputmode="decimal" value="' + esc(l.cantidad) + '" aria-label="Cantidad línea ' + (i + 1) + '"><span class="lu">' + esc(l.unidad) + '</span>' +
        '<button type="button" class="lx" aria-label="Quitar línea ' + (i + 1) + '">✕</button>';
      d.querySelector('.lc').addEventListener('change', (ev) => { const v = ev.target.value.trim(); if (cantOk(v)) { l.cantidad = v; ev.target.classList.remove('invalido'); guardarBorrador(); } else ev.target.classList.add('invalido'); });
      d.querySelector('.lx').addEventListener('click', () => { st.lineas.splice(i, 1); guardarBorrador(); pintarLineas(); });
      c.appendChild(d);
    });
  }
  function enviar(ev) {
    ev.preventDefault();
    if (!st.tag) { estado('r-estado', 'error', 'Selecciona el TAG.'); return; }
    if (!st.lineas.length) { estado('r-estado', 'error', 'Agrega al menos un material.'); return; }
    if (document.querySelector('#m-lista .invalido')) { estado('r-estado', 'error', 'Corrige las cantidades marcadas en rojo.'); return; }
    const item = { origen_id: uuid(), uid: st.sesion.uid, estado: 'guardada', creada: ahoraIso(), error: '',
      solicitud: { planta: st.planta.codigo, planta_nombre: st.planta.nombre, ot_id: st.planta.ot.id, ot_codigo: st.planta.ot.codigo,
        work_order_id: st.tag.id, tag: st.tag.tag, titulo: st.tag.titulo, lineas: st.lineas.slice(), observacion: $('r-obs').value.trim(),
        dispositivo: dispositivo() } };
    item.solicitud.origen_id = item.origen_id; item.solicitud.creada = item.creada;
    const cola = leer(K.cola, []); cola.push(item);
    if (!guardar(K.cola, cola)) estado('r-estado', 'pendiente', 'Este teléfono no deja guardar datos: no cierres la app hasta que se envíe.');
    borrar(K.bor + st.planta.codigo); st.lineas = []; st.tag = null;
    mostrarDetalle(item); sincronizar();
  }

  // ── Cola local y sincronización ──
  function misPendientes() { return st.sesion ? leer(K.cola, []).filter((x) => x.uid === st.sesion.uid) : []; }
  async function sincronizar() {
    if (st.sinc || !st.sesion || st.sesion.cambiar) return;
    st.sinc = true; pintarSync();
    try {
      let cola = leer(K.cola, []);
      for (const item of cola.filter((x) => x.uid === st.sesion.uid && x.estado !== 'rechazada_google')) {
        try {
          const r = await api('enviar', { solicitud: item.solicitud });
          if (r.ok) {
            cola = leer(K.cola, []).filter((x) => x.origen_id !== item.origen_id); guardar(K.cola, cola);
            const h = leer(K.hist, {}); h[item.origen_id] = { recepcion: r.recepcion, recibida: r.recibida }; guardar(K.hist, h);
            refrescarDetalle(item.origen_id, { estado: 'pendiente_importacion', recepcion: r.recepcion, recibida: r.recibida });
          } else if (['VALIDACION', 'PERMISO', 'SIN_CATALOGO'].includes(r.codigo)) {
            marcar(item.origen_id, r.codigo === 'SIN_CATALOGO' ? 'pendiente' : 'rechazada_google', r.error);
          } else { marcar(item.origen_id, 'pendiente', r.error || 'El servidor no aceptó el envío.'); }
        } catch (e) { marcar(item.origen_id, 'pendiente', e.message); if (!navigator.onLine) break; }
      }
    } finally { st.sinc = false; pintarSync(); if (!$('v-inicio').hidden) pintarInicio(); if (!$('v-pendientes').hidden) pintarPendientes(); }
  }
  function marcar(id, est, error) {
    const cola = leer(K.cola, []); const x = cola.find((c) => c.origen_id === id);
    if (x) { x.estado = est; x.error = error || ''; guardar(K.cola, cola); refrescarDetalle(id, x); }
  }
  function pintarSync() {
    const b = $('sync'), mios = misPendientes();
    b.classList.remove('ok', 'error');
    if (st.sinc) { b.textContent = '⟳ Enviando solicitudes…'; b.classList.remove('oculto'); return; }
    if (mios.length) { b.textContent = '⏳ ' + mios.length + ' solicitud(es) guardadas en el teléfono' + (navigator.onLine ? '' : ' · sin conexión') + '. Toca para ver.'; b.classList.remove('oculto'); return; }
    b.classList.add('oculto');
  }
  function pintarPendientes() {
    const mios = misPendientes();
    $('p-lista').innerHTML = mios.length ? mios.map((x) => {
      const e = ESTADO_TXT[x.estado] || ESTADO_TXT.pendiente;
      return '<div class="item ' + e[1] + '"><span class="t">' + esc(x.solicitud.planta_nombre) + ' · TAG ' + esc(x.solicitud.tag) + '</span><br>' +
        '<span class="s">' + esc(x.creada.replace('T', ' ')) + ' · ' + x.solicitud.lineas.length + ' material(es) · <b>' + esc(e[0]) + '</b>' +
        (x.error ? '<br>' + esc(x.error) : '') + '</span>' +
        (x.estado === 'rechazada_google' ? '<br><button type="button" class="enlace" data-descartar="' + esc(x.origen_id) + '">Descartar</button>' : '') + '</div>';
    }).join('') : '<p class="nota">No hay solicitudes pendientes. Todo fue recibido por Google.</p>';
    document.querySelectorAll('[data-descartar]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('¿Descartar esta solicitud rechazada? No se envió a ningún lado.')) return;
      guardar(K.cola, leer(K.cola, []).filter((x) => x.origen_id !== b.dataset.descartar)); pintarPendientes(); pintarSync();
    }));
  }

  // ── Historial y detalle ──
  async function cargarHistorial() {
    const locales = misPendientes().map((x) => Object.assign({ origen_id: x.origen_id, estado: x.estado, recibida: '', recepcion: '', error: x.error, local: true }, x.solicitud));
    pintarHistorial(locales.concat(st.hist));
    estado('h-estado', 'enviando', 'Consultando estados…');
    try {
      const r = await api('historial', {});
      if (!r.ok) { estado('h-estado', 'error', r.error); return; }
      st.hist = r.solicitudes; guardar(K.hist + '_lista_' + st.sesion.uid, st.hist);
      estado('h-estado', ''); pintarHistorial(locales.concat(st.hist));
    } catch (e) { st.hist = leer(K.hist + '_lista_' + st.sesion.uid, []); pintarHistorial(locales.concat(st.hist)); estado('h-estado', 'pendiente', 'Sin conexión: se muestran los últimos estados conocidos.', e.message); }
  }
  function etiqueta(s) {
    if (s.estado === 'importada') return 'Importada en Plan Infra · ' + (s.comprobante || '') + (s.estado_planinfra ? ' · ' + s.estado_planinfra : '');
    return (ESTADO_TXT[s.estado] || [s.estado])[0];
  }
  function pintarHistorial(lista) {
    $('h-lista').innerHTML = lista.length ? '' : '<p class="nota">Aún no registras solicitudes.</p>';
    lista.forEach((s) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item ' + ((ESTADO_TXT[s.estado] || ['', ''])[1]);
      b.innerHTML = '<span class="t">' + esc(s.comprobante || s.recepcion || 'Sin enviar') + '</span> · ' + esc(s.planta_nombre || s.planta) + ' · TAG ' + esc(s.tag) +
        '<br><span class="s">' + esc((s.recibida || s.creada || '').replace('T', ' ')) + ' · ' + (s.lineas || []).length + ' material(es)<br><b>' + esc(etiqueta(s)) + '</b></span>';
      b.addEventListener('click', () => mostrarDetalle(s));
      $('h-lista').appendChild(b);
    });
  }
  let detalleId = null;
  function refrescarDetalle(id, cambios) { if (detalleId === id && !$('v-detalle').hidden) mostrarDetalle(Object.assign({}, st.detalle, cambios)); }
  function mostrarDetalle(x) {
    const s = x.solicitud ? Object.assign({ origen_id: x.origen_id, estado: x.estado, error: x.error, creada: x.creada }, x.solicitud) : x;
    st.detalle = s; detalleId = s.origen_id;
    const e = ESTADO_TXT[s.estado] || [s.estado, ''];
    let cab;
    if (s.estado === 'importada') cab = '<div class="estado visible ok">IMPORTADA EN PLAN INFRA<span class="detalle">Comprobante <b>' + esc(s.comprobante) + '</b>' + (s.estado_planinfra ? ' · ' + esc(s.estado_planinfra) : '') + '</span></div>';
    else if (s.estado === 'pendiente_importacion') cab = '<div class="estado visible pendiente">RECIBIDA POR GOOGLE<span class="detalle">N° de recepción <b>' + esc(s.recepcion) + '</b>. Todavía <b>no está en Plan Infra</b>: el comprobante MAT-… llegará cuando Plan Infra la importe.</span></div>';
    else if (s.estado === 'guardada' || s.estado === 'pendiente') cab = '<div class="estado visible pendiente">' + esc(e[0].toUpperCase()) + '<span class="detalle">Guardada en este teléfono. Se enviará sola cuando haya conexión. ' + esc(s.error || '') + '</span></div>';
    else cab = '<div class="estado visible error">' + esc(e[0].toUpperCase()) + '<span class="detalle">' + esc(s.mensaje || s.error || '') + '</span></div>';
    $('dt-cont').innerHTML = cab +
      '<dl class="datos"><dt>ID de origen</dt><dd class="mono">' + esc(s.origen_id) + '</dd>' +
      (s.recepcion ? '<dt>Recepción Google</dt><dd>' + esc(s.recepcion) + ' · ' + esc(s.recibida) + '</dd>' : '') +
      (s.comprobante ? '<dt>Comprobante</dt><dd>' + esc(s.comprobante) + '</dd>' : '') +
      '<dt>Planta</dt><dd>' + esc(s.planta_nombre || s.planta) + '</dd><dt>OT semanal</dt><dd>' + esc(s.ot_codigo || s.ot) + '</dd>' +
      '<dt>TAG</dt><dd>' + esc(s.tag) + '<br><span class="ayuda">' + esc(s.titulo) + '</span></dd>' +
      (s.observacion ? '<dt>Observación</dt><dd>' + esc(s.observacion) + '</dd>' : '') + '</dl>' +
      '<table class="tabla"><thead><tr><th>Código</th><th>Descripción</th><th>Cant.</th></tr></thead><tbody>' +
      (s.lineas || []).map((l) => '<tr><td>' + esc(l.codigo) + '</td><td>' + esc(l.descripcion) + '</td><td>' + esc(l.cantidad) + ' ' + esc(l.unidad) + '</td></tr>').join('') +
      '</tbody></table>';
    ir('detalle');
  }

  // ── Cuenta ──
  async function cambiarCodigo(ev) {
    ev.preventDefault();
    try {
      const r = await api('cambiarCodigo', { actual: $('c-actual').value, nuevo: $('c-nuevo').value });
      if (r.ok) { $('c-actual').value = $('c-nuevo').value = ''; estado('c-estado', 'ok', 'Código cambiado.'); }
      else estado('c-estado', 'error', r.error);
    } catch (e) { estado('c-estado', 'error', 'No se pudo cambiar.', e.message); }
  }

  // ── Arranque ──
  document.addEventListener('DOMContentLoaded', async () => {
    document.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', () => ir(b.dataset.ir)));
    $('f-login').addEventListener('submit', ingresar);
    $('f-definir').addEventListener('submit', definirCodigo);
    $('f-reg').addEventListener('submit', enviar);
    $('f-cuenta').addEventListener('submit', cambiarCodigo);
    $('b-salir').addEventListener('click', salir);
    $('b-actualizar').addEventListener('click', async () => { await cargarCatalogo(); pintarInicio(); sincronizar(); });
    $('m-agregar').addEventListener('click', agregar);
    $('r-tag-q').addEventListener('input', buscarTag);
    $('r-obs').addEventListener('change', guardarBorrador);
    $('p-sync').addEventListener('click', sincronizar);
    $('sync').addEventListener('click', () => { if (st.sesion) { ir('pendientes'); sincronizar(); } });
    window.addEventListener('online', () => { conexion(); sincronizar(); });
    window.addEventListener('offline', conexion);
    conexion();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    $('l-usuario').value = leer(K.ult, '');
    st.sesion = leer(K.ses, null); st.cat = leer(K.cat, null);
    if (!st.sesion) { ir('login'); return; }
    if (st.sesion.cambiar) { ir('definir'); return; }
    ir('inicio'); pintarSync();
    await cargarCatalogo(); if (!$('v-inicio').hidden) pintarInicio(); sincronizar();
  });
})();
