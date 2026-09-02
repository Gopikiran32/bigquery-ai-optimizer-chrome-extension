// page-script.js — runs in the MAIN world (the page's own JS context).
// Communicates with content.js through a hidden DOM element, because the two
// worlds cannot share variables.
//
// Why this exists: the BigQuery console does not expose `monaco` as a global —
// Google bundles it internally. To read the full query (not just the lines
// currently scrolled into view) we have to locate the editor instance by
// probing the DOM and the window object.
//
// Probing only happens when content.js asks for a query, never on page load.
//
// Set localStorage.bqOptDebug = '1' in the console to see what it finds.

(function () {
  'use strict';

  var EMPTY = '__BQ_OPT_EMPTY__';  // sentinel: "I looked, found nothing"

  function debug() {
    try {
      return window.localStorage && window.localStorage.getItem('bqOptDebug') === '1';
    } catch (e) {
      return false;
    }
  }

  function log(msg) {
    if (debug()) console.log('[BQ-Opt page] ' + msg);
  }

  // ── Bridge element for cross-world communication ──
  var bridge = document.createElement('div');
  bridge.id = 'bq-opt-bridge';
  bridge.style.display = 'none';
  bridge.dataset.request = '';
  bridge.dataset.response = '';
  document.documentElement.appendChild(bridge);

  // ── Find the Monaco editor instance ──
  function findEditorInstance() {
    // Strategy A: common global names.
    var globalNames = [
      'monaco', '_monaco', 'MonacoEnvironment', '__MONACO__',
      'MonacoEditor', 'monacoEditor'
    ];
    for (var i = 0; i < globalNames.length; i++) {
      try {
        var obj = window[globalNames[i]];
        if (obj && obj.editor && typeof obj.editor.getEditors === 'function') {
          log('found editor via global: ' + globalNames[i]);
          return { type: 'global', api: obj.editor };
        }
      } catch (e) { /* skip */ }
    }

    // Strategy B: Monaco keeps editor references on its DOM nodes.
    var editorElements = document.querySelectorAll('.monaco-editor');
    for (var j = 0; j < editorElements.length; j++) {
      var el = editorElements[j];

      var keys = Object.keys(el);
      for (var k = 0; k < keys.length; k++) {
        try {
          var val = el[keys[k]];
          if (val && typeof val === 'object') {
            if (typeof val.getValue === 'function') {
              log('found editor via DOM key: ' + keys[k]);
              return { type: 'instance', editor: val };
            }
            if (val._codeEditor && typeof val._codeEditor.getValue === 'function') {
              log('found editor via _codeEditor');
              return { type: 'instance', editor: val._codeEditor };
            }
          }
        } catch (e) { /* skip */ }
      }

      // Strategy C: one level deeper — bundlers sometimes nest the instance.
      var allKeys = [];
      try { allKeys = Object.getOwnPropertyNames(el); } catch (e) { /* skip */ }
      for (var m = 0; m < allKeys.length; m++) {
        try {
          var prop = el[allKeys[m]];
          if (prop && typeof prop === 'object' && !Array.isArray(prop)) {
            var innerKeys = Object.keys(prop);
            for (var n = 0; n < innerKeys.length; n++) {
              try {
                var inner = prop[innerKeys[n]];
                if (inner && typeof inner.getValue === 'function'
                    && typeof inner.getModel === 'function') {
                  log('found editor via nested: ' + allKeys[m] + '.' + innerKeys[n]);
                  return { type: 'instance', editor: inner };
                }
              } catch (e) { /* skip */ }
            }
          }
        } catch (e) { /* skip */ }
      }
    }

    // Strategy D: Monaco is often loaded through an AMD loader.
    if (typeof window.require === 'function') {
      try {
        var editorModule = window.require('vs/editor/editor.main');
        if (editorModule && editorModule.editor) {
          log('found editor via AMD require');
          return { type: 'global', api: editorModule.editor };
        }
      } catch (e) { /* skip */ }
    }

    // Strategy E: last resort — scan window for anything exposing getEditors.
    try {
      var windowKeys = Object.getOwnPropertyNames(window);
      for (var w = 0; w < windowKeys.length; w++) {
        try {
          var wVal = window[windowKeys[w]];
          if (wVal && typeof wVal === 'object' && wVal.editor
              && typeof wVal.editor.getEditors === 'function') {
            log('found editor via window scan: ' + windowKeys[w]);
            return { type: 'global', api: wVal.editor };
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* skip */ }

    return null;
  }

  // ── Extract the query text from whatever we found ──
  function getQueryFromEditor() {
    var found = findEditorInstance();
    if (!found) return '';

    if (found.type === 'global') {
      var best = '';
      try {
        var editors = found.api.getEditors() || [];
        for (var i = 0; i < editors.length; i++) {
          try {
            var val = editors[i].getValue() || '';
            if (val.length > best.length) best = val;
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }

      if (best) return best;

      // Fall back to the models, which outlive individual editor views.
      try {
        var models = found.api.getModels() || [];
        for (var j = 0; j < models.length; j++) {
          try {
            var mval = models[j].getValue() || '';
            if (mval.length > best.length) best = mval;
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* skip */ }

      return best;
    }

    if (found.type === 'instance') {
      try {
        var direct = found.editor.getValue();
        if (direct) return direct;
      } catch (e) { /* skip */ }
      try {
        var viaModel = found.editor.getModel().getValue();
        if (viaModel) return viaModel;
      } catch (e) { /* skip */ }
    }

    return '';
  }

  // ── Answer requests from content.js ──
  // Always write a response, using the EMPTY sentinel when there is nothing to
  // send. Otherwise content.js would sit through its whole timeout waiting for
  // an answer that is never coming.
  var observer = new MutationObserver(function () {
    if (bridge.dataset.request !== 'get-query') return;
    bridge.dataset.request = '';

    var query = '';
    try {
      query = getQueryFromEditor() || '';
    } catch (e) {
      log('extraction threw: ' + e.message);
    }

    log('extracted ' + query.length + ' chars');
    bridge.dataset.response = query || EMPTY;
  });

  observer.observe(bridge, { attributes: true, attributeFilter: ['data-request'] });
  log('bridge ready');
})();
