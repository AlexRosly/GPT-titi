const scope = {page:null, section:'Реквізити', party:'QA-200'};
const changes = [{old:'Колишній район',new:'Самарівський район'}, {old:'смт.',new:'селище'}];
const prompt = 'в реквізитах QA-200 Колишній район замінити на Самарівський район, смт. замінити на селище і вітдай ПДФ змінений, нічого більше не міняй';
const report = {pages:2,changedPages:1,changedTexts:2,targetPages:[2,2],verifiedTexts:[
  '13ce3b984b8477c8d72d768d38f2a8025ed3911446d8e26b75fd9f68c0422603',
  '86f688e50f86047118fc5ec90528b5eb608ee494ce3f4a8f0cc6dab9e5dd1e0d',
]};
module.exports = {scope, changes, prompt, report};
