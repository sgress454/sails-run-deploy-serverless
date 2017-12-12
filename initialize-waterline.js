// Modules for working with Waterline
var ormHook = require('sails-hook-orm');
var _ = require('@sailshq/lodash');
var path = require('path');
var fs = require('fs');

module.exports = function(callback) {

  global.sails = {
    config: {
      appPath: path.resolve(__dirname),
      globals: {
        adapters: true,
        models: true
      },
      models: <%= modelsConfig %>,
      datastores: <%= datastoresConfig %>,
      orm: {
        skipProductionWarnings: false,
        moduleDefinitions: {
          models: {},
        }
      },
    },
    modules: {
      loadModels: (cb) => {
        let modelFiles = fs.readdirSync(path.resolve('.', 'api', 'models'));
        let modelFileNames = _.reduce(modelFiles, (memo, fileName) => {
          let match = fileName.match(/^(\w+)\.js/);
          if (match && match[1]) {
            memo.push(match[1]);
          }
          return memo;
        }, []);
        return cb(null, _.reduce(modelFileNames, (memo, modelName) => {
          let model = require('./api/models/' + modelName);
          model.globalId = modelName;
          memo[modelName.toLowerCase()] = model;
          return memo;
        }, {}));
      },
      loadAdapters: (cb) => cb(null, {})
    },
    log: {
      info: console.log,
      debug: console.log,
      warn: console.log,
      error: console.log,
      verbose: process.env.sails_log__level==='verbose' || process.env.sails_log__level==='silly' ? console.log : () => {},
      silly: process.env.sails_log__level==='silly' ? console.log : () => {},
      blank: () => {}
    },
    on: () => {},
    once: () => {}
  };

  // Load the sails ORM hook.
  _.set(sails, 'hooks.orm', ormHook(sails));

  // Apply sails-hook-orm defaults to sails confog.
  var defaults = (_.isFunction(sails.hooks.orm.defaults) ?
    sails.hooks.orm.defaults(sails.config) :
    sails.hooks.orm.defaults) || {};
  defaultsDeep(sails.config, defaults);

  // Run the hook's "configure" function.
  sails.hooks.orm.configure();

  // Run the hook's "initialize" function.
  sails.hooks.orm.initialize(callback);

  // Save the hook's models on `sails.models`.
  sails.models = sails.hooks.orm.models;

  return;

};

const defaultsDeep = _.partialRight(_.merge, function recursiveDefaults (dest,src) {

  // Ensure dates and arrays are not recursively merged
  if (_.isArray(arguments[0]) || _.isDate(arguments[0])) {
    return arguments[0];
  }
  return _.merge(dest, src, recursiveDefaults);
});
