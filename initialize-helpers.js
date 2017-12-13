// Modules for working with Waterline
var _ = require('@sailshq/lodash');
var path = require('path');
var fs = require('fs');
var Machine = require('machine');

module.exports = function(callback) {

  global.sails = global.sails || {};
  let sails = global.sails;
  sails.helpers = sails.helpers || {};

  let helperFiles = fs.readdirSync(path.resolve(__dirname, 'api', 'helpers'));
  let helperFileNames = _.reduce(helperFiles, (memo, fileName) => {
    let match = fileName.match(/^(.+)\.js/);
    if (match && match[1]) {
      memo.push(match[1]);
    }
    return memo;
  }, []);

  let helperDefs = _.reduce(helperFileNames, (memo, helperName) => {
    let helper = require(path.resolve(__dirname, 'api', 'helpers', helperName));
    helper.globalId = helperName;
    memo[helperName.toLowerCase()] = helper;
    return memo;
  }, {});

  _.each(helperDefs, function (helperDef, identity) {
    // Camel-case every part of the file path, and join with dots
    // e.g. /user-helpers/foo/my-helper => userHelpers.foo.myHelper
    var keyPath = _.map(identity.split('/'), _.camelCase).join('.');

    // Use filename-derived `identity` if no other, better identity can be derived.
    // (Otherwise, as of machine@v15, this fails with an ImplementationError.)
    if (!helperDef.identity && !helperDef.friendlyName && !helperDef.description) {
      helperDef.identity = identity;
    }

    // Use _.set to set the (possibly nested) property of sails.helpers
    // e.g. sails.helpers.userHelpers.foo.myHelper
    _.set(sails.helpers, keyPath, Machine.build(helperDef));
  });

  return callback();

};
