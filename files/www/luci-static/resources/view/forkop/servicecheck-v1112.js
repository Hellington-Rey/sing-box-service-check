"use strict";
"require view";
"require fs";
"require ui";

/*
 * Sing-box Service Check - страница проверки доступности сервисов.
 *
 * Страница намеренно не встраивается в SPA forkop: та собрана в один бандл
 * main.js, патчить который нельзя без пересборки. Здесь обычная LuCI-вьюха,
 * которая общается с /usr/bin/sing-box-service-check.
 *
 * Результаты показываются плитками: свёрнутая плитка отвечает на вопрос
 * "работает ли", развёрнутая - "что именно и на каком этапе сломалось".
 * Всё оформление - свой CSS без внешних ресурсов, чтобы страница работала
 * на любой теме LuCI и не тянула ни шрифтов, ни картинок.
 */

var BIN = "/usr/bin/sing-box-service-check";
var THEME_STORAGE_KEY = "forkop-servicecheck-theme";
var POLL_INTERVAL_MS = 1500;
var JOB_TIMEOUT_MS = 10 * 60 * 1000;
var UPDATE_TIMEOUT_MS = 10 * 60 * 1000;

var STATE_LABEL = {
  success: "работает",
  warning: "замечания",
  error: "не работает",
  skipped: "пропущено",
  udp_unconfirmed: "UDP не подтверждён",
  loading: "проверяем",
};

var VERDICT_LABEL = {
  ok: "OK",
  slow: "медленно",
  dns_fail: "DNS не отдал адрес",
  timeout: "таймаут",
  tcp_refused: "соединение отклонено",
  tls_error: "ошибка TLS",
  tls_handshake: "TLS оборван",
  tls_cert_rejected: "сертификат отклонён",
  tls_cert_untrusted: "часы или CA",
  tls_reset: "соединение сброшено",
  redirect_loop: "круг редиректов",
  route_mismatch: "неверный маршрут",
  route_unconfirmed: "маршрут не подтверждён",
  geo_blocked: "блокировка по IP/региону",
  gemini_api_key_invalid: "API-ключ невалиден",
  gemini_geo_error: "ошибка геопроверки",
  http_server_error: "ошибка на стороне сервиса",
  http_unexpected: "неожиданный ответ",
  failed: "ошибка",
  skipped: "пропущено",
};

var runState = {
  running: false,
  jobId: "",
  timer: null,
  cancelled: false,
};

var dnsRunState = {
  running: false,
  jobId: "",
  timer: null,
  cancelled: false,
};

var openTiles = {};

function callBin(args) {
  return fs.exec(BIN, args).then(function (result) {
    if ((result.code || 0) !== 0 && !result.stdout) {
      throw new Error(result.stderr || "команда завершилась с ошибкой");
    }

    try {
      return JSON.parse(result.stdout);
    } catch (e) {
      throw new Error("не удалось разобрать ответ: " + (result.stdout || result.stderr || ""));
    }
  });
}

function injectStyles() {
  if (document.getElementById("fkpsc-styles")) {
    return;
  }

  var css = [
    /* Цвета статусов держим в одном месте: они одинаково читаются */
    /* и на светлой, и на тёмной теме LuCI. */
    ".fkpsc { --ok:#2f9e44; --warn:#e8a33d; --err:#e03131; --skip:#868e96; --accent:#367fc7; --accent-border:rgba(54,127,199,.38); --surface:#f4f6f8; --surface-soft:#e9edf1; --surface-raised:#fff; --text:#17191c; --muted:#505862; --field:#fff; --field-text:#17191c; --border-soft:#d9dfe5; --border:#c4ccd4; --border-strong:#9ba8b5; --field-border:#9ba8b5; box-sizing:border-box; padding:1em; border-radius:14px; background:var(--surface); color:var(--text) !important; color-scheme:light; }",
    ".fkpsc.theme-light, .fkpsc.theme-auto.theme-inherited-light { --accent:#367fc7; --accent-border:rgba(54,127,199,.38); --surface:#f4f6f8; --surface-soft:#e9edf1; --surface-raised:#fff; --text:#17191c; --muted:#505862; --field:#fff; --field-text:#17191c; --border-soft:#d9dfe5; --border:#c4ccd4; --border-strong:#9ba8b5; --field-border:#9ba8b5; color-scheme:light; }",
    ".fkpsc.theme-dark, .fkpsc.theme-auto.theme-inherited-dark { --accent:#55a7ef; --accent-border:rgba(85,167,239,.22); --surface:#15171a; --surface-soft:#20242a; --surface-raised:#1b1f24; --text:#f1f4f7; --muted:#aeb8c3; --field:#111419; --field-text:#f5f7fa; --border-soft:#22282f; --border:#2a3139; --border-strong:#38424d; --field-border:#3b4652; color-scheme:dark; }",
    ".fkpsc h1, .fkpsc h2, .fkpsc h3, .fkpsc h4, .fkpsc h5, .fkpsc h6, .fkpsc label, .fkpsc b, .fkpsc strong { color:var(--text) !important; }",
    ".fkpsc input:not([type=radio]):not([type=checkbox]), .fkpsc select, .fkpsc textarea { color:var(--field-text) !important; background:var(--field) !important; border-color:var(--field-border) !important; }",
    ".fkpsc input::placeholder, .fkpsc textarea::placeholder { color:var(--muted) !important; opacity:.85; }",
    ".fkpsc input[type=radio], .fkpsc input[type=checkbox] { accent-color:var(--accent); }",
    ".fkpsc .fkpsc-dim, .fkpsc .fkpsc-meta, .fkpsc .fkpsc-tile-status { color:var(--muted) !important; opacity:1; }",
    ".fkpsc-theme-line { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.75em; margin-bottom:.7em; text-align:center; }",
    ".fkpsc-theme-line h2 { margin:0; }",
    ".fkpsc .cbi-button { border-color:var(--border-strong) !important; }",
    ".fkpsc-theme-switch { display:inline-flex; gap:.2em; padding:.2em; border:1px solid var(--border); border-radius:9px; background:var(--surface-soft); }",
    ".fkpsc-theme-button { padding:.35em .65em; border:0; border-radius:6px; background:transparent; color:var(--text) !important; cursor:pointer; font-size:.86em; font-weight:600; }",
    ".fkpsc-theme-button.active { color:#fff !important; background:var(--accent); box-shadow:0 2px 7px rgba(0,0,0,.18); }",
    ".fkpsc-hero { padding:1.15em 1.25em; margin-bottom:1em; border-radius:12px; background:var(--surface-raised); border:1px solid var(--border); box-shadow:0 5px 18px rgba(0,0,0,.10); text-align:center; }",
    ".fkpsc-hero h2 { margin:.05em 0 .35em; font-size:1.55em; }",
    ".fkpsc-hero > p { max-width:62em; margin:.2em auto 0; }",
    ".fkpsc-badges { display:flex; flex-wrap:wrap; justify-content:center; gap:.45em; margin-top:.8em; }",
    ".fkpsc-badge { padding:.25em .65em; border-radius:999px; background:var(--surface-soft); border:1px solid var(--border-soft); font-size:.84em; }",
    ".fkpsc-card { padding:1em 1.1em; margin:0 0 1em; border-radius:12px; border:1px solid var(--border); background:var(--surface-raised); box-shadow:0 5px 18px rgba(0,0,0,.10); }",
    ".fkpsc-card h3 { margin:.05em 0 .75em; }",
    ".fkpsc-update-row { display:flex; flex-wrap:wrap; align-items:center; gap:.65em; }",
    ".fkpsc-vpn-import { display:flex; flex-wrap:wrap; align-items:center; gap:.55em; margin:.55em 0 .2em; }",
    ".fkpsc-vpn-filename { min-width:0; color:var(--muted) !important; font-size:.84em; overflow-wrap:anywhere; }",
    ".fkpsc-update-status { flex:1 1 260px; min-width:0; }",
    ".fkpsc-update-actions { display:flex; flex-wrap:wrap; gap:.5em; }",
    ".fkpsc-tabs { display:flex; flex-wrap:wrap; gap:.35em; margin:0 0 1em; padding:.25em; border-radius:11px; background:var(--surface-soft); border:1px solid var(--border-soft); }",
    ".fkpsc-tab { flex:0 1 auto; padding:.55em .9em; border:0; border-radius:8px; background:transparent; color:inherit; cursor:pointer; font-weight:600; }",
    ".fkpsc-tab.active { color:#fff; background:var(--accent); box-shadow:0 2px 8px rgba(0,0,0,.18); }",
    ".fkpsc-page { display:none; } .fkpsc-page.active { display:block; }",
    ".fkpsc-vpn-tabs { display:flex; flex-wrap:wrap; gap:.45em; margin:0 0 .8em; }",
    ".fkpsc-vpn-tab { padding:.55em .9em; border:1px solid var(--border); border-radius:8px; background:var(--surface-raised); color:inherit; cursor:pointer; font-weight:600; }",
    ".fkpsc-vpn-tab:hover { border-color:var(--border-strong); background:var(--surface-soft); }",
    ".fkpsc-vpn-tab.active { border-color:var(--accent-border); color:#fff; background:var(--accent); box-shadow:0 2px 8px rgba(0,0,0,.16); }",
    ".fkpsc-vpn-panel { display:none; }",
    ".fkpsc-vpn-panel.active { display:block; }",
    ".fkpsc-list-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:.55em; margin:.8em 0 1em; }",
    ".fkpsc-list-toolbar .fkpsc-source { margin-right:auto; padding:.3em .7em; border-radius:999px; background:var(--surface-soft); }",
    ".fkpsc-profile-edit { padding:1em; margin:0 0 1em; border:1px solid var(--border); border-radius:12px; background:var(--surface-soft); box-shadow:0 3px 12px rgba(0,0,0,.08); }",
    ".fkpsc-profile-head { display:flex; align-items:center; gap:.55em; margin-bottom:.8em; }",
    ".fkpsc-profile-number { display:inline-flex; align-items:center; justify-content:center; min-width:2em; height:2em; border-radius:50%; color:#fff; background:var(--accent); font-weight:700; }",
    ".fkpsc-profile-name { flex:1 1 auto; font-size:1.05em; font-weight:700; overflow-wrap:anywhere; }",
    ".fkpsc-editor-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.75em; }",
    ".fkpsc-diagnostic-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:.6em; margin-top:.8em; }",
    ".fkpsc-diagnostic-cell { padding:.7em .8em; border:1px solid var(--border-soft); border-radius:8px; background:var(--surface-soft); }",
    ".fkpsc-diagnostic-cell b { display:block; margin-bottom:.2em; font-size:.82em; }",
    ".fkpsc-diagnostic-cell span { color:var(--muted); word-break:break-word; }",
    ".fkpsc-editor-field { display:flex; flex-direction:column; gap:.3em; min-width:0; }",
    ".fkpsc-editor-field.wide { grid-column:1/-1; }",
    ".fkpsc-editor-field > span { font-size:.82em; font-weight:600; opacity:.72; }",
    ".fkpsc-editor-field input, .fkpsc-editor-field select, .fkpsc-editor-field textarea { box-sizing:border-box; width:100%; border:1px solid var(--field-border); border-radius:7px; }",
    ".fkpsc-editor-field textarea { min-height:4.8em; resize:vertical; }",
    ".fkpsc-targets-title { display:flex; align-items:center; justify-content:space-between; gap:.5em; margin:1em 0 .55em; font-weight:700; }",
    ".fkpsc-target-edit { margin:.55em 0; padding:.8em; border:1px solid var(--border); border-radius:9px; background:var(--surface-raised); }",
    ".fkpsc-target-head { display:flex; align-items:center; gap:.45em; margin-bottom:.65em; }",
    ".fkpsc-target-head b { flex:1 1 auto; }",
    ".fkpsc-icon-button { min-width:2.35em; padding:.35em .55em; }",
    ".fkpsc-add-profile { width:100%; min-height:3.2em; border:1px dashed var(--accent); border-radius:10px; background:var(--surface-soft); color:inherit; font-weight:700; cursor:pointer; }",
    ".fkpsc-fix { padding:.75em; border:1px solid var(--border-soft); border-radius:9px; background:var(--surface-soft); margin-bottom:.55em; }",
    ".fkpsc-fix-title { font-weight:600; margin-bottom:.25em; }",
    ".fkpsc-intro { margin-bottom: 1em; line-height: 1.55; max-width: 60em; }",
    ".fkpsc-note { background: rgba(232,163,61,.12); border-left: 3px solid var(--warn); padding: .65em .9em; margin: .9em 0; border-radius: 0 6px 6px 0; line-height: 1.5; }",

    /* --- выбор сервисов: категории и компактные чипы --- */
    ".fkpsc-service-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(245px,1fr)); gap:.65em; margin:.7em 0 1.1em; align-items:start; }",
    ".fkpsc-service-group { min-width:0; padding:.7em; border:1px solid var(--border-soft); border-radius:10px; background:var(--surface-soft); }",
    ".fkpsc-service-group.has-selection { border-color:var(--border); }",
    ".fkpsc-group-head { display:flex; align-items:center; gap:.45em; min-height:1.75em; margin:0 .1em .55em; }",
    ".fkpsc-group-mark { width:.5em; height:.5em; flex:none; border-radius:50%; background:var(--group-color,var(--muted)); box-shadow:0 0 0 3px rgba(127,127,127,.10); }",
    ".fkpsc-group-name { min-width:0; flex:1 1 auto; font-size:.82em; font-weight:700; letter-spacing:.025em; text-transform:uppercase; }",
    ".fkpsc-group-count { color:var(--muted) !important; font-size:.78em; font-variant-numeric:tabular-nums; }",
    ".fkpsc-group-toggle { padding:.12em .3em; border:0; background:transparent; color:var(--accent) !important; cursor:pointer; font-size:.78em; }",
    ".fkpsc-group-toggle:hover { text-decoration:underline; }",
    ".fkpsc-group-picks { display:flex; flex-wrap:wrap; gap:.4em; }",
    ".fkpsc-pick { display:inline-flex; align-items:center; gap:.4em; max-width:100%; padding:.38em .72em; border-radius:999px; border:1px solid var(--border-soft); cursor:pointer; user-select:none; font-size:.9em; line-height:1.2; transition:background .15s ease,border-color .15s ease; background:var(--surface-raised); }",
    ".fkpsc-pick > span:nth-child(2) { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".fkpsc-pick:hover { border-color:var(--border-strong); background:var(--surface-soft); }",
    ".fkpsc-pick .tick { width: 1em; height: 1em; border-radius: 50%; border: 1px solid var(--border-strong); display: inline-block; position: relative; flex: none; }",
    ".fkpsc-pick.on { border-color:var(--accent-border); background:rgba(74,144,217,.12); }",
    ".fkpsc-pick.on .tick { background: var(--accent); border-color: var(--accent); }",
    ".fkpsc-pick.on .tick::after { content: ''; position: absolute; left: .3em; top: .12em; width: .22em; height: .45em; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }",
    ".fkpsc-pick .num { color:var(--muted) !important; font-size:.78em; font-variant-numeric:tabular-nums; }",

    /* --- панель управления --- */
    ".fkpsc-mode label { display: block; margin-bottom: .35em; cursor: pointer; }",
    ".fkpsc-actions { display: flex; gap: .6em; flex-wrap: wrap; align-items: center; margin: 0 0 1.2em; }",
    ".fkpsc-progress { flex: 1 1 200px; min-width: 150px; height: 6px; background: rgba(127,127,127,.22); border-radius: 3px; overflow: hidden; }",
    ".fkpsc-progress > div { height: 100%; width: 0; background: var(--accent); transition: width .35s ease; }",
    ".fkpsc-custom-form { display:flex; flex-wrap:wrap; gap:.55em; align-items:center; margin:.55em 0 .75em; }",
    ".fkpsc-custom-target { flex:1 1 260px; min-width:180px; }",
    ".fkpsc-custom-port { width:7em; }",
    ".fkpsc-custom-port-label { display:flex; gap:.35em; align-items:center; }",
    ".fkpsc-custom-result { margin:.7em 0 1.15em; padding:.8em .9em; border-radius:9px; border-left:4px solid var(--skip); background:var(--surface-soft); }",
    ".fkpsc-custom-result.state-success { border-left-color:var(--ok); }",
    ".fkpsc-custom-result.state-warning { border-left-color:var(--warn); }",
    ".fkpsc-custom-result.state-error { border-left-color:var(--err); }",
    ".fkpsc-custom-head { display:flex; flex-wrap:wrap; gap:.45em; align-items:center; margin-bottom:.35em; }",
    ".fkpsc-custom-title { font-weight:700; margin-right:auto; }",
    ".fkpsc-custom-pill { padding:.18em .6em; border-radius:999px; background:rgba(127,127,127,.16); font-size:.84em; font-weight:600; }",
    ".fkpsc-custom-pill.ok { color:var(--ok); background:rgba(47,158,68,.13); }",
    ".fkpsc-custom-pill.warn { color:#9a6500; background:rgba(232,163,61,.16); }",
    ".fkpsc-custom-pill.err { color:var(--err); background:rgba(224,49,49,.13); }",
    ".fkpsc-vpn-grid { display:grid; grid-template-columns:minmax(11em,.4fr) minmax(12em,.5fr) 1fr; gap:.75em; margin:.7em 0; }",
    ".fkpsc-vpn-config { box-sizing:border-box; width:100%; min-height:18em; resize:vertical; font-family:monospace; font-size:.88em; line-height:1.4; }",
    ".fkpsc-vpn-manual { display:flex; flex-wrap:wrap; align-items:flex-end; gap:.65em; margin:.9em 0; padding:.8em; border:1px solid var(--border-soft); border-radius:9px; background:var(--surface-soft); }",
    ".fkpsc-vpn-manual .fkpsc-editor-field { flex:1 1 220px; }",
    ".fkpsc-vpn-manual .cbi-button { min-height:2.35em; }",
    ".fkpsc-converter-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.8em; margin:.75em 0; }",
    ".fkpsc-converter-pane { display:flex; flex-direction:column; gap:.35em; min-width:0; }",
    ".fkpsc-converter-pane > span { font-size:.82em; font-weight:600; opacity:.72; }",
    ".fkpsc-converter-text { box-sizing:border-box; width:100%; min-height:13em; resize:vertical; font-family:monospace; font-size:.86em; line-height:1.4; overflow-wrap:anywhere; }",
    ".fkpsc-converter-actions { display:flex; flex-wrap:wrap; gap:.55em; align-items:center; margin:.4em 0; }",
    ".fkpsc-converter-status { min-height:1.4em; margin:.45em 0 0; color:var(--muted) !important; font-size:.88em; }",
    ".fkpsc-converter-status.ok { color:var(--ok) !important; }",
    ".fkpsc-converter-status.err { color:var(--err) !important; }",
    ".fkpsc-dns-form { display:flex; flex-wrap:wrap; align-items:center; gap:.6em; margin:.8em 0; }",
    ".fkpsc-dns-domain { flex:1 1 280px; min-width:190px; }",
    ".fkpsc-dns-groups { display:grid; gap:1em; }",
    ".fkpsc-dns-group { padding:1em; border:1px solid var(--border); border-radius:11px; background:var(--surface-raised); box-shadow:0 4px 14px rgba(0,0,0,.08); }",
    ".fkpsc-dns-group-head { display:flex; flex-wrap:wrap; justify-content:space-between; gap:.5em; align-items:baseline; margin-bottom:.7em; }",
    ".fkpsc-dns-group-head h3 { margin:0; }",
    ".fkpsc-dns-row { display:grid; grid-template-columns:minmax(7.5em,1fr) minmax(10em,1.4fr) 6em minmax(12em,2fr); gap:.7em; align-items:center; padding:.55em .65em; margin:.35em 0; border-left:3px solid var(--skip); border-radius:0 7px 7px 0; background:var(--surface-soft); }",
    ".fkpsc-dns-row.state-success { border-left-color:var(--ok); }",
    ".fkpsc-dns-row.state-error { border-left-color:var(--err); }",
    ".fkpsc-dns-host { font-family:monospace; overflow-wrap:anywhere; }",
    ".fkpsc-dns-time { font-family:monospace; font-weight:700; white-space:nowrap; }",
    ".fkpsc-dns-answer { overflow-wrap:anywhere; }",

    /* --- сводка --- */
    ".fkpsc-summary { display: flex; flex-wrap: wrap; gap: .5em; margin: 0 0 1em; }",
    ".fkpsc-sum { display: inline-flex; align-items: baseline; gap: .4em; padding: .35em .75em; border:1px solid var(--border-soft); border-radius: 8px; background:var(--surface-raised); font-size: .92em; }",
    ".fkpsc-sum b { font-size: 1.15em; }",
    ".fkpsc-sum.ok b { color: var(--ok); }",
    ".fkpsc-sum.warn b { color: var(--warn); }",
    ".fkpsc-sum.err b { color: var(--err); }",

    /* --- сетка плиток --- */
    ".fkpsc-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: .75em; align-items: start; }",
    ".fkpsc-tile { border: 1px solid var(--border); border-radius: 10px; background:var(--surface-raised); box-shadow:0 3px 12px rgba(0,0,0,.10); overflow: hidden; transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease; position: relative; }",
    ".fkpsc-tile::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--skip); z-index: 1; }",
    ".fkpsc-tile.state-success::before { background: var(--ok); }",
    ".fkpsc-tile.state-warning::before { background: var(--warn); }",
    ".fkpsc-tile.state-error::before { background: var(--err); }",
    ".fkpsc-tile:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,.16); border-color: var(--border-strong); }",
    ".fkpsc-tile.open { grid-column: 1 / -1; transform: none; box-shadow: 0 4px 18px rgba(0,0,0,.14); }",
    ".fkpsc-tile-header { cursor: pointer; user-select: none; border-radius: 10px 10px 0 0; transition: background .15s ease; }",
    ".fkpsc-tile-header:hover { background: rgba(127,127,127,.07); }",
    ".fkpsc-tile-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }",
    ".fkpsc-tile-head { display: flex; align-items: center; gap: .5em; padding: .8em .9em .1em; }",
    ".fkpsc-dot { width: .7em; height: .7em; border-radius: 50%; flex: none; background: var(--skip); }",
    ".state-success .fkpsc-dot { background: var(--ok); box-shadow: 0 0 0 3px rgba(47,158,68,.18); }",
    ".state-warning .fkpsc-dot { background: var(--warn); box-shadow: 0 0 0 3px rgba(232,163,61,.18); }",
    ".state-error .fkpsc-dot { background: var(--err); box-shadow: 0 0 0 3px rgba(224,49,49,.18); }",
    ".fkpsc-tile-title { font-weight: 600; font-size: 1.02em; flex: 1 1 auto; }",
    ".fkpsc-chev { opacity: .45; font-size: .8em; transition: transform .18s ease; flex: none; }",
    ".fkpsc-tile.open .fkpsc-chev { transform: rotate(180deg); }",
    ".fkpsc-tile-status { padding: 0 .9em .1em 2.1em; opacity: .75; font-size: .9em; }",
    ".fkpsc-tile-foot { padding: .5em .9em .8em 2.1em; display: flex; align-items: center; gap: .5em; }",
    ".fkpsc-bar { display: flex; gap: 2px; flex: 1 1 auto; height: 5px; }",
    ".fkpsc-bar > i { flex: 1 1 auto; border-radius: 2px; background: var(--skip); opacity: .85; }",
    ".fkpsc-bar > i.success { background: var(--ok); }",
    ".fkpsc-bar > i.warning { background: var(--warn); }",
    ".fkpsc-bar > i.error { background: var(--err); }",
    ".fkpsc-count { font-size: .85em; opacity: .6; white-space: nowrap; }",
    ".fkpsc-tile.loading .fkpsc-dot { animation: fkpsc-pulse 1.1s ease-in-out infinite; }",
    "@keyframes fkpsc-pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }",

    /* --- раскрытая часть --- */
    ".fkpsc-detail { display: none; padding: .3em .9em 1em; border-top: 1px solid var(--border-soft); margin-top: .5em; animation: fkpsc-fade .2s ease; }",
    ".fkpsc-tile.open .fkpsc-detail { display: block; }",
    "@keyframes fkpsc-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }",
    ".fkpsc-detail-note { opacity: .7; font-size: .9em; margin: .7em 0 .3em; }",
    ".fkpsc-sect { font-size: .82em; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 1em 0 .5em; }",
    ".fkpsc-row { border:1px solid var(--border-soft); border-left: 3px solid var(--skip); border-radius: 0 6px 6px 0; background:var(--surface-soft); padding: .6em .8em; margin-bottom: .5em; }",
    ".fkpsc-row.state-success { border-left-color: var(--ok); }",
    ".fkpsc-row.state-warning { border-left-color: var(--warn); }",
    ".fkpsc-row.state-error { border-left-color: var(--err); }",
    ".fkpsc-row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5em; }",
    ".fkpsc-row-name { font-weight: 600; }",
    ".fkpsc-row-url { font-family: monospace; font-size: .85em; opacity: .55; word-break: break-all; }",
    ".fkpsc-verdict { margin-left: auto; padding: .1em .55em; border-radius: 999px; font-size: .8em; font-weight: 600; color: #fff; background: var(--skip); white-space: nowrap; }",
    /* Правила привязаны к самой строке, а не к предку: у плитки свой класс */
    /* состояния, и через потомка он перекрашивал текст до нечитаемого. */
    ".fkpsc-row.state-success .fkpsc-verdict { background: var(--ok); color: #fff; }",
    ".fkpsc-row.state-warning .fkpsc-verdict { background: var(--warn); color: #2b2410; }",
    ".fkpsc-row.state-error .fkpsc-verdict { background: var(--err); color: #fff; }",
    ".fkpsc-row.state-skipped .fkpsc-verdict { background: var(--skip); color: #fff; }",
    ".fkpsc-row-msg { margin-top: .35em; font-size: .93em; }",

    /* --- этапы: DNS -> TCP -> TLS -> HTTP --- */
    ".fkpsc-stages { display: flex; flex-wrap: wrap; align-items: center; gap: .3em; margin-top: .55em; }",
    ".fkpsc-stage { display: inline-flex; align-items: center; gap: .3em; padding: .15em .5em; border-radius: 5px; font-size: .8em; background: rgba(127,127,127,.15); }",
    ".fkpsc-stage.ok { color: var(--ok); }",
    ".fkpsc-stage.fail { background: rgba(224,49,49,.16); color: var(--err); font-weight: 600; }",
    ".fkpsc-stage.skip { opacity: .4; }",
    ".fkpsc-arrow { opacity: .3; font-size: .75em; }",
    ".fkpsc-facts { display: flex; flex-wrap: wrap; gap: .3em; margin-top: .5em; }",
    ".fkpsc-fact { font-size: .8em; padding: .12em .5em; border-radius: 5px; background: rgba(127,127,127,.13); font-family: monospace; }",
    ".fkpsc-fact.hl { background: rgba(74,144,217,.18); }",
    ".fkpsc-okline { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5em; padding: .3em .1em; font-size: .9em; border-bottom: 1px solid var(--border-soft); }",
    ".fkpsc-okline .nm { flex: 1 1 12em; }",
    ".fkpsc-okline .tm { opacity: .5; font-family: monospace; font-size: .88em; }",
    ".fkpsc-meta { margin: .3em 0 1.1em; opacity: .7; line-height: 1.6; font-size: .92em; }",
    ".fkpsc-dim { color:var(--muted) !important; opacity:1; }",
    ".fkpsc-empty { opacity: .6; padding: 2em 1em; text-align: center; }",

    /* --- настройки Gemini API --- */
    ".fkpsc-settings { margin: .9em 0 .2em; border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; }",
    ".fkpsc-settings-toggle { display: flex; align-items: center; gap: .5em; padding: .55em .8em; cursor: pointer; user-select: none; background: rgba(127,127,127,.08); font-size: .9em; font-weight: 600; }",
    ".fkpsc-settings-toggle:hover { background: rgba(127,127,127,.14); }",
    ".fkpsc-settings-toggle .arr { font-size: .7em; opacity: .5; transition: transform .15s ease; }",
    ".fkpsc-settings.open .fkpsc-settings-toggle .arr { transform: rotate(90deg); }",
    ".fkpsc-settings-body { display: none; padding: .7em .9em; border-top: 1px solid var(--border-soft); }",
    ".fkpsc-settings.open .fkpsc-settings-body { display: block; }",
    ".fkpsc-settings-row { display: flex; align-items: center; gap: .5em; flex-wrap: wrap; margin-bottom: .5em; }",
    ".fkpsc-settings-row input[type=password] { flex: 1 1 14em; min-width: 10em; font-family: monospace; padding: .35em .5em; border: 1px solid var(--field-border); border-radius: 5px; background: transparent; color: inherit; }",
    ".fkpsc-settings-status { font-size: .85em; opacity: .7; }",
    ".fkpsc-settings-msg { display: none; font-size: .85em; padding: .3em .5em; border-radius: 5px; margin-top: .3em; }",
    ".fkpsc-settings-msg.ok { display: block; background: rgba(47,158,68,.15); color: var(--ok); }",
    ".fkpsc-settings-msg.err { display: block; background: rgba(224,49,49,.15); color: var(--err); }",
    ".fkpsc-service-tools { display:flex; flex-wrap:wrap; gap:.45em; align-items:center; margin:.45em 0; }",
    ".fkpsc-search { flex:1 1 190px; min-width:150px; }",
    "@media (max-width:600px) {",
    "  .fkpsc { padding:.55em; border-radius:10px; }",
    "  .fkpsc-hero { padding:.85em .9em; border-radius:10px; }",
    "  .fkpsc-hero h2 { font-size:1.3em; }",
    "  .fkpsc-theme-line { align-items:center; }",
    "  .fkpsc-theme-switch { width:100%; box-sizing:border-box; }",
    "  .fkpsc-theme-button { flex:1 1 30%; }",
    "  .fkpsc-dns-row { grid-template-columns:1fr auto; gap:.3em .6em; }",
    "  .fkpsc-vpn-grid { grid-template-columns:1fr; }",
    "  .fkpsc-vpn-tab { flex:1 1 45%; }",
    "  .fkpsc-vpn-manual .cbi-button { flex:1 1 100%; }",
    "  .fkpsc-converter-grid { grid-template-columns:1fr; }",
    "  .fkpsc-dns-host, .fkpsc-dns-answer { grid-column:1/-1; }",
    "  .fkpsc-tabs { position:sticky; top:0; z-index:20; }",
    "  .fkpsc-tab { flex:1 1 30%; padding:.65em .35em; }",
    "  .fkpsc-card { padding:.8em; border-radius:9px; }",
    "  .fkpsc-editor-grid { grid-template-columns:1fr; }",
    "  .fkpsc-editor-field.wide { grid-column:auto; }",
    "  .fkpsc-profile-edit { padding:.75em; }",
    "  .fkpsc-profile-head { flex-wrap:wrap; }",
    "  .fkpsc-actions .cbi-button { flex:1 1 45%; min-height:2.6em; }",
    "  .fkpsc-service-groups { grid-template-columns:1fr; gap:.5em; }",
    "  .fkpsc-service-group { padding:.65em; }",
    "  .fkpsc-pick { padding:.42em .65em; }",
    "  .fkpsc-tiles { grid-template-columns:1fr; }",
    "}",
  ].join("\n");

  document.head.appendChild(E("style", { id: "fkpsc-styles" }, css));
}
function formatMs(value) {
  value = parseInt(value, 10) || 0;
  return value > 0 ? value + " мс" : "—";
}

/*
 * Этапы соединения. Главная ценность раскрытой плитки: видно не только
 * "не работает", но и на каком именно шаге всё встало.
 */
function stagesFor(item) {
  var verdict = item.verdict || "";
  var dnsOk = !!item.dns_ok;
  var tcpFailed = verdict === "timeout" || verdict === "tcp_refused";
  var tlsFailed = verdict === "tls_error" || verdict === "tls_reset" ||
    verdict === "tls_handshake" || verdict === "tls_cert_rejected" || verdict === "tls_cert_untrusted";
  var stages = [];

  stages.push({ name: "DNS", state: dnsOk ? "ok" : (verdict === "dns_fail" ? "fail" : "skip") });

  if (item.kind === "tcp" || item.kind === "udp" || item.kind === "udp_dns") {
    stages.push({
      name: item.kind === "udp" || item.kind === "udp_dns" ? "UDP" : "TCP",
      state: !dnsOk ? "skip" : (tcpFailed ? "fail" : (item.state === "skipped" || verdict === "udp_unconfirmed" ? "skip" : "ok")),
    });
    return stages;
  }

  stages.push({ name: "TCP", state: !dnsOk ? "skip" : (tcpFailed ? "fail" : "ok") });
  stages.push({ name: "TLS", state: (!dnsOk || tcpFailed) ? "skip" : (tlsFailed ? "fail" : "ok") });
  stages.push({ name: "HTTP", state: item.http_code > 0 ? "ok" : "skip" });

  return stages;
}

function renderStages(item) {
  var nodes = [];

  stagesFor(item).forEach(function (stage, index) {
    if (index > 0) {
      nodes.push(E("span", { class: "fkpsc-arrow" }, "→"));
    }

    var mark = stage.state === "ok" ? "✓" : (stage.state === "fail" ? "✕" : "·");
    nodes.push(E("span", { class: "fkpsc-stage " + stage.state }, [
      E("span", {}, mark),
      E("span", {}, stage.name),
    ]));
  });

  return E("div", { class: "fkpsc-stages" }, nodes);
}

function renderFacts(item) {
  var facts = [];

  if (item.dns_ip) {
    facts.push({ text: item.dns_ip + (item.dns_fakeip ? " · fakeip" : ""), hl: !!item.dns_fakeip });
  }

  if (item.http_code > 0) {
    facts.push({ text: "HTTP " + item.http_code });
  }

  if (item.tcp_ms > 0) {
    facts.push({ text: "TCP " + formatMs(item.tcp_ms) });
  }

  if (item.tls_ms > 0) {
    facts.push({ text: "TLS " + formatMs(item.tls_ms) });
  }

  if (item.total_ms > 0) {
    facts.push({ text: "всего " + formatMs(item.total_ms) });
  }

  if (item.remote_ip && item.remote_ip !== item.dns_ip) {
    facts.push({ text: "→ " + item.remote_ip });
  }

  if (item.outbound) {
    facts.push({ text: "через " + item.outbound, hl: true });
  }

  if (item.expected_route && item.expected_route !== "any") {
    facts.push({ text: "ожидался " + item.expected_route });
  }

  if (!facts.length) {
    return "";
  }

  return E("div", { class: "fkpsc-facts" }, facts.map(function (fact) {
    return E("span", { class: "fkpsc-fact" + (fact.hl ? " hl" : "") }, fact.text);
  }));
}

function renderProblemRow(item) {
  var head = [
    E("span", { class: "fkpsc-row-name" }, item.label),
  ];

  if (item.url) {
    head.push(E("span", { class: "fkpsc-row-url" }, item.url));
  }

  head.push(E("span", { class: "fkpsc-verdict" }, VERDICT_LABEL[item.verdict] || item.verdict || STATE_LABEL[item.state]));

  var body = [E("div", { class: "fkpsc-row-head" }, head)];

  if (item.message) {
    body.push(E("div", { class: "fkpsc-row-msg" }, item.message));
  }

  if (item.optional) {
    body.push(E("div", { class: "fkpsc-dim", style: "font-size:.85em;margin-top:.2em" },
      "необязательная цель — на общий вердикт не влияет"));
  }

  body.push(renderStages(item));

  var facts = renderFacts(item);
  if (facts) {
    body.push(facts);
  }

  return E("div", { class: "fkpsc-row state-" + item.state }, body);
}

function renderOkLine(item) {
  var timing = item.total_ms > 0 ? formatMs(item.total_ms) : (item.tcp_ms > 0 ? formatMs(item.tcp_ms) : "");

  return E("div", { class: "fkpsc-okline" }, [
    E("span", { class: "nm" }, item.label),
    item.dns_fakeip ? E("span", { class: "fkpsc-fact hl" }, "через прокси") : "",
    item.http_code > 0 ? E("span", { class: "tm" }, "HTTP " + item.http_code) : "",
    E("span", { class: "tm" }, timing),
  ]);
}

function renderDetail(service) {
  var items = service.items || [];
  var problems = items.filter(function (item) {
    return item.state === "error" || item.state === "warning";
  });
  var fine = items.filter(function (item) {
    return item.state !== "error" && item.state !== "warning";
  });

  var nodes = [];

  if (service.description) {
    nodes.push(E("div", { class: "fkpsc-detail-note" }, service.description));
  }

  if (problems.length) {
    nodes.push(E("div", { class: "fkpsc-sect" }, "Что не работает"));
    problems.forEach(function (item) {
      nodes.push(renderProblemRow(item));
    });
  }

  if (fine.length) {
    nodes.push(E("div", { class: "fkpsc-sect" },
      problems.length ? "Остальное в порядке" : "Все цели в порядке"));
    fine.forEach(function (item) {
      nodes.push(renderOkLine(item));
    });
  }

  if (service.id === "gemini") {
    var settingsWrap = E("div", { class: "fkpsc-settings" });
    var statusSpan = E("span", { class: "fkpsc-settings-status" }, "загрузка…");
    var msgDiv = E("div", { class: "fkpsc-settings-msg" });
    var keyInput = E("input", {
      type: "password",
      placeholder: "Вставьте API-ключ Gemini",
      autocomplete: "off",
      spellcheck: "false",
    });

    function showSettingsMessage(text, ok) {
      msgDiv.textContent = text;
      msgDiv.className = "fkpsc-settings-msg " + (ok ? "ok" : "err");
      setTimeout(function () {
        msgDiv.className = "fkpsc-settings-msg";
      }, 4000);
    }

    function loadKeyStatus() {
      callBin(["gemini_key_status"]).then(function (result) {
        statusSpan.textContent = result.configured
          ? "используется сохранённый ключ"
          : "ключ не задан — геопроверка будет пропущена";
      }).catch(function () {
        statusSpan.textContent = "не удалось узнать статус ключа";
      });
    }

    var saveButton = E("button", {
      class: "cbi-button cbi-button-action",
      click: function () {
        var value = (keyInput.value || "").trim();
        if (!value) {
          showSettingsMessage("Введите ключ", false);
          return;
        }
        callBin(["gemini_key_set", value]).then(function (result) {
          showSettingsMessage(result.message || "ключ сохранён", result.success === true);
          if (result.success) {
            keyInput.value = "";
            loadKeyStatus();
          }
        }).catch(function (error) {
          showSettingsMessage(error.message || "не удалось сохранить ключ", false);
        });
      },
    }, "Сохранить");

    var resetButton = E("button", {
      class: "cbi-button",
      click: function () {
        callBin(["gemini_key_reset"]).then(function (result) {
          showSettingsMessage(result.message || "ключ удалён", result.success === true);
          keyInput.value = "";
          loadKeyStatus();
        }).catch(function (error) {
          showSettingsMessage(error.message || "не удалось удалить ключ", false);
        });
      },
    }, "Удалить ключ");

    var settingsBody = E("div", { class: "fkpsc-settings-body" }, [
      E("div", { class: "fkpsc-settings-row" }, [keyInput, saveButton, resetButton]),
      statusSpan,
      msgDiv,
    ]);
    var settingsHeader = E("div", {
      class: "fkpsc-settings-toggle",
      tabindex: "0",
      role: "button",
      "aria-expanded": "false",
    }, [
      E("span", { class: "arr" }, "▶"),
      E("span", {}, "Настройки API-ключа Gemini"),
    ]);

    function toggleSettings() {
      var isOpen = settingsWrap.classList.toggle("open");
      settingsHeader.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    settingsHeader.addEventListener("click", toggleSettings);
    settingsHeader.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleSettings();
      }
    });
    settingsWrap.appendChild(settingsHeader);
    settingsWrap.appendChild(settingsBody);
    nodes.push(settingsWrap);
    loadKeyStatus();
  }

  return E("div", { class: "fkpsc-detail" }, nodes);
}

function renderTile(service) {
  var items = service.items || [];
  var okCount = items.filter(function (item) {
    return item.state === "success";
  }).length;

  var tileHeader = E("div", {
    class: "fkpsc-tile-header",
    tabindex: "0",
    role: "button",
    "aria-expanded": openTiles[service.id] ? "true" : "false",
  }, [
    E("div", { class: "fkpsc-tile-head" }, [
      E("span", { class: "fkpsc-dot" }),
      E("span", { class: "fkpsc-tile-title" }, service.title),
      E("span", { class: "fkpsc-chev" }, "▼"),
    ]),
    E("div", { class: "fkpsc-tile-status" }, service.description_result || STATE_LABEL[service.state] || ""),
    E("div", { class: "fkpsc-tile-foot" }, [
      E("div", { class: "fkpsc-bar" }, items.map(function (item) {
        return E("i", { class: item.state, title: item.label + ": " + (item.message || STATE_LABEL[item.state] || "") });
      })),
      E("span", { class: "fkpsc-count" }, okCount + "/" + items.length),
    ]),
  ]);

  var tile = E("div", {
    class: "fkpsc-tile state-" + service.state + (openTiles[service.id] ? " open" : ""),
  }, [
    tileHeader,
    renderDetail(service),
  ]);

  function toggle() {
    var isOpen = tile.classList.toggle("open");
    openTiles[service.id] = isOpen;
    tileHeader.setAttribute("aria-expanded", isOpen ? "true" : "false");
  }

  tileHeader.addEventListener("click", toggle);
  tileHeader.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  });

  return tile;
}

function renderSummary(services) {
  if (!services.length) {
    return "";
  }

  var counts = { success: 0, warning: 0, error: 0 };

  services.forEach(function (service) {
    if (counts[service.state] !== undefined) {
      counts[service.state]++;
    }
  });

  var cells = [
    E("span", { class: "fkpsc-sum ok" }, [E("b", {}, String(counts.success)), E("span", {}, "работают")]),
  ];

  if (counts.warning) {
    cells.push(E("span", { class: "fkpsc-sum warn" }, [E("b", {}, String(counts.warning)), E("span", {}, "с замечаниями")]));
  }

  if (counts.error) {
    cells.push(E("span", { class: "fkpsc-sum err" }, [E("b", {}, String(counts.error)), E("span", {}, "не работают")]));
  }

  return E("div", { class: "fkpsc-summary" }, cells);
}

function renderRunMeta(state) {
  var lines = [];
  var backendName = state.backend_name || (state.backend === "tachyon" ? "Tachyon" : (state.backend === "podkop" ? "Podkop" : "Forkop"));
  var backendRunning = state.backend_running;
  if (backendRunning === undefined) {
    backendRunning = state.forkop_running;
  }

  if (state.mode === "netns") {
    lines.push("Режим: от имени клиента в LAN" + (state.client_ip ? " (" + state.client_ip + ")" : ""));
  } else {
    lines.push("Режим: с роутера через tproxy — тот же путь, что у трафика клиента");
  }

  if (state.netns_error) {
    lines.push("Режим клиента не запустился (" + state.netns_error + "), проверка выполнена с роутера.");
  }

  if (backendRunning === false) {
    lines.push("Внимание: " + backendName + " не запущен, соединения шли напрямую.");
  }

  if (state.resolver) {
    lines.push("DNS-резолвер проверки: " + state.resolver);
  }

  if (state.tools && !state.tools.curl) {
    lines.push("curl не установлен — тайминги и коды ответов определяются приблизительно через uclient-fetch.");
  }

  return E("div", { class: "fkpsc-meta" }, lines.map(function (line) {
    return E("div", {}, line);
  }));
}

function dnsResultCounts(groups) {
  var counts = { success: 0, error: 0, total: 0 };
  (groups || []).forEach(function (group) {
    (group.items || []).forEach(function (item) {
      counts.total++;
      if (item.ok) {
        counts.success++;
      } else {
        counts.error++;
      }
    });
  });
  return counts;
}

function renderDnsSummary(state) {
  var counts = dnsResultCounts(state.groups || []);
  return E("div", { class: "fkpsc-summary" }, [
    E("span", { class: "fkpsc-sum ok" }, [E("b", {}, String(counts.success)), E("span", {}, "ответили")]),
    E("span", { class: "fkpsc-sum err" }, [E("b", {}, String(counts.error)), E("span", {}, "ошибок")]),
    E("span", { class: "fkpsc-sum" }, [E("b", {}, String(counts.total)), E("span", {}, "проверено")]),
  ]);
}

function dnsDecimal(value, digits) {
  var text = Number(value).toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  return text.replace(".", ",");
}

function dnsQueryTime(item) {
  if (!item.ok) {
    return { text: "—", title: "DNS-сервер не ответил" };
  }
  if (item.query_us != null) {
    var microseconds = Math.max(0, Number(item.query_us) || 0);
    var milliseconds = microseconds / 1000;
    var text = microseconds === 0 ? "<0,001 мс" :
      (milliseconds < 1 ? dnsDecimal(milliseconds, 3) + " мс" :
        (milliseconds < 10 ? dnsDecimal(milliseconds, 2) + " мс" :
          (milliseconds < 100 ? dnsDecimal(milliseconds, 1) + " мс" : Math.round(milliseconds) + " мс")));
    return {
      text: text,
      title: "Точное время DNS-запроса: " + microseconds + " мкс" +
        (item.total_ms > 0 ? "; полное время запуска dig: " + item.total_ms + " мс" : ""),
    };
  }
  if (item.query_ms != null) {
    var millisecondsLegacy = Math.max(0, Number(item.query_ms) || 0);
    return {
      text: millisecondsLegacy === 0 ? "<1 мс" : millisecondsLegacy + " мс",
      title: "Время DNS-запроса по данным dig с точностью до миллисекунды",
    };
  }
  if (item.total_ms > 0) {
    return {
      text: "≈" + Math.round(item.total_ms) + " мс",
      title: "dig не вернул Query time; показано полное время выполнения процесса",
    };
  }
  return { text: "—", title: "dig не вернул время запроса" };
}

function renderDnsGroups(groups) {
  return E("div", { class: "fkpsc-dns-groups" }, (groups || []).map(function (group) {
    var items = group.items || [];
    var successful = items.filter(function (item) { return item.ok; }).length;
    var rows = items.map(function (item) {
      var time = dnsQueryTime(item);
      var answer = item.ok ? (item.addresses || []).join(", ") : (item.message || "нет ответа");
      return E("div", { class: "fkpsc-dns-row state-" + (item.ok ? "success" : "error") }, [
        E("strong", {}, item.resolver || "DNS"),
        E("span", { class: "fkpsc-dns-host" }, item.host || ""),
        E("span", { class: "fkpsc-dns-time", title: time.title }, time.text),
        E("span", { class: "fkpsc-dns-answer" }, answer),
      ]);
    });

    if (!rows.length) {
      rows.push(E("div", { class: "fkpsc-empty" }, "Ожидаем результаты…"));
    }

    return E("div", { class: "fkpsc-dns-group" }, [
      E("div", { class: "fkpsc-dns-group-head" }, [
        E("h3", {}, group.title || group.id || "DNS"),
        E("span", { class: "fkpsc-dim" }, successful + " из " + (group.total || items.length) + " ответили · быстрее → медленнее"),
      ]),
    ].concat(rows));
  }));
}
function sanitizedReport(state, moduleVersion) {
  var services = (state.services || []).map(function (service) {
    return {
      id: service.id || "",
      title: service.title || service.id || "",
      state: service.state || "",
      verdict: service.verdict || "",
      message: service.message || "",
      items: (service.items || []).map(function (item) {
        return {
          label: item.label || item.host || "",
          kind: item.kind || "",
          state: item.state || "",
          verdict: item.verdict || "",
          message: item.message || "",
          dns_ok: !!item.dns_ok,
          dns_fakeip: !!item.dns_fakeip,
          http_code: item.http_code || 0,
          tcp_ms: item.tcp_ms || 0,
          tls_ms: item.tls_ms || 0,
          total_ms: item.total_ms || 0,
          outbound: item.outbound || "",
          optional: !!item.optional,
        };
      }),
    };
  });

  return {
    report_format: 1,
    sanitized: true,
    module_version: moduleVersion || "unknown",
    generated_at: state.generated_at || state.finished_at || 0,
    mode: state.mode || "router",
    requested_mode: state.requested_mode || state.mode || "router",
    netns_fallback: !!state.netns_error,
    backend: state.backend || "unknown",
    backend_name: state.backend_name || state.backend || "unknown",
    backend_running: state.backend_running !== false,
    cancelled: !!state.cancelled,
    tools: {
      curl: !!(state.tools && state.tools.curl),
      dig: !!(state.tools && state.tools.dig),
      nc: !!(state.tools && state.tools.nc),
    },
    services: services,
  };
}

function reportAsText(report) {
  var counts = { success: 0, warning: 0, error: 0, skipped: 0 };
  report.services.forEach(function (service) {
    counts[service.state] = (counts[service.state] || 0) + 1;
  });

  var lines = [
    "Sing-box Service Check " + report.module_version,
    "Backend: " + report.backend_name + (report.backend_running ? " (running)" : " (stopped)"),
    "Mode: " + report.mode + (report.netns_fallback ? " (netns fallback)" : ""),
    "Summary: " + counts.success + " OK, " + counts.warning + " warning, " + counts.error + " error",
  ];

  if (report.cancelled) {
    lines.push("Status: cancelled");
  }
  lines.push("");

  report.services.forEach(function (service) {
    lines.push("[" + (service.state || "unknown").toUpperCase() + "] " + service.title);
    service.items.forEach(function (item) {
      var details = [];
      if (item.http_code) { details.push("HTTP " + item.http_code); }
      if (item.total_ms) { details.push(item.total_ms + " ms"); }
      else if (item.tcp_ms) { details.push("TCP " + item.tcp_ms + " ms"); }
      if (item.outbound) { details.push("outbound " + item.outbound); }
      lines.push("  - " + item.label + ": " + (item.verdict || item.state || "unknown") +
        (details.length ? " · " + details.join(" · ") : ""));
    });
  });

  lines.push("", "Report is sanitized: secrets, client IP and resolved addresses are omitted.");
  return lines.join("\n");
}

function copyReportText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function (resolve, reject) {
    var field = E("textarea", { style: "position:fixed;left:-9999px;top:-9999px" }, text);
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
    field.remove();
    if (copied) { resolve(); } else { reject(new Error("буфер обмена недоступен")); }
  });
}

function historyEntryFromState(state) {
  return {
    finished_at: state.finished_at || state.generated_at || 0,
    mode: state.mode || "router",
    backend: state.backend || "unknown",
    backend_name: state.backend_name || state.backend || "unknown",
    cancelled: !!state.cancelled,
    services: (state.services || []).map(function (service) {
      return {
        id: service.id || "",
        title: service.title || service.id || "",
        state: service.state || "",
        items: (service.items || []).map(function (item) {
          return {
            label: item.label || item.host || "",
            state: item.state || "",
            verdict: item.verdict || "",
            outbound: item.outbound || "",
            route_status: item.route_status || "unknown",
            expected_route: item.expected_route || "any",
            total_ms: item.total_ms || 0,
            tcp_ms: item.tcp_ms || 0,
          };
        }),
      };
    }),
  };
}

function renderHistoryComparison(currentState, previous) {
  if (!previous || !(previous.services || []).length) {
    return E("p", { class: "fkpsc-dim" }, "Это первая проверка в текущей истории — сравнение появится после следующего запуска.");
  }

  var previousServices = {};
  (previous.services || []).forEach(function (service) { previousServices[service.id] = service; });
  var changes = [];

  (currentState.services || []).forEach(function (service) {
    var oldService = previousServices[service.id];
    if (!oldService) {
      changes.push({ state: "info", text: service.title + ": новая категория в проверке" });
      return;
    }
    if (oldService.state !== service.state) {
      changes.push({
        state: service.state === "error" ? "error" : (service.state === "warning" ? "warning" : "success"),
        text: service.title + ": " + (STATE_LABEL[oldService.state] || oldService.state) + " → " +
          (STATE_LABEL[service.state] || service.state),
      });
    }

    var previousItems = {};
    (oldService.items || []).forEach(function (item) { previousItems[item.label] = item; });
    (service.items || []).forEach(function (item) {
      var oldItem = previousItems[item.label || item.host || ""];
      if (!oldItem) { return; }
      var currentRoute = item.route_status || (item.outbound || item.dns_fakeip ? "proxy" : "unknown");
      var oldRoute = oldItem.route_status || (oldItem.outbound ? "proxy" : "unknown");
      if (currentRoute !== oldRoute && currentRoute !== "unknown" && oldRoute !== "unknown") {
        changes.push({ state: "warning", text: service.title + " / " + oldItem.label + ": маршрут " + oldRoute + " → " + currentRoute });
      }

      var currentMs = item.total_ms || item.tcp_ms || 0;
      var previousMs = oldItem.total_ms || oldItem.tcp_ms || 0;
      if (currentMs > 0 && previousMs > 0 && currentMs - previousMs >= 100 && currentMs >= previousMs * 1.5) {
        changes.push({ state: "warning", text: service.title + " / " + oldItem.label + ": медленнее " + previousMs + " → " + currentMs + " мс" });
      }
      else if (currentMs > 0 && previousMs > 0 && previousMs - currentMs >= 100 && currentMs <= previousMs * 0.67) {
        changes.push({ state: "success", text: service.title + " / " + oldItem.label + ": быстрее " + previousMs + " → " + currentMs + " мс" });
      }
    });
  });

  if (!changes.length) {
    return E("p", { class: "fkpsc-dim" }, "Заметных изменений относительно предыдущей проверки нет.");
  }
  return E("div", {}, changes.slice(0, 20).map(function (change) {
    return E("div", { class: "fkpsc-custom-result state-" + change.state, style: "margin:.35em 0" }, change.text);
  }));
}

function renderCustomResult(result) {
  var item = result.item || {};
  var route = result.route || {};
  var reachable = item.state === "success" || item.state === "warning";
  var through = route.through_sing_box;
  var routeText = through === true ? "через sing-box" :
    (through === false ? "мимо sing-box" : "маршрут не определён");
  var routeClass = through === true ? "ok" : (through === false ? "err" : "warn");
  var stateClass = through === null || through === undefined ? "warning" :
    (reachable ? "success" : "error");
  var nodes = [
    E("div", { class: "fkpsc-custom-head" }, [
      E("span", { class: "fkpsc-custom-title" }, result.target + ":" + result.port),
      E("span", { class: "fkpsc-custom-pill " + (reachable ? "ok" : "err") },
        reachable ? "доступен" : "не доступен"),
      E("span", { class: "fkpsc-custom-pill " + routeClass }, routeText),
    ]),
    E("div", {}, route.message || ""),
  ];

  if (item.message) {
    nodes.push(E("div", { class: "fkpsc-row-msg" }, item.message));
  }

  nodes.push(renderStages(item));
  var facts = renderFacts(item);
  if (facts) {
    nodes.push(facts);
  }
  if (result.netns_error) {
    nodes.push(E("div", { class: "fkpsc-dim", style: "margin-top:.4em" },
      "Режим клиента не запустился: " + result.netns_error + ". Проверено с роутера."));
  }

  return E("div", { class: "fkpsc-custom-result state-" + stateClass }, nodes);
}

return view.extend({
  handleSaveApply: null,
  handleSave: null,
  handleReset: null,

  load: function () {
    return Promise.all([
      callBin(["capabilities"]).catch(function () {
        return null;
      }),
      callBin(["list"]).catch(function () {
        return null;
      }),
      callBin(["fixes"]).catch(function () {
        return { fixes: [] };
      }),
      callBin(["profiles-get"]).catch(function () {
        return null;
      }),
      callBin(["history"]).catch(function () {
        return { success: false, entries: [] };
      }),
      callBin(["vpn-packages"]).catch(function () {
        return { wireguard: {}, amneziawg: {} };
      }),
      callBin(["vpn-interfaces"]).catch(function () {
        return { success: false, interfaces: [] };
      }),
    ]);
  },

  render: function (data) {
    injectStyles();

    var capabilities = data[0];
    var catalogue = data[1];
    var fixes = (data[2] && data[2].fixes) || [];
    var profilesData = data[3];
    var historyData = data[4] || { entries: [] };
    var vpnPackages = data[5] || { wireguard: {}, amneziawg: {} };
    var vpnInterfacesData = data[6] || { success: false, interfaces: [] };
    var profilesDraft = profilesData && profilesData.config ?
      JSON.parse(JSON.stringify(profilesData.config)) : { version: 2, profiles: [] };
    if (!Array.isArray(profilesDraft.profiles)) {
      profilesDraft.profiles = [];
    }

    if (!capabilities || !catalogue) {
      return E("div", { class: "cbi-map fkpsc" }, [
        E("h2", {}, "Sing-box Service Check"),
        E("div", { class: "alert-message error" },
          "Не удалось обратиться к " + BIN + ". Проверьте, что модуль установлен и у пользователя есть права на его запуск."),
      ]);
    }

    var backendId = capabilities.backend || "forkop";
    var backendName = capabilities.backend_name || (backendId === "tachyon" ? "Tachyon" : (backendId === "podkop" ? "Podkop" : "Forkop"));
    var moduleVersion = capabilities.module_version || "unknown";
    var backendRunning = capabilities.backend_running;
    if (backendRunning === undefined) {
      backendRunning = capabilities.forkop_running;
    }
    var showForkopFixes = backendId === "forkop" && capabilities.forkop_installed !== false;

    var profiles = catalogue.profiles || [];
    var selected = {};

    profiles.forEach(function (profile) {
      selected[profile.id] = profile.id === "baseline" || profile.group !== "system";
    });

    var tilesNode = E("div", { class: "fkpsc-tiles" });
    var summaryNode = E("div", {});
    var progressBar = E("div", {});
    var progressWrap = E("div", { class: "fkpsc-progress", style: "display:none" }, [progressBar]);
    var progressText = E("span", { class: "fkpsc-dim" }, "");
    var metaNode = E("div", {});
    var customResultNode = E("div", {});
    var lastReportState = null;
    var copyReportButton = E("button", { class: "cbi-button cbi-button-action", type: "button" }, "Скопировать отчёт");
    var downloadReportButton = E("button", { class: "cbi-button", type: "button" }, "Скачать JSON");
    var reportPanel = E("div", { class: "fkpsc-card", style: "display:none" }, [
      E("div", { class: "fkpsc-update-row" }, [
        E("div", { class: "fkpsc-update-status" }, [
          E("h3", {}, "Диагностический отчёт"),
          E("p", { class: "fkpsc-dim" }, "API-ключи, секреты, IP клиента и полученные IP-адреса в отчёт не включаются."),
        ]),
        E("div", { class: "fkpsc-update-actions" }, [copyReportButton, downloadReportButton]),
      ]),
    ]);
    var previousHistoryEntry = (historyData.entries || [])[0] || null;
    var lastComparedJobId = "";
    var historyCountNode = E("span", { class: "fkpsc-badge" }, "сохранено: " + (historyData.entries || []).length + " из 10");
    var historyComparisonNode = E("div", {}, previousHistoryEntry
      ? E("p", { class: "fkpsc-dim" }, "Запустите проверку, чтобы сравнить результат с предыдущим.")
      : E("p", { class: "fkpsc-dim" }, "История пока пуста."));
    var clearHistoryButton = E("button", { class: "cbi-button", type: "button" }, "Очистить историю");
    var historyPanel = E("div", { class: "fkpsc-card", style: previousHistoryEntry ? "" : "display:none" }, [
      E("div", { class: "fkpsc-update-row" }, [
        E("div", { class: "fkpsc-update-status" }, [E("h3", {}, "Изменения с предыдущей проверки"), historyCountNode]),
        E("div", { class: "fkpsc-update-actions" }, [clearHistoryButton]),
      ]),
      historyComparisonNode,
    ]);

    clearHistoryButton.addEventListener("click", function () {
      clearHistoryButton.disabled = true;
      callBin(["history-clear"]).then(function (result) {
        previousHistoryEntry = null;
        historyCountNode.textContent = "сохранено: 0 из 10";
        historyPanel.style.display = "none";
        ui.addNotification(null, E("p", {}, result.message || "История очищена."), "info");
      }).catch(function (error) {
        ui.addNotification(null, E("p", {}, "Не удалось очистить историю: " + error.message), "warning");
      }).then(function () { clearHistoryButton.disabled = false; });
    });

    copyReportButton.addEventListener("click", function () {
      if (!lastReportState) { return; }
      var text = reportAsText(sanitizedReport(lastReportState, capabilities.module_version));
      copyReportButton.disabled = true;
      copyReportText(text).then(function () {
        ui.addNotification(null, E("p", {}, "Обезличенный отчёт скопирован в буфер обмена."), "info");
      }).catch(function (error) {
        ui.addNotification(null, E("p", {}, "Не удалось скопировать отчёт: " + error.message), "warning");
      }).then(function () { copyReportButton.disabled = false; });
    });

    downloadReportButton.addEventListener("click", function () {
      if (!lastReportState) { return; }
      var report = sanitizedReport(lastReportState, capabilities.module_version);
      var blob = new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = E("a", { href: url, download: "sing-box-service-check-report.json" });
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    var modeRouter = E("input", { type: "radio", name: "fkpsc-mode", value: "router", checked: "" });
    var modeNetns = E("input", {
      type: "radio",
      name: "fkpsc-mode",
      value: "netns",
      disabled: capabilities.netns ? null : "",
    });
    var clientIpInput = E("input", {
      type: "text",
      class: "cbi-input-text",
      placeholder: "авто",
      style: "width: 9em; margin-left: .4em;",
      disabled: "",
    });

    modeRouter.addEventListener("change", function () {
      clientIpInput.disabled = true;
    });
    modeNetns.addEventListener("change", function () {
      clientIpInput.disabled = false;
    });

    var customTargetInput = E("input", {
      type: "text",
      class: "cbi-input-text fkpsc-custom-target",
      placeholder: "example.com или 1.1.1.1",
      autocomplete: "off",
      spellcheck: "false",
    });
    var customPortInput = E("input", {
      type: "number",
      class: "cbi-input-text fkpsc-custom-port",
      min: "1",
      max: "65535",
      value: "443",
      title: "TCP-порт",
    });
    var customCheckButton = E("button", {
      class: "cbi-button cbi-button-action important",
      type: "button",
    }, "Проверить IP/домен");

    function runCustomCheck() {
      if (customCheckButton.disabled) {
        return;
      }
      var target = customTargetInput.value.trim();
      var port = parseInt(customPortInput.value, 10) || 443;
      if (!target) {
        ui.addNotification(null, E("p", {}, "Введите IP-адрес или домен."), "warning");
        customTargetInput.focus();
        return;
      }

      var mode = modeNetns.checked ? "netns" : "router";
      var clientIp = mode === "netns" ? clientIpInput.value.trim() : "";
      customCheckButton.disabled = true;
      customCheckButton.textContent = "Проверяем…";
      customResultNode.replaceChildren(E("div", { class: "fkpsc-custom-result state-warning" },
        "Устанавливаем соединение и смотрим маршрут в sing-box…"));

      callBin(["custom", target, String(port), mode, clientIp]).then(function (result) {
        if (!result.success) {
          customResultNode.replaceChildren(E("div", { class: "fkpsc-custom-result state-error" },
            result.message || "Не удалось выполнить проверку."));
          return;
        }
        customResultNode.replaceChildren(renderCustomResult(result));
      }).catch(function (error) {
        customResultNode.replaceChildren(E("div", { class: "fkpsc-custom-result state-error" },
          "Ошибка проверки: " + error.message));
      }).finally(function () {
        customCheckButton.disabled = false;
        customCheckButton.textContent = "Проверить IP/домен";
      });
    }

    customCheckButton.addEventListener("click", runCustomCheck);
    customTargetInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runCustomCheck();
      }
    });

    var groupMeta = {
      system: ["Основное", "#55a7ef"],
      messenger: ["Мессенджеры", "#6f9ff8"],
      social: ["Социальные сети", "#e879a9"],
      video: ["Видео и стриминг", "#b789f7"],
      ai: ["ИИ-сервисы", "#67c6ba"],
      music: ["Музыка", "#55b889"],
      games: ["Игры", "#e2a84b"],
      dev: ["Разработка", "#8b9cad"],
      bypass: ["Доступ", "#e07b67"],
      network: ["Сеть и UDP", "#6bbbd8"],
      custom: ["Свои сервисы", "#a78bfa"],
    };
    var pickNodes = {};
    var groupNodes = {};
    var groups = [];

    profiles.forEach(function (profile) {
      var groupId = profile.group || "custom";
      if (!groupNodes[groupId]) {
        groupNodes[groupId] = { id: groupId, profiles: [] };
        groups.push(groupNodes[groupId]);
      }
      groupNodes[groupId].profiles.push(profile);
    });

    function updatePick(profile) {
      var chip = pickNodes[profile.id];
      chip.classList.toggle("on", selected[profile.id]);
      chip.setAttribute("aria-checked", selected[profile.id] ? "true" : "false");
    }

    function updateGroup(group) {
      var selectedCount = group.profiles.filter(function (profile) {
        return selected[profile.id];
      }).length;
      group.node.classList.toggle("has-selection", selectedCount > 0);
      group.count.textContent = selectedCount + " / " + group.profiles.length;
      group.toggle.textContent = selectedCount === group.profiles.length ? "Снять" : "Выбрать";
      group.toggle.setAttribute("aria-label", (selectedCount === group.profiles.length ? "Снять группу " : "Выбрать группу ") + group.title);
    }

    var picker = E("div", { class: "fkpsc-service-groups" }, groups.map(function (group) {
      var meta = groupMeta[group.id] || [group.id || "Другое", "#8b9cad"];
      group.title = meta[0];
      group.count = E("span", { class: "fkpsc-group-count" });
      group.toggle = E("button", { class: "fkpsc-group-toggle", type: "button" });
      var picks = E("div", { class: "fkpsc-group-picks" }, group.profiles.map(function (profile) {
        var chip = E("span", {
          class: "fkpsc-pick" + (selected[profile.id] ? " on" : ""),
          title: profile.description || "",
          tabindex: "0",
          role: "checkbox",
          "aria-checked": selected[profile.id] ? "true" : "false",
        }, [
          E("span", { class: "tick" }),
          E("span", {}, profile.title),
          E("span", { class: "num", title: "Целей проверки: " + profile.targets }, String(profile.targets)),
        ]);

        function toggle() {
          selected[profile.id] = !selected[profile.id];
          updatePick(profile);
          updateGroup(group);
        }

        chip.addEventListener("click", toggle);
        chip.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        });
        pickNodes[profile.id] = chip;
        return chip;
      }));

      group.node = E("section", {
        class: "fkpsc-service-group",
        style: "--group-color:" + meta[1],
        "data-group": group.id,
      }, [
        E("div", { class: "fkpsc-group-head" }, [
          E("span", { class: "fkpsc-group-mark" }),
          E("span", { class: "fkpsc-group-name" }, group.title),
          group.count,
          group.toggle,
        ]),
        picks,
      ]);

      group.toggle.addEventListener("click", function () {
        var allSelected = group.profiles.every(function (profile) { return selected[profile.id]; });
        group.profiles.forEach(function (profile) {
          selected[profile.id] = !allSelected;
          updatePick(profile);
        });
        updateGroup(group);
      });
      updateGroup(group);
      return group.node;
    }));

    function setAll(value) {
      profiles.forEach(function (profile) {
        selected[profile.id] = value;
        updatePick(profile);
      });
      groups.forEach(updateGroup);
    }

    function selectOnly(ids) {
      var wanted = {};
      ids.forEach(function (id) { wanted[id] = true; });
      profiles.forEach(function (profile) {
        selected[profile.id] = !!wanted[profile.id];
        updatePick(profile);
      });
      groups.forEach(updateGroup);
    }

    var serviceSearch = E("input", { type: "search", class: "cbi-input-text fkpsc-search", placeholder: "Найти сервис…" });
    serviceSearch.addEventListener("input", function () {
      var query = serviceSearch.value.trim().toLowerCase();
      profiles.forEach(function (profile) {
        var group = groupNodes[profile.group || "custom"];
        var haystack = (profile.title + " " + (profile.description || "") + " " + group.title).toLowerCase();
        pickNodes[profile.id].style.display = !query || haystack.indexOf(query) >= 0 ? "" : "none";
      });
      groups.forEach(function (group) {
        group.node.style.display = group.profiles.some(function (profile) {
          return pickNodes[profile.id].style.display !== "none";
        }) ? "" : "none";
      });
    });

    var quickPreset = E("button", { class: "cbi-button", type: "button" }, "Быстрая");
    quickPreset.addEventListener("click", function () {
      selectOnly(["baseline", "telegram", "youtube", "discord", "udp_common"]);
    });
    var udpPreset = E("button", { class: "cbi-button", type: "button" }, "Только UDP");
    udpPreset.addEventListener("click", function () { selectOnly(["udp_common"]); });
    var runButton = E("button", { class: "cbi-button cbi-button-action important" }, "Проверить сервис");
    var retryButton = E("button", { class: "cbi-button", style: "display:none" }, "Повторить ошибки");
    var lastProblemIds = [];
    var maintenancePanel = E("div", { class: "fkpsc-card" });

    var fixesNodes = fixes.map(function (fix) {
      var applyButton = E("button", { class: "cbi-button cbi-button-action" }, "Применить");
      applyButton.addEventListener("click", function () {
        applyButton.disabled = true;
        applyButton.textContent = "Выполняю…";
        callBin(["fix", fix.id]).then(function (result) {
          ui.addNotification(null, E("p", {}, result.output || result.message || "Фикс применён"), result.success ? "info" : "warning");
        }).catch(function (error) {
          ui.addNotification(null, E("p", {}, error.message || "Не удалось применить фикс"), "error");
        }).finally(function () {
          applyButton.disabled = false;
          applyButton.textContent = "Применить";
        });
      });
      return E("div", { class: "fkpsc-fix" }, [
        E("div", { class: "fkpsc-fix-title" }, fix.title),
        E("div", { class: "fkpsc-dim" }, fix.description || ""),
        E("div", { class: "fkpsc-dim", style: "margin:.35em 0" }, fix.risk || ""),
        applyButton,
      ]);
    });

    var maintenanceChildren = [
      E("h3", {}, "Безопасные исправления Forkop"),
      E("p", { class: "fkpsc-dim" },
        "Здесь доступны только встроенные исправления из белого списка backend. Произвольные команды из браузера не выполняются."),
    ];
    if (fixesNodes.length) {
      fixesNodes.forEach(function (node) { maintenanceChildren.push(node); });
    } else {
      maintenanceChildren.push(E("div", { class: "fkpsc-dim" }, "Фикс недоступен."));
    }
    maintenancePanel.appendChild(E("div", {}, maintenanceChildren));
    var stopButton = E("button", { class: "cbi-button", style: "display:none" }, "Остановить");

    function setRunning(running) {
      runState.running = running;
      runButton.disabled = running;
      runButton.textContent = running ? "Проверяем…" : "Проверить сервис";
      stopButton.style.display = running ? "" : "none";
      stopButton.disabled = false;
      progressWrap.style.display = running ? "" : "none";
    }

    function updateProgress(progress) {
      var done = (progress && progress.done) || 0;
      var total = (progress && progress.total) || 0;
      var percent = total > 0 ? Math.round((done / total) * 100) : 0;

      progressBar.style.width = percent + "%";
      progressText.textContent = total > 0 ? done + " из " + total + " проверок" : "";
    }

    function renderResults(state) {
      var services = state.services || [];

      metaNode.replaceChildren(state.running ? E("div", {}) : renderRunMeta(state));
      summaryNode.replaceChildren(state.running ? E("div", {}) : renderSummary(services));
      tilesNode.replaceChildren.apply(tilesNode, services.map(renderTile));
      if (!state.running) {
        lastReportState = services.length ? state : null;
        reportPanel.style.display = lastReportState ? "" : "none";
        if (services.length && (!state.job_id || state.job_id !== lastComparedJobId)) {
          historyComparisonNode.replaceChildren(renderHistoryComparison(state, previousHistoryEntry));
          previousHistoryEntry = historyEntryFromState(state);
          lastComparedJobId = state.job_id || String(state.finished_at || Date.now());
          var historyCount = Math.min(10, parseInt(historyCountNode.textContent.match(/\d+/), 10) + 1 || 1);
          historyCountNode.textContent = "сохранено: " + historyCount + " из 10";
          historyPanel.style.display = "";
        }
        lastProblemIds = services.filter(function (service) {
          return service.state === "error";
        }).map(function (service) {
          return service.id;
        });
        retryButton.style.display = lastProblemIds.length ? "" : "none";
      }
    }

    function pollJob(jobId, startedAt) {
      runState.timer = window.setTimeout(function () {
        if (runState.cancelled) {
          return;
        }

        callBin(["status", jobId]).then(function (state) {
          if (runState.cancelled) {
            return;
          }

          updateProgress(state.progress);
          renderResults(state);

          if (state.running) {
            if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
              runState.cancelled = true;
              callBin(["cancel", jobId]).catch(function () { return null; }).then(function () {
                setRunning(false);
                runState.jobId = "";
                ui.addNotification(null, E("p", {}, "Проверка остановлена по таймауту."), "warning");
              });
              return;
            }

            pollJob(jobId, startedAt);
            return;
          }

          setRunning(false);
          runState.jobId = "";
        }).catch(function (error) {
          setRunning(false);
          ui.addNotification(null, E("p", {}, "Ошибка чтения состояния: " + error.message), "error");
        });
      }, POLL_INTERVAL_MS);
    }

    runButton.addEventListener("click", function () {
      var ids = profiles.filter(function (profile) {
        return selected[profile.id];
      }).map(function (profile) {
        return profile.id;
      });

      if (!ids.length) {
        ui.addNotification(null, E("p", {}, "Выберите хотя бы один сервис."), "warning");
        return;
      }

      var mode = modeNetns.checked ? "netns" : "router";
      var clientIp = mode === "netns" ? clientIpInput.value.trim() : "";

      runState.cancelled = false;
      setRunning(true);
      updateProgress({ done: 0, total: 0 });
      tilesNode.replaceChildren();
      summaryNode.replaceChildren();
      metaNode.replaceChildren();

      callBin(["start", ids.join(","), mode, clientIp]).then(function (response) {
        if (!response.success) {
          setRunning(false);
          ui.addNotification(null, E("p", {}, "Не удалось запустить проверку: " + (response.message || "")), "error");
          return;
        }

        runState.jobId = response.job_id;
        updateProgress(response.progress);
        pollJob(response.job_id, Date.now());
      }).catch(function (error) {
        setRunning(false);
        ui.addNotification(null, E("p", {}, "Не удалось запустить проверку: " + error.message), "error");
      });
    });

    stopButton.addEventListener("click", function () {
      if (!runState.jobId) {
        return;
      }
      runState.cancelled = true;
      stopButton.disabled = true;
      stopButton.textContent = "Останавливаем…";
      if (runState.timer) {
        window.clearTimeout(runState.timer);
        runState.timer = null;
      }
      callBin(["cancel", runState.jobId]).then(function (state) {
        renderResults(state);
        setRunning(false);
        stopButton.textContent = "Остановить";
        runState.jobId = "";
        ui.addNotification(null, E("p", {}, state.message || "Проверка остановлена."), "info");
      }).catch(function (error) {
        setRunning(false);
        stopButton.textContent = "Остановить";
        runState.jobId = "";
        ui.addNotification(null, E("p", {}, "Не удалось подтвердить остановку: " + error.message), "warning");
      });
    });

    retryButton.addEventListener("click", function () {
      if (!lastProblemIds.length) {
        return;
      }
      selectOnly(lastProblemIds);
      runButton.click();
    });

    var updateStatusNode = E("div", { class: "fkpsc-update-status" }, [
      E("b", {}, "Установлена версия " + moduleVersion),
      E("div", { class: "fkpsc-dim" }, "Нажмите «Проверить обновления», чтобы обратиться к GitHub Releases."),
    ]);
    var checkUpdateButton = E("button", { class: "cbi-button", type: "button" }, "Проверить обновления");
    var installUpdateButton = E("button", {
      class: "cbi-button cbi-button-action important",
      type: "button",
      style: "display:none",
    }, "Обновить");
    var updateTimer = null;
    var availableUpdate = null;

    function updateMissingPackages(info) {
      return info && Array.isArray(info.missing_packages) ? info.missing_packages.filter(Boolean) : [];
    }

    function updateStatusContent(title, message, releaseUrl) {
      var children = [E("b", {}, title)];
      if (message) {
        children.push(E("div", { class: "fkpsc-dim" }, message));
      }
      if (releaseUrl) {
        children.push(E("a", {
          href: releaseUrl,
          target: "_blank",
          rel: "noopener noreferrer",
        }, "Открыть описание версии"));
      }
      updateStatusNode.replaceChildren.apply(updateStatusNode, children);
    }

    function renderUpdateInfo(info) {
      checkUpdateButton.disabled = false;
      if (!info || !info.success) {
        availableUpdate = null;
        installUpdateButton.style.display = "none";
        updateStatusContent("Не удалось проверить обновления", (info && info.message) || "Нет ответа от backend.");
        return;
      }

      var current = info.installed_version || moduleVersion;
      var latest = info.latest_version || current;
      if (info.update_available) {
        availableUpdate = info;
        var missingPackages = updateMissingPackages(info);
        var updateMessage = "Сейчас установлена " + current + ". Перед установкой будет проверен SHA-256.";
        if (missingPackages.length) {
          updateMessage += " Будет предложено установить недостающие пакеты: " + missingPackages.join(", ") + ".";
        }
        installUpdateButton.textContent = "Обновить до " + latest;
        installUpdateButton.style.display = "";
        installUpdateButton.disabled = false;
        updateStatusContent("Доступна версия " + latest, updateMessage, info.release_url);
      } else {
        availableUpdate = null;
        installUpdateButton.style.display = "none";
        updateStatusContent("Установлена актуальная версия " + current, "Новых стабильных релизов нет.", info.release_url);
      }
    }

    function pollUpdate(startedAt) {
      updateTimer = window.setTimeout(function () {
        callBin(["update-status"]).then(function (state) {
          updateStatusContent(state.success === false ? "Ошибка обновления" : "Обновление выполняется", state.message || "Ожидаем завершения установки…", state.release_url);
          if (state.running) {
            if (Date.now() - startedAt <= UPDATE_TIMEOUT_MS) {
              pollUpdate(startedAt);
              return;
            }
            checkUpdateButton.disabled = false;
            installUpdateButton.disabled = false;
            updateStatusContent("Обновление выполняется слишком долго", "Проверьте состояние командой sing-box-service-check update-status.");
            return;
          }

          checkUpdateButton.disabled = false;
          installUpdateButton.disabled = false;
          if (state.success) {
            updateStatusContent("Обновление установлено", state.message || "Перезагружаем страницу…", state.release_url);
            ui.addNotification(null, E("p", {}, state.message || "Обновление установлено"), "info");
            window.setTimeout(function () { window.location.reload(); }, 1800);
          } else {
            updateStatusContent("Обновление не установлено", state.message || "Неизвестная ошибка.", state.release_url);
            ui.addNotification(null, E("p", {}, state.message || "Не удалось установить обновление"), "error");
          }
        }).catch(function (error) {
          // Установщик перезапускает rpcd, поэтому кратковременная потеря связи ожидаема.
          if (Date.now() - startedAt <= UPDATE_TIMEOUT_MS) {
            updateStatusContent("Применяем обновление", "LuCI ожидает перезапуск rpcd…");
            pollUpdate(startedAt);
            return;
          }
          checkUpdateButton.disabled = false;
          installUpdateButton.disabled = false;
          updateStatusContent("Связь с backend не восстановилась", error.message || "Проверьте состояние из консоли.");
        });
      }, 2000);
    }

    checkUpdateButton.addEventListener("click", function () {
      checkUpdateButton.disabled = true;
      installUpdateButton.style.display = "none";
      updateStatusContent("Проверяем GitHub Releases", "Получаем сведения о последней стабильной версии…");
      callBin(["update-check"]).then(renderUpdateInfo).catch(function (error) {
        renderUpdateInfo({ success: false, message: error.message });
      });
    });

    installUpdateButton.addEventListener("click", function () {
      if (!availableUpdate) {
        return;
      }
      var missingPackages = updateMissingPackages(availableUpdate);
      var installMode = missingPackages.length ? "install-missing" : "skip-missing";
      var confirmation = "Установить Sing-box Service Check " + availableUpdate.latest_version + "?";
      if (missingPackages.length) {
        confirmation += "\n\nВместе с обновлением будут установлены" +
          (availableUpdate.dependency_repair ? " или переустановлены" : "") +
          " недостающие пакеты: " + missingPackages.join(", ") + ".";
      }
      confirmation += "\n\nВо время обновления LuCI кратковременно потеряет связь.";
      if (!window.confirm(confirmation)) {
        return;
      }
      checkUpdateButton.disabled = true;
      installUpdateButton.disabled = true;
      updateStatusContent("Запускаем обновление", "Backend повторно проверит релиз, адрес файла и SHA-256.", availableUpdate.release_url);
      callBin(["update-start", installMode]).then(function (state) {
        if (!state.success) {
          throw new Error(state.message || "не удалось запустить обновление");
        }
        if (!state.running) {
          renderUpdateInfo(state);
          return;
        }
        pollUpdate(Date.now());
      }).catch(function (error) {
        checkUpdateButton.disabled = false;
        installUpdateButton.disabled = false;
        updateStatusContent("Не удалось запустить обновление", error.message || "Неизвестная ошибка.");
      });
    });

    var updateCard = E("div", { class: "fkpsc-card" }, [
      E("h3", {}, "Обновление модуля"),
      E("div", { class: "fkpsc-update-row" }, [
        updateStatusNode,
        E("div", { class: "fkpsc-update-actions" }, [checkUpdateButton, installUpdateButton]),
      ]),
    ]);

    var clashDiagnostic = capabilities.clash_api || {};
    var dnsDiagnostic = capabilities.dns || {};
    function diagnosticCell(title, value) {
      return E("div", { class: "fkpsc-diagnostic-cell" }, [
        E("b", {}, title),
        E("span", {}, value == null || value === "" ? "—" : String(value)),
      ]);
    }
    var dnsChainButton = E("button", { class: "cbi-button", type: "button", style: "margin-top:.8em" }, "Проверить DNS-цепочку");
    var dnsChainResult = E("div", {});
    var doctorButton = E("button", { class: "cbi-button", type: "button", style: "margin-top:.8em;margin-left:.5em" }, "Проверить установку");
    var repairButton = E("button", { class: "cbi-button cbi-button-negative", type: "button", style: "margin-top:.8em;margin-left:.5em" }, "Восстановить файлы");
    var doctorResult = E("div", {});
    var backendDiagnosticsCard = E("details", { class: "fkpsc-card" }, [
      E("summary", { style: "cursor:pointer;font-weight:700" }, "Backend и DNS · расширенная диагностика"),
      E("div", { class: "fkpsc-diagnostic-grid" }, [
        diagnosticCell("Активный backend", backendName + " · " + (capabilities.backend_version || "версия неизвестна")),
        diagnosticCell("Состояние", backendRunning ? "запущен" : "остановлен"),
        diagnosticCell("Clash API", clashDiagnostic.reachable ? "доступен · соединений: " + (clashDiagnostic.connections || 0) : "недоступен"),
        diagnosticCell("Конфигурация sing-box", dnsDiagnostic.config_readable ? dnsDiagnostic.config_path : "не удалось прочитать " + (dnsDiagnostic.config_path || "")),
        diagnosticCell("LAN-интерфейс", capabilities.lan_interface || "не определён"),
        diagnosticCell("DNS-серверы", (dnsDiagnostic.server_count || 0) + " · " + ((dnsDiagnostic.server_types || []).join(", ") || "тип не определён")),
        diagnosticCell("FakeIP", dnsDiagnostic.fakeip_enabled ? "включён · " + (dnsDiagnostic.fakeip_ranges || []).join(", ") : "не обнаружен"),
        diagnosticCell("Инструменты", [capabilities.curl ? "curl" : "без curl", capabilities.dig ? "dig" : ((capabilities.dig_status || {}).available ? "dig сломан" : "без dig"), capabilities.nc ? "nc" : "без nc", capabilities.netns ? "netns" : "без netns"].join(" · ")),
      ]),
      dnsChainButton,
      doctorButton,
      repairButton,
      dnsChainResult,
      doctorResult,
    ]);
    dnsChainButton.addEventListener("click", function () {
      var target = customTargetInput.value.trim() || "cp.cloudflare.com";
      dnsChainButton.disabled = true;
      dnsChainButton.textContent = "Проверяем…";
      callBin(["dns-diagnostics", target]).then(function (result) {
        var stages = (result.stages || []).map(function (stage) {
          return E("div", { class: "fkpsc-custom-result state-" + (stage.ok ? "success" : "error"), style: "margin:.35em 0" },
            (stage.ok ? "✓ " : "✕ ") + stage.message);
        });
        dnsChainResult.replaceChildren.apply(dnsChainResult, stages);
      }).catch(function (error) {
        dnsChainResult.replaceChildren(E("div", { class: "fkpsc-custom-result state-error" }, error.message || "DNS-диагностика не выполнена"));
      }).then(function () {
        dnsChainButton.disabled = false;
        dnsChainButton.textContent = "Проверить DNS-цепочку";
      });
    });
    doctorButton.addEventListener("click", function () {
      doctorButton.disabled = true;
      callBin(["doctor"]).then(function (result) {
        var rows = (result.checks || []).map(function (check) {
          return E("div", { class: "fkpsc-custom-result state-" + (check.ok ? "success" : (check.critical ? "error" : "warning")), style: "margin:.35em 0" },
            (check.ok ? "✓ " : "✕ ") + check.message);
        });
        doctorResult.replaceChildren.apply(doctorResult, rows);
      }).catch(function (error) {
        doctorResult.replaceChildren(E("div", { class: "fkpsc-custom-result state-error" }, error.message));
      }).then(function () { doctorButton.disabled = false; });
    });
    repairButton.addEventListener("click", function () {
      if (!window.confirm("Восстановить файлы Sing-box Service Check из локальной проверенной копии? Пользовательские профили в /etc не изменятся.")) {
        return;
      }
      repairButton.disabled = true;
      repairButton.textContent = "Восстанавливаем…";
      callBin(["repair"]).then(function (result) {
        if (!result.success) { throw new Error(result.output || result.message); }
        ui.addNotification(null, E("p", {}, result.message + ". Страница будет обновлена."), "info");
        window.setTimeout(function () { window.location.reload(); }, 1200);
      }).catch(function (error) {
        repairButton.disabled = false;
        repairButton.textContent = "Восстановить файлы";
        ui.addNotification(null, E("p", {}, "Восстановление не выполнено: " + error.message), "error");
      });
    });

    var notes = [];

    if (!backendRunning) {
      notes.push(backendName + " сейчас не запущен — проверка покажет доступность без обхода.");
    }

    if (!capabilities.curl) {
      notes.push("На роутере нет curl: тайминги TCP/TLS и коды ответов будут приблизительными. Поставьте пакет curl для точной диагностики.");
    }

    if (!capabilities.netns) {
      notes.push("Режим «от имени клиента» недоступен: ip netns не поддерживается этой прошивкой.");
    }

    var dnsDomainInput = E("input", {
      type: "text",
      class: "cbi-input-text fkpsc-dns-domain",
      value: "www.nvidia.com",
      placeholder: "www.nvidia.com",
      autocomplete: "off",
      spellcheck: "false",
    });
    var dnsStartButton = E("button", {
      class: "cbi-button cbi-button-action important",
      type: "button",
      disabled: capabilities.dig ? null : "",
    }, "Запустить тест");
    var dnsStopButton = E("button", {
      class: "cbi-button",
      type: "button",
      style: "display:none",
    }, "Остановить");
    var dnsProgressBar = E("div", {});
    var dnsProgressWrap = E("div", { class: "fkpsc-progress", style: "display:none" }, [dnsProgressBar]);
    var dnsProgressText = E("span", { class: "fkpsc-dim" }, "");
    var dnsSummaryNode = E("div", {});
    var dnsResultsNode = E("div", {});

    function setDnsRunning(running) {
      dnsRunState.running = running;
      dnsStartButton.disabled = running || !capabilities.dig;
      dnsStartButton.textContent = running ? "Тестируем…" : "Запустить тест";
      dnsStopButton.style.display = running ? "" : "none";
      dnsStopButton.disabled = false;
      dnsStopButton.textContent = "Остановить";
      dnsProgressWrap.style.display = running ? "" : "none";
    }

    function updateDnsProgress(progress) {
      var done = (progress && progress.done) || 0;
      var total = (progress && progress.total) || 0;
      var percent = total > 0 ? Math.round((done / total) * 100) : 0;
      dnsProgressBar.style.width = percent + "%";
      dnsProgressText.textContent = total > 0 ? done + " из " + total + " DNS-запросов" : "";
    }

    function renderDnsState(state) {
      dnsSummaryNode.replaceChildren(renderDnsSummary(state));
      dnsResultsNode.replaceChildren(renderDnsGroups(state.groups || []));
    }

    function pollDnsJob(jobId, startedAt) {
      dnsRunState.timer = window.setTimeout(function () {
        if (dnsRunState.cancelled) {
          return;
        }
        callBin(["status", jobId]).then(function (state) {
          if (dnsRunState.cancelled) {
            return;
          }
          updateDnsProgress(state.progress);
          renderDnsState(state);
          if (state.running) {
            if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
              dnsRunState.cancelled = true;
              callBin(["cancel", jobId]).catch(function () { return null; }).then(function () {
                setDnsRunning(false);
                dnsRunState.jobId = "";
                ui.addNotification(null, E("p", {}, "Тест DNS остановлен по таймауту."), "warning");
              });
              return;
            }
            pollDnsJob(jobId, startedAt);
            return;
          }
          setDnsRunning(false);
          dnsRunState.jobId = "";
        }).catch(function (error) {
          setDnsRunning(false);
          dnsRunState.jobId = "";
          ui.addNotification(null, E("p", {}, "Ошибка чтения теста DNS: " + error.message), "error");
        });
      }, POLL_INTERVAL_MS);
    }

    function startDnsTest() {
      if (dnsStartButton.disabled) {
        return;
      }
      var domain = dnsDomainInput.value.trim();
      if (!domain) {
        ui.addNotification(null, E("p", {}, "Введите домен для тестового A-запроса."), "warning");
        dnsDomainInput.focus();
        return;
      }

      dnsRunState.cancelled = false;
      setDnsRunning(true);
      updateDnsProgress({ done: 0, total: 0 });
      dnsSummaryNode.replaceChildren();
      dnsResultsNode.replaceChildren();

      callBin(["dns-start", domain]).then(function (response) {
        if (!response.success) {
          throw new Error(response.message || "не удалось запустить тест DNS");
        }
        dnsRunState.jobId = response.job_id;
        updateDnsProgress(response.progress);
        pollDnsJob(response.job_id, Date.now());
      }).catch(function (error) {
        setDnsRunning(false);
        dnsRunState.jobId = "";
        ui.addNotification(null, E("p", {}, error.message || "Не удалось запустить тест DNS"), "error");
      });
    }

    dnsStartButton.addEventListener("click", startDnsTest);
    dnsDomainInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        startDnsTest();
      }
    });
    dnsStopButton.addEventListener("click", function () {
      if (!dnsRunState.jobId) {
        return;
      }
      dnsRunState.cancelled = true;
      dnsStopButton.disabled = true;
      dnsStopButton.textContent = "Останавливаем…";
      if (dnsRunState.timer) {
        window.clearTimeout(dnsRunState.timer);
        dnsRunState.timer = null;
      }
      callBin(["cancel", dnsRunState.jobId]).then(function (state) {
        renderDnsState(state);
        setDnsRunning(false);
        dnsRunState.jobId = "";
        ui.addNotification(null, E("p", {}, state.message || "Тест DNS остановлен."), "info");
      }).catch(function (error) {
        setDnsRunning(false);
        dnsRunState.jobId = "";
        ui.addNotification(null, E("p", {}, "Не удалось подтвердить остановку: " + error.message), "warning");
      });
    });

    var dnsPage = E("div", { class: "fkpsc-page" }, [
      E("div", { class: "fkpsc-card" }, [
        E("h3", {}, "Тест скорости DNS-серверов"),
        E("p", { class: "fkpsc-dim" },
          "Приложение отправит A-запрос выбранного домена всем DNS-серверам из списка и покажет время ответа отдельно для UDP, DNS over HTTPS и DNS over TLS."),
        E("div", { class: "fkpsc-note" }, capabilities.dig ?
          "Полный тест выполняется последовательно и может занять несколько минут, если часть серверов недоступна." :
          (((capabilities.dig_status || {}).message) ||
            "Для теста нужен пакет bind-dig. Установите его командой: opkg install bind-dig (или apk add bind-dig).")),
        E("div", { class: "fkpsc-dns-form" }, [dnsDomainInput, dnsStartButton, dnsStopButton]),
        E("div", { class: "fkpsc-actions" }, [dnsProgressWrap, dnsProgressText]),
      ]),
      dnsSummaryNode,
      dnsResultsNode,
    ]);
function vlessDecodeComponent(value, field) {
  try {
    return decodeURIComponent(value || "");
  } catch (error) {
    throw new Error("Некорректное кодирование поля " + field + ".");
  }
}

function vlessNonEmptyList(value) {
  return String(value || "").split(",").map(function (item) {
    return item.trim();
  }).filter(function (item) {
    return item !== "";
  });
}

function vlessHeader(headers, wanted) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "";
  var wantedLower = wanted.toLowerCase();
  var names = Object.keys(headers);
  for (var i = 0; i < names.length; i++) {
    if (names[i].toLowerCase() === wantedLower) return String(headers[names[i]] || "");
  }
  return "";
}

function vlessUriHost(server) {
  return server.indexOf(":") >= 0 && server.charAt(0) !== "[" ? "[" + server + "]" : server;
}

function vlessQueryPair(name, value) {
  return encodeURIComponent(name) + "=" + encodeURIComponent(String(value));
}

function vlessOutboundFromUri(input) {
  var raw = String(input || "").trim();
  if (!/^vless:\/\//i.test(raw)) throw new Error("Ссылка должна начинаться с vless://.");

  var link;
  try {
    link = new URL(raw);
  } catch (error) {
    throw new Error("Не удалось разобрать VLESS-ссылку.");
  }

  if (link.password) throw new Error("В VLESS-ссылке не должно быть пароля после UUID.");
  var uuid = vlessDecodeComponent(link.username, "UUID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error("UUID в VLESS-ссылке имеет неверный формат.");
  }

  var server = link.hostname || "";
  if (server.charAt(0) === "[" && server.charAt(server.length - 1) === "]") server = server.slice(1, -1);
  var serverPort = parseInt(link.port, 10);
  if (!server || !serverPort || serverPort < 1 || serverPort > 65535) {
    throw new Error("Укажите сервер и порт от 1 до 65535.");
  }

  var query = link.searchParams;
  var encryption = (query.get("encryption") || "none").toLowerCase();
  if (encryption !== "none") throw new Error("sing-box поддерживает VLESS только с encryption=none.");

  var security = (query.get("security") || (query.get("pbk") ? "reality" : "none")).toLowerCase();
  if (security !== "none" && security !== "tls" && security !== "reality") {
    throw new Error("Поддерживаются security=none, tls и reality.");
  }

  var transportType = (query.get("type") || "tcp").toLowerCase();
  if (transportType === "raw") transportType = "tcp";
  if (transportType === "websocket") transportType = "ws";
  if (transportType === "h2") transportType = "http";
  if (["tcp", "ws", "grpc", "http", "httpupgrade", "quic"].indexOf(transportType) < 0) {
    throw new Error("Транспорт " + transportType + " не поддерживается sing-box.");
  }
  var headerType = (query.get("headerType") || "none").toLowerCase();
  if (transportType === "tcp" && headerType !== "none") {
    throw new Error("TCP headerType=" + headerType + " нельзя перенести в sing-box без потери настроек.");
  }

  var tag = link.hash ? vlessDecodeComponent(link.hash.slice(1), "имени") : "vless-out";
  var outbound = {
    type: "vless",
    tag: tag || "vless-out",
    server: server,
    server_port: serverPort,
    uuid: uuid,
  };

  var flow = query.get("flow") || "";
  if (flow) outbound.flow = flow;
  var network = query.get("network") || "";
  if (network) {
    if (network !== "tcp" && network !== "udp") throw new Error("network должен быть tcp или udp.");
    outbound.network = network;
  }
  var packetEncoding = query.get("packetEncoding") || query.get("packet_encoding") || "";
  if (packetEncoding) {
    if (packetEncoding !== "packetaddr" && packetEncoding !== "xudp") {
      throw new Error("packetEncoding должен быть packetaddr или xudp.");
    }
    outbound.packet_encoding = packetEncoding;
  }

  if (security !== "none") {
    var tls = { enabled: true };
    var serverName = query.get("sni") || "";
    if (serverName) tls.server_name = serverName;
    var alpn = vlessNonEmptyList(query.get("alpn") || "");
    if (alpn.length) tls.alpn = alpn;
    var insecure = (query.get("allowInsecure") || query.get("insecure") || "").toLowerCase();
    if (insecure === "1" || insecure === "true") tls.insecure = true;
    var fingerprint = query.get("fp") || "";
    if (fingerprint) tls.utls = { enabled: true, fingerprint: fingerprint };
    if (security === "reality") {
      var publicKey = query.get("pbk") || "";
      if (!publicKey) throw new Error("Для REALITY нужен публичный ключ pbk.");
      tls.reality = { enabled: true, public_key: publicKey };
      var shortId = query.get("sid") || "";
      if (shortId) tls.reality.short_id = shortId;
    }
    outbound.tls = tls;
  }

  var path = query.get("path") || "";
  var host = query.get("host") || "";
  if (transportType === "ws") {
    outbound.transport = { type: "ws" };
    if (path) outbound.transport.path = path;
    if (host) outbound.transport.headers = { Host: host };
    var earlyData = parseInt(query.get("ed") || "", 10);
    if (earlyData > 0) outbound.transport.max_early_data = earlyData;
    var earlyHeader = query.get("eh") || "";
    if (earlyHeader) outbound.transport.early_data_header_name = earlyHeader;
  } else if (transportType === "grpc") {
    outbound.transport = { type: "grpc" };
    var serviceName = query.get("serviceName") || query.get("service_name") || "";
    if (serviceName) outbound.transport.service_name = serviceName;
  } else if (transportType === "http") {
    outbound.transport = { type: "http" };
    if (host) outbound.transport.host = vlessNonEmptyList(host);
    if (path) outbound.transport.path = path;
    var method = query.get("method") || "";
    if (method) outbound.transport.method = method;
  } else if (transportType === "httpupgrade") {
    outbound.transport = { type: "httpupgrade" };
    if (host) outbound.transport.host = host;
    if (path) outbound.transport.path = path;
  } else if (transportType === "quic") {
    outbound.transport = { type: "quic" };
  }

  return outbound;
}

function vlessOutboundFromJson(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("JSON должен содержать объект VLESS outbound.");
  }
  if (document.type === "vless") return document;
  if (!Array.isArray(document.outbounds)) {
    throw new Error("Нужен outbound type=vless или объект с массивом outbounds.");
  }
  var candidates = document.outbounds.filter(function (outbound) {
    return outbound && outbound.type === "vless";
  });
  if (candidates.length !== 1) {
    throw new Error("В массиве outbounds должен быть ровно один VLESS outbound.");
  }
  return candidates[0];
}

function vlessUriFromOutbound(document) {
  var outbound = vlessOutboundFromJson(document);
  var server = String(outbound.server || "").trim();
  var serverPort = parseInt(outbound.server_port, 10);
  var uuid = String(outbound.uuid || "").trim();
  if (!server || /[\s\/\[\]]/.test(server)) throw new Error("Поле server отсутствует или содержит недопустимый адрес.");
  if (!serverPort || serverPort < 1 || serverPort > 65535 || serverPort !== Number(outbound.server_port)) {
    throw new Error("Поле server_port должно быть целым числом от 1 до 65535.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error("Поле uuid имеет неверный формат.");
  }

  var query = [vlessQueryPair("encryption", "none")];
  var tls = outbound.tls && typeof outbound.tls === "object" && outbound.tls.enabled === true ? outbound.tls : null;
  var security = tls && tls.reality && tls.reality.enabled === true ? "reality" : (tls ? "tls" : "none");
  query.push(vlessQueryPair("security", security));

  var transport = outbound.transport;
  var transportType = transport && typeof transport === "object" ? String(transport.type || "tcp").toLowerCase() : "tcp";
  if (["tcp", "ws", "grpc", "http", "httpupgrade", "quic"].indexOf(transportType) < 0) {
    throw new Error("Транспорт " + transportType + " нельзя представить VLESS-ссылкой для sing-box.");
  }
  query.push(vlessQueryPair("type", transportType));

  if (outbound.flow) query.push(vlessQueryPair("flow", outbound.flow));
  if (outbound.network) {
    if (outbound.network !== "tcp" && outbound.network !== "udp") throw new Error("network должен быть tcp или udp.");
    query.push(vlessQueryPair("network", outbound.network));
  }
  if (outbound.packet_encoding) {
    if (outbound.packet_encoding !== "packetaddr" && outbound.packet_encoding !== "xudp") {
      throw new Error("packet_encoding должен быть packetaddr или xudp.");
    }
    query.push(vlessQueryPair("packetEncoding", outbound.packet_encoding));
  }

  if (tls) {
    if (tls.server_name) query.push(vlessQueryPair("sni", tls.server_name));
    if (tls.utls && tls.utls.enabled === true && tls.utls.fingerprint) query.push(vlessQueryPair("fp", tls.utls.fingerprint));
    if (security === "reality") {
      if (!tls.reality.public_key) throw new Error("Для REALITY в tls.reality нужен public_key.");
      query.push(vlessQueryPair("pbk", tls.reality.public_key));
      if (tls.reality.short_id) query.push(vlessQueryPair("sid", tls.reality.short_id));
    }
    if (Array.isArray(tls.alpn) && tls.alpn.length) query.push(vlessQueryPair("alpn", tls.alpn.join(",")));
    if (tls.insecure === true) query.push(vlessQueryPair("allowInsecure", "1"));
  }

  if (transportType === "ws") {
    var wsHost = vlessHeader(transport.headers, "Host");
    if (wsHost) query.push(vlessQueryPair("host", wsHost));
    if (transport.path) query.push(vlessQueryPair("path", transport.path));
    if (parseInt(transport.max_early_data, 10) > 0) query.push(vlessQueryPair("ed", parseInt(transport.max_early_data, 10)));
    if (transport.early_data_header_name) query.push(vlessQueryPair("eh", transport.early_data_header_name));
  } else if (transportType === "grpc") {
    if (transport.service_name) query.push(vlessQueryPair("serviceName", transport.service_name));
  } else if (transportType === "http") {
    var httpHosts = Array.isArray(transport.host) ? transport.host.join(",") : String(transport.host || "");
    if (httpHosts) query.push(vlessQueryPair("host", httpHosts));
    if (transport.path) query.push(vlessQueryPair("path", transport.path));
    if (transport.method) query.push(vlessQueryPair("method", transport.method));
  } else if (transportType === "httpupgrade") {
    if (transport.host) query.push(vlessQueryPair("host", transport.host));
    if (transport.path) query.push(vlessQueryPair("path", transport.path));
  }

  var tag = String(outbound.tag || "").trim();
  return "vless://" + encodeURIComponent(uuid) + "@" + vlessUriHost(server) + ":" + serverPort + "?" + query.join("&") +
    (tag ? "#" + encodeURIComponent(tag) : "");
}

    var vpnNameInput = E("input", { type:"text", class:"cbi-input-text", value:"vpn0", maxlength:"15", autocomplete:"off", spellcheck:"false" });
    var vpnProtocol = E("select", { class:"cbi-input-select" }, [
      E("option", { value:"auto", selected:"" }, "Автоопределение по конфигурации"),
      E("option", { value:"wireguard" }, "WireGuard"),
      E("option", { value:"amneziawg" }, "AWG Tools (AWG 1.5/2.0/3.0)"),
    ]);
    var vpnConfig = E("textarea", { class:"cbi-input-text fkpsc-vpn-config", spellcheck:"false",
      placeholder:"[Interface]\nPrivateKey = ...\nAddress = 10.0.0.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ...\nAllowedIPs = 0.0.0.0/0\nEndpoint = host:port\nPersistentKeepalive = 25\n\nДля AmneziaWG добавьте Jc, Jmin, Jmax, S1, S2, H1-H4. I1-I5 включают AWG 3.0." });
    var vpnFileInput = E("input", { type:"file", accept:".conf,.wg,text/plain,application/octet-stream", style:"display:none" });
    var vpnFileButton = E("button", { class:"cbi-button", type:"button" }, "Загрузить файл конфигурации");
    var vpnFileName = E("span", { class:"fkpsc-vpn-filename" }, "Можно выбрать файл .conf или .wg до 16 КиБ.");
    var vpnAction = E("button", { class:"cbi-button cbi-button-action important", type:"button" }, "Создать безопасно и проверить");
    var vpnManagedSelect = E("select", { class:"cbi-input-select", "aria-label":"Управляемый VPN-туннель" });
    var vpnProbeTarget = E("input", { type:"text", class:"cbi-input-text", value:"1.1.1.1", autocomplete:"off", spellcheck:"false", placeholder:"1.1.1.1" });
    var vpnManualCheck = E("button", { class:"cbi-button cbi-button-action", type:"button" }, "Проверить туннель вручную");
    var vpnRefreshInterfaces = E("button", { class:"cbi-button", type:"button" }, "Обновить список");
    var vpnInstall = E("button", { class:"cbi-button cbi-button-action", type:"button" }, "Установить компоненты");
    var vpnNotice = E("div", { class:"fkpsc-custom-result", style:"display:none" });
    var vpnPackageNote = E("div", {});

    function vpnDetectedProtocol() {
      return /^\s*(?:Jc|Jmin|Jmax|S1|S2|S3|S4|H1|H2|H3|H4|I[1-5])\s*=/mi.test(vpnConfig.value) ? "amneziawg" : "wireguard";
    }
    function vpnSelectedProtocol() { return vpnProtocol.value === "auto" ? vpnDetectedProtocol() : vpnProtocol.value; }
    function vpnProtocolLabel(protocol) { return protocol === "amneziawg" ? "AWG Tools" : "WireGuard"; }
    function vpnCurrentStatus() { return vpnPackages[vpnSelectedProtocol()] || {}; }
    function vpnInstallMessage(result) {
      var parts = [result.message || "Проверьте пакетный менеджер."];
      if (Array.isArray(result.issues) && result.issues.length) parts.push("Не готовы: " + result.issues.join("; "));
      if (result.output) parts.push("Вывод пакетного менеджера:\n" + result.output);
      return parts.join("\n\n");
    }
    function showVpnNotice(state, title, message) {
      vpnNotice.style.display = "";
      vpnNotice.className = "fkpsc-custom-result state-" + (state === "ok" ? "success" : state === "err" ? "error" : "warning");
      vpnNotice.replaceChildren(E("div", { class:"fkpsc-custom-head" }, [E("span", { class:"fkpsc-custom-title" }, title), E("span", { class:"fkpsc-custom-pill " + state }, state === "ok" ? "готово" : state === "err" ? "ошибка" : "выполняется")]), E("div", {}, message));
    }
    function renderVpnManagedInterfaces(items, selectedName) {
      items = Array.isArray(items) ? items : [];
      var previous = selectedName || vpnManagedSelect.value;
      vpnManagedSelect.replaceChildren();
      if (!items.length) {
        vpnManagedSelect.appendChild(E("option", { value:"" }, "Управляемые туннели не найдены"));
        vpnManagedSelect.disabled = true;
        vpnManualCheck.disabled = true;
        return;
      }
      items.forEach(function (item) {
        var label = item.name + " · " + vpnProtocolLabel(item.protocol) + " · " +
          (item.link_up ? "link поднят" : "link не поднят") + " · " +
          (item.handshake ? "handshake есть" : "handshake нет");
        vpnManagedSelect.appendChild(E("option", { value:item.name, selected:item.name === previous ? "" : null }, label));
      });
      vpnManagedSelect.disabled = false;
      if (previous && items.some(function (item) { return item.name === previous; })) vpnManagedSelect.value = previous;
      vpnManualCheck.disabled = false;
    }
    function reloadVpnManagedInterfaces(selectedName, reportError) {
      vpnRefreshInterfaces.disabled = true;
      vpnRefreshInterfaces.textContent = "Обновляю...";
      return callBin(["vpn-interfaces"]).then(function (result) {
        vpnInterfacesData = result || { interfaces:[] };
        renderVpnManagedInterfaces(vpnInterfacesData.interfaces, selectedName);
        if (reportError && !(vpnInterfacesData.interfaces || []).length)
          showVpnNotice("wait", "Список туннелей пуст", "Сначала создайте WireGuard/AWG-интерфейс через этот модуль.");
      }).catch(function (error) {
        renderVpnManagedInterfaces([], "");
        if (reportError) showVpnNotice("err", "Список не обновлён", error.message || "Не удалось получить список туннелей.");
      }).finally(function () {
        vpnRefreshInterfaces.disabled = false;
        vpnRefreshInterfaces.textContent = "Обновить список";
      });
    }
    vpnFileButton.addEventListener("click", function () { vpnFileInput.click(); });
    vpnFileInput.addEventListener("change", function () {
      var file = vpnFileInput.files && vpnFileInput.files[0];
      if (!file) return;
      if (file.size > 16384) {
        showVpnNotice("err", "Файл не загружен", "Размер конфигурации не должен превышать 16 КиБ.");
        vpnFileInput.value = "";
        return;
      }
      vpnFileButton.disabled = true;
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || "").replace(/^\uFEFF/, "");
        if (!raw.trim()) {
          showVpnNotice("err", "Файл не загружен", "Выбранный файл пуст.");
        } else {
          vpnConfig.value = raw;
          vpnFileName.textContent = file.name + " · " + file.size + " байт";
          renderVpnPackages();
          showVpnNotice("ok", "Конфигурация загружена", "Файл добавлен в поле конфигурации. Проверьте имя интерфейса и нажмите «Создать безопасно и проверить».");
        }
        vpnFileButton.disabled = false;
        vpnFileInput.value = "";
      };
      reader.onerror = function () {
        vpnFileButton.disabled = false;
        vpnFileInput.value = "";
        showVpnNotice("err", "Файл не загружен", "Не удалось прочитать выбранный файл.");
      };
      reader.readAsText(file, "utf-8");
    });
    function renderVpnPackages() {
      var selectedProtocol = vpnSelectedProtocol(), status = vpnCurrentStatus(), ready = !!status.ready;
      vpnAction.disabled = !ready; vpnInstall.disabled = ready || !status.install_available || (vpnProtocol.value === "auto" && !vpnConfig.value.trim());
      if (ready) {
        if (selectedProtocol === "amneziawg" && status.awg_i_ready === false) {
          vpnPackageNote.replaceChildren(E("div", { class:"fkpsc-note" }, "Установленный AWG Tools не поддерживает параметр I1. Обновите пакет перед импортом AWG 1.5/3.0."));
        } else vpnPackageNote.replaceChildren();
        return;
      }
      var names = Array.isArray(status.missing) && status.missing.length ? status.missing.join(", ") : "компоненты протокола";
      vpnPackageNote.replaceChildren(E("div", { class:"fkpsc-note" }, [E("span", {}, "Для " + vpnProtocolLabel(selectedProtocol) + " отсутствуют: " + names + ". "), status.install_available ? vpnInstall : E("span", {}, "Поддерживаемый пакетный менеджер не найден.")]));
    }
    vpnProtocol.addEventListener("change", renderVpnPackages);
    vpnConfig.addEventListener("input", renderVpnPackages);
    vpnInstall.addEventListener("click", function () {
      var protocol = vpnSelectedProtocol();
      if (vpnInstall.disabled || !window.confirm("Обновить индекс пакетов и установить компоненты " + vpnProtocolLabel(protocol) + "?")) return;
      vpnInstall.disabled = true; vpnInstall.textContent = "Устанавливаю..."; showVpnNotice("wait", "Установка компонентов", "Обновляем индекс пакетов и устанавливаем зависимости.");
      callBin(["vpn-install", protocol]).then(function (result) { vpnPackages[protocol] = result; renderVpnPackages(); showVpnNotice(result.ready ? "ok" : "err", result.ready ? "Компоненты готовы" : "Компоненты не установлены", vpnInstallMessage(result));
      }).catch(function (error) { showVpnNotice("err", "Установка не выполнена", error.message || "Не удалось установить пакеты.");
      }).finally(function () { vpnInstall.textContent = "Установить компоненты"; renderVpnPackages(); });
    });
    vpnAction.addEventListener("click", function () {
      if (vpnAction.disabled) return;
      var name = vpnNameInput.value.trim(), config = vpnConfig.value.trim(), protocol = vpnProtocol.value, probeTarget = vpnProbeTarget.value.trim();
      if (!name || !config) { showVpnNotice("err", "Конфигурация не отправлена", "Укажите имя интерфейса и вставьте конфигурацию."); return; }
      if (!probeTarget) { showVpnNotice("err", "Проверка не запущена", "Укажите IP-адрес для тестового пакета."); return; }
      vpnAction.disabled = true; vpnAction.textContent = "Создаю и проверяю..."; showVpnNotice("wait", "Создание интерфейса", "Проверяем конфигурацию, поднимаем интерфейс и отправляем тестовый пакет через туннель. DNS, FwMark, фиксированный ListenPort и системные маршруты не применяются.");
      callBin(["vpn-create", name, protocol, config, probeTarget]).then(function (result) {
        if (!result.success) { showVpnNotice("err", "Интерфейс не создан", result.message || "Проверка не прошла."); return; }
        var title = result.protocol === "amneziawg" ? "AWG Tools " + (result.awg_version || "") : "WireGuard";
        showVpnNotice(result.tunnel_ok ? "ok" : "wait", title + " · " + result.interface, (result.message || "Интерфейс создан.") + " DNS, FwMark и фиксированный ListenPort из файла не применены. Автоматические маршруты отключены, адреса записаны только как /32 и /128." + (result.test_packet_sent ? " Тестовый пакет отправлен." : " Тестовый пакет не отправлен.") + (result.handshake ? " Handshake подтверждён." : " Handshake не подтверждён."));
        reloadVpnManagedInterfaces(result.interface, false);
      }).catch(function (error) { showVpnNotice("err", "Ошибка выполнения", error.message || "Не удалось создать интерфейс.");
      }).finally(function () { vpnAction.textContent = "Создать безопасно и проверить"; renderVpnPackages(); });
    });
    vpnManualCheck.addEventListener("click", function () {
      var name = vpnManagedSelect.value, probeTarget = vpnProbeTarget.value.trim();
      if (!name || !probeTarget) { showVpnNotice("err", "Проверка не запущена", "Выберите туннель из списка и укажите IP-адрес для тестового пакета."); return; }
      vpnManualCheck.disabled = true;
      vpnManualCheck.textContent = "Проверяю...";
      showVpnNotice("wait", "Ручная проверка туннеля", "Поднимаем управляемый интерфейс при необходимости и отправляем один пакет строго через него.");
      callBin(["vpn-check", name, probeTarget]).then(function (result) {
        var facts = [];
        facts.push(result.link_up ? "Link поднят." : "Link не поднят.");
        facts.push(result.packet_sent ? "Пакет отправлен." : "Пакет не отправлен.");
        facts.push(result.handshake ? "Handshake есть." : "Handshake не получен.");
        facts.push(result.ping_ok ? "Цель ответила на ping." : "Цель не ответила на ping.");
        if (result.rx_bytes !== undefined && result.tx_bytes !== undefined) facts.push("Счётчики: RX " + result.rx_bytes + " / TX " + result.tx_bytes + " байт.");
        showVpnNotice(result.tunnel_ok ? "ok" : (result.packet_sent || result.handshake ? "wait" : "err"), "Проверка · " + (result.interface || name), (result.message || "Проверка завершена.") + " " + facts.join(" "));
      }).catch(function (error) { showVpnNotice("err", "Проверка не выполнена", error.message || "Не удалось проверить туннель.");
      }).finally(function () { vpnManualCheck.disabled = !vpnManagedSelect.value; vpnManualCheck.textContent = "Проверить туннель вручную"; });
    });
    vpnRefreshInterfaces.addEventListener("click", function () { reloadVpnManagedInterfaces(vpnManagedSelect.value, true); });
    renderVpnPackages();
    renderVpnManagedInterfaces(vpnInterfacesData.interfaces, "");

    var vlessUriInput = E("textarea", {
      class:"cbi-input-text fkpsc-converter-text",
      spellcheck:"false",
      autocomplete:"off",
      placeholder:"vless://UUID@server.example:443?encryption=none&security=reality&type=tcp&sni=example.com&fp=chrome&pbk=...&sid=...#Мой сервер",
    });
    var vlessJsonInput = E("textarea", {
      class:"cbi-input-text fkpsc-converter-text",
      spellcheck:"false",
      autocomplete:"off",
      placeholder:'{\n  "type": "vless",\n  "tag": "Мой сервер",\n  "server": "server.example",\n  "server_port": 443,\n  "uuid": "..."\n}',
    });
    var vlessToJsonButton = E("button", { class:"cbi-button cbi-button-action important", type:"button" }, "VLESS → JSON");
    var jsonToVlessButton = E("button", { class:"cbi-button cbi-button-action", type:"button" }, "JSON → VLESS");
    var copyVlessButton = E("button", { class:"cbi-button", type:"button" }, "Копировать VLESS");
    var copyVlessJsonButton = E("button", { class:"cbi-button", type:"button" }, "Копировать JSON");
    var vlessConverterStatus = E("div", { class:"fkpsc-converter-status", role:"status", "aria-live":"polite" }, "Конвертация выполняется в браузере; данные не отправляются на роутер или во внешние сервисы.");

    function showVlessConverterStatus(ok, message) {
      vlessConverterStatus.className = "fkpsc-converter-status " + (ok ? "ok" : "err");
      vlessConverterStatus.textContent = message;
    }
    vlessToJsonButton.addEventListener("click", function () {
      try {
        vlessJsonInput.value = JSON.stringify(vlessOutboundFromUri(vlessUriInput.value), null, 2);
        showVlessConverterStatus(true, "VLESS-ссылка преобразована в sing-box outbound JSON.");
      } catch (error) {
        showVlessConverterStatus(false, error.message || "Не удалось преобразовать VLESS-ссылку.");
      }
    });
    jsonToVlessButton.addEventListener("click", function () {
      try {
        var vlessJsonDocument;
        try {
          vlessJsonDocument = JSON.parse(vlessJsonInput.value);
        } catch (parseError) {
          throw new Error("JSON имеет неверный синтаксис: " + parseError.message);
        }
        vlessUriInput.value = vlessUriFromOutbound(vlessJsonDocument);
        showVlessConverterStatus(true, "sing-box outbound JSON преобразован в VLESS-ссылку.");
      } catch (error) {
        showVlessConverterStatus(false, error.message || "Не удалось преобразовать JSON.");
      }
    });
    copyVlessButton.addEventListener("click", function () {
      if (!vlessUriInput.value.trim()) { showVlessConverterStatus(false, "Поле VLESS пусто."); return; }
      copyText(vlessUriInput.value.trim()).then(function () {
        showVlessConverterStatus(true, "VLESS-ссылка скопирована.");
      }).catch(function () { showVlessConverterStatus(false, "Браузер не разрешил копирование."); });
    });
    copyVlessJsonButton.addEventListener("click", function () {
      if (!vlessJsonInput.value.trim()) { showVlessConverterStatus(false, "Поле JSON пусто."); return; }
      copyText(vlessJsonInput.value.trim()).then(function () {
        showVlessConverterStatus(true, "JSON скопирован.");
      }).catch(function () { showVlessConverterStatus(false, "Браузер не разрешил копирование."); });
    });

    var vlessVpnTab = E("button", { class:"fkpsc-vpn-tab active", type:"button", role:"tab", "aria-selected":"true" }, "VLESS ↔ JSON");
    var tunnelVpnTab = E("button", { class:"fkpsc-vpn-tab", type:"button", role:"tab", "aria-selected":"false" }, "WireGuard / AWG");
    var vlessVpnPanel = E("div", { class:"fkpsc-card fkpsc-vpn-panel active", role:"tabpanel" }, [
      E("h3", {}, "Конвертер VLESS ↔ sing-box JSON"),
      E("p", { class:"fkpsc-dim" }, "Преобразует одну VLESS-ссылку в готовый outbound sing-box и обратно. Можно вставить полный конфиг с одним VLESS outbound; dial- и route-поля, которых нет в URI, в ссылку не переносятся."),
      E("div", { class:"fkpsc-converter-grid" }, [
        E("label", { class:"fkpsc-converter-pane" }, [E("span", {}, "VLESS-ссылка"), vlessUriInput]),
        E("label", { class:"fkpsc-converter-pane" }, [E("span", {}, "sing-box outbound JSON"), vlessJsonInput]),
      ]),
      E("div", { class:"fkpsc-converter-actions" }, [vlessToJsonButton, jsonToVlessButton, copyVlessButton, copyVlessJsonButton]),
      vlessConverterStatus,
    ]);
    var tunnelVpnPanel = E("div", { class:"fkpsc-card fkpsc-vpn-panel", role:"tabpanel" }, [
      E("h3", {}, "Создание VPN-интерфейса"),
      E("div", { class:"fkpsc-vpn-grid" }, [E("label", { class:"fkpsc-editor-field" }, [E("span", {}, "Имя интерфейса"), vpnNameInput]), E("label", { class:"fkpsc-editor-field" }, [E("span", {}, "Протокол"), vpnProtocol]), E("div", { class:"fkpsc-editor-field" }, [E("span", {}, "Действие"), vpnAction])]),
      E("label", { class:"fkpsc-editor-field" }, [E("span", {}, "Конфигурация"), vpnConfig]),
      E("div", { class:"fkpsc-vpn-import" }, [vpnFileButton, vpnFileInput, vpnFileName]),
      E("h3", { style:"margin-top:1em" }, "Ручная проверка туннеля"),
      E("div", { class:"fkpsc-vpn-manual" }, [
        E("label", { class:"fkpsc-editor-field" }, [E("span", {}, "Туннель, созданный модулем"), vpnManagedSelect]),
        E("label", { class:"fkpsc-editor-field" }, [E("span", {}, "IP для тестового пакета (должен входить в AllowedIPs)"), vpnProbeTarget]),
        vpnRefreshInterfaces,
        vpnManualCheck,
      ]),
      E("div", { class:"fkpsc-note" }, "Безопасный режим: DNS из конфигурации не применяется, автоматические маршруты AllowedIPs не создаются. Для проверки тестовый пакет привязывается к VPN-интерфейсу вручную и не меняет системный default route."), vpnPackageNote, vpnNotice,
    ]);
    function showVpnTool(name) {
      var showVless = name === "vless";
      vlessVpnTab.classList.toggle("active", showVless);
      tunnelVpnTab.classList.toggle("active", !showVless);
      vlessVpnTab.setAttribute("aria-selected", showVless ? "true" : "false");
      tunnelVpnTab.setAttribute("aria-selected", showVless ? "false" : "true");
      vlessVpnPanel.classList.toggle("active", showVless);
      tunnelVpnPanel.classList.toggle("active", !showVless);
    }
    vlessVpnTab.addEventListener("click", function () { showVpnTool("vless"); });
    tunnelVpnTab.addEventListener("click", function () { showVpnTool("tunnel"); });

    var checkTab = E("button", { class: "fkpsc-tab active", type: "button", role: "tab", "aria-selected": "true" }, "Проверка сервисов");
    var dnsTab = E("button", { class: "fkpsc-tab", type: "button", role: "tab", "aria-selected": "false" }, "Тест DNS");
    var vpnTab = E("button", { class: "fkpsc-tab", type: "button", role: "tab", "aria-selected": "false" }, "VPN");
    var fixTab = E("button", { class: "fkpsc-tab", type: "button", role: "tab", "aria-selected": "false" }, "Фикс Forkop");
    var listsTab = E("button", { class: "fkpsc-tab", type: "button", role: "tab", "aria-selected": "false" }, "Списки");
    var checkPage = E("div", { class: "fkpsc-page active" }, [
      notes.length ? E("div", { class: "fkpsc-note" }, notes.map(function (note) {
        return E("div", {}, note);
      })) : "",
      updateCard,
      backendDiagnosticsCard,
      E("div", { class: "fkpsc-card" }, [
        E("h3", {}, "Параметры проверки"),
        E("div", { class: "fkpsc-mode" }, [
          E("label", {}, [modeRouter, E("span", {}, " С роутера (быстро)")]),
          E("label", {}, [
            modeNetns,
            E("span", {}, " От имени клиента в LAN"),
            clientIpInput,
          ]),
        ]),
        E("h3", { style: "margin-top:1em" }, "Проверить свой IP или домен"),
        E("p", { class: "fkpsc-dim" },
          "Введите любую цель и TCP-порт. Проверка покажет доступность и подтвердит, попало ли соединение в sing-box. Используется выбранный выше режим."),
        E("div", { class: "fkpsc-custom-form" }, [
          customTargetInput,
          E("label", { class: "fkpsc-custom-port-label" }, ["Порт", customPortInput]),
          customCheckButton,
        ]),
        customResultNode,
        E("h3", {}, "Сервисы"),
        E("div", { class: "fkpsc-service-tools" }, [serviceSearch, quickPreset, udpPreset]),
        picker,
        E("div", { class: "fkpsc-actions" }, [
          runButton,
          retryButton,
          stopButton,
          E("button", {
            class: "cbi-button",
            click: function () { setAll(true); },
          }, "Выбрать все"),
          E("button", {
            class: "cbi-button",
            click: function () { setAll(false); },
          }, "Снять все"),
          progressWrap,
          progressText,
        ]),
      ]),
      summaryNode,
      metaNode,
      tilesNode,
      historyPanel,
      reportPanel,
    ]);
    var fixPage = E("div", { class: "fkpsc-page" }, [maintenancePanel]);
    var vpnPage = E("div", { class:"fkpsc-page" }, [
      E("div", { class:"fkpsc-vpn-tabs", role:"tablist", "aria-label":"Инструменты VPN" }, [vlessVpnTab, tunnelVpnTab]),
      vlessVpnPanel,
      tunnelVpnPanel,
    ]);
    var profilesCardsNode = E("div", {});
    var saveProfilesButton = E("button", { class: "cbi-button cbi-button-action important", type: "button" }, "Сохранить список");
    var resetProfilesButton = E("button", { class: "cbi-button cbi-button-negative", type: "button" }, "Вернуть встроенный");
    var exportProfilesButton = E("button", { class: "cbi-button", type: "button" }, "Экспорт JSON");
    var importProfilesButton = E("button", { class: "cbi-button", type: "button" }, "Импорт JSON");
    var importProfilesInput = E("input", { type: "file", accept: "application/json,.json", style: "display:none" });
    var addProfileButton = E("button", { class: "fkpsc-add-profile", type: "button" }, "+ Добавить категорию");
    saveProfilesButton.disabled = !profilesData;
    resetProfilesButton.disabled = !profilesData;

    exportProfilesButton.addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(profilesDraft, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = E("a", { href: url, download: "sing-box-service-check-profiles.json" });
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    importProfilesButton.addEventListener("click", function () { importProfilesInput.click(); });
    importProfilesInput.addEventListener("change", function () {
      var file = importProfilesInput.files && importProfilesInput.files[0];
      if (!file) { return; }
      if (file.size > 131072) {
        ui.addNotification(null, E("p", {}, "Файл больше допустимых 128 КиБ."), "warning");
        importProfilesInput.value = "";
        return;
      }
      importProfilesButton.disabled = true;
      var reader = new FileReader();
      reader.onload = function () {
        var raw = String(reader.result || "");
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (error) {
          ui.addNotification(null, E("p", {}, "Не удалось разобрать JSON: " + error.message), "error");
          importProfilesButton.disabled = false;
          importProfilesInput.value = "";
          return;
        }
        callBin(["profiles-validate", raw]).then(function (result) {
          if (!result.success) { throw new Error(result.message || "список не прошёл проверку"); }
          profilesDraft = parsed;
          if (!Array.isArray(profilesDraft.profiles)) { profilesDraft.profiles = []; }
          renderProfilesCards();
          ui.addNotification(null, E("p", {}, "Импортировано категорий: " + profilesDraft.profiles.length + ". Нажмите «Сохранить список», чтобы применить изменения."), "info");
        }).catch(function (error) {
          ui.addNotification(null, E("p", {}, "Импорт отклонён: " + error.message), "error");
        }).then(function () {
          importProfilesButton.disabled = false;
          importProfilesInput.value = "";
        });
      };
      reader.onerror = function () {
        importProfilesButton.disabled = false;
        importProfilesInput.value = "";
        ui.addNotification(null, E("p", {}, "Не удалось прочитать выбранный файл."), "error");
      };
      reader.readAsText(file, "utf-8");
    });

    function editorField(label, value, onInput, options) {
      options = options || {};
      var control;
      if (options.textarea) {
        control = E("textarea", { placeholder: options.placeholder || "" }, value == null ? "" : String(value));
      } else {
        var attrs = {
          type: options.type || "text",
          class: "cbi-input-text",
          value: value == null ? "" : String(value),
          placeholder: options.placeholder || "",
        };
        if (options.min != null) {
          attrs.min = String(options.min);
        }
        if (options.max != null) {
          attrs.max = String(options.max);
        }
        control = E("input", attrs);
      }
      control.addEventListener("input", function () { onInput(control.value); });
      return E("label", { class: "fkpsc-editor-field" + (options.wide ? " wide" : "") }, [
        E("span", {}, label),
        control,
      ]);
    }

    function moveEditorItem(items, index, direction) {
      var destination = index + direction;
      if (destination < 0 || destination >= items.length) {
        return;
      }
      var item = items.splice(index, 1)[0];
      items.splice(destination, 0, item);
      renderProfilesCards();
    }

    function editorIconButton(text, title, onClick, extraClass) {
      var button = E("button", {
        class: "cbi-button fkpsc-icon-button" + (extraClass ? " " + extraClass : ""),
        type: "button",
        title: title,
      }, text);
      button.addEventListener("click", onClick);
      return button;
    }

    function renderTargetEditor(profile, profileIndex, target, targetIndex) {
      var kinds = [
        ["https", "HTTPS"],
        ["http", "HTTP"],
        ["tcp", "TCP"],
        ["udp", "UDP"],
        ["udp_dns", "UDP с DNS-ответом"],
      ];
      var kind = target.kind || "https";
      var kindSelect = E("select", { class: "cbi-input-select" }, kinds.map(function (entry) {
        return E("option", { value: entry[0], selected: kind === entry[0] ? "" : null }, entry[1]);
      }));
      kindSelect.addEventListener("change", function () {
        target.kind = kindSelect.value;
        renderProfilesCards();
      });

      var optionalInput = E("input", { type: "checkbox", checked: target.optional ? "" : null });
      optionalInput.addEventListener("change", function () { target.optional = optionalInput.checked; });

      var expectedRoute = target.expected_route || "any";
      var routeSelect = E("select", { class: "cbi-input-select" }, [
        ["any", "Любой маршрут"],
        ["proxy", "Только через sing-box"],
        ["direct", "Только напрямую"],
      ].map(function (entry) {
        return E("option", { value: entry[0], selected: expectedRoute === entry[0] ? "" : null }, entry[1]);
      }));
      routeSelect.addEventListener("change", function () { target.expected_route = routeSelect.value; });

      var fields = [
        E("label", { class: "fkpsc-editor-field" }, [E("span", {}, "Тип проверки"), kindSelect]),
        editorField("Домен или IP", target.host || "", function (value) { target.host = value.trim(); }, { placeholder: "example.com или 1.1.1.1" }),
        editorField("Порт", target.port || (kind === "http" ? 80 : 443), function (value) {
          if (value === "") {
            delete target.port;
          } else {
            target.port = parseInt(value, 10) || 0;
          }
        }, { type: "number", min: 1, max: 65535 }),
        editorField("Подпись", target.label || "", function (value) { target.label = value; }, { placeholder: "Необязательно" }),
        E("label", { class: "fkpsc-editor-field" }, [E("span", {}, "Ожидаемый маршрут"), routeSelect]),
      ];

      if (kind === "https" || kind === "http") {
        fields.push(editorField("Путь", target.path || "/", function (value) { target.path = value || "/"; }, { placeholder: "/" }));
        fields.push(editorField("Допустимые коды", (Array.isArray(target.expect) ? target.expect : []).join(", "), function (value) {
          target.expect = value.split(/[ ,;]+/).map(function (part) { return parseInt(part, 10); })
            .filter(function (code) { return code >= 100 && code <= 999; });
        }, { placeholder: "200, 301, 302" }));
      }
      if (kind === "udp_dns") {
        fields.push(editorField("DNS-запрос", target.query || "example.com", function (value) { target.query = value.trim(); }, { placeholder: "example.com" }));
      }
      fields.push(E("label", { class: "fkpsc-editor-field" }, [
        E("span", {}, "Необязательная цель"),
        E("span", {}, [optionalInput, " Не считать ошибкой всей категории"]),
      ]));

      return E("div", { class: "fkpsc-target-edit" }, [
        E("div", { class: "fkpsc-target-head" }, [
          E("b", {}, "Цель " + (targetIndex + 1) + (target.label ? " · " + target.label : "")),
          editorIconButton("↑", "Поднять цель", function () { moveEditorItem(profile.targets, targetIndex, -1); }),
          editorIconButton("↓", "Опустить цель", function () { moveEditorItem(profile.targets, targetIndex, 1); }),
          editorIconButton("×", "Удалить цель", function () {
            if (profile.targets.length <= 1) {
              ui.addNotification(null, E("p", {}, "В категории должна остаться хотя бы одна цель."), "warning");
              return;
            }
            profile.targets.splice(targetIndex, 1);
            renderProfilesCards();
          }, "cbi-button-negative"),
        ]),
        E("div", { class: "fkpsc-editor-grid" }, fields),
      ]);
    }

    function renderProfileEditor(profile, profileIndex) {
      profile.targets = Array.isArray(profile.targets) ? profile.targets : [];
      var profileName = E("div", { class: "fkpsc-profile-name" }, profile.title || "Без названия");
      var targetsNode = E("div", {}, profile.targets.map(function (target, targetIndex) {
        return renderTargetEditor(profile, profileIndex, target, targetIndex);
      }));
      var addTargetButton = E("button", { class: "cbi-button cbi-button-add", type: "button" }, "+ Добавить цель");
      addTargetButton.addEventListener("click", function () {
        profile.targets.push({ kind: "https", host: "example.com", path: "/", expect: [200, 301, 302] });
        renderProfilesCards();
      });

      return E("div", { class: "fkpsc-profile-edit" }, [
        E("div", { class: "fkpsc-profile-head" }, [
          E("span", { class: "fkpsc-profile-number" }, String(profileIndex + 1)),
          profileName,
          editorIconButton("↑", "Поднять категорию", function () { moveEditorItem(profilesDraft.profiles, profileIndex, -1); }),
          editorIconButton("↓", "Опустить категорию", function () { moveEditorItem(profilesDraft.profiles, profileIndex, 1); }),
          editorIconButton("×", "Удалить категорию", function () {
            if (!window.confirm("Удалить категорию «" + (profile.title || profile.id) + "»?")) {
              return;
            }
            profilesDraft.profiles.splice(profileIndex, 1);
            renderProfilesCards();
          }, "cbi-button-negative"),
        ]),
        E("div", { class: "fkpsc-editor-grid" }, [
          editorField("Название категории", profile.title || "", function (value) {
            profile.title = value;
            profileName.textContent = value || "Без названия";
          }, { placeholder: "Например, Telegram" }),
          editorField("ID", profile.id || "", function (value) { profile.id = value.trim(); }, { placeholder: "telegram" }),
          editorField("Группа", profile.group || "", function (value) { profile.group = value.trim(); }, { placeholder: "messenger, video, network…" }),
          editorField("Описание", profile.description || "", function (value) { profile.description = value; }, { textarea: true, wide: true }),
        ]),
        E("div", { class: "fkpsc-targets-title" }, [
          E("span", {}, "Цели проверки · " + profile.targets.length),
          addTargetButton,
        ]),
        targetsNode,
      ]);
    }

    function renderProfilesCards() {
      if (!profilesDraft.profiles.length) {
        profilesCardsNode.replaceChildren(E("div", { class: "fkpsc-empty" }, "Категорий пока нет. Добавьте первую."));
        return;
      }
      profilesCardsNode.replaceChildren.apply(profilesCardsNode, profilesDraft.profiles.map(renderProfileEditor));
    }

    addProfileButton.addEventListener("click", function () {
      var index = 1;
      var used = {};
      profilesDraft.profiles.forEach(function (profile) { used[profile.id] = true; });
      while (used["custom_" + index]) {
        index++;
      }
      profilesDraft.profiles.push({
        id: "custom_" + index,
        title: "Новая категория",
        group: "custom",
        description: "",
        targets: [{ kind: "https", host: "example.com", path: "/", expect: [200, 301, 302] }],
      });
      renderProfilesCards();
    });

    saveProfilesButton.addEventListener("click", function () {
      saveProfilesButton.disabled = true;
      saveProfilesButton.textContent = "Сохраняю…";
      callBin(["profiles-save", JSON.stringify(profilesDraft)]).then(function (result) {
        if (!result.success) {
          throw new Error(result.message || "не удалось сохранить список");
        }
        ui.addNotification(null, E("p", {}, result.message + ". Страница будет обновлена."), "info");
        window.setTimeout(function () { window.location.reload(); }, 700);
      }).catch(function (error) {
        ui.addNotification(null, E("p", {}, error.message || "Не удалось сохранить список"), "error");
        saveProfilesButton.disabled = false;
        saveProfilesButton.textContent = "Сохранить список";
      });
    });

    resetProfilesButton.addEventListener("click", function () {
      if (!window.confirm("Удалить пользовательский список и вернуть встроенный?")) {
        return;
      }
      resetProfilesButton.disabled = true;
      callBin(["profiles-reset"]).then(function (result) {
        if (!result.success) {
          throw new Error(result.message || "не удалось восстановить список");
        }
        window.location.reload();
      }).catch(function (error) {
        ui.addNotification(null, E("p", {}, error.message || "Не удалось восстановить список"), "error");
        resetProfilesButton.disabled = false;
      });
    });

    renderProfilesCards();

    var listsPage = E("div", { class: "fkpsc-page" }, [
      E("div", { class: "fkpsc-card" }, [
        E("h3", {}, "Списки проверок"),
        E("p", { class: "fkpsc-dim" }, "Редактируйте список обычными полями — код и JSON трогать не нужно. Пользовательская копия хранится в /etc/forkop-servicecheck/profiles.json и сохраняется при обновлении модуля."),
        E("div", { class: "fkpsc-list-toolbar" }, [
          E("span", { class: "fkpsc-source" }, "Сейчас: " + (profilesData && profilesData.source === "custom" ? "пользовательский список" : "встроенный список")),
          importProfilesInput,
          importProfilesButton,
          exportProfilesButton,
          saveProfilesButton,
          resetProfilesButton,
        ]),
        profilesData ? profilesCardsNode : E("div", { class: "alert-message error" }, "Backend не отдал список проверок."),
        profilesData ? addProfileButton : "",
      ]),
    ]);

    function showPage(name) {
      var showDns = name === "dns";
      var showVpn = name === "vpn";
      var showFix = name === "fix";
      var showLists = name === "lists";
      var showCheck = !showDns && !showVpn && !showFix && !showLists;
      checkTab.classList.toggle("active", showCheck);
      dnsTab.classList.toggle("active", showDns);
      vpnTab.classList.toggle("active", showVpn);
      fixTab.classList.toggle("active", showFix);
      listsTab.classList.toggle("active", showLists);
      checkTab.setAttribute("aria-selected", showCheck ? "true" : "false");
      dnsTab.setAttribute("aria-selected", showDns ? "true" : "false");
      vpnTab.setAttribute("aria-selected", showVpn ? "true" : "false");
      fixTab.setAttribute("aria-selected", showFix ? "true" : "false");
      listsTab.setAttribute("aria-selected", showLists ? "true" : "false");
      checkPage.classList.toggle("active", showCheck);
      dnsPage.classList.toggle("active", showDns);
      vpnPage.classList.toggle("active", showVpn);
      fixPage.classList.toggle("active", showFix);
      listsPage.classList.toggle("active", showLists);
    }

    checkTab.addEventListener("click", function () { showPage("check"); });
    dnsTab.addEventListener("click", function () { showPage("dns"); });
    vpnTab.addEventListener("click", function () { showPage("vpn"); });
    if (showForkopFixes) {
      fixTab.addEventListener("click", function () { showPage("fix"); });
    }
    listsTab.addEventListener("click", function () { showPage("lists"); });

    var themeChoice = "auto";
    try {
      var storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "auto") {
        themeChoice = storedTheme;
      }
    } catch (error) {
      themeChoice = "auto";
    }

    var pageRoot = null;
    var themeButtons = {};
    var inheritedTheme = "light";

    function themeFromPage() {
      var node = pageRoot ? pageRoot.parentElement : document.body;
      var backgrounds = [];

      while (node && node.nodeType === 1) {
        var marker = [
          node.getAttribute("data-theme") || "",
          node.getAttribute("data-color-scheme") || "",
          node.getAttribute("data-darkmode") === "true" ? "dark" : "",
          typeof node.className === "string" ? node.className : "",
        ].join(" ").toLowerCase();

        if (/(^|[\s_-])(dark|night)(mode)?([\s_-]|$)/.test(marker)) {
          return "dark";
        }
        if (/(^|[\s_-])light([\s_-]|$)/.test(marker)) {
          return "light";
        }

        var style = window.getComputedStyle(node);
        if (style.colorScheme === "dark") {
          return "dark";
        }
        if (style.colorScheme === "light") {
          return "light";
        }
        if (style.backgroundColor && style.backgroundColor !== "transparent" &&
            style.backgroundColor !== "rgba(0, 0, 0, 0)") {
          backgrounds.push(style.backgroundColor);
        }
        node = node.parentElement;
      }

      for (var i = 0; i < backgrounds.length; i++) {
        var rgb = backgrounds[i].match(/[\d.]+/g);
        if (rgb && rgb.length >= 3 && (rgb.length < 4 || parseFloat(rgb[3]) > 0.15)) {
          var luminance = (0.2126 * parseFloat(rgb[0]) + 0.7152 * parseFloat(rgb[1]) +
            0.0722 * parseFloat(rgb[2])) / 255;
          return luminance < 0.5 ? "dark" : "light";
        }
      }

      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function syncInheritedTheme() {
      inheritedTheme = themeFromPage();
      if (pageRoot && themeChoice === "auto") {
        pageRoot.classList.remove("theme-inherited-light", "theme-inherited-dark");
        pageRoot.classList.add("theme-inherited-" + inheritedTheme);
      }
      if (themeButtons.auto) {
        var inheritedLabel = inheritedTheme === "dark" ? "тёмная" : "светлая";
        themeButtons.auto.textContent = "LuCI · " + inheritedLabel;
        themeButtons.auto.title = "Наследовать тему LuCI (сейчас " + inheritedLabel + ")";
      }
    }

    function applyTheme(choice, persist) {
      if (choice !== "light" && choice !== "dark") {
        choice = "auto";
      }
      themeChoice = choice;
      if (pageRoot) {
        pageRoot.classList.remove("theme-auto", "theme-light", "theme-dark", "theme-inherited-light", "theme-inherited-dark");
        pageRoot.classList.add("theme-" + choice);
        if (choice === "auto") {
          syncInheritedTheme();
        }
      }
      Object.keys(themeButtons).forEach(function (name) {
        themeButtons[name].classList.toggle("active", name === choice);
        themeButtons[name].setAttribute("aria-pressed", name === choice ? "true" : "false");
      });
      if (persist) {
        try {
          window.localStorage.setItem(THEME_STORAGE_KEY, choice);
        } catch (error) {
          /* Private browsing or a locked-down browser may disable storage. */
        }
      }
    }

    var themeSwitch = E("div", { class: "fkpsc-theme-switch", role: "group", "aria-label": "Тема интерфейса" });
    [
      ["auto", "LuCI"],
      ["light", "Светлая"],
      ["dark", "Тёмная"],
    ].forEach(function (entry) {
      var name = entry[0];
      var button = E("button", {
        class: "fkpsc-theme-button",
        type: "button",
        "aria-pressed": "false",
      }, entry[1]);
      button.addEventListener("click", function () { applyTheme(name, true); });
      themeButtons[name] = button;
      themeSwitch.appendChild(button);
    });

    pageRoot = E("div", { class: "cbi-map fkpsc theme-" + themeChoice }, [
      E("div", { class: "fkpsc-hero" }, [
        E("div", { class: "fkpsc-theme-line" }, [
          E("h2", {}, "Sing-box Service Check"),
          themeSwitch,
        ]),
        E("p", {}, "Проверка идёт тем же путём, что и трафик клиента: имя резолвится через dnsmasq и sing-box, " +
          "а соединение попадает в цепочку mangle_output и уходит в tproxy. Нажмите на плитку сервиса, " +
          "чтобы увидеть, на каком этапе всё сломалось — DNS, TCP, TLS или HTTP."),
        E("div", { class: "fkpsc-badges" }, [
          E("span", { class: "fkpsc-badge" }, "интерфейс v" + (capabilities.module_version || "unknown")),
          E("span", { class: "fkpsc-badge" }, (backendRunning ? "● " : "○ ") + backendName + (backendRunning ? " запущен" : " остановлен")),
          E("span", { class: "fkpsc-badge" }, capabilities.curl ? "HTTPS: точный" : "HTTPS: упрощённый"),
          E("span", { class: "fkpsc-badge" }, capabilities.netns ? "netns доступен" : "только роутер"),
        ]),
      ]),
      E("div", { class: "fkpsc-tabs", role: "tablist" }, showForkopFixes ? [checkTab, dnsTab, vpnTab, fixTab, listsTab] : [checkTab, dnsTab, vpnTab, listsTab]),
      checkPage,
      dnsPage,
      vpnPage,
      showForkopFixes ? fixPage : "",
      listsPage,
    ]);
    applyTheme(themeChoice, false);

    var themeObserver = new MutationObserver(function () {
      if (themeChoice === "auto") {
        window.requestAnimationFrame(syncInheritedTheme);
      }
    });

    function observeThemeAncestors() {
      var node = pageRoot.parentElement;
      while (node) {
        themeObserver.observe(node, {
          attributes: true,
          attributeFilter: ["class", "style", "data-theme", "data-color-scheme", "data-darkmode"],
        });
        node = node.parentElement;
      }
      syncInheritedTheme();
    }

    window.requestAnimationFrame(observeThemeAncestors);
    if (window.matchMedia) {
      var systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
      if (systemTheme.addEventListener) {
        systemTheme.addEventListener("change", syncInheritedTheme);
      } else if (systemTheme.addListener) {
        systemTheme.addListener(syncInheritedTheme);
      }
    }
    return pageRoot;
  },
});
