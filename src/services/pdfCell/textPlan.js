const profile = 'pdf-scoped-text-v1';
const maxEdits = 64;
const word = /^[\p{L}\p{M}\p{N}.'’ʼ/-]+$/u;
const preservation = /(?:[\s,;.]+)(?:нічого більше не (?:міняй|змінюй)|більше нічого не (?:міняй|змінюй)|решту (?:залиш|збережи) без змін)[.!\s]*$/iu;
const delivery = /(?:[\s,;.]+)(?:(?:і|й|та)\s+)?(?:поверни|віддай|вітдай|надай|збережи)\s+(?:(?:змінений|відредагований|змінену|відредаговану)\s+)?(?:копію|PDF|ПДФ)(?:\s+(?:PDF|ПДФ|змінений|відредагований))?(?:\s+(?:з назвою|як)\s+(\S+?\.pdf))?[.!\s]*$/iu;
const quoted = /«([^«»\n]+)»|“([^“”\n]+)”|"([^"\n]+)"/gu;
const quoteRef = /^@(\d+)@$/;
const verb = '(?:заміни(?:ти)?|замінити|поміняй|поміняти)';
const leading = new RegExp('^'+verb+'\\s+(.+?)\\s+на\\s+(.+)$','iu');
const trailing = new RegExp('^(.+?)\\s+'+verb+'\\s+на\\s+(.+)$','iu');

function defaultName(source) {
  const stem = source.replace(/\.pdf$/iu,'');
  const chars = Array.from(stem);
  while (Buffer.byteLength(chars.join('')+'_edited.pdf') > 180) chars.pop();
  return chars.join('')+'_edited.pdf';
}

function readScope(text, literal) {
  const scope = {page:null, section:null, party:null};
  const page = /^на\s+сторінці\s+(\d{1,6})[\s,:]+/iu.exec(text);
  if (page) { scope.page=Number(page[1]); text=text.slice(page[0].length); }
  const block = /^(?:у|в)\s+(?:розділі|блоці)\s+(@\d+@)[\s,:]+/iu.exec(text);
  const party = /^(?:у|в)\s+реквізитах\s+(?:(?:сторони|організації|компанії|військової\s+частини|в[/.]ч)\s+)?(@\d+@|[\p{L}\d_-]+)[\s,:]+/iu.exec(text);
  if (block) { scope.section=literal(block[1]); text=text.slice(block[0].length); }
  if (party) { scope.section='Реквізити'; scope.party=literal(party[1]); text=text.slice(party[0].length); }
  return {scope, rest:text, explicit:Boolean(page || party || block)};
}

function parseText(message, fileId, source) {
  if (!/(?:заміни|замінити|поміня)/iu.test(message)) return null;
  if (/(?:рядку|колонці)\s+[«“"]/iu.test(message)) return null;
  const invalid = {profile, fileId, error:'PDF_CELL_TEXT_SYNTAX'};
  if (message.length > 20000 || /@\d+@/u.test(message)) return invalid;
  const literals = [];
  let text = message.trim().replace(quoted, (_,a,b,c) => {
    literals.push(a ?? b ?? c);
    return '@'+(literals.length-1)+'@';
  });
  const literal = token => {
    const ref = quoteRef.exec(token);
    if (ref) return literals[Number(ref[1])];
    const words = token.split(/\s+/u);
    if (words.length > 7 || !words.every(w=>word.test(w)) ||
        /(?:^|\s)(?:і|й|та|не|але|якщо|також|ще|додай|зміни|видали|онови|прибери|заміни|знайди|поверни|будь ласка)(?:\s|$)/iu.test(token)) return null;
    return token;
  };
  text = text.replace(/^(?:будь ласка[,\s]+)?(?:(?:у|в)\s+(?:прикріпленому\s+)?(?:PDF|ПДФ)[,\s]+)?/iu,'');
  const initial = readScope(text, literal);
  if (!initial.explicit && (!leading.test(text) && !trailing.test(text) || /^(?:як|чому|поясни|підкажи)\s/iu.test(text))) return null;
  const scope = initial.scope;
  text = initial.rest;
  text = text.replace(preservation,'');
  const send = delivery.exec(text);
  let filename = defaultName(source);
  if (send) {
    if (send[1]) filename=send[1];
    text=text.slice(0,send.index);
  }
  if (!/^[\p{L}\p{N}_-][\p{L}\p{M}\p{N} _().’'-]*\.pdf$/iu.test(filename) && send?.[1]) return invalid;
  if (Buffer.byteLength(filename)>180) return invalid;
  text = text.replace(preservation,'').trim().replace(/[.]$/u,'');
  const parts = text.split(/\s*(?:[,;\n]+|(?<=@)\.\s+(?=(?:заміни|@|на\s+сторінці|[ув]\s+(?:розділі|блоці|реквізитах)))|\s+(?:та|і|й)\s+)\s*/iu);
  if (!parts.length || parts.length>maxEdits) return invalid;
  const changes = [];
  let activeScope = scope;
  for (const part of parts) {
    const next = readScope(part.trim(), literal);
    if (next.explicit) activeScope = next.scope;
    if (activeScope.page === 0 || [activeScope.party,activeScope.section].some(v=>v && v.length>160)) return invalid;
    let value = next.rest;
    const suffix = /\s+(?=(?:на\s+сторінці\s+\d|[ув]\s+(?:розділі|блоці|реквізитах)\s+))/iu.exec(value);
    if (suffix) {
      const tail = readScope(value.slice(suffix.index).trim()+' ', literal);
      if (!tail.explicit || tail.rest.trim() || next.explicit || initial.explicit) return invalid;
      activeScope = tail.scope;
      value = value.slice(0,suffix.index).trim();
    }
    const m = leading.exec(value) || trailing.exec(value) ||
      (changes.length && /^(@\d+@)\s+на\s+(@\d+@)$/iu.exec(value));
    if (!m) return invalid;
    const old=literal(m[1]), replacement=literal(m[2]);
    if (![old,replacement].every(v=>typeof v==='string' && v.trim()===v && v.length>0 && v.length<=160 && !/[\p{C}\r\n]/u.test(v)) || old===replacement) return invalid;
    changes.push({old,new:replacement, ...(activeScope === scope ? {} : {scope:activeScope})});
  }
  return {profile,fileId,filename,text:{scope,changes}};
}

module.exports = {profile, maxEdits, parseText};
