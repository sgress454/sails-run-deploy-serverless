const _ = require('@sailshq/lodash');
const mergeDictionaries = require('merge-dictionaries');

module.exports = {


  friendlyName: 'Deploy serverless',


  description: 'Deploy an app to a serverless service.',


  inputs: {

    all: {
      type: 'boolean',
      defaultsTo: false
    },

    f: {
      type: 'string'
    },

    nodeploy: {
      type: 'boolean',
      defaultsTo: false
    },

    prod: {
      type: 'boolean',
      defaultsTo: false
    },

    skipdeps: {
      type: 'boolean',
      defaultsTo: false
    }

  },


  exits: {

    badArgs: {
      description: 'The given arguments were invalid.'
    },

    notInSailsDir: {
      description: 'It doesn\'t look like the current directory contains a Sails project!'
    }

  },


  fn: async function(inputs, exits) {

    const sails = this.sails;
    const yamljs = require('yamljs');
    const readdir = require('recursive-readdir');
    const babel = require('babel-core');
    const fsx = require('fs-extra');
    const path = require('path');
    const exec = require('child_process').exec;
    const spawn = require('child_process').spawn;

    const cwd = process.cwd();

    // Set up default serverless config.
    sails.config.serverless = _.defaults(sails.config.serverless || {}, {
      include: ['api/controllers', 'api/helpers', 'api/models', 'config/models.js', 'config/datastores.js'],
      transpile: ['api/controllers', 'api/helpers', 'api/models'],
      orm: true
    });

    // Make sure you're in a Sails app folder.
    let packageJson;
    try {
      packageJson = require(path.resolve('.', 'package.json'));
      if ((!packageJson.dependencies || !packageJson.dependencies.sails) && (!packageJson.devDependencies || !packageJson.devDependencies.sails)) {
        throw new Error('No sails!');
      }
    }
    catch (unusedErr) {
      return exits.notInSailsDir();
    }

    if (!inputs.all && !inputs.f && !inputs.nodeploy) {
      return exits.badArgs('One of `--all`, `--nodeploy` or `--f <function name>` must be specified.');
    }

    if (!!inputs.all + !!inputs.f + !!inputs.nodeploy > 1) {
      return exits.badArgs('Only one of `--all`, `--nodeploy` or `--f <function name>` may be specified.');
    }

    // Always set `migrate: safe` so that Lambda functions don't try to run migrations.
    sails.config.models.migrate = 'safe';
    sails.config.models.datastore = 'default';

    // Assume ORM support is wanted until we find otherwise.
    let useOrm = sails.config.serverless.orm;

    // If the Sails environment is "development", use `serverless-dev` as the datastore.
    if (sails.config.environment === 'development') {
      if (!sails.config.datastores['serverless-dev'] || !sails.config.datastores['serverless-dev'].adapter) {
        useOrm = false;
        console.log('Warning -- no `serverless-dev` datastore found.  Deploying without Waterline support!');
        console.log('To suppress this warning, set `orm: false` in your `config/serverless.js` file.');
      }
      else {
        sails.config.datastores = { default: sails.config.datastores['serverless-dev'] };
      }
    }

    else if (inputs.prod === true) {
      if (!sails.config.datastores['serverless-prod'] || !sails.config.datastores['serverless-prod'].adapter) {
        useOrm = false;
        console.log('Warning -- no `serverless-prod` datastore found.  Deploying without Waterline support!');
        console.log('To suppress this warning, set `orm: false` in your `config/serverless.js` file.');
      }
      else {
        sails.config.models.datastore = 'serverless-prod';
        sails.config.datastores = { default: sails.config.datastores['serverless-prod'] };
      }
    }

    let useHelpers = (() => {

      try {
        let helperFiles = fsx.readdirSync(path.resolve(cwd, 'api', 'helpers'));
        return _.any(helperFiles, (fileName) => { return fileName.match(/^.+\.js/); });
      } catch (e) {
        if (e.code === 'ENOENT') {
          /* ignore */
        }
        else {
          throw e;
        }
      }

    })();


    // Set up the Lambda handler template.
    let handlerTemplate = (() => {
      let bootstrap = [];
      let teardown = [];
      if (useHelpers) {
        bootstrap.push(`require('<%=pathToHelpers%>')`);
      }
      if (useOrm) {
        bootstrap.push(`require('<%=pathToWaterline%>')`);
        teardown.push('(cb)=>{sails.hooks.orm.teardown(cb);}');
      }
      return _.template(`require('babel-polyfill');\nmodule.exports.fn = require('baggywrinkle')(require('<%=pathToAction%>'), { bootstrap: [${bootstrap.join(', ')}], teardown: [${teardown.join(', ')}], cors: <%=corsOptions%><%=typeof otherOptions !== 'undefined' ? (', '+otherOptions) : '' %>});\n`);
    })();

    console.log('Cleaning up previous deployments...');

    // Remove any existing serverless directory.
    fsx.removeSync(path.resolve(cwd, 'serverless'));

    console.log('Copying deployment files...');

    // Create the serverless directory.
    fsx.ensureDirSync(path.resolve(cwd, 'serverless'));

    // Remove Sails and any hooks as dependencies unless specifically told not to.
    let keepSailsDeps = _.get(sails.config.serverless, 'keepSailsDeps', []);
    packageJson.dependencies = _.reduce(packageJson.dependencies || {}, (memo, version, packageName) => {
      if ((packageName === 'sails' || packageName.indexOf('sails-hook-') > -1) && !_.contains(keepSailsDeps, packageName)) {
        return memo;
      }
      memo[packageName] = version;
      return memo;
    }, {});

    packageJson.dependencies.baggywrinkle = packageJson.dependencies.baggywrinkle || 'latest';
    packageJson.dependencies['babel-polyfill'] = packageJson.dependencies['babel-polyfill'] || '6.26.0';
    packageJson.dependencies['sails-hook-orm'] = packageJson.dependencies['sails-hook-orm'] || '^2.0.0-22';
    packageJson.dependencies['machine'] = packageJson.dependencies['machine'] || '15.0.0-20';

    packageJson.devDependencies = {};

    fsx.outputFile(path.resolve(cwd, 'serverless', 'package.json'), JSON.stringify(packageJson));

    // Copy all of the requested folders/files.
    for (let filepath of sails.config.serverless.include.concat(['api/authorizers'])) {
      fsx.copySync(path.resolve(cwd, filepath), path.resolve(cwd, 'serverless', filepath));
    }

    if (sails.config.serverless.transpile) {

      console.log('Transpiling code...');

      for (let filepath of sails.config.serverless.transpile) {
        let filesToTranspile = await readdir(path.resolve(cwd, 'serverless', filepath), [(file) => !!file.match(/\/\.[^\/]+$/)] );
        const transpile = (fileToTranspile, options) => {
          let code = fsx.readFileSync(fileToTranspile).toString();
          code = code.replace(/(fn:.+?\{)([\w\W]+)(\}\s+\})/, '$1 try { $2 } catch (e) { return exits.error(e); } $3');
          return babel.transform(code, options || { presets: ['env'] }).code;
        };
        for (let fileToTranspile of filesToTranspile) {
          let transformedFile = transpile(fileToTranspile);
          fsx.outputFileSync(fileToTranspile, transformedFile);
        }
      }

    }

    // Grab the CORS config.
    const globalCorsConfig = sails.config.security.cors;

    // Start an ACL mapping object.
    let resourceMapping = {};

    // Loop through each route.
    let serverlessFunctionConfig = _.reduce(sails.config.routes, (memo, target, address) => {

      let actionName = target.action || target;
      if (typeof actionName !== 'string') { return memo; }

      // Parse out the verb and path from the route definition.
      let {verb:routeVerb, path:routePath} = parseAddress(address);

      // Create a lambda-appropriate path.
      let lambdaPath = routePath.replace(/\/:(\w+)/g, '/{$1}');
      if (lambdaPath.match(/\/\*$/)) {
        lambdaPath = lambdaPath.replace(/\/\*$/, '/{0+}');
      }

      // Add an entry to the resource mapping dictionary associating this lambda path with the Sails route address.
      resourceMapping[(routeVerb ? routeVerb.toLowerCase() + ' ' : '') + lambdaPath] = { address, target };

      // Create a function name from the action, e.g. 'user/find' => 'user_find'
      let fnName = _.camelCase(actionName);

      // Start the serverless config for the function.
      memo[fnName] = {
        handler: `functions/${actionName}.fn`,
        events: [
          {
            http: {
              path: lambdaPath,
              method: routeVerb
            }
          }
        ]
      };

      // See if we have any pattern vars or wildcards.
      let params = address.match(/(\/:\w+)|(\/\*)/g);

      if (params) {
        _.set(memo[fnName].events[0].http, 'request.parameters.paths', _.reduce(params, (memo, param) => {
          if (param === '/*') {
            memo['0'] = true;
          }
          else {
            memo[param.substr(2)] = true;
          }
          return memo;
        }, {}));
      }

      // See if we have any local CORS config.
      _.set(memo[fnName].events[0].http, 'cors', (() => {
        if (!_.isUndefined(target.cors) || globalCorsConfig.allRoutes) {
          if (target.cors === false) {
            return undefined;
          }
          let targetCors = target.cors || {};
          if (targetCors === true || globalCorsConfig.allRoutes) {
            return {
              origin: targetCors.allowOrigins || globalCorsConfig.allowOrigins,
              headers: _.map((targetCors.allowRequestHeaders || globalCorsConfig.allowRequestHeaders).split(','), (header) => header.trim()),
              allowCredentials: targetCors.allowCredentials || globalCorsConfig.allowCredentials
            };
          }
        }
        return undefined;
      })());

      if (typeof memo[fnName].events[0].http.cors === 'undefined') {
        delete memo[fnName].events[0].http.cors;
      }

      // See if any authorizer should be applied to this route.
      let authorizer = target.authorizer || (target.authorizer !== false && sails.config.serverless.defaultAuthorizer);
      if (authorizer) {
        memo[fnName].events[0].http.authorizer = {
          name: _.camelCase(`authorizers ${authorizer}`),
          type: 'request',
          resultTtlInSeconds: 0
        };
      }

      // Output a handler.
      let pathToFunction = path.resolve(cwd, 'serverless', 'functions', actionName + '.js');
      let pathToAction = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'api', 'controllers', actionName + '.js'));
      let pathToWaterline = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-waterline.js'));
      let pathToHelpers = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));

      fsx.outputFileSync(pathToFunction, handlerTemplate({ pathToAction, pathToHelpers, pathToWaterline, corsOptions: JSON.stringify(_.get(memo[fnName].events[0].http, 'cors', false)) }));

      return memo;

    }, {});

    // If there's an authorizers folder, create functions for everything in it.
    let authorizers;
    try {
      authorizers = await readdir(path.resolve(cwd, 'serverless', 'api', 'authorizers'));
    }
    catch (unusedErr) {
      authorizers = [];
    }

    _.each(authorizers, (authorizerPath) => {
      let filePath = `authorizers/${path.basename(authorizerPath)}`;
      let actionName = filePath.replace(/\.js$/,'');
      let fnName = _.camelCase(actionName);
      let pathToFunction = path.resolve(cwd, 'serverless', 'functions', filePath);
      let pathToAction = path.relative(path.dirname(pathToFunction), authorizerPath);
      let pathToWaterline = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-waterline.js'));
      let pathToHelpers = path.relative(path.dirname(pathToFunction), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));
      serverlessFunctionConfig[fnName] = {
        handler: `functions/${actionName}.fn`,
      };
      fsx.outputFileSync(pathToFunction, handlerTemplate({ pathToAction, pathToHelpers, pathToWaterline, corsOptions: true, otherOptions: 'noEnvelope: true' }));
    });

    // Load any serverless file template from config.
    let serverlessYml = {};
    try {
      serverlessYml = yamljs.parse(_.template(fsx.readFileSync(path.resolve(cwd, 'config', 'serverless.yml')).toString())({ sails: { config: sails.config } }));
    }
    catch (unusedErr) {
      // no-op
    }

    // If there is a environment-specific yml file, merge it on top.
    try {
      let envServerlessYml = yamljs.parse(_.template(fsx.readFileSync(path.resolve(cwd, 'config', `serverless-${sails.config.environment}.yml`)).toString())({ sails: { config: sails.config } }));
      mergeDictionaries(serverlessYml, envServerlessYml);
    }
    catch (unusedErr) {
      // no-op
    }

    // Merge in any options from sails.config.serverless.yml.
    mergeDictionaries(serverlessYml, sails.config.serverless.yml);

    // Supply some defaults.
    _.defaultsDeep(serverlessYml, {
      service: 'my-service',
      package: {
        excludeDevDependencies: false
      },
      provider: {
        name: 'aws',
        runtime: 'nodejs6.10',
      }
    });

    // Merge in the stuff we just created.
    _.merge(serverlessYml, { functions: serverlessFunctionConfig });

    // Output the serverless config.
    fsx.outputFileSync(path.resolve(cwd, 'serverless', 'serverless.yml'), yamljs.stringify(serverlessYml, 100, 2).replace(/'<<<(.*?)>>>'/mg,'$1'));

    // Output the resource map.
    fsx.outputFileSync(path.resolve(cwd, 'serverless', 'resources.json'), JSON.stringify(resourceMapping));

    // Create "initialize-waterline.js", if using the orm.
    if (useOrm) {
      const initalizeWaterlineTemplate = _.template(fsx.readFileSync(path.resolve(__dirname, 'initialize-waterline.js')));
      let initializeWaterlineCode = initalizeWaterlineTemplate({
        modelsConfig: JSON.stringify(sails.config.models),
        datastoresConfig: JSON.stringify(sails.config.datastores)
      });
      fsx.outputFileSync(path.resolve(cwd, 'serverless', 'initialize-waterline.js'), initializeWaterlineCode);
    }

    // Create "initialize-helpers.js", if any helpers are being included.
    try {
      let helperFiles = fsx.readdirSync(path.resolve(cwd, 'api', 'helpers'));
      if (_.any(helperFiles, (fileName) => { return fileName.match(/^.+\.js/); })) {
        fsx.copySync(path.resolve(__dirname, 'initialize-helpers.js'), path.resolve(cwd, 'serverless', 'initialize-helpers.js'));
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        /* ignore */
      }
      else {
        throw e;
      }
    }

    if (inputs.skipdeps) {
      return exits.success('Done!');
    }

    console.log('Installing dependencies...');

    await exec('npm install', {cwd: path.resolve(cwd, 'serverless')}, (err) => {
      if (err) { return exits.error('A problem occurred while installing dependencies: ' + require('util').inspect(err)); }

      if (inputs.nodeploy) {
        return exits.success('Done!');
      }

      let serverlessArgs = ['deploy'];
      if (inputs.f) {
        serverlessArgs = serverlessArgs.concat(['-f', inputs.f]);
      }

      console.log('Starting Serverless deployment...');

      // TODO -- Check for serverless bin and fail gracefully (i.e. 'Please install serverless') if it isn't found.
      let serverlessProcess = spawn('serverless', serverlessArgs, { cwd: path.resolve(cwd, 'serverless')});
      serverlessProcess.stdout.on('data', (data) => {
        process.stdout.write(data);
      });

      serverlessProcess.stderr.on('data', (data) => {
        process.stdout.write(data);
      });

      serverlessProcess.on('close', () => {
        console.log();
        return exits.success('Done!');
      });

    });

  }

};

function parseAddress(haystack) {
  var verbExpr = /^\s*(all|get|post|put|delete|trace|options|connect|patch|head)\s+/i;
  var verbSpecified = _.last(haystack.match(verbExpr) || []) || '';
  verbSpecified = verbSpecified.toLowerCase();

  // If a verb was specified, eliminate the verb from the original string
  if (verbSpecified) {
    haystack = haystack.replace(verbExpr,'').trim();
  } else {
    haystack = haystack.trim();
  }

  return {
    verb: verbSpecified,
    original: haystack,
    path: haystack
  };
}
