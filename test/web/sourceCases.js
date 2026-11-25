const { readFileSync } = require('node:fs');
const path = require('node:path');
const a = 'https://example.org/first', b = 'https://example.net/second';
const rows = readFileSync(path.join(__dirname, 'fixtures', 'source-intent.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const scenarios = ['read-second', 'mention', 'compare'];
module.exports = rows.flatMap(([locale, ...messages]) => messages.map((message, index) => ({
  locale, scenario: scenarios[index],
  message: message.replace(/\b[AB]\b/gu, x => x === 'A' ? a : b),
  expected: [[b], [], [a,b]][index],
})));

// Vary word order, exclusions, ordinal references, ambiguity and quoted commands.
module.exports.push(
  { locale:'en', scenario:'target-first', message:`Use the price on ${a} to answer. ${b} is just the name printed in the example.`, expected:[a] },
  { locale:'es', scenario:'target-first', message:`¿Qué dice ${a}? No abras ${b}.`, expected:[a] },
  { locale:'de', scenario:'ordinal', message:`Hier sind zwei Seiten: ${b} und ${a}. Was steht auf der zweiten?`, expected:[a] },
  { locale:'ja', scenario:'indirect', message:`このページには送料がいくらと書いてありますか？ ${a}`, expected:[a] },
  { locale:'zh-Hans', scenario:'embedded-command', message:`请解释代码 «open ${a}» 的含义，不要访问网站。`, expected:[] },
  { locale:'ar', scenario:'target-first', message:`لخّص محتوى ${a}، ولا تفتح ${b}.`, expected:[a] },
  { locale:'hi', scenario:'ordinal', message:`ये दो पते हैं: ${a} और ${b}। केवल पहले का सार बताइए।`, expected:[a] },
  { locale:'pt', scenario:'ambiguous', message:`Entre ${a} e ${b}, queria consultar uma delas, mas não lembro qual. Pergunte-me qual é.`, expected:[] },
  { locale:'uk', scenario:'router', message:'Для налаштування PPPoE на TP-Link TL-WR841N підключіть кабель провайдера в синій порт WAN, відкрийте у браузері адресу http://192.168.0.1 (або 192.168.1.1/tplinkwifi.net), увійдіть з логіном та паролем admin та вкажіть дані PPPoE у розділі Мережа → WAN. Ви можете подивитися в інтернеті як налаштувати. Де взяти PPPoE?', expected:[] },
);
