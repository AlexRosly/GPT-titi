// Shared dispatch keeps acceptance, history reservation and provider input identical.
const text = require('./textInput');
const office = require('./officeInput');
const reader = file => text.supported(file) ? text : office.supported(file) ? office : null;
module.exports = {
  supported: file => Boolean(reader(file)),
  readPart: (user, file, options) => reader(file).readPart(user, file, options),
};
