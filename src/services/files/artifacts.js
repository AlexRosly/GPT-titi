const path = require('node:path');
const sax = require('sax');
const { safeName, fail, textExtensions } = require('./validation');
const config = require('./config');
const outputSpec = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'filename')) throw fail('INVALID_OUTPUT_FILE');
  const filename = safeName(value.filename);
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!textExtensions.has(ext) && ext !== 'svg') throw fail('UNSUPPORTED_OUTPUT_FORMAT');
  return { filename };
};
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svgElements = new Set('svg g defs path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath'.split(' '));
const svgAttrs = new Set('xmlns viewBox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray opacity fill-opacity stroke-opacity transform font-family font-size font-weight text-anchor dominant-baseline dx dy id offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod clip-path preserveAspectRatio'.split(' '));
const sanitizeSvg = (input) => {
  // Parse and reconstruct a deliberately small, static SVG subset. Never regex-strip active XML.
  let output = '', depth = 0, roots = 0, nodes = 0;
  const parser = sax.parser(true, { xmlns: false, strictEntities: true });
  parser.onerror = () => { throw fail('INVALID_SVG'); };
  parser.ondoctype = () => { throw fail('UNSAFE_SVG'); };
  parser.onprocessinginstruction = () => { throw fail('UNSAFE_SVG'); };
  parser.onopentag = (node) => {
    if (++nodes > 10000 || ++depth > 64 || !svgElements.has(node.name)) throw fail('UNSAFE_SVG');
    if (depth === 1 && (node.name !== 'svg' || ++roots !== 1)) throw fail('INVALID_SVG');
    output += `<${node.name}`;
    for (const [name, value] of Object.entries(node.attributes)) {
      if (!svgAttrs.has(name) || value.length > 100000) throw fail('UNSAFE_SVG');
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw fail('UNSAFE_SVG');
      if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)) throw fail('UNSAFE_SVG');
      if (/[\\<>]/.test(value) || /(?:javascript:|data:|https?:|\/\/)/i.test(value) && name !== 'xmlns') throw fail('UNSAFE_SVG');
      output += ` ${name}="${escapeXml(value)}"`;
    }
    output += '>';
  };
  parser.onclosetag = name => { output += `</${name}>`; depth--; };
  parser.ontext = text => {
    if (!depth && text.trim()) throw fail('INVALID_SVG');
    output += escapeXml(text);
  };
  parser.oncdata = () => { throw fail('UNSAFE_SVG'); };
  parser.write(input).close();
  if (roots !== 1 || depth !== 0) throw fail('INVALID_SVG');
  return output;
};
const render = (spec, content) => {
  const { filename } = outputSpec(spec);
  if (typeof content !== 'string' || !content.length || content.includes('\0') || Buffer.byteLength(content) > config.artifactBytes) throw fail('INVALID_FILE_CONTENT');
  const ext = path.extname(filename).slice(1).toLowerCase();
  let mimetype = 'text/plain';
  if (ext === 'json') { try { JSON.parse(content); } catch { throw fail('INVALID_JSON'); } mimetype = 'application/json'; }
  if (ext === 'svg') { content = sanitizeSvg(content); mimetype = 'image/svg+xml'; }
  if (ext === 'md') mimetype = 'text/markdown';
  // CSV is downloadable data, not executed server-side; use the parser below to neutralize spreadsheet formula cells.
  if (ext === 'csv' || ext === 'tsv') { content = safeDelimited(content, ext === 'csv' ? ',' : '\t'); mimetype = ext === 'csv' ? 'text/csv' : 'text/tab-separated-values'; }
  return { name: filename, mimetype, buffer: Buffer.from(content) };
};
function safeDelimited(input, delimiter) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const push = () => { row.push(/^[\s\u0000-\u001f]*[=+@-]/.test(cell) && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(cell) ? "'" + cell : cell); cell = ''; closed = false; };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += c; continue; }
    if (c === delimiter) { push(); continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && input[i + 1] === '\n') i++; push(); rows.push(row); row = []; continue; }
    if (closed) throw fail('INVALID_CSV');
    if (c === '"') { if (cell) throw fail('INVALID_CSV'); quoted = true; } else cell += c;
  }
  if (quoted) throw fail('INVALID_CSV');
  if (cell || closed || row.length || !rows.length) { push(); rows.push(row); }
  return rows.map(r => r.map(c => '"' + c.replace(/"/g, '""') + '"').join(delimiter)).join('\r\n');
}
const toolOptions = (spec) => ({
  tools: [{ type: 'function', function: { name: 'create_file',
    description: `Produce the requested file ${spec.filename}. Return complete UTF-8 content, without Markdown fences. No external resources or scripts in SVG. summary is a short description, not a download link.`,
    strict: true, parameters: { type: 'object', properties: { content: { type: 'string' }, summary: { type: 'string' } }, required: ['content', 'summary'], additionalProperties: false } } }],
  tool_choice: { type: 'function', function: { name: 'create_file' } }, parallel_tool_calls: false,
});
const collector = () => {
  let args = '', name = '', invalid = false, reason, argumentChars = 0;
  return {
    add(chunk) {
      if (chunk.choices?.[0]?.finish_reason) reason = chunk.choices[0].finish_reason;
      for (const call of chunk.choices?.[0]?.delta?.tool_calls || []) {
        if (call.index !== 0) invalid = true;
        if (call.function?.name) name += call.function.name;
        argumentChars += (call.function?.arguments || '').length;
        if (!invalid) {
          args += call.function?.arguments || '';
          if (Buffer.byteLength(args) > config.artifactBytes * 3) { invalid = true; args = ''; }
        }
      }
    },
    finish() {
      if (invalid || name !== 'create_file' || reason !== 'tool_calls') return { artifactError: 'INCOMPLETE_FILE_OUTPUT', argumentChars };
      try {
        const value = JSON.parse(args);
        if (typeof value.content !== 'string' || typeof value.summary !== 'string' || value.summary.length > 2000) throw new Error();
        return { artifact: value, argumentChars };
      } catch { return { artifactError: 'INVALID_FILE_OUTPUT', argumentChars }; }
    },
  };
};
module.exports = { outputSpec, render, sanitizeSvg, safeDelimited, toolOptions, collector };
