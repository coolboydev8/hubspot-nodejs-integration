const _ = require('lodash');

exports.logJson = (data) => {
  console.log('Response', JSON.stringify(data, null, 2));
};
