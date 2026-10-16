const path = require('node:path');
const sax = require('sax');
const { safeName, fail, textExtensions } = require('./validation');
const config = require('./config');
const office = require('./office');
const outputSpec = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'filename')) throw fail('INVALID_OUTPUT_FILE');
  const filename = safeName(value.filename);
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (!textExtensions.has(ext) && ext !== 'svg' && !office.extensions.has(ext)) throw fail('UNSUPPORTED_OUTPUT_FORMAT');
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
    for (const [name, rawValue] of Object.entries(node.attributes)) {
      // Repair only this known model typo; keep all security checks below.
      const value = ['fill', 'stroke'].includes(name) && rawValue.trim().toLowerCase() === '#none' ? 'none' : rawValue;
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
  if (office.extensions.has(ext)) throw fail('ASYNC_DOCUMENT_RENDER_REQUIRED');
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
// Keep the generation contract derived from the same allowlists as validation.
const svgInstructions = () => [
  'SVG content must be one complete, well-formed static SVG document.',
  'Start with <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 WIDTH HEIGHT"> using numeric WIDTH and HEIGHT, and end with </svg>.',
  `Use ONLY these case-sensitive elements: ${[...svgElements].join(', ')}.`,
  `Use ONLY these case-sensitive attributes: ${[...svgAttrs].join(', ')}.`,
  'Use presentation attributes such as fill and stroke directly; never use style or class.',
  'Do not include XML declarations, processing instructions, DOCTYPE, entities declared in a DTD, CDATA, comments, scripts, event handlers, animation, foreignObject, image, use, href or external resources.',
  'Escape XML text and attribute values correctly (for example &amp; for an ampersand).',
  'No URLs, data URIs or backslashes in attribute values except the root xmlns above. Local references are allowed only as url(#id), with an ID matching [A-Za-z_][A-Za-z0-9_.-]*.',
  'Gradients, clipping and text are allowed only with the listed elements and attributes; do not add unlisted gradient attributes. Prefer simple shapes when unsure.',
  'At most 10000 elements, nesting depth 64, and 100000 characters per attribute value.',
].join(' ');
const renderOutput = async (spec, content) => {
  const checked = outputSpec(spec);
  return office.extensions.has(path.extname(checked.filename).slice(1).toLowerCase()) ? office.render(checked, content) : render(checked, content);
};
const toolOptions = (spec) => ({
  tools: [{ type: 'function', function: { name: 'create_file',
    description: `Produce the requested file ${spec.filename}. Put complete UTF-8 file content in content, without Markdown fences or surrounding explanation. Keep content within ${config.artifactBytes} UTF-8 bytes. summary is a short description of at most 2000 characters, not a download link.${path.extname(spec.filename).toLowerCase() === '.svg' ? ' ' + svgInstructions() : office.extensions.has(path.extname(spec.filename).slice(1).toLowerCase()) ? ' ' + office.instructions : ''}`,
    strict: true, parameters: { type: 'object', properties: { content: { type: 'string' }, summary: { type: 'string' } }, required: ['content', 'summary'], additionalProperties: false } } }],
  tool_choice: { type: 'function', function: { name: 'create_file' } }, parallel_tool_calls: false,
});
const autoEnabled = (modelId) => config.enabled() && process.env.FILE_OUTPUT_AUTO_ENABLED !== 'false'
  && (process.env.FILE_OUTPUT_MODELS || '').split(',').map(x => x.trim()).filter(Boolean).includes(modelId);
const autoToolOptions = () => {
  const options = toolOptions({ filename: 'requested file' });
  const fn = options.tools[0].function;
  fn.description = [
    'Create one downloadable file when the user asks you to create, save, export or deliver a file, including requests expressed naturally in any language.',
    'For ordinary questions, explanations, or inline code examples, answer normally without calling this tool. Mere mentions of file extensions are not a request to create a file.',
    'Choose a short descriptive filename with the requested extension. If no format was specified, choose a suitable supported format. If the request is ambiguous, ask a brief clarification.',
    `Supported extensions ONLY: ${[...textExtensions, 'svg', ...office.extensions].join(', ')}.`,
    'Do not claim to create PNG, audio or other unsupported formats. Explain the limitation and offer a supported alternative, without silently changing an explicitly requested format.',
    'For a request for several files, ask which one to create first. Never invent download links.',
    `Return complete UTF-8 content without Markdown fences or surrounding explanation, at most ${config.artifactBytes} bytes. summary is a short description of at most 2000 characters.`,
    office.instructions,
    'The following rules apply ONLY when the chosen extension is SVG:', svgInstructions(),
  ].join(' ');
  fn.parameters.properties.filename = { type: 'string', description: 'Safe basename with a supported extension; no directory path.' };
  fn.parameters.required.push('filename');
  options.tool_choice = 'auto';
  return options;
};
const collector = ({ optional = false } = {}) => {
  let args = '', name = '', invalid = false, reason, argumentChars = 0, seen = false;
  return {
    add(chunk) {
      if (chunk.choices?.[0]?.finish_reason) reason = chunk.choices[0].finish_reason;
      for (const call of chunk.choices?.[0]?.delta?.tool_calls || []) {
        seen = true;
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
      if (optional && !seen && reason !== 'tool_calls') return {};
      if (invalid || name !== 'create_file' || reason !== 'tool_calls') return { artifactError: 'INCOMPLETE_FILE_OUTPUT', argumentChars };
      try {
        const value = JSON.parse(args);
        if (typeof value.content !== 'string' || typeof value.summary !== 'string' || value.summary.length > 2000) throw new Error();
        if (optional) outputSpec({ filename: value.filename });
        return { artifact: value, argumentChars };
      } catch (error) { return { artifactError: error.fileError || 'INVALID_FILE_OUTPUT', argumentChars }; }
    },
  };
};
module.exports = { outputSpec, render, renderOutput, sanitizeSvg, safeDelimited, toolOptions, autoToolOptions, autoEnabled, collector };
