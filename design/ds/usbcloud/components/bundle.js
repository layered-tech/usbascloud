/* @ds-bundle: {"format":4,"namespace":"USBCloud","components":[{"name":"Button","group":"Actions"},{"name":"Input","group":"Forms"},{"name":"StatusBadge","group":"Status"},{"name":"Meter","group":"Status"},{"name":"DeviceCard","group":"Devices"},{"name":"DataTable","group":"Data"},{"name":"Toolbar","group":"Navigation"},{"name":"Tabs","group":"Navigation"},{"name":"Dialog","group":"Overlays"},{"name":"Icon","group":"Primitives"},{"name":"LogPane","group":"Data"},{"name":"SideNav","group":"Navigation"},{"name":"Select","group":"Forms"}]} */
(function () {
  var React = window.React;
  var h = React.createElement;

  // Lucide icons (ISC) used by the components; the app itself uses lucide-react with the same settings.
  var ICONS = {"hard-drive":"<svg class=\"lucide lucide-hard-drive\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\"/> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/> <line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\"/> <line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\"/>","usb":"<svg class=\"lucide lucide-usb\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <circle cx=\"10\" cy=\"7\" r=\"1\"/> <circle cx=\"4\" cy=\"20\" r=\"1\"/> <path d=\"M4.7 19.3 19 5\"/> <path d=\"m21 3-3 1 2 2Z\"/> <path d=\"M9.26 7.68 5 12l2 5\"/> <path d=\"m10 14 5 2 3.5-3.5\"/> <path d=\"m18 12 1-1 1 1-1 1Z\"/>","cloud":"<svg class=\"lucide lucide-cloud\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>","cloud-download":"<svg class=\"lucide lucide-cloud-download\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 13v8l-4-4\"/> <path d=\"m12 21 4-4\"/> <path d=\"M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284\"/>","refresh-cw":"<svg class=\"lucide lucide-refresh-cw\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/> <path d=\"M21 3v5h-5\"/> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/> <path d=\"M8 16H3v5\"/>","folder-sync":"<svg class=\"lucide lucide-folder-sync\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v.5\"/> <path d=\"M12 10v4h4\"/> <path d=\"m12 14 1.535-1.605a5 5 0 0 1 8 1.5\"/> <path d=\"M22 22v-4h-4\"/> <path d=\"m22 18-1.535 1.605a5 5 0 0 1-8-1.5\"/>","download":"<svg class=\"lucide lucide-download\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 15V3\"/> <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <path d=\"m7 10 5 5 5-5\"/>","upload":"<svg class=\"lucide lucide-upload\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 3v12\"/> <path d=\"m17 8-5-5-5 5\"/> <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>","search":"<svg class=\"lucide lucide-search\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m21 21-4.34-4.34\"/> <circle cx=\"11\" cy=\"11\" r=\"8\"/>","sliders-horizontal":"<svg class=\"lucide lucide-sliders-horizontal\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M10 5H3\"/> <path d=\"M12 19H3\"/> <path d=\"M14 3v4\"/> <path d=\"M16 17v4\"/> <path d=\"M21 12h-9\"/> <path d=\"M21 19h-5\"/> <path d=\"M21 5h-7\"/> <path d=\"M8 10v4\"/> <path d=\"M8 12H3\"/>","settings":"<svg class=\"lucide lucide-settings\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>","check":"<svg class=\"lucide lucide-check\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M20 6 9 17l-5-5\"/>","triangle-alert":"<svg class=\"lucide lucide-triangle-alert\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/> <path d=\"M12 9v4\"/> <path d=\"M12 17h.01\"/>","circle-alert":"<svg class=\"lucide lucide-circle-alert\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <circle cx=\"12\" cy=\"12\" r=\"10\"/> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\"/> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\"/>","x":"<svg class=\"lucide lucide-x\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M18 6 6 18\"/> <path d=\"m6 6 12 12\"/>","plug":"<svg class=\"lucide lucide-plug\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 22v-5\"/> <path d=\"M9 8V2\"/> <path d=\"M15 8V2\"/> <path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\"/>","unplug":"<svg class=\"lucide lucide-unplug\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m19 5 3-3\"/> <path d=\"m2 22 3-3\"/> <path d=\"M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z\"/> <path d=\"M7.5 13.5 10 11\"/> <path d=\"M10.5 16.5 13 14\"/> <path d=\"m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z\"/>","server":"<svg class=\"lucide lucide-server\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/> <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/> <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/> <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>","terminal":"<svg class=\"lucide lucide-terminal\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 19h8\"/> <path d=\"m4 17 6-6-6-6\"/>","chevron-down":"<svg class=\"lucide lucide-chevron-down\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m6 9 6 6 6-6\"/>","chevron-right":"<svg class=\"lucide lucide-chevron-right\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m9 18 6-6-6-6\"/>","ellipsis":"<svg class=\"lucide lucide-ellipsis\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <circle cx=\"12\" cy=\"12\" r=\"1\"/> <circle cx=\"19\" cy=\"12\" r=\"1\"/> <circle cx=\"5\" cy=\"12\" r=\"1\"/>","trash-2":"<svg class=\"lucide lucide-trash-2\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M10 11v6\"/> <path d=\"M14 11v6\"/> <path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\"/> <path d=\"M3 6h18\"/> <path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\"/>","file":"<svg class=\"lucide lucide-file\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/>","folder":"<svg class=\"lucide lucide-folder\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>","clock":"<svg class=\"lucide lucide-clock\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 6v6l4 2\"/> <circle cx=\"12\" cy=\"12\" r=\"10\"/>","lock-keyhole":"<svg class=\"lucide lucide-lock-keyhole\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <circle cx=\"12\" cy=\"16\" r=\"1\"/> <rect x=\"3\" y=\"10\" width=\"18\" height=\"12\" rx=\"2\"/> <path d=\"M7 10V7a5 5 0 0 1 10 0v3\"/>","log-out":"<svg class=\"lucide lucide-log-out\" xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m16 17 5-5-5-5\"/> <path d=\"M21 12H9\"/> <path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/>"};

  function cx() { var out = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]); return out.join(' '); }

  function Icon(props) {
    var name = props.name, size = props.size || 16, className = props.className, label = props.label;
    var body = ICONS[name] || '';
    return h('span', {
      className: cx('uc-icon', className),
      style: size !== 16 ? { width: size, height: size } : undefined,
      role: label ? 'img' : undefined, 'aria-label': label, 'aria-hidden': label ? undefined : true,
      dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24">' + body + '</svg>' }
    });
  }

  function Button(props) {
    var variant = props.variant || 'quiet', size = props.size, icon = props.icon, className = props.className, children = props.children;
    var rest = {};
    for (var k in props) if (k !== 'variant' && k !== 'size' && k !== 'icon' && k !== 'className' && k !== 'children') rest[k] = props[k];
    rest.type = rest.type || 'button';
    rest.className = cx('uc-btn', 'uc-btn-' + variant, size === 'small' && 'uc-btn-sm', className);
    return h('button', rest, icon ? h(Icon, { name: icon }) : null, children);
  }

  var inputSeq = 0;
  function Input(props) {
    var id = props.id || ('uc-input-' + (++inputSeq));
    var label = props.label, prompt = props.prompt, hint = props.hint, error = props.error, disabled = props.disabled, className = props.className;
    var rest = {};
    for (var k in props) if (['id', 'label', 'prompt', 'hint', 'error', 'className'].indexOf(k) < 0) rest[k] = props[k];
    rest.id = id;
    rest.type = rest.type || 'text';
    if (error) rest['aria-invalid'] = true;
    if (hint || error) rest['aria-describedby'] = id + '-msg';
    return h('div', { className: cx('uc-input', error && 'uc-input-error', disabled && 'uc-input-disabled', className) },
      label ? h('label', { className: 'uc-label uc-input-label', htmlFor: id }, label) : null,
      h('div', { className: 'uc-field' },
        prompt ? h('span', { className: 'uc-data uc-field-prefix', 'aria-hidden': true }, prompt) : null,
        h('input', rest)),
      error ? h('div', { className: 'uc-input-message', id: id + '-msg', role: 'alert' }, h(Icon, { name: 'triangle-alert' }), error)
        : hint ? h('div', { className: 'uc-input-hint', id: id + '-msg' }, hint) : null);
  }

  var STATUS_WORDS = { online: 'Online', syncing: 'Syncing', offline: 'Offline', fault: 'Fault' };
  function StatusBadge(props) {
    var status = props.status || 'offline';
    return h('span', { className: cx('uc-badge', 'uc-label', 'uc-badge-' + status, props.className) },
      h('span', { className: 'uc-badge-dot', 'aria-hidden': true }),
      props.children || STATUS_WORDS[status] || status);
  }

  function Meter(props) {
    var value = Math.max(0, props.value || 0), max = Math.max(1, props.max || 1), segments = props.segments || 20;
    var ratio = Math.min(1, value / max), on = Math.round(ratio * segments);
    var full = ratio >= (props.fullAt == null ? 0.95 : props.fullAt);
    var segs = [];
    for (var i = 0; i < segments; i++) segs.push(h('span', { key: i, className: cx('uc-meter-seg', i < on && 'uc-meter-seg-on', props.live && i === on - 1 && on < segments && 'uc-meter-seg-live') }));
    return h('div', { className: cx('uc-meter', full && 'uc-meter-full', props.className), role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value, 'aria-label': props.label || 'Storage' },
      (props.label || props.valueText || props.caption) ? h('div', { className: 'uc-meter-head' },
        h('span', { className: 'uc-label uc-meter-caption' }, props.label),
        h('span', { className: 'uc-data' }, h('span', { className: 'uc-meter-value' }, props.valueText || (Math.round(ratio * 100) + '%')), props.caption ? h('span', { className: 'uc-meter-caption' }, ' ' + props.caption) : null)) : null,
      h('div', { className: 'uc-meter-track', 'aria-hidden': true }, segs));
  }

  function DeviceCard(props) {
    var d = props.device || {};
    var selectable = !!props.onSelect;
    var handle = function () { if (props.onSelect) props.onSelect(d); };
    return h('article', {
      className: cx('uc-card', props.selected && 'uc-card-selected', props.className),
      tabIndex: selectable ? 0 : undefined, onClick: selectable ? handle : undefined,
      onKeyDown: selectable ? function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle(); } } : undefined,
      'aria-pressed': selectable ? !!props.selected : undefined
    },
      h('div', { className: 'uc-card-head' },
        h('div', null,
          h('div', { className: 'uc-card-id uc-data' }, h(Icon, { name: 'hard-drive' }), h('span', { className: 'uc-card-id-text' }, d.id)),
          h('h3', { className: 'uc-heading uc-card-name' }, d.name)),
        h(StatusBadge, { status: d.status })),
      h(Meter, { label: 'Storage', value: d.usedBytes, max: d.totalBytes, live: d.status === 'syncing', valueText: props.formatBytes ? props.formatBytes(d.usedBytes) : fmtBytes(d.usedBytes), caption: '/ ' + (props.formatBytes ? props.formatBytes(d.totalBytes) : fmtBytes(d.totalBytes)) }),
      h('dl', { className: 'uc-card-meta uc-data' },
        h('div', null, h('dt', { className: 'uc-label' }, 'Last sync'), h('dd', null, d.lastSync || '—')),
        h('div', null, h('dt', { className: 'uc-label' }, 'Pending'), h('dd', null, d.pending == null ? '—' : d.pending + (d.pending === 1 ? ' file' : ' files')))),
      props.actions ? h('div', { className: 'uc-card-actions', onClick: function (e) { e.stopPropagation(); } }, props.actions) : null);
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = n;
    while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
    return (i === 0 ? v : v < 100 ? Math.round(v * 10) / 10 : Math.round(v)) + ' ' + u[i];
  }

  function DataTable(props) {
    var columns = props.columns || [], rows = props.rows || [], rowKey = props.rowKey || 'id';
    var selectable = !!props.onSelectRow;
    return h('table', { className: cx('uc-table', 'uc-data', props.className) },
      props.caption ? h('caption', { className: 'uc-label' }, props.caption) : null,
      h('thead', null, h('tr', null, columns.map(function (c) {
        return h('th', { key: c.key, className: cx('uc-label', c.align === 'right' && 'uc-right'), style: c.width ? { width: c.width } : undefined, scope: 'col' }, c.label);
      }))),
      h('tbody', null, rows.length === 0 ? h('tr', null, h('td', { colSpan: columns.length, className: 'uc-table-empty' }, props.emptyText || 'No rows.')) :
        rows.map(function (r) {
          var key = r[rowKey], selected = props.selectedKey != null && props.selectedKey === key;
          return h('tr', {
            key: key, className: cx(selectable && 'uc-tr-selectable', selected && 'uc-tr-selected'),
            tabIndex: selectable ? 0 : undefined, 'aria-selected': selectable ? selected : undefined,
            onClick: selectable ? function () { props.onSelectRow(r); } : undefined,
            onKeyDown: selectable ? function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelectRow(r); } } : undefined
          }, columns.map(function (c) {
            var v = c.render ? c.render(r) : r[c.key];
            return h('td', { key: c.key, className: cx(c.align === 'right' && 'uc-right', c.key === rowKey && 'uc-key', c.muted && 'uc-muted') }, v);
          }));
        })));
  }

  function Toolbar(props) {
    var crumbs = props.crumbs || [];
    var parts = [];
    crumbs.forEach(function (c, i) {
      if (i) parts.push(h('span', { key: 'sep' + i, className: 'uc-sep', 'aria-hidden': true }, '/'));
      parts.push(h('span', { key: 'c' + i }, c));
    });
    return h('header', { className: cx('uc-toolbar', props.className) },
      h('div', { className: 'uc-toolbar-lead' },
        crumbs.length ? h('nav', { className: 'uc-label uc-toolbar-crumb', 'aria-label': 'Breadcrumb' }, parts) : null,
        h('h1', { className: 'uc-title uc-toolbar-title' }, props.title)),
      props.children ? h('div', { className: 'uc-toolbar-actions' }, props.children) : null);
  }

  function Tabs(props) {
    var items = props.items || [];
    return h('div', { className: cx('uc-tabs', props.className), role: 'tablist' }, items.map(function (t) {
      var active = t.id === props.active;
      return h('button', {
        key: t.id, type: 'button', role: 'tab', 'aria-selected': active, tabIndex: active ? 0 : -1,
        className: cx('uc-tab', 'uc-label', active && 'uc-tab-active'),
        onClick: function () { if (props.onChange) props.onChange(t.id); }
      }, t.label, t.count != null ? h('span', { className: 'uc-tab-count' }, t.count) : null);
    }));
  }

  function Dialog(props) {
    if (props.open === false) return null;
    var titleId = 'uc-dialog-title-' + (props.id || 'x');
    return h('div', { className: cx('uc-dialog-scrim', props.inline && 'uc-dialog-scrim-inline'), onMouseDown: props.onClose ? function (e) { if (e.target === e.currentTarget) props.onClose(); } : undefined },
      h('div', { className: cx('uc-dialog', props.destructive && 'uc-dialog-destructive', props.className), role: 'dialog', 'aria-modal': !props.inline, 'aria-labelledby': titleId },
        h('div', { className: 'uc-dialog-head' },
          h('div', null,
            props.kicker ? h('div', { className: 'uc-label uc-dialog-kicker' }, props.kicker) : null,
            h('h2', { className: 'uc-heading uc-dialog-title', id: titleId }, props.title)),
          props.onClose ? h(Button, { variant: 'ghost', size: 'small', icon: 'x', 'aria-label': 'Close', onClick: props.onClose }) : null),
        h('div', { className: 'uc-dialog-body' }, props.children),
        props.actions ? h('div', { className: 'uc-dialog-actions' }, props.actions) : null));
  }

  var LEVEL_WORDS = { info: 'INFO', ok: 'OK', warn: 'WARN', err: 'ERR' };
  function LogPane(props) {
    var entries = props.entries || [];
    var ref = React.useRef(null);
    React.useEffect(function () { if (props.follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; });
    return h('section', { className: cx('uc-log', props.className), style: props.height ? { height: props.height } : undefined, 'aria-label': props.title || 'Log' },
      props.title ? h('header', { className: 'uc-log-head' },
        h('span', { className: 'uc-label' }, props.title),
        h('span', { className: 'uc-label uc-log-count' }, entries.length + (entries.length === 1 ? ' line' : ' lines'))) : null,
      h('div', { className: 'uc-log-body uc-data', ref: ref, role: 'log', 'aria-live': props.follow ? 'polite' : 'off', tabIndex: 0 },
        entries.length === 0 ? h('div', { className: 'uc-log-empty' }, props.emptyText || 'No entries.') :
        entries.map(function (e, i) {
          return h('div', { key: e.id != null ? e.id : i, className: cx('uc-log-line', 'uc-log-' + (e.level || 'info')) },
            h('span', { className: 'uc-log-time' }, e.time),
            h('span', { className: 'uc-log-level' }, LEVEL_WORDS[e.level] || LEVEL_WORDS.info),
            e.source ? h('span', { className: 'uc-log-source' }, e.source) : null,
            h('span', { className: 'uc-log-msg' }, e.message));
        }),
        props.prompt !== false ? h('div', { className: 'uc-log-prompt', 'aria-hidden': true }, h('span', { className: 'uc-log-caret' }, '>'), h('span', { className: 'uc-log-cursor' })) : null));
  }

  function SideNav(props) {
    var sections = props.sections || [];
    return h('nav', { className: cx('uc-sidenav', props.className), 'aria-label': props.brand || 'Navigation' },
      props.brand ? h('div', { className: 'uc-sidenav-brand' },
        h('span', { className: 'uc-heading uc-sidenav-brand-name' }, props.brand),
        props.version ? h('span', { className: 'uc-sidenav-version' }, props.version) : null) : null,
      sections.map(function (s, si) {
        return h('div', { key: s.id || si, className: 'uc-sidenav-section' },
          s.label ? h('div', { className: 'uc-label uc-sidenav-label' }, s.label) : null,
          h('ul', { className: 'uc-sidenav-list' }, (s.items || []).map(function (it) {
            var active = it.id === props.active;
            return h('li', { key: it.id }, h('button', {
              type: 'button', className: cx('uc-sidenav-item', active && 'uc-sidenav-item-active'),
              'aria-current': active ? 'page' : undefined, disabled: it.disabled,
              onClick: function () { if (props.onChange) props.onChange(it.id); }
            },
              h('span', { className: 'uc-sidenav-caret', 'aria-hidden': true }, '>'),
              it.icon ? h(Icon, { name: it.icon }) : null,
              h('span', { className: 'uc-sidenav-item-label' }, it.label),
              it.count != null ? h('span', { className: 'uc-sidenav-count uc-data' }, it.count) : null));
          })));
      }),
      props.footer ? h('div', { className: 'uc-sidenav-foot' }, props.footer) : null);
  }

  var selectSeq = 0;
  function Select(props) {
    var options = props.options || [];
    var idRef = React.useRef(null); if (!idRef.current) idRef.current = props.id || ('uc-select-' + (++selectSeq));
    var id = idRef.current;
    var st = React.useState(!!props.defaultOpen), open = st[0], setOpen = st[1];
    var selectedIdx = -1; for (var i = 0; i < options.length; i++) if (options[i].value === props.value) selectedIdx = i;
    var hi = React.useState(selectedIdx < 0 ? 0 : selectedIdx), highlight = hi[0], setHighlight = hi[1];
    var rootRef = React.useRef(null);
    React.useEffect(function () {
      if (!open) return;
      function onDoc(e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); }
      document.addEventListener('mousedown', onDoc);
      return function () { document.removeEventListener('mousedown', onDoc); };
    }, [open]);
    function choose(i) { var o = options[i]; if (!o || o.disabled) return; if (props.onChange) props.onChange(o.value, o); setOpen(false); }
    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setHighlight(Math.min(options.length - 1, highlight + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (open) setHighlight(Math.max(0, highlight - 1)); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (open) choose(highlight); else setOpen(true); }
      else if (e.key === 'Escape') { if (open) { e.preventDefault(); setOpen(false); } }
      else if (e.key === 'Home' && open) { e.preventDefault(); setHighlight(0); }
      else if (e.key === 'End' && open) { e.preventDefault(); setHighlight(options.length - 1); }
    }
    var selected = selectedIdx >= 0 ? options[selectedIdx] : null;
    return h('div', { className: cx('uc-select', props.disabled && 'uc-select-disabled', props.className), ref: rootRef },
      props.label ? h('label', { className: 'uc-label uc-input-label', htmlFor: id + '-btn' }, props.label) : null,
      h('button', {
        type: 'button', id: id + '-btn', className: cx('uc-select-btn', !selected && 'uc-select-placeholder'), disabled: props.disabled,
        'aria-haspopup': 'listbox', 'aria-expanded': open, 'aria-controls': id + '-list',
        onClick: function () { setOpen(!open); if (!open) setHighlight(selectedIdx < 0 ? 0 : selectedIdx); }, onKeyDown: onKey
      },
        selected && selected.icon ? h(Icon, { name: selected.icon }) : null,
        h('span', { className: 'uc-select-value uc-data' }, selected ? selected.label : (props.placeholder || 'Select')),
        h(Icon, { name: 'chevron-down', className: 'uc-select-chevron' })),
      open ? h('ul', { className: 'uc-select-list', id: id + '-list', role: 'listbox', 'aria-labelledby': id + '-btn', 'aria-activedescendant': id + '-opt-' + highlight },
        options.map(function (o, i) {
          var isSel = i === selectedIdx, isHi = i === highlight;
          return h('li', {
            key: String(o.value), id: id + '-opt-' + i, role: 'option', 'aria-selected': isSel, 'aria-disabled': o.disabled || undefined,
            className: cx('uc-select-opt', isSel && 'uc-select-opt-selected', isHi && 'uc-select-opt-hi', o.disabled && 'uc-select-opt-disabled'),
            onMouseEnter: function () { setHighlight(i); }, onMouseDown: function (e) { e.preventDefault(); }, onClick: function () { choose(i); }
          },
            h('span', { className: 'uc-select-mark', 'aria-hidden': true }, isSel ? h(Icon, { name: 'check', size: 14 }) : null),
            o.icon ? h(Icon, { name: o.icon }) : null,
            h('span', { className: 'uc-select-opt-label uc-data' }, o.label),
            o.hint ? h('span', { className: 'uc-select-opt-hint' }, o.hint) : null);
        })) : null);
  }

  window.USBCloud = {
    Button: Button, Input: Input, StatusBadge: StatusBadge, Meter: Meter, DeviceCard: DeviceCard,
    DataTable: DataTable, Toolbar: Toolbar, Tabs: Tabs, Dialog: Dialog, Icon: Icon, LogPane: LogPane, SideNav: SideNav, Select: Select, formatBytes: fmtBytes
  };
})();
